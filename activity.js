// activity.js
// מעקב משתמשים: נוכחות (מי מחובר עכשיו), היסטוריית התחברויות ויומן פעולות.
// הרישום מתבצע מרכזית ב-worker.js סביב כל בקשה, כך שה-handlers הקיימים לא משתנים.

import { getIsraelTimeForDB, getFutureIsraelTimeForDB, getMinutesSinceIsraelDbTime } from './timeUtils.js';
import { getAllNamesFromIni } from './yemot.js';
import { isMainAdmin, forbidden } from './adminAuth.js';

export const ONLINE_MINUTES = 2;

// נתיב -> סוג פעולה ביומן
const TRACKED_ROUTES = [
    ['/api/login/google', 'LOGIN'],
    ['/api/login', 'LOGIN'],
    ['/api/logout', 'LOGOUT'],
    ['/api/register', 'REGISTER'],
    ['/api/update-profile', 'PROFILE_UPDATE'],
    ['/api/change-password', 'PASSWORD_CHANGE'],
    ['/api/reset-password/confirm', 'PASSWORD_RESET'],
    ['/api/unblock-email', 'EMAIL_UNBLOCK'],
    ['/api/messages/upload', 'UPLOAD'],
    ['/api/messages/tzintuk', 'TZINTUK'],
    ['/api/messages/delete', 'DELETE_MESSAGE'],
    ['/api/messages/stream', 'LISTEN'],
    ['/api/chat/send', 'CHAT_SEND'],
];

// כתיבת נוכחות לכל טוקן לכל היותר פעם בדקה (בתוך אותו מופע של ה-Worker)
const presenceWrites = new Map();
const PRESENCE_THROTTLE_MS = 60 * 1000;

function routeAction(pathname) {
    for (const [suffix, action] of TRACKED_ROUTES) if (pathname.endsWith(suffix)) return action;
    return null;
}

async function readCredentials(request) {
    const url = new URL(request.url);
    const out = { userToken: url.searchParams.get('userToken'), body: {} };
    if (request.method !== 'POST') return out;
    const type = request.headers.get('content-type') || '';
    try {
        if (type.includes('application/json')) {
            out.body = await request.clone().json();
        } else if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
            const form = await request.clone().formData();
            out.body = { userToken: form.get('userToken') };
        }
    } catch (e) {}
    if (out.body && out.body.userToken) out.userToken = out.body.userToken;
    return out;
}

// שלב א': לפני הטיפול בבקשה (חשוב ליציאה, כי הטוקן נמחק בתוכה)
export async function beginTracking(request, env, pathname, ip) {
    if (!pathname.includes('/api/') || pathname.includes('/api/admin/') || pathname.includes('/api/verify/admin/')) return null;
    const action = routeAction(pathname);
    const { userToken, body } = await readCredentials(request);
    if (!userToken && !action) return null;

    let session = null;
    if (userToken) {
        session = await env.DB.prepare("SELECT phone, token_type FROM user_tokens WHERE id = ?").bind(userToken).first().catch(() => null);
    }
    return {
        pathname, action, userToken, body, session,
        ip, userAgent: (request.headers.get('user-agent') || '').slice(0, 400),
        fileId: new URL(request.url).searchParams.get('fileId'),
    };
}

