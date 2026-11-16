// nativeapp.js
// האפליקציה הייעודית לאנדרואיד (לא מבוססת אתר): כניסה עם חיבור קבוע, דיווח מכשיר, שליטה מרחוק
// ממרכז השליטה (חסימת גרסאות, חיוב עדכון, פתיחה באתר, מצב תחזוקה, הודעה לכולם, נעילת מסך),
// הגדרות התראות לכל מכשיר, ובדיקת רקע כגיבוי להתראות.

import { authenticateUser } from './auth.js';
import { isMainAdmin } from './adminAuth.js';
import { getIsraelTimeForDB } from './timeUtils.js';
import { getNameFromIni } from './yemot.js';
import { ensureTables, latestAppInfo } from './app.js';
import { pushEnabled, pushToPhone, pushToAllApp, getFeedStatus, checkNewFeedMessages, sendOne } from './push.js';
import { getSettings } from './schema.js';

function json(data, status = 200) { return Response.json(data, { status }); }

// ---------------------------------------------------------------- הגדרות מרחוק

export const APP_CONFIG_DEFAULTS = {
    // 'native' = המסכים של האפליקציה; 'web' = האפליקציה פותחת את האתר
    mode: 'native',
    webUrl: 'https://smti.uk/salamon',
    // גרסאות: מתחת למינימום או ברשימת החסומות = מסך "חובה לעדכן"
    minVersion: 0,
    blockedVersions: [],
    recommendedVersion: 0,
    updateMessage: 'יצאה גרסה חדשה של האפליקציה. כדי להמשיך יש לעדכן.',
    // מצב תחזוקה: האפליקציה מציגה הודעה ולא נכנסת
    maintenance: false,
    maintenanceMessage: 'האפליקציה בתחזוקה קצרה. נחזור בקרוב.',
    // הודעה שמוצגת בראש האפליקציה (ריק = אין)
    announcement: '',
    // נעילת מסך: אישור עם טביעת אצבע / קוד הטלפון כדי להיכנס
    requireLock: false,
    lockAfterMinutes: 5,
    // מסכים
    features: { feed: true, record: true, tzintuk: true, chat: true, groups: true },
};

async function readConfig(env) {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'native_app_config'").first();
    let saved = {};
    try { saved = row ? JSON.parse(row.value) : {}; } catch (e) { saved = {}; }
    return { ...APP_CONFIG_DEFAULTS, ...saved, features: { ...APP_CONFIG_DEFAULTS.features, ...(saved.features || {}) } };
}

function cleanConfig(input = {}) {
    const c = {};
    if (input.mode === 'native' || input.mode === 'web') c.mode = input.mode;
    if (typeof input.webUrl === 'string' && /^https:\/\/[^\s]+$/.test(input.webUrl)) c.webUrl = input.webUrl.slice(0, 300);
    for (const k of ['minVersion', 'recommendedVersion']) if (input[k] !== undefined) c[k] = Math.max(0, Math.floor(Number(input[k]) || 0));
    if (Array.isArray(input.blockedVersions)) c.blockedVersions = input.blockedVersions.map(v => Math.floor(Number(v))).filter(v => v > 0).slice(0, 50);
    for (const k of ['updateMessage', 'maintenanceMessage', 'announcement']) if (typeof input[k] === 'string') c[k] = input[k].slice(0, 500);
    for (const k of ['maintenance', 'requireLock']) if (input[k] !== undefined) c[k] = !!input[k];
    if (input.lockAfterMinutes !== undefined) c.lockAfterMinutes = Math.min(1440, Math.max(0, Math.floor(Number(input.lockAfterMinutes) || 0)));
    if (input.features && typeof input.features === 'object') {
        c.features = {};
        for (const k of Object.keys(APP_CONFIG_DEFAULTS.features)) if (input.features[k] !== undefined) c.features[k] = !!input.features[k];
    }
    return c;
}

