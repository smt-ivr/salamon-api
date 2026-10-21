// groups.js
// צ'אט קבוצתי (כמו גוגל צ'אט), נפרד לגמרי מצ'אט התמיכה מול ההנהלה.
// כל קבוצה מוגדרת בנפרד: מי רואה ומצטרף, אורחים מבחוץ (בקישור הזמנה), מי כותב, קבצים, שעות פעילות, השהיה בין הודעות,
// והרשאות המפקחים. משתתפים: משתמשי האתר (u:<טלפון>), אורחים מבחוץ (g:<מזהה>), והמנהל הראשי (admin).

import { authenticateUser } from './auth.js';
import { isMainAdmin } from './adminAuth.js';
import { getIsraelTimeForDB, getFutureIsraelTimeForDB, isPastIsraelTime } from './timeUtils.js';
import { getNameFromIni } from './yemot.js';
import { getSettings, setSettings } from './schema.js';
import { readUpload, storeFile, storeThumb, removeFiles, typeOf } from './chatFiles.js';

const MAX_TEXT_DEFAULT = 2000;
const PAGE = 80;
const TYPING_SECONDS = 7;
const ADMIN_NAME = 'צוות עכשיו סלומון';
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// ---------- הגדרות קבוצה ----------

export const GROUP_DEFAULTS = {
    visibility: 'private',          // private: רק מי שצורף | public: כל משתמשי האתר רואים ומצטרפים | request: רואים ומבקשים להצטרף
    userApproval: false,            // משתמשי אתר שמצטרפים (ציבורי/הזמנה) צריכים אישור מפקח
    allowGuests: false,             // אורחים מבחוץ, רק דרך קישור הזמנה
    guestApproval: true,            // אורח צריך אישור מפקח לפני שהוא רואה את הקבוצה
    guestPhoneRequired: true,       // אורח חייב להזין טלפון
    whoCanPost: 'all',              // all | moderators (ערוץ הודעות)
    guestsCanPost: true,
    allowFiles: true,
    guestsCanSendFiles: false,
    maxFileMb: 20,
    slowModeSeconds: 0,
    maxMessageLength: MAX_TEXT_DEFAULT,
    allowEditOwn: true,
    allowDeleteOwn: true,
    allowReplies: true,
    showMembers: 'all',             // all | moderators - מי רואה את רשימת החברים
    showReadCount: true,            // "נקרא ע״י X"
    hours: { enabled: false, mode: 'readonly', exemptModerators: true, days: [0, 1, 2, 3, 4, 5, 6].map(d => ({ on: d !== 6, from: '08:00', to: '22:00' })) },
    moderatorPerms: { approve: true, remove: true, ban: true, mute: true, deleteMessages: true, pin: true, invites: true, editSettings: false, seePhones: true },
    welcome: '',
};

function bool(v, d) { return v === undefined ? d : !!v; }
function pick(v, list, d) { return list.includes(v) ? v : d; }
function num(v, min, max, d) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; }
function hhmm(v, d) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? v : d; }

export function cleanGroupSettings(input = {}, base = GROUP_DEFAULTS) {
    const s = { ...GROUP_DEFAULTS, ...base };
    const i = input || {};
    const out = {
        visibility: pick(i.visibility ?? s.visibility, ['private', 'public', 'request'], 'private'),
        userApproval: bool(i.userApproval, s.userApproval),
        allowGuests: bool(i.allowGuests, s.allowGuests),
        guestApproval: bool(i.guestApproval, s.guestApproval),
        guestPhoneRequired: bool(i.guestPhoneRequired, s.guestPhoneRequired),
        whoCanPost: pick(i.whoCanPost ?? s.whoCanPost, ['all', 'moderators'], 'all'),
        guestsCanPost: bool(i.guestsCanPost, s.guestsCanPost),
        allowFiles: bool(i.allowFiles, s.allowFiles),
        guestsCanSendFiles: bool(i.guestsCanSendFiles, s.guestsCanSendFiles),
        maxFileMb: num(i.maxFileMb ?? s.maxFileMb, 1, 20, 20),
        slowModeSeconds: num(i.slowModeSeconds ?? s.slowModeSeconds, 0, 3600, 0),
        maxMessageLength: num(i.maxMessageLength ?? s.maxMessageLength, 50, 4000, MAX_TEXT_DEFAULT),
        allowEditOwn: bool(i.allowEditOwn, s.allowEditOwn),
        allowDeleteOwn: bool(i.allowDeleteOwn, s.allowDeleteOwn),
        allowReplies: bool(i.allowReplies, s.allowReplies),
        showMembers: pick(i.showMembers ?? s.showMembers, ['all', 'moderators'], 'all'),
        showReadCount: bool(i.showReadCount, s.showReadCount),
        welcome: String(i.welcome ?? s.welcome ?? '').slice(0, 1000),
    };
    const h = i.hours || {}, bh = s.hours || GROUP_DEFAULTS.hours;
    out.hours = {
        enabled: bool(h.enabled, bh.enabled),
        mode: pick(h.mode ?? bh.mode, ['readonly', 'closed'], 'readonly'),
        exemptModerators: bool(h.exemptModerators, bh.exemptModerators),
        days: [0, 1, 2, 3, 4, 5, 6].map(d => {
            const x = (h.days || [])[d] || {}, b = (bh.days || [])[d] || GROUP_DEFAULTS.hours.days[d];
            return { on: bool(x.on, b.on), from: hhmm(x.from ?? b.from, '08:00'), to: hhmm(x.to ?? b.to, '22:00') };
        }),
    };
    const mp = i.moderatorPerms || {}, bmp = s.moderatorPerms || GROUP_DEFAULTS.moderatorPerms;
    out.moderatorPerms = {};
    for (const k of Object.keys(GROUP_DEFAULTS.moderatorPerms)) out.moderatorPerms[k] = bool(mp[k], bmp[k] ?? GROUP_DEFAULTS.moderatorPerms[k]);
    return out;
}

function parseSettings(raw) {
    try { return cleanGroupSettings(JSON.parse(raw || '{}'), GROUP_DEFAULTS); } catch (e) { return cleanGroupSettings({}); }
}

// שעות פעילות לפי שעון ישראל
function hoursState(settings) {
    const h = settings.hours;
    if (!h || !h.enabled) return { open: true };
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(p => [p.type, p.value]));
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    const now = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
    const d = h.days[day] || {};
    const open = !!d.on && (d.from <= d.to ? now >= d.from && now < d.to : now >= d.from || now < d.to);
    // מתי נפתח הבא
    let next = '';
    if (!open) {
        for (let k = 0; k < 8; k++) {
            const dd = h.days[(day + k) % 7];
            if (!dd || !dd.on) continue;
            if (k === 0 && now >= dd.from) continue;
            next = `${k === 0 ? 'היום' : k === 1 ? 'מחר' : `ביום ${DAYS[(day + k) % 7]}`} ב-${dd.from}`;
            break;
        }
    }
    return { open, mode: h.mode, next, today: d.on ? `${d.from}–${d.to}` : 'סגור היום' };
}

// ---------- זהות ----------

async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomId(bytes = 16) { return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join(''); }

