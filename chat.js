// chat.js
// צ'אט בין הלקוחות למנהל הראשי: הודעות, ציטוטים, עריכה, "מקליד/ה", נוכחות, הצמדה/ארכיון/הערות וחיפוש.
// צד הניהול שמור למנהל הראשי בלבד.

import { authenticateUser } from './auth.js';
import { getIsraelTimeForDB, getFutureIsraelTimeForDB, getMinutesSinceIsraelDbTime } from './timeUtils.js';
import { sendEmail, escapeHtml } from './emailService.js';
import { getNameFromIni, getAllNamesFromIni } from './yemot.js';
import { isMainAdmin, forbidden, sessionExpired } from './adminAuth.js';
import { getSettings, setSettings, EDITABLE_SETTINGS } from './schema.js';
import { getPresenceMap } from './activity.js';
import { markAdminActive, maybeNotifyAdmin, canEmailCustomer, sendCustomerMessageEmail, sendTestAdminEmail, getSuperAdminEmail, redeemEmailLink } from './chatNotify.js';
import { logActivity } from './activity.js';
import { readUpload, storeFile, storeThumb, removeFiles, fileInfoWithLinks, messagePreview, userFileQuotaExceeded, parseLimits, isLimited, MAX_EMAIL_ATTACHMENT } from './chatFiles.js';

const MAX_TEXT = 2000;
const TYPING_SECONDS = 7;
const PAGE_SIZE = 150;
const USER_RATE_PER_MINUTE = 15;
const PRESENCE_FRESH_SECONDS = 75;

// מה הלקוח רשאי לראות על המנהל, לפי הגדרות הפרטיות
function adminVisibility(settings) {
    const showPresence = settings.admin_show_presence !== '0';
    const online = showPresence && settings.admin_presence_state === 'online' && isFresh(settings.admin_presence_at, PRESENCE_FRESH_SECONDS);
    return {
        admin: { online, lastActiveAt: null },
        showTyping: settings.admin_show_typing !== '0',
        showReadReceipts: settings.admin_show_read_receipts !== '0',
    };
}

const DELETED_TEXT = "🚫 ההודעה נמחקה";

function isFresh(dbTime, seconds) {
    return !!dbTime && getMinutesSinceIsraelDbTime(dbTime) * 60 <= seconds;
}