/** What the app should do for this version (versionCode). */
function gate(config, versionCode, latest) {
    const v = Number(versionCode) || 0;
    const mustUpdate = (config.minVersion && v < config.minVersion) || config.blockedVersions.includes(v);
    const latestCode = (latest && latest.versionCode) || 0;
    return {
        mustUpdate: !!mustUpdate,
        // a newer build is published, or the control center recommends a version
        shouldUpdate: !mustUpdate && ((config.recommendedVersion > 0 && v < config.recommendedVersion) || (latestCode > 0 && v > 0 && v < latestCode)),
        latestVersionCode: latestCode,
        latestVersionName: (latest && latest.version) || '',
    };
}

function publicConfig(config, versionCode, latest) {
    return {
        mode: config.mode, webUrl: config.webUrl,
        maintenance: config.maintenance, maintenanceMessage: config.maintenanceMessage,
        updateMessage: config.updateMessage, updateUrl: 'https://smti.uk/salamon/app/download',
        announcement: config.announcement,
        requireLock: config.requireLock, lockAfterMinutes: config.lockAfterMinutes,
        features: config.features,
        pushConfigured: false,
        ...gate(config, versionCode, latest),
    };
}

/** GET/POST /api/app/config?v=<versionCode> - public, before login. */
export async function handleNativeConfig(request, env) {
    await ensureTables(env);
    const url = new URL(request.url);
    let v = url.searchParams.get('v');
    if (request.method === 'POST') {
        const body = await request.clone().json().catch(() => ({}));
        if (body.versionCode !== undefined) v = body.versionCode;
    }
    const config = await readConfig(env);
    const latest = await latestAppInfo().catch(() => null);
    return json({ success: true, config: { ...publicConfig(config, v, latest), pushConfigured: pushEnabled(env) } });
}

// ---------------------------------------------------------------- כניסה ויציאה

/**
 * POST /api/app/login { identifier, password, device }
 * Permanent app session ('app_perm'): does not expire and is not removed by logins on the website.
 */
export async function handleNativeLogin(request, env) {
    const body = await request.json().catch(() => ({}));
    const identifier = String(body.identifier || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!identifier || !password) return json({ error: "נא להזין טלפון או אימייל וסיסמה" }, 400);

    const user = await env.DB.prepare("SELECT * FROM users WHERE phone = ? OR email = ?").bind(identifier, identifier).first();
    if (!user || user.password !== password) return json({ error: "פרטי הכניסה שגויים" }, 401);
    if (user.google_login_only === 1) return json({ error: "החשבון הזה מוגדר לכניסה עם Google בלבד. אפשר להגדיר סיסמה באתר, בהגדרות החשבון." }, 403);

    await ensureTables(env);
    const blocked = await env.DB.prepare("SELECT blocked FROM app_users WHERE phone = ?").bind(user.phone).first();
    if (blocked && blocked.blocked) return json({ error: "הגישה שלך לאפליקציה נחסמה. לפרטים אפשר לפנות לצוות עכשיו סלומון.", appBlocked: true }, 403);

    const token = crypto.randomUUID();
    const now = getIsraelTimeForDB();
    await env.DB.prepare("INSERT INTO user_tokens (id, phone, token_type, created_at, expires_at, last_used_at, session_email) VALUES (?, ?, 'app_perm', ?, NULL, ?, NULL)")
        .bind(token, user.phone, now, now).run();
    const name = await getNameFromIni(user.phone, env.YEMOT_TOKEN).catch(() => '');
    return json({ success: true, token, user: { phone: user.phone, name: name || '', email: user.email || '' } });
}

async function issueAppToken(env, user) {
    await ensureTables(env);
    const blocked = await env.DB.prepare("SELECT blocked FROM app_users WHERE phone = ?").bind(user.phone).first();
    if (blocked && blocked.blocked) return json({ error: "הגישה שלך לאפליקציה נחסמה. לפרטים אפשר לפנות לצוות עכשיו סלומון.", appBlocked: true }, 403);
    const token = crypto.randomUUID();
    const now = getIsraelTimeForDB();
    await env.DB.prepare("INSERT INTO user_tokens (id, phone, token_type, created_at, expires_at, last_used_at, session_email) VALUES (?, ?, 'app_perm', ?, NULL, ?, NULL)")
        .bind(token, user.phone, now, now).run();
    const name = await getNameFromIni(user.phone, env.YEMOT_TOKEN).catch(() => '');
    return json({ success: true, token, user: { phone: user.phone, name: name || '', email: user.email || '' } });
}