// שלב ב': אחרי שהתקבלה תשובה
export async function finishTracking(env, t, response) {
    if (!t) return;
    const ok = response.status < 400;
    const now = getIsraelTimeForDB();

    if (t.session && ok) await touchPresence(env, t.userToken, t.session.phone, t.ip, t.userAgent, now);
    if (!t.action) return;

    let phone = t.session ? t.session.phone : null;
    let action = t.action;
    let details = '';

    if (t.action === 'LOGIN') {
        const isGoogle = t.pathname.endsWith('/google');
        let data = {};
        try { data = await response.clone().json(); } catch (e) {}
        if (ok && data.token) {
            const s = await env.DB.prepare("SELECT phone, token_type FROM user_tokens WHERE id = ?").bind(data.token).first();
            if (!s) return;
            phone = s.phone;
            const method = s.token_type === 'master' ? 'master' : isGoogle ? 'google' : 'password';
            action = method === 'master' ? 'LOGIN_MASTER' : 'LOGIN';
            details = JSON.stringify({ method, remember: s.token_type.endsWith('_perm') });
            await env.DB.prepare(`INSERT INTO user_presence (phone, last_seen_at, last_ip, last_user_agent, last_login_at, last_login_method) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(phone) DO UPDATE SET last_seen_at = excluded.last_seen_at, last_ip = excluded.last_ip, last_user_agent = excluded.last_user_agent,
                last_login_at = excluded.last_login_at, last_login_method = excluded.last_login_method`)
                .bind(phone, now, t.ip, t.userAgent, now, method).run();
        } else if (!isGoogle && t.body && t.body.identifier) {
            const id = String(t.body.identifier).toLowerCase();
            const u = await env.DB.prepare("SELECT phone FROM users WHERE phone = ? OR email = ?").bind(id, id).first();
            if (!u) return;
            phone = u.phone;
            action = 'LOGIN_FAILED';
            details = JSON.stringify({ reason: data.error || 'שגיאה' });
        } else {
            return;
        }
    } else if (t.action === 'REGISTER') {
        if (!ok) return;
        phone = t.body && t.body.phone;
    } else if (t.action === 'PASSWORD_RESET') {
        if (!ok) return;
        phone = t.body && t.body.phone;
    } else {
        if (!ok || !phone) return;
        if (t.action === 'CHAT_SEND') details = String(t.body.text || '').slice(0, 120);
        else if (t.action === 'DELETE_MESSAGE') details = String(t.body.fileName || '');
        else if (t.action === 'PROFILE_UPDATE') details = Object.keys(t.body).filter(k => !['userToken', 'password'].includes(k)).join(', ');
        else if (t.action === 'LISTEN') {
            details = String(t.fileId || '');
            // נגן השמע שולח כמה בקשות לאותו קובץ; נרשמת האזנה אחת לכל 10 דקות
            const recent = await env.DB.prepare("SELECT 1 FROM user_activity WHERE phone = ? AND action = 'LISTEN' AND details = ? AND created_at > ?")
                .bind(phone, details, getFutureIsraelTimeForDB(-10)).first();
            if (recent) return;
        }
    }
    if (!phone) return;
    await logActivity(env, phone, action, details, t.ip, t.userAgent, now);
}

export async function logActivity(env, phone, action, details, ip, userAgent, now = getIsraelTimeForDB()) {
    await env.DB.prepare("INSERT INTO user_activity (phone, action, details, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(phone, action, details || '', ip || '', userAgent || '', now).run();
}

async function touchPresence(env, token, phone, ip, userAgent, now) {
    const last = presenceWrites.get(token) || 0;
    if (Date.now() - last < PRESENCE_THROTTLE_MS) return;
    presenceWrites.set(token, Date.now());
    if (presenceWrites.size > 5000) presenceWrites.clear();
    await env.DB.prepare(`INSERT INTO user_presence (phone, last_seen_at, last_ip, last_user_agent) VALUES (?, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET last_seen_at = excluded.last_seen_at, last_ip = excluded.last_ip, last_user_agent = excluded.last_user_agent`)
        .bind(phone, now, ip, userAgent).run();
}

// ---------- עזרים ----------

export function describeDevice(ua) {
    if (!ua) return '';
    const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    const browser = /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
        : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
    return [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
}

export function isOnline(lastSeenAt) {
    return !!lastSeenAt && getMinutesSinceIsraelDbTime(lastSeenAt) <= ONLINE_MINUTES;
}

export async function getPresenceMap(env, phones = null) {
    const rows = phones && phones.length
        ? (await env.DB.prepare(`SELECT * FROM user_presence WHERE phone IN (${phones.map(() => '?').join(',')})`).bind(...phones).all()).results
        : (await env.DB.prepare("SELECT * FROM user_presence").all()).results;
    const map = {};
    for (const r of rows || []) map[r.phone] = { lastSeenAt: r.last_seen_at, online: isOnline(r.last_seen_at), lastLoginAt: r.last_login_at, lastLoginMethod: r.last_login_method, device: describeDevice(r.last_user_agent), ip: r.last_ip };
    return map;
}

function presentEvent(e, names) {
    let details = e.details || '';
    let meta = null;
    if (details.startsWith('{')) { try { meta = JSON.parse(details); details = ''; } catch (err) {} }
    return { id: e.id, phone: e.phone, name: names[e.phone] || '', action: e.action, details, meta, ip: e.ip, device: describeDevice(e.user_agent), createdAt: e.created_at };
}

// ---------- נתיבי ניהול ----------

export async function handleAdminActivityOnline(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await isMainAdmin(env, body.adminToken))) return forbidden();

    const since = getFutureIsraelTimeForDB(-ONLINE_MINUTES);
    const dayAgo = getFutureIsraelTimeForDB(-24 * 60);
    const today = getIsraelTimeForDB().slice(0, 10) + ' 00:00:00';

    const [online, active24, logins, recentLogins, names] = await Promise.all([
        env.DB.prepare("SELECT * FROM user_presence WHERE last_seen_at >= ? ORDER BY last_seen_at DESC").bind(since).all(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM user_presence WHERE last_seen_at >= ?").bind(dayAgo).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM user_activity WHERE action IN ('LOGIN', 'LOGIN_MASTER') AND created_at >= ?").bind(today).first(),
        env.DB.prepare("SELECT * FROM user_activity WHERE action IN ('LOGIN', 'LOGIN_MASTER', 'LOGIN_FAILED', 'LOGOUT') ORDER BY id DESC LIMIT 25").all(),
        getAllNamesFromIni(env.YEMOT_TOKEN),
    ]);

    return Response.json({
        success: true,
        online: (online.results || []).map(r => ({ phone: r.phone, name: names[r.phone] || '', lastSeenAt: r.last_seen_at, device: describeDevice(r.last_user_agent), ip: r.last_ip, lastLoginAt: r.last_login_at })),
        recentLogins: (recentLogins.results || []).map(e => presentEvent(e, names)),
        stats: { onlineNow: (online.results || []).length, active24h: active24 ? active24.n : 0, loginsToday: logins ? logins.n : 0 },
    });
}

