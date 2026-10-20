// master.js
// התחברות מאסטר: המנהל נכנס לחשבון של לקוח עם סיסמת המאסטר.
// אצל הלקוח לא נרשם כלום (לא נוכחות, לא קריאה, לא צפיות). במקום זה כל כניסה ופעולה נרשמות ביומן מאסטר נפרד,
// שרק המנהל הראשי רואה במרכז השליטה, ושם גם מנהלים את הסיסמה, ההפעלה, משך החיבור והחיבורים הפעילים.

import { getIsraelTimeForDB, getFutureIsraelTimeForDB, isPastIsraelTime } from './timeUtils.js';
import { getSettings, setSettings } from './schema.js';
import { isMainAdmin, forbidden, sessionExpired } from './adminAuth.js';
import { getAllNamesFromIni } from './yemot.js';
import { describeDevice } from './activity.js';

export const MASTER_DEFAULT_MINUTES = 10;

async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// מזהה קצר לחיבור, כדי שהטוקן עצמו לא יישלח לדפדפן של המנהל
async function handleOf(tokenId) {
    return (await sha256('master:' + tokenId)).slice(0, 20);
}

export async function masterConfig(env) {
    const s = await getSettings(env);
    const minutes = Math.min(720, Math.max(1, Number(s.master_session_minutes) || MASTER_DEFAULT_MINUTES));
    return { enabled: s.master_enabled !== '0', minutes };
}

// משך החיבור של מאסטר (נקרא מתוך authenticateUser, שמקבל רק את המסד)
export async function masterMinutes(db) {
    const row = await db.prepare("SELECT value FROM app_settings WHERE key = 'master_session_minutes'").first().catch(() => null);
    return Math.min(720, Math.max(1, Number(row && row.value) || MASTER_DEFAULT_MINUTES));
}

export async function logMaster(env, { phone, action, details = '', ip = '', userAgent = '', tokenId = null }) {
    await env.DB.prepare("INSERT INTO master_log (phone, action, details, ip, user_agent, session, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(phone || '', action, String(details || '').slice(0, 300), ip || '', String(userAgent || '').slice(0, 400), tokenId ? await handleOf(tokenId) : '', getIsraelTimeForDB()).run();
}

async function requireMainAdmin(env, body) {
    if (await isMainAdmin(env, body.adminToken)) return null;
    return body.adminToken ? sessionExpired() : forbidden();
}

async function activeSessions(env) {
    const { results } = await env.DB.prepare("SELECT id, phone, created_at, expires_at, last_used_at FROM user_tokens WHERE token_type = 'master' ORDER BY created_at DESC").all();
    const out = [];
    for (const t of results || []) {
        if (t.expires_at && isPastIsraelTime(t.expires_at)) continue;
        out.push({ handle: await handleOf(t.id), phone: t.phone, createdAt: t.created_at, lastUsedAt: t.last_used_at, expiresAt: t.expires_at });
    }
    return out;
}

// POST /api/admin/master  { adminToken, phone?, before? }  - מצב, חיבורים פעילים והיסטוריה
export async function handleAdminMaster(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireMainAdmin(env, body);
    if (denied) return denied;

    const cfg = await masterConfig(env);
    const where = [], vals = [];
    if (body.phone) { where.push('phone = ?'); vals.push(String(body.phone)); }
    if (body.before) { where.push('id < ?'); vals.push(Number(body.before)); }
    const [{ results: log }, sessions, hasPassword, names] = await Promise.all([
        env.DB.prepare(`SELECT * FROM master_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).bind(...vals).all(),
        activeSessions(env),
        env.DB.prepare("SELECT 1 FROM admins WHERE username = 'master'").first().then(r => !!r).catch(() => false),
        getAllNamesFromIni(env.YEMOT_TOKEN).catch(() => ({})),
    ]);
    // ניקוי חיבורי מאסטר שפג תוקפם
    await env.DB.prepare("DELETE FROM user_tokens WHERE token_type = 'master' AND expires_at < ?").bind(getIsraelTimeForDB()).run().catch(() => {});

    return Response.json({
        success: true,
        config: { ...cfg, hasPassword },
        sessions: sessions.map(s => ({ ...s, name: names[s.phone] || '' })),
        log: (log || []).map(l => ({ id: l.id, phone: l.phone, name: names[l.phone] || '', action: l.action, details: l.details, ip: l.ip, device: describeDevice(l.user_agent), session: l.session, createdAt: l.created_at })),
        hasMore: (log || []).length === 200,
    });
}

// POST /api/admin/master/save  { adminToken, enabled?, sessionMinutes?, newPassword? }
export async function handleAdminMasterSave(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireMainAdmin(env, body);
    if (denied) return denied;

    const values = {};
    if (body.enabled !== undefined) values.master_enabled = body.enabled ? '1' : '0';
    if (body.sessionMinutes !== undefined) values.master_session_minutes = String(Math.min(720, Math.max(1, Math.round(Number(body.sessionMinutes) || MASTER_DEFAULT_MINUTES))));
    const changes = [];
    if (Object.keys(values).length) {
        await setSettings(env, values, getIsraelTimeForDB());
        if (values.master_enabled) changes.push(values.master_enabled === '1' ? 'הופעל' : 'כובה');
        if (values.master_session_minutes) changes.push(`משך חיבור ${values.master_session_minutes} דק'`);
    }
    if (body.newPassword !== undefined) {
        const pw = String(body.newPassword || '');
        if (pw.length < 8) return Response.json({ error: "סיסמת המאסטר חייבת להכיל לפחות 8 תווים" }, { status: 400 });
        const exists = await env.DB.prepare("SELECT 1 FROM admins WHERE username = 'master'").first();
        if (exists) await env.DB.prepare("UPDATE admins SET password = ? WHERE username = 'master'").bind(pw).run();
        else await env.DB.prepare("INSERT INTO admins (username, password) VALUES ('master', ?)").bind(pw).run();
        changes.push('הסיסמה שונתה');
    }
    // כיבוי או החלפת סיסמה מנתקים מיד את כל חיבורי המאסטר
    if (values.master_enabled === '0' || body.newPassword !== undefined || body.endAll) {
        await env.DB.prepare("DELETE FROM user_tokens WHERE token_type = 'master'").run();
        if (body.endAll) changes.push('כל החיבורים נותקו');
    }
    if (changes.length) await logMaster(env, { action: 'SETTINGS', details: changes.join(' · '), ip: request.headers.get('cf-connecting-ip') || '', userAgent: request.headers.get('user-agent') || '' });
    return Response.json({ success: true, config: { ...(await masterConfig(env)), hasPassword: true } });
}

// POST /api/admin/master/end  { adminToken, handle }  - ניתוק חיבור מאסטר אחד
export async function handleAdminMasterEnd(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireMainAdmin(env, body);
    if (denied) return denied;
    const { results } = await env.DB.prepare("SELECT id, phone FROM user_tokens WHERE token_type = 'master'").all();
    for (const t of results || []) {
        if (await handleOf(t.id) !== body.handle) continue;
        await env.DB.prepare("DELETE FROM user_tokens WHERE id = ?").bind(t.id).run();
        await logMaster(env, { phone: t.phone, action: 'SESSION_ENDED', details: 'נותק ממרכז השליטה', tokenId: t.id, ip: request.headers.get('cf-connecting-ip') || '', userAgent: request.headers.get('user-agent') || '' });
        return Response.json({ success: true });
    }
    return Response.json({ error: "החיבור לא נמצא (אולי כבר הסתיים)" }, { status: 404 });
}