// מי מבקש: מנהל ראשי, משתמש אתר, או אורח
async function actorOf(env, body) {
    if (body.adminToken && await isMainAdmin(env, body.adminToken)) return { type: 'admin', key: 'admin', name: ADMIN_NAME };
    if (body.userToken) {
        const u = await authenticateUser(env.DB, body.userToken);
        if (u) return { type: 'user', key: 'u:' + u.phone, phone: u.phone, master: !!u.is_master, token: body.userToken };
    }
    if (body.guestToken) {
        const g = await env.DB.prepare("SELECT * FROM group_guests WHERE token_hash = ?").bind(await sha256(String(body.guestToken))).first();
        if (g && !g.blocked) {
            await env.DB.prepare("UPDATE group_guests SET last_seen_at = ? WHERE id = ?").bind(getIsraelTimeForDB(), g.id).run().catch(() => {});
            return { type: 'guest', key: 'g:' + g.id, guestId: g.id, name: g.name, phone: g.phone || '' };
        }
        if (g && g.blocked) return { type: 'blocked' };
    }
    return null;
}

async function displayNameFor(env, actor) {
    if (actor.type === 'admin') return ADMIN_NAME;
    if (actor.type === 'guest') return actor.name;
    const row = await env.DB.prepare("SELECT display_name FROM group_members WHERE member_key = ? AND display_name IS NOT NULL AND display_name != '' LIMIT 1").bind(actor.key).first();
    if (row) return row.display_name;
    const n = await getNameFromIni(actor.phone, env.YEMOT_TOKEN).catch(() => null);
    return n || `משתמש ${String(actor.phone).slice(-4)}`;
}

function json(data, status = 200) { return Response.json(data, { status }); }
function err(msg, status = 400, extra = {}) { return Response.json({ error: msg, ...extra }, { status }); }

async function featureOn(env) {
    const s = await getSettings(env);
    return s.groups_enabled !== '0';
}

// ---------- הרשאות ----------

async function loadGroup(env, id) {
    const g = await env.DB.prepare("SELECT * FROM chat_groups WHERE id = ?").bind(Number(id) || 0).first();
    if (!g) return null;
    g.settings = parseSettings(g.settings);
    return g;
}

async function loadMember(env, groupId, key) {
    return env.DB.prepare("SELECT * FROM group_members WHERE group_id = ? AND member_key = ?").bind(groupId, key).first();
}

function isBanned(m) { return m && (m.status === 'banned' || (m.banned_until && !isPastIsraelTime(m.banned_until))); }
function isMuted(m) { return m && m.muted_until && !isPastIsraelTime(m.muted_until); }

// כל מה שהמשתתף רשאי לעשות בקבוצה
function permsFor(actor, member, group) {
    const s = group.settings, mp = s.moderatorPerms;
    if (actor.type === 'admin') {
        const all = { read: true, post: true, files: s.allowFiles || true, reply: true, editOwn: true, deleteOwn: true, moderator: true, admin: true, seeMembers: true };
        for (const k of Object.keys(mp)) all[k] = true;
        return { ...all, hours: hoursState(s) };
    }
    const none = { read: false, post: false };
    if (!member || group.archived) return none;
    if (member.status !== 'active' || isBanned(member)) return { ...none, status: isBanned(member) ? 'banned' : member.status };
    const mod = member.role === 'moderator';
    const guest = member.member_key.startsWith('g:');
    const hrs = hoursState(s);
    const exempt = mod && s.hours.exemptModerators;
    const closed = !hrs.open && !exempt;
    if (closed && s.hours.mode === 'closed') return { ...none, status: 'closed', hours: hrs };
    let post = !closed && !isMuted(member) && (s.whoCanPost === 'all' || mod) && (!guest || s.guestsCanPost || mod);
    const p = {
        read: true, post, files: post && s.allowFiles && (!guest || s.guestsCanSendFiles || mod), reply: s.allowReplies,
        editOwn: s.allowEditOwn, deleteOwn: s.allowDeleteOwn, moderator: mod, admin: false,
        seeMembers: s.showMembers === 'all' || mod, muted: isMuted(member) ? member.muted_until : null, hours: hrs, guest,
    };
    for (const k of Object.keys(mp)) p[k] = mod && !!mp[k];
    return p;
}

async function access(env, body, groupId) {
    if (!(await featureOn(env))) return { error: err('הצ\'אט הקבוצתי כבוי כרגע', 503) };
    const actor = await actorOf(env, body);
    if (!actor) return { error: err('יש להתחבר', 401) };
    if (actor.type === 'blocked') return { error: err('הגישה שלך נחסמה', 403) };
    if (groupId === undefined) return { actor };
    const group = await loadGroup(env, groupId);
    if (!group) return { error: err('הקבוצה לא נמצאה', 404) };
    const member = actor.type === 'admin' ? null : await loadMember(env, group.id, actor.key);
    const perms = permsFor(actor, member, group);
    return { actor, group, member, perms };
}

