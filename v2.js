// v2.js
// שירותים לגרסה החדשה של האתר (/salamon/v2): הגדרות כלליות של הגרסה, העדפות אישיות שמסונכרנות בין מכשירים,
// וקהל ההודעה (מי ראה ומי שמע) למנהל-העל מתוך האתר עצמו.

import { authenticateUser } from './auth.js';
import { isMainAdmin, sessionExpired } from './adminAuth.js';
import { getSettings, setSettings } from './schema.js';
import { getIsraelTimeForDB, getFutureIsraelTimeForDB } from './timeUtils.js';
import { buildAudience } from './voice.js';

const V2_DEFAULTS = {
    v2_mode: 'all',            // all / staff / off
    v2_show_switch: '1',       // כפתור "לגרסה החדשה" באתר הוותיק
    v2_banner: '',             // הודעה בראש הגרסה החדשה
    v2_banner_tone: 'info',    // info / warn / good
    v2_default_theme: 'system',
    v2_default_accent: 'green',
    v2_chat_welcome: '',
    v2_off_message: '',
};

const ACCENTS = ['green', 'blue', 'violet', 'rose', 'orange', 'teal', 'slate'];
const THEMES = ['system', 'light', 'dark'];

// העדפות אישיות: רק מפתחות מוכרים, עם בדיקת סוג וטווח
const PREF_RULES = {
    theme: v => THEMES.includes(v) ? v : undefined,
    accent: v => ACCENTS.includes(v) ? v : undefined,
    fontScale: v => (typeof v === 'number' && v >= 0.85 && v <= 1.3) ? Math.round(v * 100) / 100 : undefined,
    density: v => ['comfortable', 'compact'].includes(v) ? v : undefined,
    reduceMotion: v => typeof v === 'boolean' ? v : undefined,
    playbackRate: v => [0.75, 1, 1.25, 1.5, 1.75, 2].includes(v) ? v : undefined,
    skipSeconds: v => [5, 10, 15, 30].includes(v) ? v : undefined,
    autoplayNext: v => typeof v === 'boolean' ? v : undefined,
    rememberPosition: v => typeof v === 'boolean' ? v : undefined,
    hideHeard: v => typeof v === 'boolean' ? v : undefined,
    showStats: v => typeof v === 'boolean' ? v : undefined,
    notifyNewMessages: v => typeof v === 'boolean' ? v : undefined,
    notifyChat: v => typeof v === 'boolean' ? v : undefined,
    sounds: v => typeof v === 'boolean' ? v : undefined,
    haptics: v => typeof v === 'boolean' ? v : undefined,
    confirmSend: v => typeof v === 'boolean' ? v : undefined,
    tzintukPrompt: v => typeof v === 'boolean' ? v : undefined,
    startTab: v => ['feed', 'chat', 'settings'].includes(v) ? v : undefined,
    feedFilter: v => ['all', 'unheard', 'mine', 'web', 'phone'].includes(v) ? v : undefined,
    quietStart: v => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) ? v : (v === '' ? '' : undefined),
    quietEnd: v => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) ? v : (v === '' ? '' : undefined),
};

export function sanitizePrefs(input = {}) {
    const out = {};
    for (const [k, rule] of Object.entries(PREF_RULES)) {
        if (!(k in input)) continue;
        const v = rule(input[k]);
        if (v !== undefined) out[k] = v;
    }
    return out;
}

async function v2Settings(env) {
    const s = await getSettings(env);
    const out = {};
    for (const k of Object.keys(V2_DEFAULTS)) out[k] = s[k] !== undefined && s[k] !== null && s[k] !== '' ? s[k] : V2_DEFAULTS[k];
    // הודעה ריקה היא ערך לגיטימי
    for (const k of ['v2_banner', 'v2_chat_welcome', 'v2_off_message']) out[k] = s[k] || '';
    return out;
}

function allowedFor(mode, user) {
    if (mode === 'off') return false;
    if (mode === 'staff') return !!user && (user.is_admin === 1);
    return true;
}

async function isSuperAdmin(env, phone) {
    const s = await getSettings(env);
    return !!s.super_admin_phone && s.super_admin_phone === phone;
}

// הגדרות הגרסה החדשה (גם בלי התחברות - כדי להציג מסך מתאים)
export async function handleV2Config(request, env) {
    const body = await request.json().catch(() => ({}));
    const s = await v2Settings(env);
    let user = null;
    if (body.userToken) user = await authenticateUser(env.DB, body.userToken);
    const superAdmin = user ? await isSuperAdmin(env, user.phone) : false;
    const allowed = allowedFor(s.v2_mode, user) || superAdmin;
    return Response.json({
        success: true,
        mode: s.v2_mode,
        allowed: user ? allowed : s.v2_mode !== 'off',
        showSwitch: s.v2_show_switch === '1' && (user ? allowed : s.v2_mode === 'all'),
        banner: s.v2_banner ? { text: s.v2_banner, tone: s.v2_banner_tone } : null,
        offMessage: s.v2_off_message || '',
        chatWelcome: s.v2_chat_welcome || '',
        defaults: { theme: s.v2_default_theme, accent: s.v2_default_accent },
    });
}

