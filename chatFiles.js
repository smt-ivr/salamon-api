// chatFiles.js
// קבצים מצורפים בצ'אט: הלקוח שולח למנהל והמנהל ללקוח. הקבצים נשמרים בשרת הקבצים של קלאודפלייר (R2, ה-binding FILES).
// אין קישור ציבורי: הקובץ נמסר רק בבקשה מאומתת של הלקוח (בשיחה שלו) או של המנהל.
// המנהל יכול להגביל קובץ ששלח: צפייה חד-פעמית, מספר צפיות, או תוקף.

import { getIsraelTimeForDB, getFutureIsraelTimeForDB, isPastIsraelTime } from './timeUtils.js';
import { authenticateUser } from './auth.js';
import { isMainAdmin } from './adminAuth.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_EMAIL_ATTACHMENT = 10 * 1024 * 1024;
const KEY_PREFIX = 'salamon/chat/';
const MAX_NAME = 120;

// סוגים שמוצגים בדפדפן. כל השאר יורדים כקובץ, כדי שקובץ HTML/SVG לא ירוץ תחת הדומיין של האתר
const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif|bmp|heic|heif)|application\/pdf|audio\/[\w.+-]+|video\/[\w.+-]+|text\/plain)$/;

// כשהדפדפן לא שלח סוג קובץ (נפוץ בטלפונים), הסוג נקבע לפי הסיומת
const EXT_TYPES = {
    pdf: 'application/pdf', txt: 'text/plain', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', amr: 'audio/amr',
};
export function typeOf(type, name) {
    const t = String(type || '').toLowerCase();
    if (t && t !== 'application/octet-stream') return t;
    const ext = String(name || '').toLowerCase().split('.').pop();
    return EXT_TYPES[ext] || 'application/octet-stream';
}
const BLOCKED_EXT = /\.(exe|msi|bat|cmd|com|scr|pif|vbs|vbe|js|jse|wsf|wsh|ps1|psm1|jar|reg|lnk|hta|cpl|dll|apk|app|dmg|sh)$/i;

export function hasFileStorage(env) {
    return !!(env.FILES && env.FILES.put);
}

function cleanName(name) {
    const n = String(name || 'file').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
    if (n.length <= MAX_NAME) return n || 'file';
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 10 ? n.slice(dot) : '';
    return n.slice(0, MAX_NAME - ext.length) + ext;
}

function cleanType(type) {
    const t = String(type || '').toLowerCase().split(';')[0].trim();
    return /^[\w.+-]+\/[\w.+-]+$/.test(t) ? t : 'application/octet-stream';
}

// קריאת הטופס ובדיקת הקובץ. מחזיר { form, file } או { error }
export async function readUpload(request, env) {
    if (!hasFileStorage(env)) return { error: Response.json({ error: "שרת הקבצים לא מחובר" }, { status: 503 }) };
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_FILE_BYTES + 64 * 1024) return { error: tooBig() };
    let form;
    try { form = await request.formData(); } catch (e) { return { error: Response.json({ error: "בקשת העלאה לא תקינה" }, { status: 400 }) }; }
    const file = form.get('file');
    if (!file || typeof file === 'string') return { error: Response.json({ error: "לא נבחר קובץ" }, { status: 400 }) };
    if (!file.size) return { error: Response.json({ error: "הקובץ ריק" }, { status: 400 }) };
    if (file.size > MAX_FILE_BYTES) return { error: tooBig() };
    if (BLOCKED_EXT.test(file.name || '')) return { error: Response.json({ error: "לא ניתן לשלוח קבצי הרצה מסוג זה" }, { status: 400 }) };
    return { form, file };
}

function tooBig() {
    return Response.json({ error: `הקובץ גדול מדי (עד ${MAX_FILE_BYTES / 1024 / 1024}MB)` }, { status: 413 });
}

