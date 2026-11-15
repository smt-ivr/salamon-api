// push.js
// התראות לאפליקציית האנדרואיד דרך Firebase Cloud Messaging (FCM), גם כשהאפליקציה סגורה.
//
// הפעלה: סוד בשם FCM_SERVICE_ACCOUNT ב-Worker, עם תוכן קובץ ה-JSON של חשבון השירות מ-Firebase
// (Project settings → Service accounts → Generate new private key).
// בלי הסוד הזה כל הפונקציות כאן לא עושות כלום.

import { authenticateUser } from './auth.js';
import { getIsraelTimeForDB } from './timeUtils.js';
import { blockedAppPhones } from './app.js';

const FEED_FOLDER = 'ivr2:/1/2';
const FEED_URL = 'https://smti.uk/salamon/v2#feed';
const CHAT_URL = 'https://smti.uk/salamon/v2#chat';
const GROUPS_URL = 'https://smti.uk/salamon/groups';

export function pushEnabled(env) {
    return !!env.FCM_SERVICE_ACCOUNT;
}

// ---------------------------------------------------------------- רישום מכשירים

export async function handlePushRegister(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!body.userToken) return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });
    const token = String(body.token || '').trim();
    if (!/^[\w:.-]{20,4096}$/.test(token)) return Response.json({ error: "טוקן לא תקין" }, { status: 400 });
    const now = getIsraelTimeForDB();
    await env.DB.prepare(`INSERT INTO push_devices (token, phone, platform, app_version, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET phone = excluded.phone, app_version = excluded.app_version, last_seen_at = excluded.last_seen_at`)
        .bind(token, user.phone, 'android', String(body.appVersion || '').slice(0, 20), now, now).run();
    return Response.json({ success: true, enabled: pushEnabled(env) });
}

/** ביציאה מהחשבון: המכשיר מפסיק לקבל התראות של המשתמש הזה. */
export async function handlePushUnregister(request, env) {
    const body = await request.json().catch(() => ({}));
    const token = String(body.token || '').trim();
    if (token) await env.DB.prepare("DELETE FROM push_devices WHERE token = ?").bind(token).run();
    return Response.json({ success: true });
}

// ---------------------------------------------------------------- שליחה

/**
 * שולח התראה לכל המכשירים של רשימת טלפונים, לפי ההעדפות של כל משתמש.
 * kind: 'feed' (הודעה קולית חדשה), 'chat' (תשובה מהצוות), 'group' (הודעה בקבוצה)
 */
export async function pushToPhones(env, phones, { kind, title, body, tag, url }) {
    if (!pushEnabled(env)) return { sent: 0 };
    phones = [...new Set((phones || []).filter(Boolean).map(String))];
    // מי שנחסם באפליקציה לא מקבל התראות
    const blocked = await blockedAppPhones(env, phones).catch(() => new Set());
    phones = phones.filter(p => !blocked.has(p));
    if (!phones.length) return { sent: 0 };

    let sent = 0;
    for (let i = 0; i < phones.length; i += 50) {
        const part = phones.slice(i, i + 50);
        const marks = part.map(() => '?').join(',');
        const { results } = await env.DB.prepare(
            `SELECT d.token, d.phone, p.prefs FROM push_devices d LEFT JOIN user_prefs p ON p.phone = d.phone WHERE d.phone IN (${marks})`
        ).bind(...part).all();
        const targets = (results || []).filter(r => wants(r.prefs, kind));
        const outcomes = await Promise.all(targets.map(r => sendOne(env, r.token, { title, body, tag, url })));
        sent += outcomes.filter(Boolean).length;
    }
    return { sent };
}

function wants(prefsJson, kind) {
    let p = {};
    try { p = prefsJson ? JSON.parse(prefsJson) : {}; } catch (e) { p = {}; }
    // ברירות המחדל זהות לאתר: הודעות קוליות כבויות, צ'אט דלוק
    if (kind === 'feed' && p.notifyNewMessages !== true) return false;
    if ((kind === 'chat' || kind === 'group') && p.notifyChat === false) return false;
    return !inQuietHours(p.quietStart, p.quietEnd);
}