// העדפות אישיות: קריאה, ושמירה (מיזוג) כשנשלח prefs
export async function handleV2Prefs(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!body.userToken) return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return Response.json({ error: "החיבור פג תוקף, יש להתחבר מחדש" }, { status: 401 });

    const now = getIsraelTimeForDB();
    const row = await env.DB.prepare("SELECT prefs FROM user_prefs WHERE phone = ?").bind(user.phone).first();
    let prefs = {};
    try { prefs = row && row.prefs ? JSON.parse(row.prefs) : {}; } catch (e) { prefs = {}; }
    prefs = sanitizePrefs(prefs);

    if (body.prefs && typeof body.prefs === 'object') {
        prefs = { ...prefs, ...sanitizePrefs(body.prefs) };
    }
    if (body.prefs || body.open) {
        await env.DB.prepare(`INSERT INTO user_prefs (phone, prefs, updated_at, last_v2_at, v2_opens) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(phone) DO UPDATE SET prefs = excluded.prefs, updated_at = CASE WHEN ? THEN excluded.updated_at ELSE user_prefs.updated_at END,
            last_v2_at = CASE WHEN ? THEN excluded.last_v2_at ELSE user_prefs.last_v2_at END, v2_opens = COALESCE(user_prefs.v2_opens, 0) + ?`)
            .bind(user.phone, JSON.stringify(prefs), now, now, body.open ? 1 : 0, body.prefs ? 1 : 0, body.open ? 1 : 0, body.open ? 1 : 0).run();
    }
    return Response.json({ success: true, prefs });
}

// "מי ראה ומי שמע" להודעה - מנהל-העל בלבד
export async function handleV2Audience(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!body.userToken) return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return Response.json({ error: "החיבור פג תוקף, יש להתחבר מחדש" }, { status: 401 });
    if (!(await isSuperAdmin(env, user.phone))) return Response.json({ error: "המידע הזה זמין למנהל-העל בלבד" }, { status: 403 });
    const fileId = String(body.fileId || '');
    if (!/^\d+$/.test(fileId)) return Response.json({ error: "מזהה הודעה לא חוקי" }, { status: 400 });
    return Response.json({ success: true, ...(await buildAudience(env, fileId, false)) });
}

// ---------- מרכז השליטה ----------

export async function handleAdminV2Settings(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await isMainAdmin(env, body.adminToken))) return body.adminToken ? sessionExpired() : Response.json({ error: "לא מורשה" }, { status: 401 });

    if (body.settings && typeof body.settings === 'object') {
        const i = body.settings;
        const values = {};
        if (['all', 'staff', 'off'].includes(i.v2_mode)) values.v2_mode = i.v2_mode;
        if (i.v2_show_switch !== undefined) values.v2_show_switch = i.v2_show_switch ? '1' : '0';
        if (i.v2_banner !== undefined) values.v2_banner = String(i.v2_banner || '').slice(0, 300);
        if (['info', 'warn', 'good'].includes(i.v2_banner_tone)) values.v2_banner_tone = i.v2_banner_tone;
        if (THEMES.includes(i.v2_default_theme)) values.v2_default_theme = i.v2_default_theme;
        if (ACCENTS.includes(i.v2_default_accent)) values.v2_default_accent = i.v2_default_accent;
        if (i.v2_chat_welcome !== undefined) values.v2_chat_welcome = String(i.v2_chat_welcome || '').slice(0, 300);
        if (i.v2_off_message !== undefined) values.v2_off_message = String(i.v2_off_message || '').slice(0, 300);
        await setSettings(env, values, getIsraelTimeForDB());
    }

    const since7 = getFutureIsraelTimeForDB(-7 * 24 * 60);
    const since30 = getFutureIsraelTimeForDB(-30 * 24 * 60);
    const [w, m, total, prefs] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) c FROM user_prefs WHERE last_v2_at >= ?").bind(since7).first(),
        env.DB.prepare("SELECT COUNT(*) c FROM user_prefs WHERE last_v2_at >= ?").bind(since30).first(),
        env.DB.prepare("SELECT COUNT(*) c, SUM(COALESCE(v2_opens, 0)) o FROM user_prefs WHERE last_v2_at IS NOT NULL").first(),
        env.DB.prepare("SELECT prefs FROM user_prefs WHERE last_v2_at IS NOT NULL ORDER BY last_v2_at DESC LIMIT 500").all(),
    ]);
    const themes = {};
    for (const r of prefs.results || []) {
        let p = {}; try { p = JSON.parse(r.prefs || '{}'); } catch (e) {}
        const t = p.theme || 'system';
        themes[t] = (themes[t] || 0) + 1;
    }
    const { results: recent } = await env.DB.prepare("SELECT phone, last_v2_at, v2_opens FROM user_prefs WHERE last_v2_at IS NOT NULL ORDER BY last_v2_at DESC LIMIT 12").all();
    return Response.json({
        success: true, settings: await v2Settings(env),
        usage: { week: w.c || 0, month: m.c || 0, total: total.c || 0, opens: total.o || 0, themes, recent: recent || [] },
        accents: ACCENTS,
    });
}
