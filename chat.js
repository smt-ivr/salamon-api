// chat.js
// צ'אט בין הלקוחות למנהל הראשי: הודעות, ציטוטים, עריכה, "מקליד/ה", נוכחות, הצמדה/ארכיון/הערות וחיפוש.
// צד הניהול שמור למנהל הראשי בלבד.

import { authenticateUser } from './auth.js';
import { getIsraelTimeForDB, getFutureIsraelTimeForDB, getMinutesSinceIsraelDbTime } from './timeUtils.js';
import { sendEmail, escapeHtml } from './emailService.js';
import { getNameFromIni, getAllNamesFromIni } from './yemot.js';
import { isMainAdmin, forbidden } from './adminAuth.js';
import { getSettings, setSettings, SETTING_DEFAULTS } from './schema.js';
import { getPresenceMap } from './activity.js';
import { markAdminActive, maybeNotifyAdmin, decideCustomerEmail, sendCustomerReplyEmail, sendTestAdminEmail } from './chatNotify.js';

const MAX_TEXT = 2000;
const TYPING_SECONDS = 7;
const PAGE_SIZE = 150;
const USER_RATE_PER_MINUTE = 15;
const ADMIN_ONLINE_MINUTES = 3;

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
    const { results } = await env.DB.prepare(`SELECT id, sender, message_text, is_deleted FROM chat_messages WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    const map = {};
    for (const r of results || []) map[r.id] = { id: r.id, sender: r.sender, text: r.is_deleted === 1 ? DELETED_TEXT : String(r.message_text || '').slice(0, 200) };
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
        const messages = rows.map(msg => ({
            id: msg.id, sender: msg.sender, text: msg.is_deleted === 1 ? DELETED_TEXT : msg.message_text,
            isRead: msg.is_read === 1, isDeleted: msg.is_deleted === 1, createdAt: msg.created_at,
            edited: isEdited(msg), replyTo: msg.reply_to ? (replies[msg.reply_to] || null) : null,
        }));
        const adminLast = settings.admin_last_active_at || null;
        return Response.json({
            success: true, messages, hasMore,
            adminTyping: isFresh(thread && thread.admin_typing_at, TYPING_SECONDS),
            admin: { online: !!adminLast && getMinutesSinceIsraelDbTime(adminLast) <= ADMIN_ONLINE_MINUTES, lastActiveAt: adminLast },
        });
    } catch (e) { return Response.json({ error: "שגיאה בשליפת ההודעות" }, { status: 500 }); }
}

export async function handleUserCheckUnread(request, env) {
    const body = await readBody(request);
    const { user, error } = await requireUser(env, body);
    if (error) return error;

    try {
        const [countRes, thread] = await Promise.all([
            env.DB.prepare("SELECT COUNT(*) as unread FROM chat_messages WHERE user_phone = ? AND sender = 'admin' AND is_read = 0 AND is_deleted = 0").bind(user.phone).first(),
            env.DB.prepare("SELECT admin_typing_at FROM chat_threads WHERE user_phone = ?").bind(user.phone).first(),
        ]);
        return Response.json({ success: true, unreadCount: countRes.unread || 0, adminTyping: isFresh(thread && thread.admin_typing_at, TYPING_SECONDS) });
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

export async function handleUserMarkRead(request, env) {
    const body = await readBody(request);
    const { user, error } = await requireUser(env, body);
    if (error) return error;

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
    await upsertThread(env, user.phone, { user_typing_at: body.typing === false ? null : getIsraelTimeForDB() });
    return Response.json({ success: true });
}

export async function handleUserDeleteMessage(request, env) {
    return Response.json({ error: "הנהלת האתר ביטלה את האפשרות למחוק הודעות מצד המשתמש." }, { status: 403 });
}

// ==========================================
// צד המנהל הראשי
// ==========================================

async function requireAdmin(env, body) {
    if (!(await isMainAdmin(env, body.adminToken))) return forbidden("הצ'אט זמין למנהל הראשי בלבד");
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
            const { results: last } = await env.DB.prepare(`SELECT id, sender, message_text, is_deleted FROM chat_messages WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
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
                last_message: { sender: last.sender, text: last.is_deleted === 1 ? DELETED_TEXT : String(last.message_text || '').slice(0, 140) },
                online: !!p.online, last_seen_at: p.lastSeenAt || null,
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
        const messages = rows.map(m => ({ ...m, edited: isEdited(m), reply: m.reply_to ? (replies[m.reply_to] || null) : null }));
        const t = thread || {};
        const p = presence[phone] || {};
        return Response.json({
            success: true, messages, hasMore, userName: userName || 'משתמש לא מזוהה',
            userTyping: isFresh(t.user_typing_at, TYPING_SECONDS),
            presence: { online: !!p.online, lastSeenAt: p.lastSeenAt || null, device: p.device || '' },
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

        // מצב המייל: מהבקשה, או מהגדרת ברירת המחדל. sendEmail הישן נתמך לתאימות.
        let mode = body.emailMode;
        if (!mode) mode = body.sendEmail === true ? 'always' : (await getSettings(env)).customer_email_mode || 'auto';
        if (!['auto', 'always', 'never'].includes(mode)) mode = 'auto';

        const decision = await decideCustomerEmail(env, phone, mode);
        if (decision.send) {
            // תופסים את ההתראה מיד כדי שהודעות נוספות ברצף לא ישלחו מייל כפול,
            // ושולחים אחרי השהיה קצרה כדי שהמייל יכלול את כל התשובות שנכתבו ברצף.
            await upsertThread(env, phone, { user_notified_at: now });
            const delay = Number(env.CHAT_EMAIL_DELAY_MS ?? 12000);
            const job = new Promise(r => setTimeout(r, delay))
                .then(() => sendCustomerReplyEmail(env, phone, decision.email))
                .catch(e => console.error('customer email failed', e));
            if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
        }
        return Response.json({ success: true, message: "ההודעה נשלחה", id: res.meta && res.meta.last_row_id, email: decision.send ? 'queued' : decision.reason });
    } catch (e) { return Response.json({ error: "שגיאה בשליחת הודעה" }, { status: 500 }); }
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

export async function handleAdminSearchMessages(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const q = String(body.q || '').trim();
    if (q.length < 2) return Response.json({ success: true, results: [] });

    const like = `%${q.replace(/[\\%_]/g, c => '\\' + c)}%`;
    const [{ results }, names] = await Promise.all([
        env.DB.prepare("SELECT id, user_phone, sender, message_text, created_at FROM chat_messages WHERE is_deleted = 0 AND message_text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 50").bind(like).all(),
        getAllNamesFromIni(env.YEMOT_TOKEN),
    ]);
    return Response.json({
        success: true,
        results: (results || []).map(r => ({ id: r.id, phone: r.user_phone, name: names[r.user_phone] || '', sender: r.sender, text: r.message_text, createdAt: r.created_at })),
    });
}

export async function handleAdminChatSettings(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;

    if (body.settings) {
        const input = body.settings;
        const values = {};
        if (input.notify_admin_email !== undefined) {
            const email = String(input.notify_admin_email || '').trim().toLowerCase();
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: "כתובת האימייל אינה תקינה" }, { status: 400 });
            values.notify_admin_email = email;
        }
        if (input.notify_admin_enabled !== undefined) values.notify_admin_enabled = input.notify_admin_enabled ? '1' : '0';
        const clamp = (v, min, max) => String(Math.min(max, Math.max(min, Math.round(Number(v) || min))));
        if (input.notify_idle_minutes !== undefined) values.notify_idle_minutes = clamp(input.notify_idle_minutes, 1, 240);
        if (input.notify_cooldown_minutes !== undefined) values.notify_cooldown_minutes = clamp(input.notify_cooldown_minutes, 1, 1440);
        if (input.customer_offline_minutes !== undefined) values.customer_offline_minutes = clamp(input.customer_offline_minutes, 1, 120);
        if (input.customer_email_mode !== undefined) {
            if (!['auto', 'always', 'never'].includes(input.customer_email_mode)) return Response.json({ error: "מצב מייל לא חוקי" }, { status: 400 });
            values.customer_email_mode = input.customer_email_mode;
        }
        await setSettings(env, values, getIsraelTimeForDB());
    }

    const s = await getSettings(env);
    const out = {};
    for (const k of Object.keys(SETTING_DEFAULTS)) out[k] = s[k];
    return Response.json({ success: true, settings: out });
}

export async function handleAdminChatTestEmail(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const s = await getSettings(env);
    if (!s.notify_admin_email) return Response.json({ error: "לא הוגדרה כתובת מייל להתראות" }, { status: 400 });
    const ok = await sendTestAdminEmail(env, s.notify_admin_email);
    return ok ? Response.json({ success: true, message: `מייל בדיקה נשלח אל ${s.notify_admin_email}` }) : Response.json({ error: "שליחת המייל נכשלה" }, { status: 500 });
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
    if (!body.messageId) return Response.json({ error: "חסר מזהה הודעה" }, { status: 400 });

    try {
        if (body.hardDelete) await env.DB.prepare("DELETE FROM chat_messages WHERE id = ?").bind(body.messageId).run();
        else await env.DB.prepare("UPDATE chat_messages SET is_deleted = 1, message_text = '', updated_at = ? WHERE id = ?").bind(getIsraelTimeForDB(), body.messageId).run();
        return Response.json({ success: true, message: "ההודעה נמחקה בהצלחה" });
    } catch (e) { return Response.json({ error: "שגיאה במחיקת ההודעה" }, { status: 500 }); }
}