function cleanText(text) {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

async function readBody(request) {
    return request.json().catch(() => ({}));
}

async function requireUser(env, body) {
    if (!body.userToken) return { error: Response.json({ error: "חסר אימות משתמש" }, { status: 401 }) };
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return { error: Response.json({ error: "הרשאות לא חוקיות" }, { status: 403 }) };
    return { user };
}

async function upsertThread(env, phone, fields) {
    const keys = Object.keys(fields);
    const now = getIsraelTimeForDB();
    await env.DB.prepare(`INSERT INTO chat_threads (user_phone, ${keys.join(', ')}, updated_at) VALUES (?, ${keys.map(() => '?').join(', ')}, ?)
        ON CONFLICT(user_phone) DO UPDATE SET ${keys.map(k => `${k} = excluded.${k}`).join(', ')}, updated_at = excluded.updated_at`)
        .bind(phone, ...keys.map(k => fields[k]), now).run();
}

// ציטוטים: שליפת ההודעות המצוטטות בשאילתה אחת
async function attachReplies(env, rows) {
    const ids = [...new Set(rows.map(r => r.reply_to).filter(Boolean))];
    if (!ids.length) return {};
    const { results } = await env.DB.prepare(`SELECT id, sender, message_text, is_deleted, file_key, file_name, file_type FROM chat_messages WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    const map = {};
    for (const r of results || []) map[r.id] = { id: r.id, sender: r.sender, text: r.is_deleted === 1 ? DELETED_TEXT : messagePreview(r).slice(0, 200) };
    return map;
}

function isEdited(row) {
    return row.is_deleted !== 1 && !!row.edited_at;
}

async function fetchPage(env, phone, beforeId) {
    const q = beforeId
        ? env.DB.prepare(`SELECT * FROM chat_messages WHERE user_phone = ? AND id < ? ORDER BY id DESC LIMIT ${PAGE_SIZE + 1}`).bind(phone, Number(beforeId))
        : env.DB.prepare(`SELECT * FROM chat_messages WHERE user_phone = ? ORDER BY id DESC LIMIT ${PAGE_SIZE + 1}`).bind(phone);
    const { results } = await q.all();
    const rows = results || [];
    const hasMore = rows.length > PAGE_SIZE;
    return { rows: rows.slice(0, PAGE_SIZE).reverse(), hasMore };
}

// ==========================================
// צד הלקוח
// ==========================================

export async function handleUserGetChat(request, env) {
    const body = await readBody(request);
    const { user, error } = await requireUser(env, body);
    if (error) return error;

    try {
        const [{ rows, hasMore }, thread, settings] = await Promise.all([
            fetchPage(env, user.phone, body.beforeId),
            env.DB.prepare("SELECT admin_typing_at FROM chat_threads WHERE user_phone = ?").bind(user.phone).first(),
            getSettings(env),
        ]);
        const replies = await attachReplies(env, rows);
        const vis = adminVisibility(settings);
        const messages = await Promise.all(rows.map(async msg => ({
            id: msg.id, sender: msg.sender, text: msg.is_deleted === 1 ? DELETED_TEXT : msg.message_text,
            // כשאישורי הקריאה מוסתרים, הלקוח רואה רק "נשלח" על ההודעות שלו
            isRead: msg.sender === 'user' && !vis.showReadReceipts ? false : msg.is_read === 1,
            isDeleted: msg.is_deleted === 1, createdAt: msg.created_at,
            edited: isEdited(msg), replyTo: msg.reply_to ? (replies[msg.reply_to] || null) : null,
            file: await fileInfoWithLinks(env, request, msg, user.is_master ? 'master' : 'user'),
        })));
        return Response.json({
            success: true, messages, hasMore,
            adminTyping: vis.showTyping && isFresh(thread && thread.admin_typing_at, TYPING_SECONDS),
            admin: vis.admin,
        });
    } catch (e) { return Response.json({ error: "שגיאה בשליפת ההודעות" }, { status: 500 }); }
}

export async function handleUserCheckUnread(request, env) {
    const body = await readBody(request);
    const { user, error } = await requireUser(env, body);
    if (error) return error;

    try {
        const [countRes, thread, settings] = await Promise.all([
            env.DB.prepare("SELECT COUNT(*) as unread FROM chat_messages WHERE user_phone = ? AND sender = 'admin' AND is_read = 0 AND is_deleted = 0").bind(user.phone).first(),
            env.DB.prepare("SELECT admin_typing_at FROM chat_threads WHERE user_phone = ?").bind(user.phone).first(),
            getSettings(env),
        ]);
        const vis = adminVisibility(settings);
        // ההודעה האחרונה שלא נקראה - להתראת דפדפן אצל הלקוח
        const last = countRes.unread ? await env.DB.prepare("SELECT id, message_text, file_key, file_name, file_type FROM chat_messages WHERE user_phone = ? AND sender = 'admin' AND is_read = 0 AND is_deleted = 0 ORDER BY id DESC LIMIT 1").bind(user.phone).first() : null;
        return Response.json({
            success: true, unreadCount: countRes.unread || 0, adminTyping: vis.showTyping && isFresh(thread && thread.admin_typing_at, TYPING_SECONDS),
            lastUnread: last ? { id: last.id, text: messagePreview(last).slice(0, 160) } : null,
        });
    } catch (e) { return Response.json({ error: "שגיאה בבדיקת הודעות" }, { status: 500 }); }
}

export async function handleUserSendMessage(request, env, ctx) {
    const body = await readBody(request);
    const { user, error } = await requireUser(env, body);
    if (error) return error;

    const text = cleanText(body.text);
    if (!text) return Response.json({ error: "לא ניתן לשלוח הודעה ריקה" }, { status: 400 });
    if (text.length > MAX_TEXT) return Response.json({ error: `ההודעה ארוכה מדי (עד ${MAX_TEXT} תווים)` }, { status: 400 });

    try {
        const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE user_phone = ? AND sender = 'user' AND created_at >= ?")
            .bind(user.phone, getFutureIsraelTimeForDB(-1)).first();
        if (recent && recent.n >= USER_RATE_PER_MINUTE) return Response.json({ error: "שלחת הרבה הודעות ברצף. נסה שוב בעוד דקה." }, { status: 429 });

        let replyTo = null;
        if (body.replyTo) {
            const target = await env.DB.prepare("SELECT id FROM chat_messages WHERE id = ? AND user_phone = ?").bind(Number(body.replyTo), user.phone).first();
            if (target) replyTo = target.id;
        }

        const now = getIsraelTimeForDB();
        const res = await env.DB.prepare("INSERT INTO chat_messages (user_phone, sender, message_text, created_at, updated_at, reply_to) VALUES (?, 'user', ?, ?, ?, ?)")
            .bind(user.phone, text, now, now, replyTo).run();
        await upsertThread(env, user.phone, { user_typing_at: null, archived: 0 });

        const notify = maybeNotifyAdmin(env, user.phone).catch(e => console.error('admin notify failed', e));
        if (ctx && ctx.waitUntil) ctx.waitUntil(notify); else await notify;

        return Response.json({ success: true, message: "ההודעה נשלחה בהצלחה", id: res.meta && res.meta.last_row_id, createdAt: now });
    } catch (e) { return Response.json({ error: "שגיאה בשליחת ההודעה" }, { status: 500 }); }
}

// שליחת קובץ מהלקוח למנהל (multipart: userToken, file, text, replyTo)
export async function handleUserSendFile(request, env, ctx) {
    const { form, file, error: bad } = await readUpload(request, env);
    if (bad) return bad;
    const { user, error } = await requireUser(env, { userToken: form.get('userToken') });
    if (error) return error;

    const text = cleanText(form.get('text'));
    if (text.length > MAX_TEXT) return Response.json({ error: `ההודעה ארוכה מדי (עד ${MAX_TEXT} תווים)` }, { status: 400 });

    try {
        if (await userFileQuotaExceeded(env, user.phone)) return Response.json({ error: "שלחת הרבה קבצים בשעה האחרונה. נסה שוב מאוחר יותר." }, { status: 429 });
        const replyTo = await validReply(env, form.get('replyTo'), user.phone);
        const f = await storeFile(env, user.phone, file);
        const th = await storeThumb(env, f.file_key, form).catch(() => ({ file_thumb_key: null, file_meta: null }));
        const now = getIsraelTimeForDB();
        const res = await env.DB.prepare(`INSERT INTO chat_messages (user_phone, sender, message_text, created_at, updated_at, reply_to, file_key, file_name, file_type, file_size, file_thumb_key, file_meta)
            VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(user.phone, text, now, now, replyTo, f.file_key, f.file_name, f.file_type, f.file_size, th.file_thumb_key, th.file_meta).run();
        await upsertThread(env, user.phone, { user_typing_at: null, archived: 0 });

        const notify = maybeNotifyAdmin(env, user.phone).catch(e => console.error('admin notify failed', e));
        if (ctx && ctx.waitUntil) ctx.waitUntil(notify); else await notify;

        return Response.json({ success: true, message: "הקובץ נשלח", id: res.meta && res.meta.last_row_id, createdAt: now });
    } catch (e) { console.error('chat file', e); return Response.json({ error: "שגיאה בשליחת הקובץ" }, { status: 500 }); }
}

async function validReply(env, id, phone) {
    if (!id) return null;
    const target = await env.DB.prepare("SELECT id FROM chat_messages WHERE id = ? AND user_phone = ?").bind(Number(id), phone).first();
    return target ? target.id : null;
}

export async function handleUserMarkRead(request, env) {
    const body = await readBody(request);
    const { user, error } = await requireUser(env, body);
    if (error) return error;
    // במאסטר ההודעות לא מסומנות כנקראו, כדי שלא ייראה שהלקוח קרא אותן
    if (user.is_master) return Response.json({ success: true });

    try {
        await env.DB.prepare("UPDATE chat_messages SET is_read = 1 WHERE user_phone = ? AND sender = 'admin' AND is_read = 0").bind(user.phone).run();
        await upsertThread(env, user.phone, { user_seen_at: getIsraelTimeForDB() });
        return Response.json({ success: true });
    } catch (e) { return Response.json({ error: "שגיאה בעדכון קריאה" }, { status: 500 }); }
}

export async function handleUserTyping(request, env) {
    const body = await readBody(request);
    const { user, error } = await requireUser(env, body);
    if (error) return error;
    if (user.is_master) return Response.json({ success: true });
    await upsertThread(env, user.phone, { user_typing_at: body.typing === false ? null : getIsraelTimeForDB() });
    return Response.json({ success: true });
}

// נוכחות הלקוח באתר: active (הלשונית פתוחה מולו), hidden (עבר לכרטיסייה אחרת), offline (סגר את האתר)
export async function handleUserPresence(request, env) {
    const text = await request.text().catch(() => '');
    let body = {};
    try { body = JSON.parse(text || '{}'); } catch (e) {}
    const { user, error } = await requireUser(env, body);
    if (error) return error;
    if (user.is_master) return Response.json({ success: true });
    const state = ['active', 'hidden', 'offline'].includes(body.state) ? body.state : 'active';
    const now = getIsraelTimeForDB();
    await env.DB.prepare(`INSERT INTO user_presence (phone, last_seen_at, page_state, page_state_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET page_state = excluded.page_state, page_state_at = excluded.page_state_at,
        last_seen_at = CASE WHEN excluded.page_state = 'offline' THEN user_presence.last_seen_at ELSE excluded.last_seen_at END`)
        .bind(user.phone, now, state, now).run();
    return Response.json({ success: true });
}

// פתיחת הקישור החד-פעמי מהמייל: מתעד את הפתיחה ופותח את הצ'אט (אם צריך - עם חיבור זמני)
export async function handleUserEmailLink(request, env) {
    const body = await readBody(request);
    const ip = request.headers.get('cf-connecting-ip') || '';
    const ua = (request.headers.get('user-agent') || '').slice(0, 400);
    const r = await redeemEmailLink(env, body.token);
    if (r.status === 'invalid') return Response.json({ error: "הקישור אינו תקין", code: 'invalid' }, { status: 404 });

    const link = r.link;
    const current = body.userToken ? await authenticateUser(env.DB, body.userToken) : null;
    const isOwner = current && current.phone === link.phone;

    if (r.status !== 'ok') {
        if (isOwner) return Response.json({ success: true, messageId: link.message_id, alreadyUsed: true });
        return Response.json({
            error: r.status === 'used' ? "הקישור כבר נוצל. יש להתחבר כדי לצפות בצ'אט." : "תוקף הקישור פג. יש להתחבר כדי לצפות בצ'אט.",
            code: r.status,
        }, { status: 410 });
    }

    // סימון כמשומש באופן אטומי, כדי ששתי לחיצות במקביל לא ינוצלו שתיהן
    const now = getIsraelTimeForDB();
    const upd = await env.DB.prepare("UPDATE chat_email_links SET used_at = ?, used_ip = ?, used_user_agent = ? WHERE id = ? AND used_at IS NULL").bind(now, ip, ua, r.id).run();
    if (!upd.meta || !upd.meta.changes) return Response.json({ error: "הקישור כבר נוצל. יש להתחבר כדי לצפות בצ'אט.", code: 'used' }, { status: 410 });
    await logActivity(env, link.phone, 'EMAIL_LINK_OPENED', JSON.stringify({ messageId: link.message_id }), ip, ua, now).catch(() => {});

    const msg = await env.DB.prepare("SELECT message_text, created_at FROM chat_messages WHERE id = ?").bind(link.message_id).first();
    const preview = msg ? { text: String(msg.message_text || '').slice(0, 500), createdAt: msg.created_at } : null;
    if (isOwner) return Response.json({ success: true, messageId: link.message_id, preview });

    const owner = await env.DB.prepare("SELECT phone, google_login_only FROM users WHERE phone = ?").bind(link.phone).first();
    if (!owner) return Response.json({ error: "החשבון לא נמצא", code: 'invalid' }, { status: 404 });
    // חשבון שננעל לכניסה עם Google בלבד: מציגים את ההודעה, אבל הכניסה נשארת דרך Google
    if (owner.google_login_only === 1) return Response.json({ success: true, messageId: link.message_id, preview, needLogin: true, googleOnly: true });

    const token = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO user_tokens (id, phone, token_type, created_at, expires_at, last_used_at, session_email) VALUES (?, ?, 'email_link', ?, ?, ?, ?)")
        .bind(token, owner.phone, now, getFutureIsraelTimeForDB(30), now, link.email || null).run();
    return Response.json({ success: true, messageId: link.message_id, preview, userToken: token });
}

export async function handleUserDeleteMessage(request, env) {
    return Response.json({ error: "הנהלת האתר ביטלה את האפשרות למחוק הודעות מצד המשתמש." }, { status: 403 });
}

// ==========================================
// צד המנהל הראשי
// ==========================================

async function requireAdmin(env, body) {
    if (!(await isMainAdmin(env, body.adminToken))) return body.adminToken ? sessionExpired() : forbidden("הצ'אט זמין למנהל הראשי בלבד");
    // "active" נשלח רק כשהמנהל באמת פעיל מול המסך, כדי שהתראות המייל יידעו מתי הוא לא זמין
    if (body.active) await markAdminActive(env).catch(() => {});
    return null;
}

export async function handleAdminGetConversations(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;

    try {
        const [{ results }, threadsRes, namesMap, usersRes] = await Promise.all([
            env.DB.prepare(`SELECT user_phone, MAX(created_at) AS last_message_time, MAX(id) AS last_id, COUNT(*) AS total,
                SUM(CASE WHEN sender = 'user' AND is_read = 0 AND is_deleted = 0 THEN 1 ELSE 0 END) AS unread_count
                FROM chat_messages GROUP BY user_phone`).all(),
            env.DB.prepare("SELECT * FROM chat_threads").all(),
            getAllNamesFromIni(env.YEMOT_TOKEN),
            env.DB.prepare("SELECT phone, email FROM users").all(),
        ]);
        const rows = results || [];
        const lastIds = rows.map(r => r.last_id);
        const lastMap = {};
        // שליפה במקבצים כדי לא לחרוג ממגבלת הפרמטרים של D1
        for (let i = 0; i < lastIds.length; i += 90) {
            const chunk = lastIds.slice(i, i + 90);
            const { results: last } = await env.DB.prepare(`SELECT id, sender, message_text, is_deleted, file_key, file_name, file_type FROM chat_messages WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
            for (const m of last || []) lastMap[m.id] = m;
        }
        const threads = {};
        for (const t of threadsRes.results || []) threads[t.user_phone] = t;
        const emails = {};
        for (const u of usersRes.results || []) emails[u.phone] = u.email || '';
        const presence = await getPresenceMap(env);

        const conversations = rows.map(r => {
            const t = threads[r.user_phone] || {};
            const last = lastMap[r.last_id] || {};
            const p = presence[r.user_phone] || {};
            return {
                user_phone: r.user_phone,
                user_name: namesMap[r.user_phone] || 'משתמש לא מזוהה',
                last_message_time: r.last_message_time,
                unread_count: r.unread_count || 0,
                total: r.total,
                last_message: { sender: last.sender, text: last.is_deleted === 1 ? DELETED_TEXT : messagePreview(last).slice(0, 140) },
                online: !!p.online, presence: p.status || 'offline', last_seen_at: p.lastSeenAt || null,
                typing: isFresh(t.user_typing_at, TYPING_SECONDS),
                pinned: t.pinned === 1, archived: t.archived === 1, note: t.note || '',
                has_account: r.user_phone in emails, email: emails[r.user_phone] || '',
                last_id: r.last_id,
            };
        });

        // לקוח חדש שמקליד את ההודעה הראשונה שלו מופיע מיד ברשימה
        const known = new Set(rows.map(r => r.user_phone));
        for (const t of threadsRes.results || []) {
            if (known.has(t.user_phone) || !isFresh(t.user_typing_at, TYPING_SECONDS)) continue;
            const p = presence[t.user_phone] || {};
            conversations.push({
                user_phone: t.user_phone, user_name: namesMap[t.user_phone] || 'משתמש לא מזוהה', last_message_time: t.user_typing_at,
                unread_count: 0, total: 0, last_message: { sender: 'user', text: '' }, online: !!p.online, last_seen_at: p.lastSeenAt || null,
                typing: true, pinned: t.pinned === 1, archived: false, note: t.note || '',
                has_account: t.user_phone in emails, email: emails[t.user_phone] || '', last_id: Number.MAX_SAFE_INTEGER,
            });
        }
        conversations.sort((a, b) => (b.pinned - a.pinned) || (b.last_id - a.last_id));

        return Response.json({ success: true, conversations });
    } catch (e) { return Response.json({ error: "שגיאה בשליפת שיחות" }, { status: 500 }); }
}

export async function handleAdminGetChat(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    if (!body.targetPhone) return Response.json({ error: "חסר טלפון יעד" }, { status: 400 });

    const phone = String(body.targetPhone);
    try {
        const [{ rows, hasMore }, thread, user, presence, userName] = await Promise.all([
            fetchPage(env, phone, body.beforeId),
            env.DB.prepare("SELECT * FROM chat_threads WHERE user_phone = ?").bind(phone).first(),
            env.DB.prepare("SELECT email, receive_emails FROM users WHERE phone = ?").bind(phone).first(),
            getPresenceMap(env, [phone]),
            getNameFromIni(phone, env.YEMOT_TOKEN).catch(() => null),
        ]);
        const replies = await attachReplies(env, rows);
        // תיעוד מיילים לכל הודעה: מתי נשלח ומתי הלקוח פתח את הקישור
        const { results: links } = await env.DB.prepare("SELECT message_id, created_at, sent_ok, used_at, used_ip FROM chat_email_links WHERE phone = ? ORDER BY created_at").bind(phone).all();
        const emailByMsg = {};
        for (const l of links || []) emailByMsg[l.message_id] = { sentAt: l.created_at, ok: l.sent_ok === 1, openedAt: l.used_at, openedIp: l.used_ip };
        const messages = await Promise.all(rows.map(async ({ file_key, file_token, file_thumb_key, ...m }) => ({
            ...m, edited: isEdited(m), reply: m.reply_to ? (replies[m.reply_to] || null) : null, email: emailByMsg[m.id] || null,
            file: await fileInfoWithLinks(env, request, { ...m, file_key, file_thumb_key }, 'admin'),
        })));
        const t = thread || {};
        const p = presence[phone] || {};
        return Response.json({
            success: true, messages, hasMore, userName: userName || 'משתמש לא מזוהה',
            userTyping: isFresh(t.user_typing_at, TYPING_SECONDS),
            presence: { online: !!p.online, status: p.status || 'offline', lastSeenAt: p.lastSeenAt || null, device: p.device || '' },
            thread: { pinned: t.pinned === 1, archived: t.archived === 1, note: t.note || '', userSeenAt: t.user_seen_at || null, userNotifiedAt: t.user_notified_at || null },
            user: user ? { hasAccount: true, email: user.email || '', receiveEmails: user.receive_emails !== 0 } : { hasAccount: false },
        });
    } catch (e) { return Response.json({ error: "שגיאה בשליפת הודעות" }, { status: 500 }); }
}

export async function handleAdminSendMessage(request, env, ctx) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, { ...body, active: true });
    if (denied) return denied;

    const phone = body.targetPhone ? String(body.targetPhone) : '';
    const text = cleanText(body.text);
    if (!phone || !text) return Response.json({ error: "נתונים חסרים" }, { status: 400 });
    if (text.length > MAX_TEXT) return Response.json({ error: `ההודעה ארוכה מדי (עד ${MAX_TEXT} תווים)` }, { status: 400 });

    try {
        let replyTo = null;
        if (body.replyTo) {
            const target = await env.DB.prepare("SELECT id FROM chat_messages WHERE id = ? AND user_phone = ?").bind(Number(body.replyTo), phone).first();
            if (target) replyTo = target.id;
        }
        const now = getIsraelTimeForDB();
        const res = await env.DB.prepare("INSERT INTO chat_messages (user_phone, sender, message_text, created_at, updated_at, reply_to) VALUES (?, 'admin', ?, ?, ?, ?)")
            .bind(phone, text, now, now, replyTo).run();
        await upsertThread(env, phone, { admin_typing_at: null, archived: 0 });

        const messageId = res.meta && res.meta.last_row_id;
        const email = await emailIfAsked(env, ctx, phone, messageId, body.sendEmail === true || body.emailMode === 'always');
        return Response.json({ success: true, message: "ההודעה נשלחה", id: messageId, email });
    } catch (e) { return Response.json({ error: "שגיאה בשליחת הודעה" }, { status: 500 }); }
}

// מייל ללקוח נשלח רק כשהמנהל סימן זאת במפורש על ההודעה
// fileMode: 'link' - במייל רק קישור לצ'אט (הקובץ נפתח אחרי התחברות), 'attach' - הקובץ מצורף למייל
async function emailIfAsked(env, ctx, phone, messageId, asked, fileMode = 'link') {
    if (!asked) return 'none';
    const can = await canEmailCustomer(env, phone);
    if (!can.ok) return can.reason;
    const job = sendCustomerMessageEmail(env, phone, messageId, can.email, { attach: fileMode === 'attach' }).catch(e => console.error('customer email failed', e));
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    return 'queued';
}

// שליחת קובץ מהמנהל ללקוח (multipart: adminToken, targetPhone, file, text, replyTo, sendEmail)
export async function handleAdminSendFile(request, env, ctx) {
    const { form, file, error: bad } = await readUpload(request, env);
    if (bad) return bad;
    const denied = await requireAdmin(env, { adminToken: form.get('adminToken'), active: true });
    if (denied) return denied;

    const phone = form.get('targetPhone') ? String(form.get('targetPhone')) : '';
    const text = cleanText(form.get('text'));
    if (!phone) return Response.json({ error: "חסר טלפון יעד" }, { status: 400 });
    if (text.length > MAX_TEXT) return Response.json({ error: `ההודעה ארוכה מדי (עד ${MAX_TEXT} תווים)` }, { status: 400 });
    const limits = parseLimits(form.get('maxViews'), form.get('expiresMinutes'));
    const wantEmail = form.get('sendEmail') === '1' || form.get('sendEmail') === 'true';
    const fileMode = form.get('emailFile') === 'attach' ? 'attach' : 'link';
    // צירוף הקובץ למייל היה עוקף את מגבלות הצפייה
    if (wantEmail && fileMode === 'attach' && isLimited(limits)) return Response.json({ error: "אי אפשר לצרף למייל קובץ עם הגבלת צפייה או תוקף. שלח קישור בלבד." }, { status: 400 });
    if (wantEmail && fileMode === 'attach' && file.size > MAX_EMAIL_ATTACHMENT) return Response.json({ error: `קובץ מעל ${MAX_EMAIL_ATTACHMENT / 1024 / 1024}MB אי אפשר לצרף למייל. שלח קישור בלבד.` }, { status: 400 });

    try {
        const replyTo = await validReply(env, form.get('replyTo'), phone);
        const f = await storeFile(env, phone, file);
        const th = await storeThumb(env, f.file_key, form).catch(() => ({ file_thumb_key: null, file_meta: null }));
        const now = getIsraelTimeForDB();
        const res = await env.DB.prepare(`INSERT INTO chat_messages (user_phone, sender, message_text, created_at, updated_at, reply_to, file_key, file_name, file_type, file_size, file_max_views, file_views, file_expires_at, file_thumb_key, file_meta)
            VALUES (?, 'admin', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
            .bind(phone, text, now, now, replyTo, f.file_key, f.file_name, f.file_type, f.file_size, limits.file_max_views, limits.file_expires_at, th.file_thumb_key, th.file_meta).run();
        await upsertThread(env, phone, { admin_typing_at: null, archived: 0 });
        const messageId = res.meta && res.meta.last_row_id;
        const email = await emailIfAsked(env, ctx, phone, messageId, wantEmail, fileMode);
        return Response.json({ success: true, message: "הקובץ נשלח", id: messageId, email });
    } catch (e) { console.error('chat file', e); return Response.json({ error: "שגיאה בשליחת הקובץ" }, { status: 500 }); }
}

export async function handleAdminEditMessage(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, { ...body, active: true });
    if (denied) return denied;
    const text = cleanText(body.text);
    if (!body.messageId || !text) return Response.json({ error: "נתונים חסרים" }, { status: 400 });
    if (text.length > MAX_TEXT) return Response.json({ error: "ההודעה ארוכה מדי" }, { status: 400 });

    const res = await env.DB.prepare("UPDATE chat_messages SET message_text = ?, updated_at = ?, edited_at = ? WHERE id = ? AND sender = 'admin' AND is_deleted = 0")
        .bind(text, getIsraelTimeForDB(), getIsraelTimeForDB(), Number(body.messageId)).run();
    if (!res.meta || !res.meta.changes) return Response.json({ error: "ניתן לערוך רק הודעות שלך שלא נמחקו" }, { status: 404 });
    return Response.json({ success: true });
}

export async function handleAdminTyping(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, { ...body, active: true });
    if (denied) return denied;
    if (!body.targetPhone) return Response.json({ error: "חסר טלפון יעד" }, { status: 400 });
    await upsertThread(env, String(body.targetPhone), { admin_typing_at: body.typing === false ? null : getIsraelTimeForDB() });
    return Response.json({ success: true });
}

export async function handleAdminThreadMeta(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, { ...body, active: true });
    if (denied) return denied;
    if (!body.targetPhone) return Response.json({ error: "חסר טלפון יעד" }, { status: 400 });

    const fields = {};
    if (body.pinned !== undefined) fields.pinned = body.pinned ? 1 : 0;
    if (body.archived !== undefined) fields.archived = body.archived ? 1 : 0;
    if (body.note !== undefined) fields.note = String(body.note || '').slice(0, 1000);
    if (!Object.keys(fields).length) return Response.json({ error: "לא נשלחו שינויים" }, { status: 400 });
    await upsertThread(env, String(body.targetPhone), fields);
    return Response.json({ success: true });
}

export async function handleAdminMarkUnread(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, { ...body, active: true });
    if (denied) return denied;
    if (!body.targetPhone) return Response.json({ error: "חסר טלפון יעד" }, { status: 400 });
    const last = await env.DB.prepare("SELECT id FROM chat_messages WHERE user_phone = ? AND sender = 'user' AND is_deleted = 0 ORDER BY id DESC LIMIT 1").bind(String(body.targetPhone)).first();
    if (!last) return Response.json({ error: "אין הודעות מהלקוח בשיחה זו" }, { status: 404 });
    await env.DB.prepare("UPDATE chat_messages SET is_read = 0 WHERE id = ?").bind(last.id).run();
    return Response.json({ success: true });
}