function inQuietHours(a, b) {
    if (!a || !b || !/^\d\d:\d\d$/.test(a) || !/^\d\d:\d\d$/.test(b)) return false;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const h = Number(parts.find(x => x.type === 'hour').value) % 24, m = Number(parts.find(x => x.type === 'minute').value);
    const cur = h * 60 + m;
    const [ah, am] = a.split(':').map(Number), [bh, bm] = b.split(':').map(Number);
    const s = ah * 60 + am, e = bh * 60 + bm;
    return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

async function sendOne(env, token, { title, body, tag, url }) {
    try {
        const sa = serviceAccount(env);
        const access = await accessToken(env);
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
            method: 'POST',
            headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                message: {
                    token,
                    // הודעת נתונים בלבד: האפליקציה מציגה אותה בעצמה, עם אותו מראה כמו בזמן שהיא פתוחה
                    data: { title: String(title || ''), body: String(body || ''), tag: String(tag || 'salamon'), url: String(url || '') },
                    android: { priority: 'HIGH', ttl: '86400s' },
                },
            }),
        });
        if (res.ok) return true;
        const err = await res.text();
        // מכשיר שהסיר את האפליקציה או טוקן שפג: מוחקים אותו
        if (res.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT.*token/i.test(err)) {
            await env.DB.prepare("DELETE FROM push_devices WHERE token = ?").bind(token).run();
        } else {
            console.error('fcm send', res.status, err.slice(0, 300));
        }
        return false;
    } catch (e) {
        console.error('fcm send', e.message);
        return false;
    }
}

// ---------------------------------------------------------------- התחברות ל-Google (JWT חתום ב-RS256)

let cachedSa = null;
function serviceAccount(env) {
    if (!cachedSa) cachedSa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
    return cachedSa;
}

let cachedToken = null; // { value, exp }
let tokenRequest = null;
function accessToken(env) {
    if (cachedToken && cachedToken.exp > Date.now() + 60_000) return Promise.resolve(cachedToken.value);
    // כמה שליחות במקביל חולקות בקשה אחת ל-Google
    if (!tokenRequest) tokenRequest = fetchAccessToken(env).finally(() => { tokenRequest = null; });
    return tokenRequest;
}

async function fetchAccessToken(env) {
    const sa = serviceAccount(env);
    const now = Math.floor(Date.now() / 1000);
    const enc = obj => b64url(new TextEncoder().encode(JSON.stringify(obj)));
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
    })}`;
    const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${b64url(sig)}`,
    });
    const data = await res.json();
    if (!data.access_token) throw new Error('Google token: ' + JSON.stringify(data).slice(0, 200));
    cachedToken = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
    return cachedToken.value;
}