async function log(env, groupId, actor, action, target = '', details = '') {
    const name = actor.type === 'admin' ? ADMIN_NAME : (actor.displayName || actor.name || actor.phone || '');
    await env.DB.prepare("INSERT INTO group_log (group_id, actor, actor_name, action, target, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(groupId, actor.key, name, action, target, String(details || '').slice(0, 500), getIsraelTimeForDB()).run().catch(() => {});
}

async function systemMessage(env, groupId, text) {
    const now = getIsraelTimeForDB();
    const r = await env.DB.prepare("INSERT INTO group_messages (group_id, sender_key, sender_name, text, kind, created_at) VALUES (?, 'system', '', ?, 'system', ?)").bind(groupId, text, now).run();
    await env.DB.prepare("UPDATE chat_groups SET last_message_id = ?, updated_at = ? WHERE id = ?").bind(r.meta.last_row_id, now, groupId).run();
}

// ---------- קבצים בקבוצה: קישור חתום ומוגבל בזמן (גם לאורחים, שאין להם עוגיית אתר) ----------

let signKey = null;
async function signingKey(env) {
    if (signKey) return signKey;
    let row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'file_link_secret'").first();
    if (!row || !row.value) {
        await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('file_link_secret', ?, ?) ON CONFLICT(key) DO NOTHING").bind(randomId(32), getIsraelTimeForDB()).run();
        row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'file_link_secret'").first();
    }
    signKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(row.value), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return signKey;
}
async function sig(env, id, kind, exp) {
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), new TextEncoder().encode(`grp.${id}.${kind}.${exp}`)));
    return btoa(String.fromCharCode(...mac.subarray(0, 18))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function apiBase(request) {
    const u = new URL(request.url);
    const i = u.pathname.indexOf('/api/');
    return u.origin + (i >= 0 ? u.pathname.slice(0, i) : '') + '/api';
}
async function fileLinks(env, request, row) {
    const exp = Math.ceil((Date.now() / 1000 + 6 * 3600) / 3600) * 3600;
    const base = apiBase(request);
    const out = { url: `${base}/groups/f/${row.id}/f/${exp}/${await sig(env, row.id, 'f', exp)}` };
    if (row.file_thumb_key) out.thumbUrl = `${base}/groups/f/${row.id}/t/${exp}/${await sig(env, row.id, 't', exp)}`;
    return out;
}

export async function handleGroupFileGet(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/\/api\/groups\/f\/(\d+)\/(f|t)\/(\d+)\/([A-Za-z0-9_-]{20,40})$/);
    if (!m) return new Response('Not Found', { status: 404 });
    const [, idStr, kind, expStr, s] = m;
    const exp = Number(expStr), id = Number(idStr);
    if (exp < Date.now() / 1000) return new Response("הקישור פג תוקף. יש לפתוח את הקובץ מחדש מתוך הצ'אט.", { status: 410, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (s !== await sig(env, id, kind, exp)) return new Response('Forbidden', { status: 403 });
    const row = await env.DB.prepare("SELECT * FROM group_messages WHERE id = ?").bind(id).first();
    if (!row || !row.file_key || row.is_deleted === 1) return new Response('Gone', { status: 410 });
    const key = kind === 't' ? row.file_thumb_key : row.file_key;
    if (!key) return new Response('Not Found', { status: 404 });
    const obj = await env.FILES.get(key, { range: request.headers });
    if (!obj) return new Response('Not Found', { status: 404 });
    const type = kind === 't' ? ((obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg') : typeOf(row.file_type, row.file_name);
    const inline = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|audio\/|video\/|text\/plain)/.test(type) && url.searchParams.get('dl') !== '1';
    const headers = new Headers({
        'Content-Type': inline ? type : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(kind === 't' ? 'preview.jpg' : (row.file_name || 'file'))}`,
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': `private, max-age=${Math.max(0, exp - Math.floor(Date.now() / 1000))}`, 'Accept-Ranges': 'bytes',
    });
    const body = request.method === 'HEAD' ? null : obj.body;
    if (obj.range && request.headers.get('range')) {
        const r = obj.range;
        const offset = 'suffix' in r ? Math.max(0, obj.size - r.suffix) : (r.offset || 0);
        const length = 'suffix' in r ? obj.size - offset : (r.length ?? obj.size - offset);
        headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
        headers.set('Content-Length', String(length));
        return new Response(body, { status: 206, headers });
    }
    headers.set('Content-Length', String(obj.size));
    return new Response(body, { headers });
}

// ---------- רשימות ----------

function preview(row) {
    if (!row) return '';
    if (row.is_deleted === 1) return 'ההודעה נמחקה';
    const file = row.file_name ? `📎 ${row.file_name}` : '';
    return (row.text ? (file ? `${file} · ${row.text}` : row.text) : file).slice(0, 140);
}

// POST /api/groups/me - הקבוצות שלי + קבוצות שאפשר להצטרף אליהן
export async function handleGroupsMe(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor } = await access(env, body);
    if (error) return error;
    let mine;
    if (actor.type === 'admin') {
        mine = (await env.DB.prepare("SELECT g.*, 'admin' AS role, 'active' AS status, 0 AS last_read_id FROM chat_groups g WHERE g.archived = 0 ORDER BY g.last_message_id DESC").all()).results || [];
    } else {
        mine = (await env.DB.prepare(`SELECT g.*, m.role, m.status, m.last_read_id, m.muted_until, m.banned_until FROM group_members m JOIN chat_groups g ON g.id = m.group_id
            WHERE m.member_key = ? AND g.archived = 0 AND m.status IN ('active', 'pending', 'banned') ORDER BY g.last_message_id DESC`).bind(actor.key).all()).results || [];
    }
    const lastIds = mine.map(g => g.last_message_id).filter(Boolean);
    const lastMap = {};
    for (let i = 0; i < lastIds.length; i += 90) {
        const chunk = lastIds.slice(i, i + 90);
        const { results } = await env.DB.prepare(`SELECT id, sender_name, text, file_name, is_deleted, kind, created_at FROM group_messages WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
        for (const r of results || []) lastMap[r.id] = r;
    }
    const groups = [];
    for (const g of mine) {
        const s = parseSettings(g.settings);
        const banned = g.status === 'banned' || (g.banned_until && !isPastIsraelTime(g.banned_until));
        let unread = 0;
        if (g.status === 'active' && !banned && actor.type !== 'admin') {
            const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ? AND id > ? AND is_deleted = 0 AND kind = 'msg' AND sender_key != ?").bind(g.id, g.last_read_id || 0, actor.key).first();
            unread = r ? r.n : 0;
        }
        const last = lastMap[g.last_message_id];
        groups.push({
            id: g.id, name: g.name, description: g.description, color: g.color, role: g.role, status: banned ? 'banned' : g.status, unread,
            last: last && !banned && g.status === 'active' ? { sender: last.kind === 'system' ? '' : last.sender_name, text: preview(last), at: last.created_at } : null,
            hours: hoursState(s), announce: s.whoCanPost === 'moderators',
        });
    }
    // קבוצות פתוחות לגילוי (משתמשי אתר בלבד)
    let discover = [];
    if (actor.type === 'user') {
        const joined = new Set(mine.map(g => g.id));
        const { results } = await env.DB.prepare("SELECT g.id, g.name, g.description, g.color, g.settings, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'active') AS members FROM chat_groups g WHERE g.archived = 0").all();
        discover = (results || []).filter(g => !joined.has(g.id)).map(g => ({ ...g, s: parseSettings(g.settings) })).filter(g => g.s.visibility !== 'private')
            .map(g => ({ id: g.id, name: g.name, description: g.description, color: g.color, members: g.members, join: g.s.visibility === 'request' || g.s.userApproval ? 'request' : 'open' }));
    }
    const name = await displayNameFor(env, actor);
    return json({ success: true, me: { type: actor.type, name, master: !!actor.master, phone: actor.type === 'user' ? actor.phone : undefined }, groups, discover });
}

// POST /api/groups/open { groupId } - פרטי הקבוצה, ההרשאות שלי והחברים
export async function handleGroupOpen(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor, group, member, perms } = await access(env, body, body.groupId);
    if (error) return error;
    if (!perms.read) return err(perms.status === 'banned' ? 'נחסמת בקבוצה הזו' : perms.status === 'pending' ? 'הבקשה שלך להצטרף ממתינה לאישור' : perms.status === 'closed' ? `הקבוצה סגורה עכשיו${perms.hours && perms.hours.next ? ` · תיפתח ${perms.hours.next}` : ''}` : 'אין לך גישה לקבוצה הזו', 403, { code: perms.status || 'no_access' });
    const s = group.settings;
    let members = [];
    if (perms.seeMembers) {
        const { results } = await env.DB.prepare("SELECT member_key, role, status, display_name, muted_until, banned_until, last_seen_at, joined_at FROM group_members WHERE group_id = ? AND status = 'active' ORDER BY role = 'moderator' DESC, display_name").bind(group.id).all();
        const onlineSince = getFutureIsraelTimeForDB(-1.5);
        const showPhones = perms.admin || perms.seePhones;
        members = (results || []).map(m => ({
            key: m.member_key, name: m.display_name || '', role: m.role, guest: m.member_key.startsWith('g:'),
            phone: showPhones && m.member_key.startsWith('u:') ? m.member_key.slice(2) : undefined,
            online: !!m.last_seen_at && m.last_seen_at > onlineSince,
            muted: isMuted(m) ? m.muted_until : null,
        }));
    }
    const pinned = (await env.DB.prepare("SELECT id, sender_name, text, file_name, created_at FROM group_messages WHERE group_id = ? AND pinned = 1 AND is_deleted = 0 ORDER BY id DESC LIMIT 20").bind(group.id).all()).results || [];
    const counts = await env.DB.prepare("SELECT SUM(status = 'active') AS active, SUM(status = 'pending') AS pending FROM group_members WHERE group_id = ?").bind(group.id).first();
    return json({
        success: true,
        group: { id: group.id, name: group.name, description: group.description, color: group.color, welcome: s.welcome, announce: s.whoCanPost === 'moderators', maxMessageLength: s.maxMessageLength, maxFileMb: s.maxFileMb, slowModeSeconds: s.slowModeSeconds, showReadCount: s.showReadCount },
        settings: perms.admin || perms.editSettings ? s : undefined,
        me: { key: actor.key, role: actor.type === 'admin' ? 'admin' : member.role, perms },
        members, memberCount: counts ? counts.active || 0 : 0, pendingCount: perms.approve ? (counts ? counts.pending || 0 : 0) : 0,
        pinned: pinned.map(p => ({ id: p.id, sender: p.sender_name, text: preview({ ...p, is_deleted: 0 }), at: p.created_at })),
    });
}

// POST /api/groups/messages { groupId, beforeId? } - הודעות + מי מקליד
export async function handleGroupMessages(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor, group, member, perms } = await access(env, body, body.groupId);
    if (error) return error;
    if (!perms.read) return err('אין לך גישה לקבוצה הזו', 403, { code: perms.status || 'no_access' });
    const q = body.beforeId
        ? env.DB.prepare(`SELECT * FROM group_messages WHERE group_id = ? AND id < ? ORDER BY id DESC LIMIT ${PAGE + 1}`).bind(group.id, Number(body.beforeId))
        : env.DB.prepare(`SELECT * FROM group_messages WHERE group_id = ? ORDER BY id DESC LIMIT ${PAGE + 1}`).bind(group.id);
    const rows = (await q.all()).results || [];
    const hasMore = rows.length > PAGE;
    const list = rows.slice(0, PAGE).reverse();
    const replyIds = [...new Set(list.map(r => r.reply_to).filter(Boolean))];
    const replies = {};
    if (replyIds.length) {
        const { results } = await env.DB.prepare(`SELECT id, sender_name, text, file_name, is_deleted FROM group_messages WHERE id IN (${replyIds.map(() => '?').join(',')})`).bind(...replyIds).all();
        for (const r of results || []) replies[r.id] = { id: r.id, sender: r.sender_name, text: preview(r) };
    }
    // כמה חברים כבר קראו כל הודעה (לפי מיקום הקריאה האחרון של כל חבר)
    let reads = [];
    if (group.settings.showReadCount) reads = ((await env.DB.prepare("SELECT last_read_id FROM group_members WHERE group_id = ? AND status = 'active'").bind(group.id).all()).results || []).map(r => r.last_read_id || 0);
    const messages = [];
    for (const r of list) {
        const mine = r.sender_key === actor.key;
        const m = {
            id: r.id, kind: r.kind, sender: r.sender_name, senderKey: r.kind === 'system' ? '' : r.sender_key, mine,
            senderRole: r.sender_role || '', text: r.is_deleted === 1 ? '' : r.text, deleted: r.is_deleted === 1, deletedBy: r.is_deleted === 1 ? (r.deleted_by === r.sender_key ? 'self' : 'mod') : undefined,
            edited: !!r.edited_at && r.is_deleted !== 1, pinned: r.pinned === 1, at: r.created_at,
            replyTo: r.reply_to ? (replies[r.reply_to] || null) : null,
            canEdit: mine && perms.editOwn && r.is_deleted !== 1 && r.kind === 'msg' && !!r.text,
            canDelete: r.is_deleted !== 1 && r.kind === 'msg' && ((mine && perms.deleteOwn) || perms.deleteMessages),
        };
        if (mine && group.settings.showReadCount) m.readBy = reads.filter(x => x >= r.id).length - 1;
        if (r.file_key && r.is_deleted !== 1) {
            let meta; try { meta = r.file_meta ? JSON.parse(r.file_meta) : undefined; } catch (e) {}
            m.file = { name: r.file_name, type: typeOf(r.file_type, r.file_name), size: r.file_size, thumb: !!r.file_thumb_key, meta, available: true, ...(await fileLinks(env, request, r)) };
        }
        messages.push(m);
    }
    const typing = ((await env.DB.prepare("SELECT display_name FROM group_members WHERE group_id = ? AND member_key != ? AND typing_at > ?").bind(group.id, actor.key, getFutureIsraelTimeForDB(-TYPING_SECONDS / 60)).all()).results || []).map(r => r.display_name);
    // נוכחות וקריאה (לא במאסטר, ולא למנהל שאינו חבר)
    if (member && !actor.master) await env.DB.prepare("UPDATE group_members SET last_seen_at = ? WHERE group_id = ? AND member_key = ?").bind(getIsraelTimeForDB(), group.id, actor.key).run();
    return json({ success: true, messages, hasMore, typing, perms: { post: perms.post, files: perms.files, muted: perms.muted || null, hours: perms.hours } });
}

// ---------- כתיבה ----------

async function canSendNow(env, group, member, perms, actor) {
    if (!perms.post) {
        if (perms.muted) return 'הושתקת בקבוצה הזו עד ' + perms.muted;
        if (perms.hours && !perms.hours.open) return `הכתיבה בקבוצה סגורה עכשיו (שעות היום: ${perms.hours.today})${perms.hours.next ? ` · תיפתח ${perms.hours.next}` : ''}`;
        if (group.settings.whoCanPost === 'moderators') return 'רק המפקחים כותבים בקבוצה הזו';
        return 'אין לך הרשאה לכתוב בקבוצה הזו';
    }
    const slow = group.settings.slowModeSeconds;
    if (slow && member && !perms.moderator && member.last_post_at) {
        // שני הזמנים בשעון ישראל, ולכן ההפרש ביניהם נכון גם בלי לדעת את אזור הזמן
        const asUtc = t => Date.parse(t.replace(' ', 'T') + 'Z');
        const wait = Math.ceil(slow - (asUtc(getIsraelTimeForDB()) - asUtc(member.last_post_at)) / 1000);
        if (wait > 0 && wait <= slow) return `אפשר לשלוח הודעה נוספת בעוד ${wait} שניות`;
    }
    return null;
}

async function insertMessage(env, group, actor, member, fields) {
    const now = getIsraelTimeForDB();
    const name = actor.type === 'admin' ? ADMIN_NAME : (member && member.display_name) || await displayNameFor(env, actor);
    const role = actor.type === 'admin' ? 'admin' : member ? member.role : '';
    const r = await env.DB.prepare(`INSERT INTO group_messages (group_id, sender_key, sender_name, sender_role, text, reply_to, file_key, file_name, file_type, file_size, file_thumb_key, file_meta, kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'msg', ?)`)
        .bind(group.id, actor.key, name, role, fields.text || '', fields.replyTo || null, fields.file_key || null, fields.file_name || null, fields.file_type || null, fields.file_size || null, fields.file_thumb_key || null, fields.file_meta || null, now).run();
    const id = r.meta.last_row_id;
    await env.DB.batch([
        env.DB.prepare("UPDATE chat_groups SET last_message_id = ?, updated_at = ? WHERE id = ?").bind(id, now, group.id),
        ...(member ? [env.DB.prepare("UPDATE group_members SET last_post_at = ?, typing_at = NULL, last_read_id = MAX(COALESCE(last_read_id, 0), ?) WHERE group_id = ? AND member_key = ?").bind(now, id, group.id, actor.key)] : []),
    ]);
    return { id, at: now };
}

async function validReply(env, groupId, id) {
    if (!id) return null;
    const r = await env.DB.prepare("SELECT id FROM group_messages WHERE id = ? AND group_id = ?").bind(Number(id), groupId).first();
    return r ? r.id : null;
}

export async function handleGroupSend(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor, group, member, perms } = await access(env, body, body.groupId);
    if (error) return error;
    const why = await canSendNow(env, group, member, perms, actor);
    if (why) return err(why, 403);
    const text = String(body.text || '').replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
    if (!text) return err('לא ניתן לשלוח הודעה ריקה');
    if (text.length > group.settings.maxMessageLength) return err(`ההודעה ארוכה מדי (עד ${group.settings.maxMessageLength} תווים)`);
    const replyTo = perms.reply ? await validReply(env, group.id, body.replyTo) : null;
    const r = await insertMessage(env, group, actor, member, { text, replyTo });
    return json({ success: true, ...r });
}