// שמירת הקובץ ב-R2. מחזיר את השדות לשמירה בשורת ההודעה
export async function storeFile(env, phone, file) {
    const name = cleanName(file.name);
    const type = typeOf(cleanType(file.type), name);
    const key = `${KEY_PREFIX}${String(phone).replace(/[^\d+]/g, '') || 'unknown'}/${Date.now()}-${crypto.randomUUID()}`;
    await env.FILES.put(key, file.stream ? file.stream() : file, {
        httpMetadata: { contentType: type },
        customMetadata: { phone: String(phone), name: encodeURIComponent(name) },
    });
    return { file_key: key, file_name: name, file_type: type, file_size: file.size };
}

export async function removeFiles(env, keys) {
    const list = [...new Set((keys || []).filter(Boolean))];
    if (!list.length || !hasFileStorage(env)) return;
    for (let i = 0; i < list.length; i += 900) await env.FILES.delete(list.slice(i, i + 900)).catch(e => console.error('r2 delete', e));
}

// מגבלות שהמנהל קבע לקובץ: מספר צפיות (null = ללא הגבלה) ותוקף בדקות מעכשיו (null = ללא)
export function parseLimits(maxViews, expiresMinutes) {
    const views = maxViews === null || maxViews === undefined || maxViews === '' ? NaN : Math.round(Number(maxViews));
    const mins = expiresMinutes === null || expiresMinutes === undefined || expiresMinutes === '' ? NaN : Math.round(Number(expiresMinutes));
    return {
        file_max_views: Number.isFinite(views) ? Math.min(1000, Math.max(0, views)) : null,
        file_expires_at: Number.isFinite(mins) && mins > 0 ? getFutureIsraelTimeForDB(Math.min(mins, 366 * 24 * 60)) : null,
    };
}

// האם הלקוח עדיין רשאי לפתוח את הקובץ. קבצים שהלקוח עצמו שלח - תמיד
function blockReason(row) {
    if (row.sender !== 'admin') return null;
    if (row.file_max_views === 0) return 'revoked';
    if (row.file_expires_at && isPastIsraelTime(row.file_expires_at)) return 'expired';
    if (row.file_max_views !== null && row.file_max_views !== undefined && (row.file_views || 0) >= row.file_max_views) return 'used';
    return null;
}

export function isLimited(row) {
    return !!row && ((row.file_max_views !== null && row.file_max_views !== undefined) || !!row.file_expires_at);
}

// פרטי הקובץ כפי שהם נשלחים לדפדפן. אין בהם קישור: הקובץ נפתח רק דרך בקשה מאומתת ל-/api/chat/file
export function fileInfo(row, viewer = 'user') {
    if (!row || !row.file_key || row.is_deleted === 1) return null;
    const reason = blockReason(row);
    const info = {
        name: row.file_name || 'file', type: typeOf(row.file_type, row.file_name), size: row.file_size || 0,
        limited: isLimited(row), maxViews: row.file_max_views ?? null, views: row.file_views || 0, expiresAt: row.file_expires_at || null,
        available: viewer === 'admin' || !reason, blocked: reason,
    };
    if (viewer === 'admin') info.lastViewedAt = row.file_last_viewed_at || null;
    if (viewer === 'master') { info.available = true; info.master = true; }
    return info;
}

// תיאור קצר להודעה שיש בה רק קובץ (רשימת השיחות, התראות ומיילים)
export function fileLabel(row) {
    if (!row || !row.file_key) return '';
    const t = String(row.file_type || '');
    const icon = t.startsWith('image/') ? '🖼️' : t.startsWith('audio/') ? '🎧' : t.startsWith('video/') ? '🎬' : '📎';
    return `${icon} ${row.file_name || 'קובץ'}`;
}

export function messagePreview(row) {
    const text = String((row && row.message_text) || '');
    const label = fileLabel(row);
    return label ? (text ? `${label} · ${text}` : label) : text;
}

// הגבלת קצב לקבצים מצד הלקוח: עד 20 קבצים בשעה
export async function userFileQuotaExceeded(env, phone) {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE user_phone = ? AND sender = 'user' AND file_key IS NOT NULL AND created_at >= ?")
        .bind(phone, getFutureIsraelTimeForDB(-60)).first();
    return !!r && r.n >= 20;
}

