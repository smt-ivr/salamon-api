// chatFiles.js
// קבצים מצורפים בצ'אט: הלקוח שולח למנהל והמנהל ללקוח. הקבצים נשמרים בשרת הקבצים של קלאודפלייר (R2, ה-binding FILES).
// כל קובץ מקבל טוקן אקראי, והקישור /api/chat/file/<id>/<token> הוא שמאפשר לצפות בו או להוריד אותו.

import { getFutureIsraelTimeForDB } from './timeUtils.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const KEY_PREFIX = 'salamon/chat/';
const MAX_NAME = 120;

// סוגים שמוצגים בדפדפן. כל השאר יורדים כקובץ, כדי שקובץ HTML/SVG לא ירוץ תחת הדומיין של האתר
const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|audio\/[\w.+-]+|video\/(mp4|webm|ogg|quicktime)|text\/plain)$/;
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
    const type = cleanType(file.type);
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const key = `${KEY_PREFIX}${String(phone).replace(/[^\d+]/g, '') || 'unknown'}/${Date.now()}-${crypto.randomUUID()}`;
    await env.FILES.put(key, file.stream ? file.stream() : file, {
        httpMetadata: { contentType: type },
        customMetadata: { phone: String(phone), name: encodeURIComponent(name) },
    });
    return { file_key: key, file_name: name, file_type: type, file_size: file.size, file_token: token };
}

export async function removeFiles(env, keys) {
    const list = [...new Set((keys || []).filter(Boolean))];
    if (!list.length || !hasFileStorage(env)) return;
    for (let i = 0; i < list.length; i += 900) await env.FILES.delete(list.slice(i, i + 900)).catch(e => console.error('r2 delete', e));
}

// פרטי הקובץ כפי שהם נשלחים לדפדפן
export function fileInfo(row, apiBase) {
    if (!row || !row.file_key || row.is_deleted === 1) return null;
    return {
        name: row.file_name || 'file', type: row.file_type || 'application/octet-stream', size: row.file_size || 0,
        url: `${apiBase}/chat/file/${row.id}/${row.file_token}`,
    };
}

// כתובת ה-API כפי שהדפדפן פנה אליה (למשל https://smti.uk/salamon/api)
export function apiBaseOf(request) {
    const url = new URL(request.url);
    const i = url.pathname.indexOf('/api/');
    return url.origin + (i >= 0 ? url.pathname.slice(0, i) : '') + '/api';
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

// GET /api/chat/file/<id>/<token>  (?dl=1 מכריח הורדה)
export async function handleChatFile(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/\/api\/chat\/file\/(\d+)\/([a-f0-9]{64})$/);
    if (!m) return new Response('Not Found', { status: 404 });
    if (!hasFileStorage(env)) return new Response('File storage unavailable', { status: 503 });

    const row = await env.DB.prepare("SELECT id, file_key, file_name, file_type, file_size, file_token, is_deleted FROM chat_messages WHERE id = ?").bind(Number(m[1])).first();
    if (!row || !row.file_key || row.file_token !== m[2]) return new Response('Not Found', { status: 404 });
    if (row.is_deleted === 1) return new Response('Gone', { status: 410 });

    const obj = await env.FILES.get(row.file_key, { range: request.headers, onlyIf: request.headers });
    if (!obj) return new Response('Not Found', { status: 404 });

    const type = row.file_type || 'application/octet-stream';
    const inline = INLINE_TYPES.test(type) && url.searchParams.get('dl') !== '1';
    const headers = new Headers();
    headers.set('Content-Type', inline ? type : 'application/octet-stream');
    headers.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.file_name || 'file')}`);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    headers.set('Cache-Control', 'private, max-age=86400');
    headers.set('Accept-Ranges', 'bytes');
    if (obj.httpEtag) headers.set('ETag', obj.httpEtag);

    if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers });
    if (obj.range && request.headers.get('range')) {
        const r = obj.range;
        const offset = 'suffix' in r ? Math.max(0, obj.size - r.suffix) : (r.offset || 0);
        const length = 'suffix' in r ? obj.size - offset : (r.length ?? obj.size - offset);
        headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
        headers.set('Content-Length', String(length));
        return new Response(obj.body, { status: 206, headers });
    }
    headers.set('Content-Length', String(obj.size));
    return new Response(obj.body, { headers });
}