export async function handleGroupSendFile(request, env) {
    const { form, file, error: bad } = await readUpload(request, env);
    if (bad) return bad;
    const creds = { adminToken: form.get('adminToken'), userToken: form.get('userToken'), guestToken: form.get('guestToken') };
    const { error, actor, group, member, perms } = await access(env, creds, form.get('groupId'));
    if (error) return error;
    const why = await canSendNow(env, group, member, perms, actor);
    if (why) return err(why, 403);
    if (!perms.files) return err('אין הרשאה לשלוח קבצים בקבוצה הזו', 403);
    if (file.size > group.settings.maxFileMb * 1024 * 1024) return err(`הקובץ גדול מדי (עד ${group.settings.maxFileMb}MB בקבוצה הזו)`, 413);
    const text = String(form.get('text') || '').trim().slice(0, group.settings.maxMessageLength);
    const f = await storeFile(env, `group-${group.id}`, file);
    const th = await storeThumb(env, f.file_key, form).catch(() => ({ file_thumb_key: null, file_meta: null }));
    const replyTo = perms.reply ? await validReply(env, group.id, form.get('replyTo')) : null;
    const r = await insertMessage(env, group, actor, member, { text, replyTo, ...f, ...th });
    return json({ success: true, ...r });
}

// תמונה מקדימה לקובץ ישן (מי שפתח אותו מכין ושולח)
export async function handleGroupFileThumb(request, env) {
    let form;
    try { form = await request.formData(); } catch (e) { return err('בקשה לא תקינה'); }
    const row = await env.DB.prepare("SELECT * FROM group_messages WHERE id = ?").bind(Number(form.get('messageId')) || 0).first();
    if (!row || !row.file_key) return err('הקובץ לא נמצא', 404);
    const { error, perms } = await access(env, { adminToken: form.get('adminToken'), userToken: form.get('userToken'), guestToken: form.get('guestToken') }, row.group_id);
    if (error) return error;
    if (!perms.read) return err('אין גישה', 403);
    if (row.file_thumb_key) return json({ success: true, existed: true });
    const t = await storeThumb(env, row.file_key, form);
    await env.DB.prepare("UPDATE group_messages SET file_thumb_key = COALESCE(file_thumb_key, ?), file_meta = COALESCE(file_meta, ?) WHERE id = ?").bind(t.file_thumb_key, t.file_meta, row.id).run();
    return json({ success: true });
}