/** POST /api/app/login/google { credential } - Google sign-in done in the browser (smti.uk/salamon/app/login). */
export async function handleNativeLoginGoogle(request, env) {
    const body = await request.json().catch(() => ({}));
    const credential = String(body.credential || '');
    if (!credential) return json({ error: "חסר אימות Google" }, 400);
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    const g = await r.json().catch(() => ({}));
    if (!r.ok || !g.email) return json({ error: "האימות מול Google נכשל" }, 401);
    if (g.aud !== "89500817024-tbvsuu4dci6bqh173l65ua9lc65pe24p.apps.googleusercontent.com") return json({ error: "בקשה לא מורשית" }, 403);
    const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(String(g.email).toLowerCase()).first();
    if (!user) return json({ error: `כתובת המייל ${g.email} לא משויכת לחשבון בעכשיו סלומון.` }, 404);
    return issueAppToken(env, user);
}

/** POST /api/app/login/session { userToken } - "continue as…" for someone already signed in to the website in the browser. */
export async function handleNativeLoginSession(request, env) {
    const body = await request.json().catch(() => ({}));
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return json({ error: "החיבור באתר הסתיים. נא להתחבר מחדש." }, 401);
    if (user.is_master) return json({ error: "אי אפשר לחבר את האפליקציה מחיבור מאסטר" }, 403);
    return issueAppToken(env, user);
}

// ---------------------------------------------------------------- דוחות קריסה