export async function handleAdminActivityFeed(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await isMainAdmin(env, body.adminToken))) return forbidden();

    const where = [];
    const args = [];
    if (body.phone) { where.push("phone = ?"); args.push(String(body.phone)); }
    if (body.action) {
        const actions = String(body.action).split(',').map(s => s.trim()).filter(Boolean);
        where.push(`action IN (${actions.map(() => '?').join(',')})`); args.push(...actions);
    }
    if (body.beforeId) { where.push("id < ?"); args.push(Number(body.beforeId)); }
    const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 300);

    const [rows, names] = await Promise.all([
        env.DB.prepare(`SELECT * FROM user_activity ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`).bind(...args).all(),
        getAllNamesFromIni(env.YEMOT_TOKEN),
    ]);
    return Response.json({ success: true, events: (rows.results || []).map(e => presentEvent(e, names)) });
}

export async function handleAdminActivityUser(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await isMainAdmin(env, body.adminToken))) return forbidden();
    if (!body.phone) return Response.json({ error: "חסר מספר טלפון" }, { status: 400 });

    const phone = String(body.phone);
    const [presence, events, sessions, counts] = await Promise.all([
        env.DB.prepare("SELECT * FROM user_presence WHERE phone = ?").bind(phone).first(),
        env.DB.prepare("SELECT * FROM user_activity WHERE phone = ? ORDER BY id DESC LIMIT 200").bind(phone).all(),
        env.DB.prepare("SELECT id, token_type, created_at, expires_at, last_used_at, session_email FROM user_tokens WHERE phone = ? AND token_type != 'master' ORDER BY last_used_at DESC").bind(phone).all(),
        env.DB.prepare("SELECT action, COUNT(*) AS n FROM user_activity WHERE phone = ? GROUP BY action").bind(phone).all(),
    ]);

    const totals = {};
    for (const r of counts.results || []) totals[r.action] = r.n;

    return Response.json({
        success: true,
        presence: presence ? {
            online: isOnline(presence.last_seen_at), lastSeenAt: presence.last_seen_at, lastLoginAt: presence.last_login_at,
            lastLoginMethod: presence.last_login_method, device: describeDevice(presence.last_user_agent), ip: presence.last_ip,
        } : { online: false },
        sessions: sessions.results || [],
        totals,
        events: (events.results || []).map(e => presentEvent(e, {})),
    });
}

// ניקוי יומן ישן (מופעל מה-cron)
export async function pruneActivity(env, days = 180) {
    await env.DB.prepare("DELETE FROM user_activity WHERE created_at < ?").bind(getFutureIsraelTimeForDB(-days * 24 * 60)).run();
}