async function messageAccess(env, body) {
    const row = await env.DB.prepare("SELECT * FROM group_messages WHERE id = ?").bind(Number(body.messageId) || 0).first();
    if (!row) return { error: err('ההודעה לא נמצאה', 404) };
    const a = await access(env, body, row.group_id);
    return { ...a, row };
}

export async function handleGroupEdit(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor, group, perms, row } = await messageAccess(env, body);
    if (error) return error;
    if (row.sender_key !== actor.key || !perms.editOwn || row.is_deleted === 1 || !perms.read) return err('אי אפשר לערוך את ההודעה הזו', 403);
    const text = String(body.text || '').trim();
    if (!text || text.length > group.settings.maxMessageLength) return err('טקסט לא תקין');
    await env.DB.prepare("UPDATE group_messages SET text = ?, edited_at = ? WHERE id = ?").bind(text, getIsraelTimeForDB(), row.id).run();
    return json({ success: true });
}

export async function handleGroupDelete(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor, group, perms, row } = await messageAccess(env, body);
    if (error) return error;
    const own = row.sender_key === actor.key;
    if (row.is_deleted === 1 || !perms.read || !((own && perms.deleteOwn) || perms.deleteMessages)) return err('אי אפשר למחוק את ההודעה הזו', 403);
    await env.DB.prepare("UPDATE group_messages SET is_deleted = 1, deleted_by = ?, pinned = 0 WHERE id = ?").bind(actor.key, row.id).run();
    if (row.file_key) await removeFiles(env, [row.file_key]);
    if (!own) await log(env, group.id, actor, 'DELETE_MESSAGE', row.sender_key, `${row.sender_name}: ${preview(row)}`);
    return json({ success: true });
}

export async function handleGroupPin(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor, group, perms, row } = await messageAccess(env, body);
    if (error) return error;
    if (!perms.pin || row.is_deleted === 1) return err('אין הרשאה להצמיד', 403);
    await env.DB.prepare("UPDATE group_messages SET pinned = ? WHERE id = ?").bind(body.pinned ? 1 : 0, row.id).run();
    await log(env, group.id, actor, body.pinned ? 'PIN' : 'UNPIN', '', preview(row));
    return json({ success: true });
}

export async function handleGroupRead(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor, group, member } = await access(env, body, body.groupId);
    if (error) return error;
    if (member && !actor.master) await env.DB.prepare("UPDATE group_members SET last_read_id = MAX(COALESCE(last_read_id, 0), ?) WHERE group_id = ? AND member_key = ?").bind(Number(body.lastId) || 0, group.id, actor.key).run();
    return json({ success: true });
}

export async function handleGroupTyping(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor, group, member, perms } = await access(env, body, body.groupId);
    if (error) return error;
    if (member && perms.post && !actor.master) await env.DB.prepare("UPDATE group_members SET typing_at = ? WHERE group_id = ? AND member_key = ?").bind(body.typing === false ? null : getIsraelTimeForDB(), group.id, actor.key).run();
    return json({ success: true });
}

// ---------- הצטרפות ----------

async function addMember(env, group, actor, { role = 'member', status = 'active', name, addedBy = '' }) {
    const now = getIsraelTimeForDB();
    const existing = await loadMember(env, group.id, actor.key);
    if (existing && (existing.status === 'banned' || isBanned(existing))) return { banned: true };
    if (existing && existing.status === 'active') return { already: true };
    const displayName = name || await displayNameFor(env, actor);
    await env.DB.prepare(`INSERT INTO group_members (group_id, member_key, role, status, display_name, joined_at, added_by, last_read_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id, member_key) DO UPDATE SET role = excluded.role, status = excluded.status, display_name = excluded.display_name, joined_at = excluded.joined_at, added_by = excluded.added_by`)
        .bind(group.id, actor.key, role, status, displayName, now, addedBy, status === 'active' ? 0 : 0).run();
    if (status === 'active') await systemMessage(env, group.id, `${displayName} הצטרף/ה לקבוצה`);
    return { ok: true, status, name: displayName };
}