const BLOCKED_TEXT = { expired: "תוקף הקובץ פג", used: "הקובץ כבר נצפה במספר הפעמים המותר", revoked: "הגישה לקובץ בוטלה" };

const FILE_COLUMNS = "id, user_phone, sender, is_deleted, file_key, file_name, file_type, file_size, file_max_views, file_views, file_expires_at";

// POST /api/chat/file  { userToken | adminToken, messageId, download }
// הקובץ נמסר רק למי שמחובר: הלקוח - רק משיחה שלו, המנהל - מכל שיחה.
// פתיחה של הלקוח לקובץ שהמנהל שלח נספרת, ונחסמת כשנגמרו הצפיות או פג התוקף.
export async function handleChatFile(request, env) {
    if (!hasFileStorage(env)) return Response.json({ error: "שרת הקבצים לא מחובר" }, { status: 503 });
    const body = await request.json().catch(() => ({}));
    const id = Number(body.messageId);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "חסר מזהה קובץ" }, { status: 400 });

    let viewer = null, phone = null;
    if (body.adminToken && await isMainAdmin(env, body.adminToken)) viewer = 'admin';
    else if (body.userToken) {
        const user = await authenticateUser(env.DB, body.userToken);
        // מאסטר רואה את הקבצים של הלקוח בלי הגבלה ובלי שהצפייה תיספר
        if (user) { viewer = user.is_master ? 'master' : 'user'; phone = user.phone; }
    }
    if (!viewer) return Response.json({ error: "יש להתחבר כדי לפתוח את הקובץ" }, { status: 401 });

    const row = await env.DB.prepare(`SELECT ${FILE_COLUMNS} FROM chat_messages WHERE id = ?`).bind(id).first();
    if (!row || !row.file_key || (viewer !== 'admin' && row.user_phone !== phone)) return Response.json({ error: "הקובץ לא נמצא" }, { status: 404 });
    if (row.is_deleted === 1) return Response.json({ error: "הקובץ נמחק" }, { status: 410 });

    if (viewer === 'user' && row.sender === 'admin') {
        const reason = blockReason(row);
        if (reason) return Response.json({ error: BLOCKED_TEXT[reason], code: reason }, { status: 410 });
        // ספירה אטומית, כדי ששתי פתיחות במקביל לא יעברו את המגבלה
        const upd = await env.DB.prepare(`UPDATE chat_messages SET file_views = COALESCE(file_views, 0) + 1, file_last_viewed_at = ?
            WHERE id = ? AND is_deleted = 0 AND (file_max_views IS NULL OR COALESCE(file_views, 0) < file_max_views)`).bind(getIsraelTimeForDB(), id).run();
        if (!upd.meta || !upd.meta.changes) return Response.json({ error: "הקובץ כבר נצפה במספר הפעמים המותר", code: 'used' }, { status: 410 });
    }

    const obj = await env.FILES.get(row.file_key);
    if (!obj) return Response.json({ error: "הקובץ לא נמצא בשרת הקבצים" }, { status: 404 });

    const type = typeOf(row.file_type, row.file_name);
    const inline = INLINE_TYPES.test(type) && !body.download;
    const headers = new Headers();
    headers.set('Content-Type', inline ? type : 'application/octet-stream');
    headers.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.file_name || 'file')}`);
    headers.set('Content-Length', String(obj.size));
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    headers.set('Cache-Control', 'no-store');
    return new Response(obj.body, { headers });
}

// הקובץ כצרופה למייל (Resend). רק לקובץ בלי מגבלות, ועד 10MB
export async function emailAttachment(env, row) {
    if (!row || !row.file_key || !hasFileStorage(env) || isLimited(row) || (row.file_size || 0) > MAX_EMAIL_ATTACHMENT) return null;
    const obj = await env.FILES.get(row.file_key);
    if (!obj) return null;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { filename: row.file_name || 'file', content: btoa(bin) };
}
