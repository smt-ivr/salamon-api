// app.js
// אפליקציית האנדרואיד: מי משתמש בה, חסימה לפי משתמש, ספירת הורדות, ומסך הניהול במרכז השליטה.
//
// - כל פתיחה של האתר מתוך האפליקציה (אחרי כניסה) מדווחת ל-/api/app/hello ונשמרת ב-app_users.
// - משתמש חסום: כל בקשה שמגיעה מהאפליקציה עם הטוקן שלו נדחית (ראו appBlockGuard ב-worker.js),
//   והוא לא מקבל התראות. באתר הרגיל בדפדפן הוא ממשיך כרגיל.
// - הורדות: smti.uk/salamon/app/download מגיע ל-/api/app/download, שסופר ומגיש את הקובץ מ-smti.uk עצמו
//   (דפדפנים מסוננים חוסמים לעתים קרובות את github.com).

import { authenticateUser } from './auth.js';
import { isMainAdmin } from './adminAuth.js';
import { getIsraelTimeForDB, getFutureIsraelTimeForDB } from './timeUtils.js';
import { getAllNamesFromIni } from './yemot.js';

const APK_URL = 'https://github.com/smt-ivr/salamon/releases/download/android/salamon.apk';
const BLOCK_MESSAGE = 'הגישה שלך לאפליקציה נחסמה. לפרטים אפשר לפנות לצוות עכשיו סלומון.';

function json(data, status = 200) { return Response.json(data, { status }); }