// POST /api/groups/join { groupId } - משתמש אתר מצטרף לקבוצה ציבורית או מבקש להצטרף
export async function handleGroupJoin(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor, group } = await access(env, body, body.groupId);
    if (error) return error;
    if (actor.type !== 'user' || actor.master) return err('רק משתמשי האתר יכולים להצטרף כך', 403);
    const s = group.settings;
    if (group.archived || s.visibility === 'private') return err('אפשר להצטרף לקבוצה הזו רק בהזמנה', 403);
    const status = s.visibility === 'request' || s.userApproval ? 'pending' : 'active';
    const r = await addMember(env, group, actor, { status });
    if (r.banned) return err('נחסמת בקבוצה הזו', 403);
    await log(env, group.id, { ...actor, displayName: r.name }, status === 'pending' ? 'JOIN_REQUEST' : 'JOIN', actor.key);
    return json({ success: true, status: r.already ? 'active' : status });
}

export async function handleGroupLeave(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor, group, member } = await access(env, body, body.groupId);
    if (error) return error;
    if (!member) return err('את/ה לא חבר/ה בקבוצה', 400);
    if (isBanned(member)) return err('לא ניתן לעזוב קבוצה שנחסמת בה', 403);
    await env.DB.prepare("UPDATE group_members SET status = 'left' WHERE group_id = ? AND member_key = ?").bind(group.id, actor.key).run();
    if (member.status === 'active') await systemMessage(env, group.id, `${member.display_name} עזב/ה את הקבוצה`);
    await log(env, group.id, { ...actor, displayName: member.display_name }, 'LEAVE', actor.key);
    return json({ success: true });
}

// ---------- הזמנות ----------

async function inviteByCode(env, code) {
    const inv = await env.DB.prepare("SELECT * FROM group_invites WHERE code = ?").bind(String(code || '')).first();
    if (!inv || inv.revoked) return { error: 'קישור ההזמנה אינו תקין או שבוטל' };
    if (inv.expires_at && isPastIsraelTime(inv.expires_at)) return { error: 'תוקף קישור ההזמנה פג' };
    if (inv.max_uses && inv.uses >= inv.max_uses) return { error: 'קישור ההזמנה נוצל במלואו' };
    const group = await loadGroup(env, inv.group_id);
    if (!group || group.archived) return { error: 'הקבוצה אינה זמינה' };
    return { inv, group };
}

// POST /api/groups/invite/info { code }
export async function handleInviteInfo(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await featureOn(env))) return err('הצ\'אט הקבוצתי כבוי כרגע', 503);
    const { error, inv, group } = await inviteByCode(env, body.code);
    if (error) return err(error, 404);
    const s = group.settings;
    const guestsOk = !!inv.allow_guests && s.allowGuests;
    return json({ success: true, group: { name: group.name, description: group.description, color: group.color }, allowUsers: !!inv.allow_users, allowGuests: guestsOk, guestPhoneRequired: s.guestPhoneRequired,
        approval: !!inv.approval, guestApproval: guestsOk && (s.guestApproval || !!inv.approval) });
}

// POST /api/groups/invite/accept { code, userToken? | guestToken? | name, phone }
export async function handleInviteAccept(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await featureOn(env))) return err('הצ\'אט הקבוצתי כבוי כרגע', 503);
    const { error, inv, group } = await inviteByCode(env, body.code);
    if (error) return err(error, 404);
    const s = group.settings;
    let actor = await actorOf(env, body);
    if (actor && actor.type === 'blocked') return err('הגישה שלך נחסמה', 403);
    let guestToken = null;
    if (actor && actor.type === 'admin') return err('המנהל רואה את כל הקבוצות ממילא', 400);
    if (actor && actor.type === 'user') {
        if (!inv.allow_users) return err('קישור זה מיועד לאורחים בלבד', 403);
        if (actor.master) return err('לא ניתן להצטרף בהתחברות מאסטר', 403);
    } else {
        if (!inv.allow_guests || !s.allowGuests) return err('הקבוצה לא פתוחה לאורחים. יש להתחבר לאתר כדי להצטרף.', 403, { code: 'login_required' });
        if (!actor) {
            const name = String(body.name || '').trim().slice(0, 40);
            const phone = String(body.phone || '').replace(/\D/g, '').slice(0, 15);
            if (name.length < 2) return err('יש להזין שם (לפחות 2 תווים)');
            if (s.guestPhoneRequired && phone.length < 9) return err('יש להזין מספר טלפון תקין');
            const id = randomId(8);
            guestToken = 'gst_' + randomId(24);
            await env.DB.prepare("INSERT INTO group_guests (id, name, phone, token_hash, created_at, last_seen_at, blocked) VALUES (?, ?, ?, ?, ?, ?, 0)")
                .bind(id, name, phone, await sha256(guestToken), getIsraelTimeForDB(), getIsraelTimeForDB()).run();
            actor = { type: 'guest', key: 'g:' + id, guestId: id, name, phone };
        }
    }
    const isGuest = actor.type === 'guest';
    const needApproval = !!inv.approval || (isGuest ? s.guestApproval : s.userApproval);
    const r = await addMember(env, group, actor, { role: inv.role === 'moderator' && !isGuest ? 'moderator' : 'member', status: needApproval ? 'pending' : 'active', name: isGuest ? actor.name : undefined, addedBy: 'invite:' + inv.id });
    if (r.banned) return err('נחסמת בקבוצה הזו', 403);
    if (!r.already) await env.DB.prepare("UPDATE group_invites SET uses = uses + 1 WHERE id = ?").bind(inv.id).run();
    await log(env, group.id, { ...actor, displayName: r.name || actor.name }, needApproval ? 'JOIN_REQUEST' : 'JOIN', actor.key, `דרך הזמנה${inv.note ? ` (${inv.note})` : ''}`);
    return json({ success: true, groupId: group.id, status: r.already ? 'active' : (needApproval ? 'pending' : 'active'), guestToken });
}

// ---------- פיקוח ----------

const MOD_ACTIONS = {
    approve: 'approve', reject: 'approve', remove: 'remove', ban: 'ban', unban: 'ban', mute: 'mute', unmute: 'mute',
    promote: 'admin', demote: 'admin', rename: 'admin',
};