// שינוי המגבלות של קובץ שהמנהל שלח: מספר צפיות, תוקף, איפוס הספירה או חסימה מיידית
export async function handleAdminFileLimits(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, { ...body, active: true });
    if (denied) return denied;
    const id = Number(body.messageId);
    const row = id ? await env.DB.prepare("SELECT id, file_key, file_views FROM chat_messages WHERE id = ? AND sender = 'admin'").bind(id).first() : null;
    if (!row || !row.file_key) return Response.json({ error: "הקובץ לא נמצא" }, { status: 404 });

    const views = body.resetViews ? 0 : (row.file_views || 0);
    let fields;
    if (body.revoke) fields = { file_max_views: 0 };
    else {
        const l = parseLimits(body.maxViews, body.expiresMinutes);
        fields = { file_max_views: l.file_max_views, file_expires_at: body.keepExpiry ? undefined : l.file_expires_at };
    }
    const sets = ['file_views = ?'], vals = [views];
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); }
    await env.DB.prepare(`UPDATE chat_messages SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, getIsraelTimeForDB(), id).run();
    const updated = await env.DB.prepare("SELECT * FROM chat_messages WHERE id = ?").bind(id).first();
    return Response.json({ success: true, file: await fileInfoWithLinks(env, request, updated, 'admin') });
}

export async function handleAdminSearchMessages(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const q = String(body.q || '').trim();
    if (q.length < 2) return Response.json({ success: true, results: [] });

    const like = `%${q.replace(/[\\%_]/g, c => '\\' + c)}%`;
    const [{ results }, names] = await Promise.all([
        env.DB.prepare("SELECT id, user_phone, sender, message_text, file_key, file_name, file_type, created_at FROM chat_messages WHERE is_deleted = 0 AND (message_text LIKE ? ESCAPE '\\' OR file_name LIKE ? ESCAPE '\\') ORDER BY id DESC LIMIT 50").bind(like, like).all(),
        getAllNamesFromIni(env.YEMOT_TOKEN),
    ]);
    return Response.json({
        success: true,
        results: (results || []).map(r => ({ id: r.id, phone: r.user_phone, name: names[r.user_phone] || '', sender: r.sender, text: messagePreview(r), createdAt: r.created_at })),
    });
}

export async function handleAdminChatSettings(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;

    if (body.settings) {
        const input = body.settings;
        const values = {};
        if (input.notify_admin_enabled !== undefined) values.notify_admin_enabled = input.notify_admin_enabled ? '1' : '0';
        const clamp = (v, min, max) => String(Math.min(max, Math.max(min, Math.round(Number(v) || min))));
        if (input.notify_idle_minutes !== undefined) values.notify_idle_minutes = clamp(input.notify_idle_minutes, 1, 240);
        if (input.notify_cooldown_minutes !== undefined) values.notify_cooldown_minutes = clamp(input.notify_cooldown_minutes, 1, 1440);
        for (const k of ['admin_show_presence', 'admin_show_typing', 'admin_show_read_receipts']) {
            if (input[k] !== undefined) values[k] = input[k] ? '1' : '0';
        }
        await setSettings(env, values, getIsraelTimeForDB());
    }

    const s = await getSettings(env);
    const out = {};
    for (const k of EDITABLE_SETTINGS) out[k] = s[k];
    // ההתראות נשלחות למייל של חשבון מנהל-העל
    out.notify_recipient = await getSuperAdminEmail(env) || '';
    out.super_admin_set = !!s.super_admin_phone;
    return Response.json({ success: true, settings: out });
}

export async function handleAdminChatTestEmail(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const r = await sendTestAdminEmail(env);
    if (r.error) return Response.json({ error: r.error }, { status: 400 });
    return r.ok ? Response.json({ success: true, message: `מייל בדיקה נשלח אל ${r.to}` }) : Response.json({ error: "שליחת המייל נכשלה" }, { status: 500 });
}

export async function handleAdminSendCustomEmail(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    if (!body.email || !body.subject || !body.content) return Response.json({ error: "חסרים פרטים לשליחה" }, { status: 400 });

    try {
        const htmlContent = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; direction: rtl; text-align: right;">
            <p style="white-space: pre-wrap; font-size: 16px; color: #334155; line-height: 1.6;">${escapeHtml(body.content)}</p>
            <div style="margin-top: 30px; text-align: center;">
                <a href="https://smti.uk/salamon" style="background: #0f172a; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 8px; font-weight: bold;">למעבר למערכת עכשיו סלומון</a>
            </div>
        </div>`;

        const success = await sendEmail(env, body.email, body.subject, htmlContent, body.content);
        if (success) return Response.json({ success: true, message: "המייל נשלח בהצלחה" });
        else return Response.json({ error: "שגיאה בשליחת המייל דרך שרת הדואר" }, { status: 500 });
    } catch (e) { return Response.json({ error: "שגיאת מערכת בשליחת המייל" }, { status: 500 }); }
}