let ready = false;
export async function ensureTables(env) {
    if (ready) return;
    await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_users (
            phone TEXT PRIMARY KEY,
            first_seen_at TEXT,
            last_seen_at TEXT,
            app_version TEXT,
            opens INTEGER DEFAULT 0,
            blocked INTEGER DEFAULT 0,
            blocked_note TEXT,
            blocked_at TEXT
        )`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL,
            country TEXT,
            device TEXT
        )`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_app_downloads_at ON app_downloads (at)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_devices (token TEXT PRIMARY KEY, phone TEXT NOT NULL, platform TEXT DEFAULT 'android', app_version TEXT, created_at TEXT, last_seen_at TEXT)`),
    ]);
    // device details for the dedicated app (also added by schema.js; done here so the app never depends on it)
    const cols = new Set(((await env.DB.prepare("PRAGMA table_info(push_devices)").all()).results || []).map(c => c.name));
    const want = [['kind', "TEXT DEFAULT 'web'"], ['device_id', 'TEXT'], ['device_model', 'TEXT'], ['os_version', 'TEXT'],
        ['notify_feed', 'INTEGER DEFAULT 1'], ['notify_chat', 'INTEGER DEFAULT 1'], ['notify_groups', 'INTEGER DEFAULT 1']];
    for (const [name, type] of want) {
        if (!cols.has(name)) await env.DB.prepare(`ALTER TABLE push_devices ADD COLUMN ${name} ${type}`).run().catch(() => {});
    }
    ready = true;
}

// ---------------------------------------------------------------- מהאפליקציה

/** POST /api/app/hello { userToken, version } - נקרא מהאתר כשהוא רץ בתוך האפליקציה. */
export async function handleAppHello(request, env) {
    const body = await request.json().catch(() => ({}));
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return json({ error: "הרשאות משתמש לא חוקיות" }, 403);
    await ensureTables(env);
    const now = getIsraelTimeForDB();
    const version = String(body.version || '').slice(0, 20);
    await env.DB.prepare(`INSERT INTO app_users (phone, first_seen_at, last_seen_at, app_version, opens) VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(phone) DO UPDATE SET last_seen_at = excluded.last_seen_at, app_version = excluded.app_version, opens = COALESCE(app_users.opens, 0) + 1`)
        .bind(user.phone, now, now, version).run();
    const row = await env.DB.prepare("SELECT blocked FROM app_users WHERE phone = ?").bind(user.phone).first();
    const blocked = !!(row && row.blocked);
    return json({ success: true, blocked, message: blocked ? BLOCK_MESSAGE : '' });
}

/**
 * The APK, served from smti.uk itself (filtered browsers often block github.com).
 * Cached at the edge for a few minutes so a new version shows up quickly.
 */
async function fetchApk(ctx) {
    const cache = caches.default;
    const key = new Request('https://smti.uk/salamon/api/app/__apk-cache');
    let res = await cache.match(key);
    if (!res) {
        const gh = await fetch(APK_URL, { redirect: 'follow', headers: { 'user-agent': 'salamon-app-download' } });
        if (!gh.ok) return null;
        const body = await gh.arrayBuffer();
        res = new Response(body, { headers: { 'content-type': 'application/vnd.android.package-archive', 'cache-control': 'public, max-age=300' } });
        const put = cache.put(key, res.clone());
        if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
    }
    return res;
}

/** Latest published version (version.json next to the APK), cached at the edge for 10 minutes. */
export async function latestAppInfo(ctx) {
    const cache = caches.default;
    const key = new Request('https://smti.uk/salamon/api/app/__info-cache');
    const hit = await cache.match(key);
    if (hit) { try { return await hit.json(); } catch (e) {} }
    let info = null;
    try {
        const r = await fetch(APK_URL.replace('salamon.apk', 'version.json'), { redirect: 'follow', headers: { 'user-agent': 'salamon-app-info' } });
        if (r.ok) {
            const d = await r.json();
            info = { version: String(d.version || ''), versionCode: Number(d.versionCode) || 0, size: Number(d.size) || 0, updatedAt: String(d.updatedAt || '') };
        }
    } catch (e) {}
    const out = { success: true, ...(info || { version: '', versionCode: 0, size: 0, updatedAt: '' }) };
    const res = Response.json(out, { headers: { 'cache-control': `public, max-age=${info ? 600 : 60}` } });
    const put = cache.put(key, res);
    if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
    return out;
}

/** GET /api/app/info - version, size and date of the current APK (for the download page). */
export async function handleAppInfo(request, env, ctx) {
    const info = await latestAppInfo(ctx);
    return Response.json(info, { headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } });
}

/** GET /api/app/download - counts the download and serves the current APK from smti.uk. */
export async function handleAppDownload(request, env, ctx) {
    const log = (async () => {
        await ensureTables(env);
        const ua = request.headers.get('user-agent') || '';
        const device = /android/i.test(ua) ? 'android' : /iphone|ipad/i.test(ua) ? 'ios' : 'computer';
        await env.DB.prepare("INSERT INTO app_downloads (at, country, device) VALUES (?, ?, ?)")
            .bind(getIsraelTimeForDB(), (request.cf && request.cf.country) || '', device).run();
    })().catch(e => console.error('app download log', e.message));
    if (ctx && ctx.waitUntil) ctx.waitUntil(log); else await log;
    const apk = await fetchApk(ctx).catch(() => null);
    if (!apk) return Response.redirect(APK_URL, 302); // fallback: straight to GitHub
    return new Response(apk.body, {
        headers: {
            'content-type': 'application/vnd.android.package-archive',
            'content-disposition': 'attachment; filename="salamon.apk"',
            'cache-control': 'no-store',
        },
    });
}

/**
 * חסימה בפועל: בקשה שמגיעה מהאפליקציה (לפי ה-User-Agent) עם טוקן של משתמש חסום נדחית.
 * מחזיר Response לדחייה, או null כדי להמשיך כרגיל.
 */
export async function appBlockGuard(request, env) {
    const ua = request.headers.get('user-agent') || '';
    if (!ua.includes('SalamonApp/') || request.method !== 'POST') return null;
    if (!(request.headers.get('content-type') || '').includes('application/json')) return null;
    let token = '';
    try { token = (await request.clone().json()).userToken || ''; } catch (e) { return null; }
    if (!token) return null;
    try {
        await ensureTables(env);
        const row = await env.DB.prepare(
            "SELECT a.blocked FROM user_tokens t JOIN app_users a ON a.phone = t.phone WHERE t.id = ?"
        ).bind(token).first();
        if (row && row.blocked) return json({ error: BLOCK_MESSAGE, appBlocked: true }, 403);
    } catch (e) {
        console.error('app guard', e.message);
    }
    return null;
}

/** טלפונים חסומים באפליקציה (כדי לא לשלוח אליהם התראות). */
export async function blockedAppPhones(env, phones) {
    if (!phones.length) return new Set();
    await ensureTables(env);
    const out = new Set();
    for (let i = 0; i < phones.length; i += 50) {
        const part = phones.slice(i, i + 50);
        const { results } = await env.DB.prepare(`SELECT phone FROM app_users WHERE blocked = 1 AND phone IN (${part.map(() => '?').join(',')})`).bind(...part).all();
        (results || []).forEach(r => out.add(r.phone));
    }
    return out;
}

// ---------------------------------------------------------------- מרכז השליטה

async function requireAdmin(env, body) {
    return (await isMainAdmin(env, body.adminToken)) ? null : json({ error: 'למנהל הראשי בלבד' }, 401);
}

/** POST /api/admin/app { adminToken } - נתונים למסך "אפליקציה". */
export async function handleAdminApp(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    await ensureTables(env);
    const weekAgo = getFutureIsraelTimeForDB(-7 * 24 * 60);
    const monthAgo = getFutureIsraelTimeForDB(-30 * 24 * 60);

    const { results: users } = await env.DB.prepare(`SELECT a.*, u.email,
            (SELECT COUNT(*) FROM push_devices d WHERE d.phone = a.phone) AS devices
        FROM app_users a LEFT JOIN users u ON u.phone = a.phone ORDER BY a.last_seen_at DESC LIMIT 2000`).all();
    const dl = await env.DB.prepare(`SELECT COUNT(*) AS total,
            SUM(CASE WHEN at > ? THEN 1 ELSE 0 END) AS week,
            SUM(CASE WHEN device = 'android' THEN 1 ELSE 0 END) AS android
        FROM app_downloads`).bind(weekAgo).first();
    const { results: days } = await env.DB.prepare(`SELECT substr(at, 1, 10) AS day, COUNT(*) AS n FROM app_downloads WHERE at > ? GROUP BY day ORDER BY day`).bind(monthAgo).all();

    let names = {};
    try { if (env.YEMOT_TOKEN && users && users.length) names = await getAllNamesFromIni(env.YEMOT_TOKEN) || {}; } catch (e) {}

    const list = (users || []).map(u => ({
        phone: u.phone,
        name: names[u.phone] || '',
        email: u.email || '',
        version: u.app_version || '',
        firstSeen: u.first_seen_at,
        lastSeen: u.last_seen_at,
        opens: u.opens || 0,
        push: (u.devices || 0) > 0,
        blocked: !!u.blocked,
        note: u.blocked_note || '',
    }));
    return json({
        success: true,
        downloadUrl: 'https://smti.uk/salamon/app',
        pushConfigured: !!env.FCM_SERVICE_ACCOUNT,
        stats: {
            users: list.length,
            activeWeek: list.filter(u => u.lastSeen && u.lastSeen > weekAgo).length,
            blocked: list.filter(u => u.blocked).length,
            withPush: list.filter(u => u.push).length,
            downloads: (dl && dl.total) || 0,
            downloadsWeek: (dl && dl.week) || 0,
        },
        days: days || [],
        users: list,
    });
}

/** POST /api/admin/app/block { adminToken, phone, blocked, note } */
export async function handleAdminAppBlock(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const phone = String(body.phone || '').replace(/\D/g, '');
    if (!phone) return json({ error: 'חסר מספר טלפון' }, 400);
    await ensureTables(env);
    const now = getIsraelTimeForDB();
    const blocked = body.blocked ? 1 : 0;
    await env.DB.prepare(`INSERT INTO app_users (phone, first_seen_at, last_seen_at, opens, blocked, blocked_note, blocked_at) VALUES (?, NULL, NULL, 0, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET blocked = excluded.blocked, blocked_note = excluded.blocked_note, blocked_at = excluded.blocked_at`)
        .bind(phone, blocked, blocked ? String(body.note || '').slice(0, 200) : null, blocked ? now : null).run();
    // חסום לא מקבל התראות: מוחקים את המכשירים שלו (יירשמו מחדש אם יבוטל החסימה וייכנס שוב)
    if (blocked) await env.DB.prepare("DELETE FROM push_devices WHERE phone = ?").bind(phone).run();
    return json({ success: true });
}