// POST /api/groups/mod/members { groupId } - כל החברים כולל ממתינים וחסומים
export async function handleModMembers(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, group, perms } = await access(env, body, body.groupId);
    if (error) return error;
    if (!perms.moderator) return err('למפקחים בלבד', 403);
    const { results } = await env.DB.prepare("SELECT * FROM group_members WHERE group_id = ? AND status != 'left' ORDER BY status = 'pending' DESC, role = 'moderator' DESC, display_name").bind(group.id).all();
    const guestIds = (results || []).filter(m => m.member_key.startsWith('g:')).map(m => m.member_key.slice(2));
    const guests = {};
    for (let i = 0; i < guestIds.length; i += 90) {
        const chunk = guestIds.slice(i, i + 90);
        const r = await env.DB.prepare(`SELECT id, phone FROM group_guests WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
        for (const g of r.results || []) guests[g.id] = g.phone;
    }
    const seePhones = perms.admin || perms.seePhones;
    return json({ success: true, members: (results || []).map(m => ({
        key: m.member_key, name: m.display_name, role: m.role, guest: m.member_key.startsWith('g:'),
        status: isBanned(m) ? 'banned' : m.status, bannedUntil: m.banned_until, banReason: m.ban_reason, mutedUntil: isMuted(m) ? m.muted_until : null,
        joinedAt: m.joined_at, lastSeenAt: m.last_seen_at, addedBy: m.added_by,
        phone: seePhones ? (m.member_key.startsWith('u:') ? m.member_key.slice(2) : guests[m.member_key.slice(2)] || '') : undefined,
    })) });
}

// POST /api/groups/mod/action { groupId, memberKey, action, minutes?, reason?, name? }
export async function handleModAction(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor, group, perms } = await access(env, body, body.groupId);
    if (error) return error;
    const need = MOD_ACTIONS[body.action];
    if (!need) return err('פעולה לא מוכרת');
    if (need === 'admin' ? !perms.admin : !perms[need]) return err('אין לך הרשאה לפעולה הזו', 403);
    const target = await loadMember(env, group.id, String(body.memberKey || ''));
    if (!target) return err('החבר לא נמצא', 404);
    if (target.role === 'moderator' && !perms.admin && body.action !== 'approve') return err('רק המנהל יכול לטפל במפקחים', 403);
    if (target.member_key === actor.key) return err('לא ניתן לבצע פעולה על עצמך', 400);
    const minutes = Math.min(525600, Math.max(0, Number(body.minutes) || 0));
    const until = minutes ? getFutureIsraelTimeForDB(minutes) : null;
    const reason = String(body.reason || '').slice(0, 200);
    const name = target.display_name;
    const st = env.DB.prepare.bind(env.DB);
    const where = [group.id, target.member_key];
    switch (body.action) {
        case 'approve':
            await st("UPDATE group_members SET status = 'active', joined_at = ? WHERE group_id = ? AND member_key = ?").bind(getIsraelTimeForDB(), ...where).run();
            await systemMessage(env, group.id, `${name} הצטרף/ה לקבוצה`); break;
        case 'reject': await st("DELETE FROM group_members WHERE group_id = ? AND member_key = ? AND status = 'pending'").bind(...where).run(); break;
        case 'remove':
            await st("UPDATE group_members SET status = 'left' WHERE group_id = ? AND member_key = ?").bind(...where).run();
            await systemMessage(env, group.id, `${name} הוסר/ה מהקבוצה`); break;
        case 'ban':
            await st("UPDATE group_members SET status = 'banned', banned_until = ?, ban_reason = ? WHERE group_id = ? AND member_key = ?").bind(until, reason, ...where).run();
            await systemMessage(env, group.id, `${name} נחסם/ה בקבוצה`); break;
        case 'unban': await st("UPDATE group_members SET status = 'active', banned_until = NULL, ban_reason = NULL WHERE group_id = ? AND member_key = ?").bind(...where).run(); break;
        case 'mute': await st("UPDATE group_members SET muted_until = ? WHERE group_id = ? AND member_key = ?").bind(until || getFutureIsraelTimeForDB(525600), ...where).run(); break;
        case 'unmute': await st("UPDATE group_members SET muted_until = NULL WHERE group_id = ? AND member_key = ?").bind(...where).run(); break;
        case 'promote':
            if (target.member_key.startsWith('g:')) return err('אורח לא יכול להיות מפקח');
            await st("UPDATE group_members SET role = 'moderator' WHERE group_id = ? AND member_key = ?").bind(...where).run(); break;
        case 'demote': await st("UPDATE group_members SET role = 'member' WHERE group_id = ? AND member_key = ?").bind(...where).run(); break;
        case 'rename': {
            const n = String(body.name || '').trim().slice(0, 40);
            if (n.length < 2) return err('שם קצר מדי');
            await st("UPDATE group_members SET display_name = ? WHERE group_id = ? AND member_key = ?").bind(n, ...where).run(); break;
        }
    }
    await log(env, group.id, actor, body.action.toUpperCase(), target.member_key, `${name}${minutes ? ` · ${minutes} דק'` : ''}${reason ? ` · ${reason}` : ''}`);
    return json({ success: true });
}

// POST /api/groups/mod/invites { groupId, create?: {...}, revoke?: id }
export async function handleModInvites(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor, group, perms } = await access(env, body, body.groupId);
    if (error) return error;
    if (!perms.invites) return err('אין לך הרשאה לנהל הזמנות', 403);
    if (body.create) {
        const c = body.create;
        const id = randomId(8), code = randomId(12);
        const hours = Math.min(24 * 365, Math.max(0, Number(c.hours) || 0));
        await env.DB.prepare(`INSERT INTO group_invites (id, group_id, code, created_by, created_at, expires_at, max_uses, uses, role, approval, allow_guests, allow_users, revoked, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?)`)
            .bind(id, group.id, code, actor.key, getIsraelTimeForDB(), hours ? getFutureIsraelTimeForDB(hours * 60) : null, Math.max(0, Number(c.maxUses) || 0) || null,
                c.role === 'moderator' && perms.admin ? 'moderator' : 'member', c.approval ? 1 : 0, c.allowGuests === false ? 0 : 1, c.allowUsers === false ? 0 : 1, String(c.note || '').slice(0, 80)).run();
        await log(env, group.id, actor, 'INVITE_CREATE', '', `${c.note || ''}${hours ? ` · ${hours} שעות` : ''}${c.maxUses ? ` · ${c.maxUses} שימושים` : ''}`);
    }
    if (body.revoke) {
        await env.DB.prepare("UPDATE group_invites SET revoked = 1 WHERE id = ? AND group_id = ?").bind(String(body.revoke), group.id).run();
        await log(env, group.id, actor, 'INVITE_REVOKE', '', String(body.revoke));
    }
    const { results } = await env.DB.prepare("SELECT * FROM group_invites WHERE group_id = ? ORDER BY created_at DESC LIMIT 100").bind(group.id).all();
    return json({ success: true, invites: (results || []).map(i => ({
        id: i.id, code: i.code, createdAt: i.created_at, expiresAt: i.expires_at, maxUses: i.max_uses, uses: i.uses, role: i.role, approval: !!i.approval,
        allowGuests: !!i.allow_guests, allowUsers: !!i.allow_users, note: i.note, active: !i.revoked && (!i.expires_at || !isPastIsraelTime(i.expires_at)) && (!i.max_uses || i.uses < i.max_uses), revoked: !!i.revoked,
    })) });
}

// POST /api/groups/mod/settings { groupId, settings?, name?, description?, color? }
export async function handleModSettings(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, actor, group, perms } = await access(env, body, body.groupId);
    if (error) return error;
    if (!perms.admin && !perms.editSettings) return err('אין לך הרשאה לשנות הגדרות', 403);
    if (body.settings || body.name !== undefined || body.description !== undefined || body.color !== undefined) {
        const s = cleanGroupSettings(body.settings || {}, group.settings);
        // מפקח לא משנה את הרשאות המפקחים
        if (!perms.admin) s.moderatorPerms = group.settings.moderatorPerms;
        const name = body.name !== undefined ? String(body.name).trim().slice(0, 60) : group.name;
        if (!name) return err('חסר שם לקבוצה');
        await env.DB.prepare("UPDATE chat_groups SET name = ?, description = ?, color = ?, settings = ?, updated_at = ? WHERE id = ?")
            .bind(name, body.description !== undefined ? String(body.description).slice(0, 300) : group.description, body.color !== undefined ? String(body.color).slice(0, 20) : group.color, JSON.stringify(s), getIsraelTimeForDB(), group.id).run();
        await log(env, group.id, actor, 'SETTINGS', '', 'עדכון הגדרות');
    }
    const g = await loadGroup(env, group.id);
    return json({ success: true, group: { id: g.id, name: g.name, description: g.description, color: g.color }, settings: g.settings });
}

export async function handleModLog(request, env) {
    const body = await request.json().catch(() => ({}));
    const { error, group, perms } = await access(env, body, body.groupId);
    if (error) return error;
    if (!perms.moderator) return err('למפקחים בלבד', 403);
    const { results } = await env.DB.prepare("SELECT * FROM group_log WHERE group_id = ? ORDER BY id DESC LIMIT 200").bind(group.id).all();
    return json({ success: true, log: (results || []).map(l => ({ id: l.id, actor: l.actor_name, action: l.action, target: l.target, details: l.details, at: l.created_at })) });
}

// ---------- ניהול במרכז השליטה (מנהל ראשי) ----------

async function requireAdmin(env, body) {
    return (await isMainAdmin(env, body.adminToken)) ? null : err('למנהל הראשי בלבד', 401);
}

// POST /api/admin/groups { adminToken } - כל הקבוצות + סטטיסטיקה + הגדרה כללית
export async function handleAdminGroups(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    if (body.enabled !== undefined) await setSettings(env, { groups_enabled: body.enabled ? '1' : '0' }, getIsraelTimeForDB());
    const { results } = await env.DB.prepare(`SELECT g.*,
        (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'active') AS members,
        (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'pending') AS pending,
        (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'active' AND m.role = 'moderator') AS moderators,
        (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'active' AND m.member_key LIKE 'g:%') AS guests,
        (SELECT COUNT(*) FROM group_messages x WHERE x.group_id = g.id AND x.kind = 'msg' AND x.created_at > ?) AS week
        FROM chat_groups g ORDER BY g.archived, g.last_message_id DESC`).bind(getFutureIsraelTimeForDB(-7 * 24 * 60)).all();
    return json({ success: true, enabled: await featureOn(env), defaults: GROUP_DEFAULTS, groups: (results || []).map(g => ({ id: g.id, name: g.name, description: g.description, color: g.color, archived: !!g.archived,
        members: g.members, pending: g.pending, moderators: g.moderators, guests: g.guests, week: g.week, createdAt: g.created_at, settings: parseSettings(g.settings), hours: hoursState(parseSettings(g.settings)) })) });
}

// POST /api/admin/groups/save { adminToken, id?, name, description, color, settings, archived }
export async function handleAdminGroupSave(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return err('חסר שם לקבוצה');
    const now = getIsraelTimeForDB();
    const admin = { type: 'admin', key: 'admin' };
    if (body.id) {
        const g = await loadGroup(env, body.id);
        if (!g) return err('הקבוצה לא נמצאה', 404);
        const s = cleanGroupSettings(body.settings || {}, g.settings);
        await env.DB.prepare("UPDATE chat_groups SET name = ?, description = ?, color = ?, settings = ?, archived = ?, updated_at = ? WHERE id = ?")
            .bind(name, String(body.description || '').slice(0, 300), String(body.color || '').slice(0, 20), JSON.stringify(s), body.archived ? 1 : 0, now, g.id).run();
        await log(env, g.id, admin, body.archived && !g.archived ? 'ARCHIVE' : 'SETTINGS', '', 'עדכון ממרכז השליטה');
        return json({ success: true, id: g.id });
    }
    const s = cleanGroupSettings(body.settings || {});
    const r = await env.DB.prepare("INSERT INTO chat_groups (name, description, color, settings, archived, created_at, updated_at, last_message_id) VALUES (?, ?, ?, ?, 0, ?, ?, 0)")
        .bind(name, String(body.description || '').slice(0, 300), String(body.color || '').slice(0, 20), JSON.stringify(s), now, now).run();
    const id = r.meta.last_row_id;
    await systemMessage(env, id, `הקבוצה "${name}" נוצרה`);
    await log(env, id, admin, 'CREATE', '', name);
    return json({ success: true, id });
}

// POST /api/admin/groups/delete { adminToken, id } - מחיקה מלאה כולל קבצים
export async function handleAdminGroupDelete(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const id = Number(body.id) || 0;
    const { results } = await env.DB.prepare("SELECT file_key FROM group_messages WHERE group_id = ? AND file_key IS NOT NULL").bind(id).all();
    await env.DB.batch([
        env.DB.prepare("DELETE FROM group_messages WHERE group_id = ?").bind(id),
        env.DB.prepare("DELETE FROM group_members WHERE group_id = ?").bind(id),
        env.DB.prepare("DELETE FROM group_invites WHERE group_id = ?").bind(id),
        env.DB.prepare("DELETE FROM group_log WHERE group_id = ?").bind(id),
        env.DB.prepare("DELETE FROM chat_groups WHERE id = ?").bind(id),
    ]);
    await removeFiles(env, (results || []).map(r => r.file_key));
    return json({ success: true });
}

// POST /api/admin/groups/add-members { adminToken, groupId, phones: [], role }
export async function handleAdminGroupAddMembers(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const group = await loadGroup(env, body.groupId);
    if (!group) return err('הקבוצה לא נמצאה', 404);
    const phones = [...new Set((Array.isArray(body.phones) ? body.phones : String(body.phones || '').split(/[\s,;]+/)).map(p => String(p).replace(/\D/g, '')).filter(p => p.length >= 9))].slice(0, 500);
    if (!phones.length) return err('לא נמצאו מספרי טלפון תקינים');
    const known = new Set();
    for (let i = 0; i < phones.length; i += 90) {
        const chunk = phones.slice(i, i + 90);
        const r = await env.DB.prepare(`SELECT phone FROM users WHERE phone IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
        for (const u of r.results || []) known.add(u.phone);
    }
    let added = 0;
    const missing = [];
    for (const phone of phones) {
        if (!known.has(phone)) { missing.push(phone); continue; }
        const actor = { type: 'user', key: 'u:' + phone, phone };
        const r = await addMember(env, group, actor, { role: body.role === 'moderator' ? 'moderator' : 'member', status: 'active', addedBy: 'admin' });
        if (r.ok) added++;
        else if (r.already && body.role === 'moderator') await env.DB.prepare("UPDATE group_members SET role = 'moderator' WHERE group_id = ? AND member_key = ?").bind(group.id, actor.key).run();
    }
    await log(env, group.id, { type: 'admin', key: 'admin' }, 'ADD_MEMBERS', '', `${added} נוספו${body.role === 'moderator' ? ' כמפקחים' : ''}`);
    return json({ success: true, added, missing });
}

// חסימת אורח בכל הקבוצות
export async function handleAdminGuestBlock(request, env) {
    const body = await request.json().catch(() => ({}));
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const id = String(body.memberKey || '').replace(/^g:/, '');
    await env.DB.prepare("UPDATE group_guests SET blocked = ? WHERE id = ?").bind(body.blocked === false ? 0 : 1, id).run();
    return json({ success: true });
}