let crashTable = false;
async function ensureCrashTable(env) {
    if (crashTable) return;
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_crashes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, phone TEXT, version TEXT, device TEXT, os TEXT, screen TEXT, message TEXT, stack TEXT
    )`).run();
    crashTable = true;
}

/** POST /api/app/crash { userToken?, device, screen, message, stack } - sent by the app after a crash. */
export async function handleNativeCrash(request, env) {
    const body = await request.json().catch(() => ({}));
    await ensureCrashTable(env);
    let phone = '';
    try { const u = body.userToken ? await authenticateUser(env.DB, body.userToken) : null; phone = u ? u.phone : ''; } catch (e) {}
    const d = body.device || {};
    await env.DB.prepare("INSERT INTO app_crashes (at, phone, version, device, os, screen, message, stack) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(getIsraelTimeForDB(), phone, String(d.versionName || '').slice(0, 20), String(d.model || '').slice(0, 80), String(d.os || '').slice(0, 30),
            String(body.screen || '').slice(0, 60), String(body.message || '').slice(0, 500), String(body.stack || '').slice(0, 8000)).run();
    // keep the table small
    await env.DB.prepare("DELETE FROM app_crashes WHERE id NOT IN (SELECT id FROM app_crashes ORDER BY id DESC LIMIT 500)").run().catch(() => {});
    return json({ success: true });
}

/** POST /api/admin/app/crashes { adminToken } */
export async function handleAdminNativeCrashes(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    await ensureCrashTable(env);
    const { results } = await env.DB.prepare("SELECT * FROM app_crashes ORDER BY id DESC LIMIT 200").all();
    return json({ success: true, crashes: results || [] });
}

/** POST /api/app/logout { userToken, pushToken } */
export async function handleNativeLogout(request, env) {
    const body = await request.json().catch(() => ({}));
    if (body.pushToken) await env.DB.prepare("DELETE FROM push_devices WHERE token = ?").bind(String(body.pushToken)).run();
    if (body.userToken) await env.DB.prepare("DELETE FROM user_tokens WHERE id = ? AND token_type = 'app_perm'").bind(String(body.userToken)).run();
    return json({ success: true });
}

// ---------------------------------------------------------------- דיווח מכשיר

/**
 * POST /api/app/heartbeat { userToken, open, device: { id, model, os, versionCode, versionName }, pushToken, notify: { feed, chat, groups } }
 * Called when the app opens and when settings change. Returns the remote config and the user's status.
 */
export async function handleNativeHeartbeat(request, env) {
    const body = await request.json().catch(() => ({}));
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return json({ error: "יש להתחבר מחדש", relogin: true }, 401);
    await ensureTables(env);
    const d = body.device || {};
    const now = getIsraelTimeForDB();
    const versionName = String(d.versionName || '').slice(0, 20);

    await env.DB.prepare(`INSERT INTO app_users (phone, first_seen_at, last_seen_at, app_version, opens) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET last_seen_at = excluded.last_seen_at, app_version = excluded.app_version, opens = COALESCE(app_users.opens, 0) + ?`)
        .bind(user.phone, now, now, versionName, body.open ? 1 : 0, body.open ? 1 : 0).run();

    const pushToken = String(body.pushToken || '').trim();
    if (/^[\w:.-]{20,4096}$/.test(pushToken)) {
        const n = body.notify || {};
        const flag = v => (v === false ? 0 : 1);
        await env.DB.prepare(`INSERT INTO push_devices (token, phone, platform, app_version, created_at, last_seen_at, kind, device_id, device_model, os_version, notify_feed, notify_chat, notify_groups)
            VALUES (?, ?, 'android', ?, ?, ?, 'native', ?, ?, ?, ?, ?, ?)
            ON CONFLICT(token) DO UPDATE SET phone = excluded.phone, app_version = excluded.app_version, last_seen_at = excluded.last_seen_at, kind = 'native',
              device_id = excluded.device_id, device_model = excluded.device_model, os_version = excluded.os_version,
              notify_feed = excluded.notify_feed, notify_chat = excluded.notify_chat, notify_groups = excluded.notify_groups`)
            .bind(pushToken, user.phone, versionName, now, now, String(d.id || '').slice(0, 64), String(d.model || '').slice(0, 80), String(d.os || '').slice(0, 20),
                flag(n.feed), flag(n.chat), flag(n.groups)).run();
        // the same device with an old token (token refresh): keep only the newest
        if (d.id) await env.DB.prepare("DELETE FROM push_devices WHERE device_id = ? AND token != ?").bind(String(d.id).slice(0, 64), pushToken).run();
    }

    const row = await env.DB.prepare("SELECT blocked FROM app_users WHERE phone = ?").bind(user.phone).first();
    const config = await readConfig(env);
    const name = body.open ? await getNameFromIni(user.phone, env.YEMOT_TOKEN).catch(() => '') : undefined;
    const settings = await getSettings(env).catch(() => ({}));
    const isSuperAdmin = !!settings.super_admin_phone && settings.super_admin_phone === user.phone;
    return json({
        success: true,
        blocked: !!(row && row.blocked),
        blockedMessage: 'הגישה שלך לאפליקציה נחסמה. לפרטים אפשר לפנות לצוות עכשיו סלומון.',
        user: { phone: user.phone, name, email: user.email || '', canRecord: user.can_record !== 0, canUpload: !!user.can_upload, canListen: user.can_listen !== 0, canTzintuk: user.can_tzintuk !== 0,
            isAdmin: user.is_admin === 1 || isSuperAdmin, isSuperAdmin, adminPermissions: user.admin_permissions || '' },
        config: { ...publicConfig(config, d.versionCode, await latestAppInfo().catch(() => null)), pushConfigured: pushEnabled(env) },
    });
}

/** POST /api/app/test-push { userToken } - "send me a test notification" in the app settings. */
export async function handleNativeTestPush(request, env) {
    const body = await request.json().catch(() => ({}));
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return json({ error: "יש להתחבר מחדש" }, 401);
    const r = await pushToPhone(env, user.phone, 'עכשיו סלומון', 'ככה תיראה התראה מהאפליקציה 👋', { type: 'test' });
    if (!r.enabled) return json({ error: 'ההתראות עדיין לא הופעלו בשרת' }, 400);
    if (!r.devices) return json({ error: 'המכשיר עוד לא נרשם להתראות. נסו לסגור ולפתוח את האפליקציה.' }, 400);
    return json({ success: true, sent: r.sent });
}

/**
 * POST /api/app/poll { userToken } - background check (backup for push):
 * newest voice message id, unread chat replies and unread group messages.
 */
export async function handleNativePoll(request, env) {
    const body = await request.json().catch(() => ({}));
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return json({ error: "יש להתחבר מחדש", relogin: true }, 401);
    let feedNewest = 0;
    try {
        if (user.can_listen !== 0 && env.YEMOT_TOKEN) {
            const r = await fetch(`https://www.call2all.co.il/ym/api/GetIVR2Dir?token=${env.YEMOT_TOKEN}&path=${encodeURIComponent('ivr2:/1/2')}&filesLimit=10&filesFrom=0`);
            const d = await r.json();
            const ids = (d.files || []).filter(f => f.fileType === 'AUDIO' && /^\d+\.(wav|mp3)$/i.test(f.name)).map(f => Number(f.name.split('.')[0]));
            if (ids.length) feedNewest = Math.max(...ids);
        }
    } catch (e) {}
    const chat = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(id) AS last FROM chat_messages WHERE user_phone = ? AND sender = 'admin' AND COALESCE(is_read, 0) = 0 AND COALESCE(is_deleted, 0) = 0")
        .bind(user.phone).first().catch(() => null);
    const groups = await env.DB.prepare(`SELECT COUNT(*) AS n, MAX(x.id) AS last FROM group_members m JOIN group_messages x ON x.group_id = m.group_id
        WHERE m.member_key = ? AND m.status = 'active' AND x.id > COALESCE(m.last_read_id, 0) AND x.kind = 'msg' AND COALESCE(x.is_deleted, 0) = 0 AND x.sender_key != m.member_key`)
        .bind('u:' + user.phone).first().catch(() => null);
    return json({
        success: true,
        feedNewest,
        chatUnread: (chat && chat.n) || 0, chatLast: (chat && chat.last) || 0,
        groupsUnread: (groups && groups.n) || 0, groupsLast: (groups && groups.last) || 0,
    });
}