function b64url(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------- אירועים

/** תשובה מהצוות בצ'אט התמיכה. */
export async function pushChatReply(env, phone, text) {
    if (!pushEnabled(env)) return;
    await pushToPhones(env, [phone], {
        kind: 'chat',
        title: 'תשובה חדשה מצוות עכשיו סלומון',
        body: String(text || '').slice(0, 200) || '📎 קובץ חדש',
        tag: 'salamon-chat',
        url: CHAT_URL,
    }).catch(e => console.error('push chat', e.message));
}

/** הודעה בקבוצה: לכל החברים הפעילים שהם משתמשי האתר, חוץ מהשולח. */
export async function pushGroupMessage(env, group, senderKey, senderName, text) {
    if (!pushEnabled(env) || !group) return;
    try {
        const { results } = await env.DB.prepare(
            "SELECT member_key FROM group_members WHERE group_id = ? AND status = 'active' AND member_key LIKE 'u:%' AND member_key != ?"
        ).bind(group.id, senderKey || '').all();
        const phones = (results || []).map(r => r.member_key.slice(2));
        await pushToPhones(env, phones, {
            kind: 'group',
            title: group.name || 'קבוצה',
            body: `${senderName ? senderName + ': ' : ''}${String(text || '').slice(0, 180) || '📎 קובץ'}`,
            tag: `salamon-group-${group.id}`,
            url: GROUPS_URL,
        });
    } catch (e) {
        console.error('push group', e.message);
    }
}

/**
 * רץ כל דקה (משימה מתוזמנת): בודק אם הגיעה הודעה קולית חדשה במערכת הטלפונית,
 * ושולח התראה למי שמאזין להודעות וביקש התראות עליהן.
 */
export async function checkNewFeedMessages(env) {
    if (!pushEnabled(env) || !env.YEMOT_TOKEN) return;
    // אין טעם לפנות לימות המשיח אם אף מכשיר לא רשום
    const any = await env.DB.prepare("SELECT 1 FROM push_devices LIMIT 1").first();
    if (!any) return;

    const token = env.YEMOT_TOKEN;
    const res = await fetch(`https://www.call2all.co.il/ym/api/GetIVR2Dir?token=${token}&path=${encodeURIComponent(FEED_FOLDER)}&filesLimit=10&filesFrom=0`);
    const data = await res.json().catch(() => null);
    if (!data || data.responseStatus !== 'OK') return;
    const ids = (data.files || [])
        .filter(f => f.fileType === 'AUDIO' && /^\d+\.(wav|mp3)$/i.test(f.name))
        .map(f => Number(f.name.split('.')[0]));
    if (!ids.length) return;
    const newest = Math.max(...ids);

    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'push_last_feed_id'").first();
    const last = row ? Number(row.value) : null;
    await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('push_last_feed_id', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(String(newest), getIsraelTimeForDB()).run();
    // בפעם הראשונה רק שומרים את המצב, בלי התראה על הודעות ישנות
    if (last === null || newest <= last) return;

    const fresh = ids.filter(id => id > last).sort((a, b) => b - a);
    // מי הקליט את ההודעה האחרונה (לשם בהתראה, ולסינון לפי רשימה לבנה/שחורה)
    let name = '', recorder = '';
    try {
        const pad = data.files.find(f => Number(f.name.split('.')[0]) === fresh[0]).name.split('.')[0];
        const t = await (await fetch(`https://www.call2all.co.il/ym/api/GetTextFile?token=${token}&what=${encodeURIComponent(FEED_FOLDER + '/' + pad + '.txt')}`)).json();
        const c = (t && t.contents) || '';
        if (c.includes('Phone-')) recorder = c.split('Phone-')[1].split('-')[0].trim();
        if (c.includes('ValName-')) name = c.split('ValName-')[1].replace(/\[WEB[^\]]*\]|\(דרך האתר\)/g, '').trim();
    } catch (e) {}

    const { results } = await env.DB.prepare(
        `SELECT DISTINCT u.phone, u.listen_whitelist, u.listen_blacklist FROM users u JOIN push_devices d ON d.phone = u.phone
         WHERE COALESCE(u.can_listen, 1) != 0`
    ).all();
    const phones = (results || []).filter(u => {
        if (recorder && u.phone === recorder) return false; // מי שהקליט לא מקבל התראה על עצמו
        const wl = (u.listen_whitelist || '').split(',').map(s => s.trim()).filter(Boolean);
        const bl = (u.listen_blacklist || '').split(',').map(s => s.trim()).filter(Boolean);
        if (recorder && wl.length && !wl.includes(recorder)) return false;
        if (recorder && bl.includes(recorder)) return false;
        return true;
    }).map(u => u.phone);

    await pushToPhones(env, phones, {
        kind: 'feed',
        title: 'עכשיו סלומון',
        body: fresh.length > 1 ? `${fresh.length} הודעות קוליות חדשות` : `הודעה חדשה מ${name || 'המערכת'}`,
        tag: 'salamon-feed',
        url: FEED_URL,
    });
}