export async function handleAdminMarkRead(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, { ...body, active: true });
    if (denied) return denied;
    if (!body.targetPhone) return Response.json({ error: "נתונים חסרים" }, { status: 400 });

    try {
        await env.DB.prepare("UPDATE chat_messages SET is_read = 1 WHERE user_phone = ? AND sender = 'user' AND is_read = 0").bind(String(body.targetPhone)).run();
        return Response.json({ success: true });
    } catch (e) { return Response.json({ error: "שגיאה בעדכון קריאה" }, { status: 500 }); }
}

export async function handleAdminDeleteMessage(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, { ...body, active: true });
    if (denied) return denied;
    const ids = [...new Set((Array.isArray(body.messageIds) ? body.messageIds : [body.messageId]).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 500);
    if (!ids.length) return Response.json({ error: "חסר מזהה הודעה" }, { status: 400 });

    try {
        const marks = ids.map(() => '?').join(',');
        const now = getIsraelTimeForDB();
        const files = body.hardDelete ? await env.DB.prepare(`SELECT file_key FROM chat_messages WHERE id IN (${marks}) AND file_key IS NOT NULL`).bind(...ids).all() : null;
        // מחיקה רכה שומרת עותק של הטקסט שרק המנהל רואה, כדי שאפשר יהיה לשחזר או למחוק לצמיתות מאוחר יותר.
        // הודעה שכבר נמחקה רכה נמחקת עכשיו לצמיתות.
        const stmts = body.hardDelete
            ? [env.DB.prepare(`DELETE FROM chat_messages WHERE id IN (${marks})`).bind(...ids),
               env.DB.prepare(`DELETE FROM chat_email_links WHERE message_id IN (${marks})`).bind(...ids)]
            : [env.DB.prepare(`UPDATE chat_messages SET deleted_text = message_text, deleted_at = ?, is_deleted = 1, message_text = '', updated_at = ? WHERE id IN (${marks}) AND is_deleted = 0`).bind(now, now, ...ids)];
        await env.DB.batch(stmts);
        if (files) await removeFiles(env, (files.results || []).map(r => r.file_key));
        return Response.json({ success: true, deleted: ids.length, message: ids.length > 1 ? `${ids.length} הודעות נמחקו` : "ההודעה נמחקה בהצלחה" });
    } catch (e) { return Response.json({ error: "שגיאה במחיקת ההודעה" }, { status: 500 }); }
}

