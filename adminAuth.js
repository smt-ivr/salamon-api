// adminAuth.js
// התחברות למרכז השליטה: חיבורים זמניים (session) במקום שליחת הסיסמה בכל בקשה.
// הטוקן אקראי, נשמר במסד רק כ-hash, ופג אחרי חוסר פעילות (או אחרי 30 יום עם "זכור אותי").
// אפשר להתחבר בשם משתמש וסיסמה, או עם חשבון האתר של "מנהל-העל" היחיד שהוגדר בהגדרות.

import { getIsraelTimeForDB, getFutureIsraelTimeForDB, isPastIsraelTime } from './timeUtils.js';
import { authenticateUser } from './auth.js';
import { getSettings, setSettings } from './schema.js';
import { getNameFromIni } from './yemot.js';
import { describeDevice } from './activity.js';

const IDLE_MINUTES = 120;
const REMEMBER_MINUTES = 30 * 24 * 60;
const MAX_FAILED_LOGINS = 8;
const FAILED_WINDOW_MINUTES = 15;

async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function newToken() {
    return 'adm_' + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

// מטמון קצר בתוך המופע, כדי שבקשות רצופות לא יבדקו את המסד כל פעם
const cache = new Map();
const CACHE_MS = 15000;

export async function getAdminSession(env, token) {
    if (!token || typeof token !== 'string' || !token.startsWith('adm_')) return null;
    const hit = cache.get(token);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.session;

    const id = await sha256(token);
    const s = await env.DB.prepare("SELECT * FROM admin_sessions WHERE id = ?").bind(id).first();
    if (!s || isPastIsraelTime(s.expires_at)) {
        if (s) await env.DB.prepare("DELETE FROM admin_sessions WHERE id = ?").bind(id).run();
        cache.delete(token);
        return null;
    }
    // תוקף מתחדש עם כל שימוש
    const expires = getFutureIsraelTimeForDB(s.remember ? REMEMBER_MINUTES : IDLE_MINUTES);
    await env.DB.prepare("UPDATE admin_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?").bind(getIsraelTimeForDB(), expires, id).run();
    const session = { ...s, expires_at: expires };
    cache.set(token, { at: Date.now(), session });
    if (cache.size > 500) cache.clear();
    return session;
}

export async function isMainAdmin(env, adminToken) {
    return !!(await getAdminSession(env, adminToken));
}

export function forbidden(message = "פעולה זו שמורה למנהל הראשי בלבד") {
    return Response.json({ error: message }, { status: 403 });
}

export function sessionExpired() {
    return Response.json({ error: "פג תוקף החיבור למרכז השליטה, יש להתחבר מחדש", code: 'ADMIN_SESSION_EXPIRED' }, { status: 401 });
}

async function createSession(env, { kind, subject, remember, ip, userAgent }) {
    const token = newToken();
    const now = getIsraelTimeForDB();
    await env.DB.prepare(`INSERT INTO admin_sessions (id, kind, subject, remember, created_at, last_used_at, expires_at, ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(await sha256(token), kind, subject, remember ? 1 : 0, now, now, getFutureIsraelTimeForDB(remember ? REMEMBER_MINUTES : IDLE_MINUTES), ip || '', (userAgent || '').slice(0, 400)).run();
    // ניקוי חיבורים שפג תוקפם
    await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").bind(now).run();
    return token;
}

async function tooManyAttempts(env, ip) {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_login_attempts WHERE ip = ? AND created_at >= ?")
        .bind(ip, getFutureIsraelTimeForDB(-FAILED_WINDOW_MINUTES)).first();
    return r && r.n >= MAX_FAILED_LOGINS;
}

async function recordFailure(env, ip) {
    const now = getIsraelTimeForDB();
    await env.DB.batch([
        env.DB.prepare("INSERT INTO admin_login_attempts (ip, created_at) VALUES (?, ?)").bind(ip, now),
        env.DB.prepare("DELETE FROM admin_login_attempts WHERE created_at < ?").bind(getFutureIsraelTimeForDB(-24 * 60)),
    ]);
}

async function describeSession(env, s) {
    if (s.kind === 'user') {
        const name = await getNameFromIni(s.subject, env.YEMOT_TOKEN).catch(() => null);
        return { kind: 'user', name: name || s.subject, phone: s.subject };
    }
    return { kind: 'admin', name: 'מנהל ראשי', username: s.subject };
}

function readClient(request) {
    return { ip: request.headers.get('cf-connecting-ip') || '0.0.0.0', userAgent: request.headers.get('user-agent') || '' };
}

// ---------- נתיבים ----------

export async function handleAdminLogin(request, env) {
    const body = await request.json().catch(() => ({}));
    const { ip, userAgent } = readClient(request);
    const { username, password } = body;
    if (!username || !password) return Response.json({ error: "חובה להזין שם משתמש וסיסמה" }, { status: 400 });
    if (await tooManyAttempts(env, ip)) return Response.json({ error: `יותר מדי ניסיונות כושלים. נסה שוב בעוד ${FAILED_WINDOW_MINUTES} דקות.` }, { status: 429 });

    const admin = await env.DB.prepare("SELECT username FROM admins WHERE username = ? AND password = ?").bind(String(username), String(password)).first();
    if (!admin) {
        await recordFailure(env, ip);
        return Response.json({ error: "שם משתמש או סיסמת מנהל שגויים" }, { status: 401 });
    }
    await env.DB.prepare("DELETE FROM admin_login_attempts WHERE ip = ?").bind(ip).run();
    const token = await createSession(env, { kind: 'admin', subject: admin.username, remember: !!body.remember, ip, userAgent });
    return Response.json({ success: true, message: "התחברת למרכז השליטה", adminToken: token, admin: { kind: 'admin', name: 'מנהל ראשי', username: admin.username } });
}

// כניסה עם חשבון האתר של מנהל-העל (משתמש יחיד שמוגדר בהגדרות)
export async function handleAdminLoginWithUser(request, env) {
    const body = await request.json().catch(() => ({}));
    const { ip, userAgent } = readClient(request);
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return Response.json({ error: "החיבור לאתר פג תוקף, יש להתחבר מחדש באתר" }, { status: 401 });
    const s = await getSettings(env);
    if (!s.super_admin_phone || s.super_admin_phone !== user.phone) return forbidden("החשבון הזה אינו מוגדר כמנהל-על");
    const token = await createSession(env, { kind: 'user', subject: user.phone, remember: !!body.remember, ip, userAgent });
    const name = await getNameFromIni(user.phone, env.YEMOT_TOKEN).catch(() => null);
    return Response.json({ success: true, adminToken: token, admin: { kind: 'user', name: name || user.phone, phone: user.phone } });
}

export async function handleAdminMe(request, env) {
    const body = await request.json().catch(() => ({}));
    const s = await getAdminSession(env, body.adminToken);
    if (!s) return sessionExpired();
    return Response.json({ success: true, admin: await describeSession(env, s), session: { createdAt: s.created_at, expiresAt: s.expires_at, remember: s.remember === 1 } });
}

export async function handleAdminLogout(request, env) {
    const body = await request.json().catch(() => ({}));
    if (body.adminToken && String(body.adminToken).startsWith('adm_')) {
        await env.DB.prepare("DELETE FROM admin_sessions WHERE id = ?").bind(await sha256(body.adminToken)).run();
        cache.delete(body.adminToken);
    }
    await setSettings(env, { admin_presence_state: 'offline', admin_presence_at: getIsraelTimeForDB() }, getIsraelTimeForDB());
    return Response.json({ success: true });
}

export async function handleAdminSessions(request, env) {
    const body = await request.json().catch(() => ({}));
    const current = await getAdminSession(env, body.adminToken);
    if (!current) return sessionExpired();

    if (body.revoke) {
        await env.DB.prepare("DELETE FROM admin_sessions WHERE id = ? AND id != ?").bind(String(body.revoke), current.id).run();
        cache.clear();
    }
    if (body.revokeOthers) {
        await env.DB.prepare("DELETE FROM admin_sessions WHERE id != ?").bind(current.id).run();
        cache.clear();
    }

    const { results } = await env.DB.prepare("SELECT * FROM admin_sessions ORDER BY last_used_at DESC").all();
    const sessions = [];
    for (const s of results || []) {
        sessions.push({
            id: s.id, current: s.id === current.id, ...(await describeSession(env, s)),
            createdAt: s.created_at, lastUsedAt: s.last_used_at, expiresAt: s.expires_at, remember: s.remember === 1,
            ip: s.ip, device: describeDevice(s.user_agent),
        });
    }
    return Response.json({ success: true, sessions });
}

// חשבון המנהל: שינוי סיסמה והגדרת מנהל-העל
export async function handleAdminAccount(request, env) {
    const body = await request.json().catch(() => ({}));
    const current = await getAdminSession(env, body.adminToken);
    if (!current) return sessionExpired();
    const now = getIsraelTimeForDB();

    if (body.changePassword) {
        if (current.kind !== 'admin') return forbidden("שינוי סיסמת המנהל אפשרי רק בכניסה עם שם משתמש וסיסמה");
        const { currentPassword, newPassword } = body.changePassword;
        if (!newPassword || String(newPassword).length < 8) return Response.json({ error: "הסיסמה החדשה חייבת להכיל לפחות 8 תווים" }, { status: 400 });
        const ok = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(current.subject, String(currentPassword || '')).first();
        if (!ok) return Response.json({ error: "הסיסמה הנוכחית שגויה" }, { status: 401 });
        await env.DB.prepare("UPDATE admins SET password = ? WHERE username = ?").bind(String(newPassword), current.subject).run();
        await env.DB.prepare("DELETE FROM admin_sessions WHERE id != ?").bind(current.id).run();
        cache.clear();
        return Response.json({ success: true, message: "הסיסמה שונתה. כל שאר המכשירים נותקו." });
    }

    if (body.superAdminPhone !== undefined) {
        const phone = String(body.superAdminPhone || '').replace(/[^\d]/g, '');
        if (phone) {
            const user = await env.DB.prepare("SELECT phone FROM users WHERE phone = ?").bind(phone).first();
            if (!user) return Response.json({ error: "לא נמצא חשבון אתר למספר הזה. יש לפתוח לו חשבון קודם." }, { status: 404 });
        }
        if (current.kind === 'user' && phone !== current.subject) return forbidden("כדי להחליף את מנהל-העל יש להתחבר עם שם המשתמש והסיסמה של המנהל");
        await setSettings(env, { super_admin_phone: phone }, now);
        // רק מנהל-על אחד: חיבורים של חשבונות אחרים נסגרים
        await env.DB.prepare("DELETE FROM admin_sessions WHERE kind = 'user' AND subject != ?").bind(phone).run();
        cache.clear();
    }

    const s = await getSettings(env);
    const superName = s.super_admin_phone ? await getNameFromIni(s.super_admin_phone, env.YEMOT_TOKEN).catch(() => null) : null;
    return Response.json({
        success: true,
        account: {
            me: await describeSession(env, current),
            superAdmin: s.super_admin_phone ? { phone: s.super_admin_phone, name: superName || '' } : null,
            idleMinutes: IDLE_MINUTES, rememberDays: REMEMBER_MINUTES / 1440,
        },
    });
}

// נוכחות המנהל: "online" נשלח רק כשהמנהל באמת מול המסך, "offline" ביציאה או בסגירת הלשונית
export async function handleAdminPresence(request, env) {
    const text = await request.text().catch(() => '');
    let body = {};
    try { body = JSON.parse(text || '{}'); } catch (e) {}
    if (!(await isMainAdmin(env, body.adminToken))) return sessionExpired();
    const state = ['online', 'away', 'offline'].includes(body.state) ? body.state : 'online';
    const now = getIsraelTimeForDB();
    await setSettings(env, { admin_presence_state: state, admin_presence_at: now }, now);
    return Response.json({ success: true });
}

export async function handleIsSuperAdmin(env, phone) {
    const s = await getSettings(env);
    return !!s.super_admin_phone && s.super_admin_phone === phone;
}