// ---------------------------------------------------------------- מרכז השליטה

async function requireAdmin(env, body) {
    return (await isMainAdmin(env, body.adminToken)) ? null : json({ error: 'למנהל הראשי בלבד' }, 401);
}

/** POST /api/admin/app/config { adminToken, config? } - read or save the remote settings. */
export async function handleAdminNativeConfig(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    await ensureTables(env);
    if (body.config && typeof body.config === 'object') {
        const merged = { ...(await readConfig(env)), ...cleanConfig(body.config) };
        if (body.config.features) merged.features = { ...APP_CONFIG_DEFAULTS.features, ...merged.features, ...cleanConfig(body.config).features };
        await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('native_app_config', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(JSON.stringify(merged), getIsraelTimeForDB()).run();
    }
    return json({ success: true, config: await readConfig(env), defaults: APP_CONFIG_DEFAULTS, latest: await latestAppInfo().catch(() => null) });
}

/** POST /api/admin/app/devices { adminToken } - every registered app device. */
export async function handleAdminNativeDevices(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    await ensureTables(env);
    const { results } = await env.DB.prepare(`SELECT phone, kind, device_model, os_version, app_version, created_at, last_seen_at, notify_feed, notify_chat, notify_groups
        , device_id, last_push_at, last_push_title, last_ack_at, last_ack_title, cmd_id, cmd_name, cmd_sent_at, cmd_ack_at
        FROM push_devices ORDER BY last_seen_at DESC LIMIT 3000`).all();
    const versions = {};
    for (const r of results || []) if (r.kind === 'native') versions[r.app_version || '?'] = (versions[r.app_version || '?'] || 0) + 1;
    if (body.runFeedCheck) await checkNewFeedMessages(env).catch(() => {});
    return json({ success: true, devices: results || [], versions, pushConfigured: pushEnabled(env), latest: await latestAppInfo().catch(() => null), feedStatus: await getFeedStatus(env) });
}

/** POST /api/admin/app/push { adminToken, phone?, title, body } - to one user, or to everyone in the app. */
export async function handleAdminNativePush(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const title = String(body.title || '').trim().slice(0, 80) || 'עכשיו סלומון';
    const text = String(body.body || '').trim().slice(0, 300);
    if (!text) return json({ error: 'נא לכתוב את תוכן ההתראה' }, 400);
    if (!pushEnabled(env)) return json({ error: 'ההתראות לא מוגדרות בשרת (FCM_SERVICE_ACCOUNT)' }, 400);
    const r = body.phone
        ? await pushToPhone(env, String(body.phone).replace(/\D/g, ''), title, text, { type: 'announce' })
        : await pushToAllApp(env, title, text);
    return json({ success: true, ...r });
}

/**
 * POST /api/app/ack { userToken, pushToken, pid, type, title, cmd? } - the app confirms every push it
 * received (and every remote command it ran), so the console shows whether notifications really arrive.
 */
export async function handleNativeAck(request, env) {
    const body = await request.json().catch(() => ({}));
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return json({ error: "יש להתחבר מחדש" }, 401);
    await ensureTables(env);
    const token = String(body.pushToken || '');
    const now = getIsraelTimeForDB();
    await env.DB.prepare("UPDATE push_devices SET last_ack_at = ?, last_ack_title = ? WHERE token = ? AND phone = ?")
        .bind(now, String(body.title || body.type || '').slice(0, 80), token, user.phone).run();
    if (body.cmd) {
        await env.DB.prepare("UPDATE push_devices SET cmd_ack_at = ? WHERE token = ? AND phone = ? AND cmd_id = ?")
            .bind(now, token, user.phone, String(body.cmd)).run();
    }
    return json({ success: true });
}

const COMMANDS = {
    ping: 'בדיקת התראה', restart: 'הפעלה מחדש', refresh: 'רענון הגדרות', logout: 'ניתוק המכשיר', update: 'בקשת עדכון',
};

/**
 * POST /api/admin/app/command { adminToken, deviceId | phone, command } - a remote command to one device
 * (or every device of a user). The app runs it and acks, so the console sees "received ✓".
 */
export async function handleAdminNativeCommand(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    await ensureTables(env);
    const command = String(body.command || '');
    if (!COMMANDS[command]) return json({ error: 'פקודה לא מוכרת' }, 400);
    if (!pushEnabled(env)) return json({ error: 'ההתראות לא מוגדרות בשרת (FCM_SERVICE_ACCOUNT)' }, 400);
    const { results } = body.deviceId
        ? await env.DB.prepare("SELECT token FROM push_devices WHERE kind = 'native' AND device_id = ?").bind(String(body.deviceId)).all()
        : await env.DB.prepare("SELECT token FROM push_devices WHERE kind = 'native' AND phone = ?").bind(String(body.phone || '').replace(/\D/g, '')).all();
    if (!results || !results.length) return json({ error: 'המכשיר לא נמצא או שאינו רשום להתראות' }, 404);
    const now = getIsraelTimeForDB();
    let sent = 0;
    for (const r of results) {
        const cid = crypto.randomUUID().slice(0, 12);
        await env.DB.prepare("UPDATE push_devices SET cmd_id = ?, cmd_name = ?, cmd_sent_at = ?, cmd_ack_at = NULL WHERE token = ?").bind(cid, command, now, r.token).run();
        const ok = await sendOne(env, r.token, {
            title: command === 'ping' ? 'בדיקת התראה ✓' : COMMANDS[command],
            body: command === 'ping' ? 'ההתראה הגיעה. אפשר להתעלם מההודעה.' : '',
            tag: 'salamon-cmd', type: 'command', extra: { cmd: command, cid },
        });
        if (ok) sent++;
    }
    return json({ success: true, sent, devices: results.length, label: COMMANDS[command] });
}