// שחזור הודעה שנמחקה רכה (כל עוד לא נמחקה לצמיתות)
export async function handleAdminRestoreMessage(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, { ...body, active: true });
    if (denied) return denied;
    const id = Number(body.messageId);
    if (!id) return Response.json({ error: "חסר מזהה הודעה" }, { status: 400 });
    const res = await env.DB.prepare("UPDATE chat_messages SET message_text = COALESCE(deleted_text, ''), deleted_text = NULL, deleted_at = NULL, is_deleted = 0, updated_at = ? WHERE id = ? AND is_deleted = 1 AND ((deleted_text IS NOT NULL AND deleted_text != '') OR file_key IS NOT NULL)")
        .bind(getIsraelTimeForDB(), id).run();
    if (!res.meta || !res.meta.changes) return Response.json({ error: "אי אפשר לשחזר את ההודעה הזו (נמחקה לפני שנשמר עותק)" }, { status: 400 });
    return Response.json({ success: true });
}

// ניקוי שיחה: כל ההודעות שנמחקו, או השיחה כולה
export async function handleAdminPurgeChat(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, { ...body, active: true });
    if (denied) return denied;
    const phone = body.targetPhone ? String(body.targetPhone) : '';
    if (!phone || !['deleted', 'all'].includes(body.scope)) return Response.json({ error: "נתונים חסרים" }, { status: 400 });

    const where = body.scope === 'all' ? "user_phone = ?" : "user_phone = ? AND is_deleted = 1";
    const { results } = await env.DB.prepare(`SELECT id, file_key FROM chat_messages WHERE ${where}`).bind(phone).all();
    const ids = (results || []).map(r => r.id);
    const stmts = [env.DB.prepare(`DELETE FROM chat_messages WHERE ${where}`).bind(phone)];
    if (body.scope === 'all') {
        stmts.push(env.DB.prepare("DELETE FROM chat_email_links WHERE phone = ?").bind(phone));
        stmts.push(env.DB.prepare("DELETE FROM chat_threads WHERE user_phone = ?").bind(phone));
    } else {
        for (let i = 0; i < ids.length; i += 90) {
            const chunk = ids.slice(i, i + 90);
            stmts.push(env.DB.prepare(`DELETE FROM chat_email_links WHERE message_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk));
        }
    }
    await env.DB.batch(stmts);
    await removeFiles(env, (results || []).map(r => r.file_key));
    return Response.json({ success: true, deleted: ids.length });
}
