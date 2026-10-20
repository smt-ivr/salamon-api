// chatNotify.js
// מיילים של מערכת הצ'אט:
// • למנהל - למייל של חשבון מנהל-העל, רק כשלא היה פעיל בצ'אט זמן מה, ופעם אחת לכל שיחה עד שיחזור.
//   אם לא הוגדר מנהל-על (או שאין לו מייל) - לא נשלח כלום.
// • ללקוח - רק כשהמנהל סימן "שלח גם במייל" על ההודעה. המייל כולל קישור חד-פעמי שפותח את הצ'אט,
//   וכל פתיחה של הקישור מתועדת.

import { sendEmail, escapeHtml } from './emailService.js';
import { getIsraelTimeForDB, getFutureIsraelTimeForDB, getMinutesSinceIsraelDbTime, isPastIsraelTime } from './timeUtils.js';
import { getSettings, setSettings } from './schema.js';
import { getNameFromIni } from './yemot.js';
import { messagePreview, emailAttachment, isLimited } from './chatFiles.js';

const ADMIN_CHAT_URL = 'https://smti.uk/salamon/admin#chat/';
const SITE_URL = 'https://smti.uk/salamon';
const LINK_DAYS = 7;
const LOGO = 'https://smt-tel-manager.netlify.app/salamon-logo.png';

let lastActiveWrite = 0;

// נקרא בכל פעולה של המנהל בצ'אט. נכתב למסד לכל היותר פעם ב-20 שניות.
export async function markAdminActive(env) {
    if (Date.now() - lastActiveWrite < 20000) return;
    lastActiveWrite = Date.now();
    await setSettings(env, { admin_last_active_at: getIsraelTimeForDB() }, getIsraelTimeForDB());
}

async function setThreadField(env, phone, field, value) {
    await env.DB.prepare(`INSERT INTO chat_threads (user_phone, ${field}, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_phone) DO UPDATE SET ${field} = excluded.${field}, updated_at = excluded.updated_at`)
        .bind(phone, value, getIsraelTimeForDB()).run();
}

export async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// כתובת המייל של מנהל-העל (או null)
export async function getSuperAdminEmail(env) {
    const s = await getSettings(env);
    if (!s.super_admin_phone) return null;
    const u = await env.DB.prepare("SELECT email FROM users WHERE phone = ?").bind(s.super_admin_phone).first();
    return u && u.email ? u.email : null;
}

// ---------- תבנית מייל ----------

function formatTime(dbTime) {
    if (!dbTime) return '';
    const [d, t] = String(dbTime).split(' ');
    const [, m, day] = (d || '').split('-');
    return `${day}/${m} · ${String(t || '').slice(0, 5)}`;
}

function messageHtml(text) {
    return escapeHtml(text).replace(/\n/g, '<br>');
}

// מעטפת מייל מעוצבת, בנויה בטבלאות כדי להיראות נכון ב-Gmail, Outlook ובטלפון
function layout({ preheader, eyebrow, title, body, cta, footnote, unsubscribeUrl }) {
    return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title></head>
<body style="margin:0; padding:0; background:#eef1f7;">
<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${escapeHtml(preheader || '')}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef1f7;">
<tr><td align="center" style="padding:32px 14px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px; font-family:'Segoe UI',Arial,Helvetica,sans-serif; direction:rtl; text-align:right;">
        <tr><td align="center" style="padding:0 0 18px 0;">
            <table role="presentation" cellspacing="0" cellpadding="0"><tr>
                <td style="padding-left:10px;"><img src="${LOGO}" width="40" height="40" alt="" style="display:block; border-radius:50%; border:0;"></td>
                <td style="font-size:17px; font-weight:700; color:#0f172a;">עכשיו סלומון</td>
            </tr></table>
        </td></tr>
        <tr><td style="background:#ffffff; border-radius:22px; box-shadow:0 12px 32px rgba(15,23,42,.08); overflow:hidden;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr><td style="height:6px; background:#16a34a; background-image:linear-gradient(90deg,#16a34a,#0ea5e9); font-size:0; line-height:0;">&nbsp;</td></tr>
                <tr><td style="padding:34px 34px 8px 34px;">
                    ${eyebrow ? `<div style="font-size:13px; font-weight:700; color:#16a34a; letter-spacing:.3px; margin-bottom:8px;">${escapeHtml(eyebrow)}</div>` : ''}
                    <div style="font-size:24px; line-height:1.35; font-weight:800; color:#0f172a;">${escapeHtml(title)}</div>
                </td></tr>
                <tr><td style="padding:14px 34px 6px 34px; font-size:15.5px; line-height:1.7; color:#334155;">${body}</td></tr>
                ${cta ? `<tr><td align="center" style="padding:22px 34px 8px 34px;">
                    <table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:14px; background:#16a34a;">
                        <a href="${cta.href}" style="display:inline-block; padding:15px 36px; font-size:16px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:14px;">${escapeHtml(cta.label)}</a>
                    </td></tr></table>
                </td></tr>` : ''}
                ${footnote ? `<tr><td align="center" style="padding:6px 34px 30px 34px; font-size:12.5px; line-height:1.6; color:#94a3b8;">${footnote}</td></tr>` : '<tr><td style="height:26px;"></td></tr>'}
            </table>
        </td></tr>
        <tr><td align="center" style="padding:20px 10px 0 10px; font-size:12px; line-height:1.7; color:#94a3b8;">
            © ${new Date().getFullYear()} עכשיו סלומון מבית SMT
            ${unsubscribeUrl ? `<br>לא רוצה לקבל מיילים? <a href="${unsubscribeUrl}" style="color:#64748b;">הסרה מרשימת התפוצה</a>` : ''}
        </td></tr>
    </table>
</td></tr>
</table>
</body></html>`;
}

// כרטיס הודעה בולט + שורת ציטוט קטנה של ההודעה הקודמת
function messageCard({ from, time, text, quote }) {
    return `
    ${quote ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:18px 0 0 0;"><tr>
        <td style="border-right:3px solid #cbd5e1; padding:6px 12px; font-size:13.5px; color:#64748b; line-height:1.55;">
            <div style="font-size:12px; font-weight:700; color:#94a3b8; margin-bottom:2px;">${escapeHtml(quote.label)}</div>${messageHtml(quote.text)}
        </td></tr></table>` : ''}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:14px 0 4px 0;"><tr>
        <td style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:16px; padding:16px 18px;">
            <div style="font-size:12.5px; font-weight:700; color:#15803d; margin-bottom:6px;">${escapeHtml(from)}${time ? `<span style="font-weight:400; color:#86efac;"> · ${escapeHtml(time)}</span>` : ''}</div>
            <div style="font-size:16px; line-height:1.7; color:#0f172a; word-break:break-word;">${messageHtml(text)}</div>
        </td></tr></table>`;
}

async function unsubscribeLink(env, email) {
    const token = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO unsubscribe_tokens (token, email, created_at) VALUES (?, ?, ?)").bind(token, email, getIsraelTimeForDB()).run();
    return `${SITE_URL}/unsubscribe?token=${token}`;
}

// ---------- התראה למנהל ----------

export async function maybeNotifyAdmin(env, phone) {
    const s = await getSettings(env);
    if (s.notify_admin_enabled !== '1') return { sent: false, reason: 'disabled' };
    const to = await getSuperAdminEmail(env);
    if (!to) return { sent: false, reason: 'no_super_admin_email' };

    const idleMinutes = Number(s.notify_idle_minutes) || 5;
    const cooldown = Number(s.notify_cooldown_minutes) || 30;
    const adminIdle = getMinutesSinceIsraelDbTime(s.admin_last_active_at || null);
    if (adminIdle < idleMinutes) return { sent: false, reason: 'admin_active' };

    const thread = await env.DB.prepare("SELECT admin_notified_at FROM chat_threads WHERE user_phone = ?").bind(phone).first();
    const notifiedAt = thread && thread.admin_notified_at;
    if (notifiedAt) {
        // כבר נשלחה התראה על שיחה זו מאז שהמנהל עזב - לא מציפים
        if (!s.admin_last_active_at || notifiedAt > s.admin_last_active_at) return { sent: false, reason: 'already_notified' };
        if (getMinutesSinceIsraelDbTime(notifiedAt) < cooldown) return { sent: false, reason: 'cooldown' };
    }

    const [{ results: unread }, name] = await Promise.all([
        env.DB.prepare("SELECT message_text, file_key, file_name, file_type, created_at FROM chat_messages WHERE user_phone = ? AND sender = 'user' AND is_read = 0 AND is_deleted = 0 ORDER BY id DESC LIMIT 5").bind(phone).all(),
        getNameFromIni(phone, env.YEMOT_TOKEN).catch(() => null),
    ]);
    // הודעה עם קובץ מוצגת במייל כשם הקובץ (הקובץ עצמו נפתח בצ'אט)
    const msgs = (unread || []).reverse().map(m => ({ ...m, message_text: messagePreview(m) }));
    if (!msgs.length) return { sent: false, reason: 'nothing_unread' };

    const who = name || phone;
    const last = msgs[msgs.length - 1];
    const earlier = msgs.slice(0, -1);
    const body = `
        <div style="color:#475569;"><b style="color:#0f172a;">${escapeHtml(who)}</b> · <span dir="ltr">${escapeHtml(phone)}</span>${msgs.length > 1 ? ` · ${msgs.length} הודעות שלא נקראו` : ''}</div>
        ${earlier.map(m => `<div style="margin-top:10px; font-size:14px; color:#64748b;">${messageHtml(m.message_text)}</div>`).join('')}
        ${messageCard({ from: who, time: formatTime(last.created_at), text: last.message_text })}`;
    const html = layout({
        preheader: `${who}: ${String(last.message_text).slice(0, 90)}`,
        eyebrow: 'תיבת התמיכה', title: `הודעה חדשה מ${who}`, body,
        cta: { href: ADMIN_CHAT_URL + encodeURIComponent(phone), label: 'פתיחת השיחה במרכז השליטה' },
        footnote: 'לא יישלחו מיילים נוספים על שיחה זו עד שתחזור לצ\'אט.',
    });
    const text = `הודעה חדשה מ${who} (${phone}):\n\n${msgs.map(m => m.message_text).join('\n')}\n\nפתיחת השיחה: ${ADMIN_CHAT_URL}${phone}`;

    const ok = await sendEmail(env, to, `💬 הודעה חדשה מ${who}`, html, text);
    if (ok) await setThreadField(env, phone, 'admin_notified_at', getIsraelTimeForDB());
    return { sent: ok, reason: ok ? 'sent' : 'email_failed' };
}

export async function sendTestAdminEmail(env) {
    const to = await getSuperAdminEmail(env);
    if (!to) return { ok: false, error: 'לא הוגדר מנהל-על עם כתובת מייל' };
    const html = layout({
        preheader: 'ההתראות מוגדרות כראוי', eyebrow: 'בדיקת התראות', title: 'ההתראות מוגדרות כראוי ✅',
        body: '<p style="margin:0;">מעכשיו יישלח לכאן מייל כשלקוח כותב בצ\'אט ואתה לא פעיל במרכז השליטה.</p>',
        cta: { href: ADMIN_CHAT_URL, label: 'מעבר לתיבת התמיכה' },
    });
    const ok = await sendEmail(env, to, 'בדיקת התראות צ\'אט | עכשיו סלומון', html, 'בדיקת התראות צ\'אט - ההגדרה תקינה.');
    return { ok, to };
}

// ---------- מייל ללקוח (רק כשהמנהל ביקש) ----------

export async function canEmailCustomer(env, phone) {
    const user = await env.DB.prepare("SELECT email, receive_emails FROM users WHERE phone = ?").bind(phone).first();
    if (!user || !user.email) return { ok: false, reason: 'no_email' };
    if (user.receive_emails === 0) return { ok: false, reason: 'opted_out' };
    const blocked = await env.DB.prepare("SELECT 1 FROM email_blocklist WHERE email = ?").bind(user.email).first();
    if (blocked) return { ok: false, reason: 'blocked' };
    return { ok: true, email: user.email };
}

function fileLimitNote(row) {
    if (!isLimited(row)) return '';
    const parts = [];
    if (row.file_max_views === 1) parts.push('לצפייה חד-פעמית');
    else if (row.file_max_views !== null && row.file_max_views !== undefined) parts.push(`עד ${row.file_max_views} צפיות`);
    if (row.file_expires_at) parts.push(`זמין עד ${formatTime(row.file_expires_at)}`);
    return parts.length ? ` (${parts.join(', ')})` : '';
}

export async function sendCustomerMessageEmail(env, phone, messageId, email, { attach = false } = {}) {
    const msg = await env.DB.prepare("SELECT id, message_text, file_key, file_name, file_type, file_size, file_max_views, file_expires_at, created_at FROM chat_messages WHERE id = ? AND user_phone = ? AND sender = 'admin'").bind(messageId, phone).first();
    if (!msg) return false;
    msg.message_text = messagePreview(msg);
    // קובץ: מצורף למייל, או רק הודעה שהוא מחכה בצ'אט (שם הוא נפתח אחרי התחברות)
    const attachment = msg.file_key && attach ? await emailAttachment(env, msg) : null;
    const fileNote = !msg.file_key ? '' : attachment ? '📎 הקובץ מצורף למייל זה.'
        : `🔒 הקובץ זמין בצ'אט באתר, אחרי התחברות${fileLimitNote(msg)}.`;
    const [lastUser, name] = await Promise.all([
        env.DB.prepare("SELECT message_text, file_key, file_name, file_type FROM chat_messages WHERE user_phone = ? AND sender = 'user' AND is_deleted = 0 AND id < ? ORDER BY id DESC LIMIT 1").bind(phone, messageId).first(),
        getNameFromIni(phone, env.YEMOT_TOKEN).catch(() => null),
    ]);

    // קישור חד-פעמי: הטוקן עצמו נשלח רק במייל, במסד נשמר רק ה-hash שלו
    const token = 'ml_' + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const now = getIsraelTimeForDB();
    await env.DB.prepare(`INSERT INTO chat_email_links (id, phone, message_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(await sha256(token), phone, messageId, email, now, getFutureIsraelTimeForDB(LINK_DAYS * 24 * 60)).run();
    const link = `${SITE_URL}?chat=open&ml=${token}`;

    const greeting = name ? `שלום ${escapeHtml(name)},` : 'שלום,';
    const body = `
        <p style="margin:0;">${greeting}<br>צוות עכשיו סלומון השיב לך בצ'אט:</p>
        ${messageCard({ from: 'צוות עכשיו סלומון', time: formatTime(msg.created_at), text: msg.message_text, quote: lastUser ? { label: 'ההודעה שלך', text: messagePreview(lastUser) } : null })}
        ${fileNote ? `<p style="margin:14px 0 0; font-size:14px; color:#475569;">${escapeHtml(fileNote)}</p>` : ''}`;
    const html = layout({
        preheader: String(msg.message_text).slice(0, 110),
        eyebrow: 'הודעה חדשה בצ\'אט', title: 'יש לך תשובה מצוות עכשיו סלומון', body,
        cta: { href: link, label: 'פתיחת הצ\'אט והמשך השיחה' },
        footnote: `הכפתור פותח את הצ'אט ישירות, בלי צורך בסיסמה. הוא חד-פעמי ותקף ל-${LINK_DAYS} ימים.<br>אם לא אתה ביקשת, אפשר להתעלם מהמייל.`,
        unsubscribeUrl: await unsubscribeLink(env, email),
    });
    const text = `${name ? `שלום ${name},` : 'שלום,'}\n\nצוות עכשיו סלומון השיב לך:\n\n${msg.message_text}${fileNote ? `\n\n${fileNote}` : ''}\n\nלהמשך השיחה: ${link}`;

    const ok = await sendEmail(env, email, 'יש לך תשובה חדשה בצ\'אט | עכשיו סלומון', html, text, attachment ? [attachment] : undefined);
    await env.DB.prepare("UPDATE chat_email_links SET sent_ok = ? WHERE id = ?").bind(ok ? 1 : 0, await sha256(token)).run();
    if (ok) await setThreadField(env, phone, 'user_notified_at', now);
    return ok;
}

// פדיון הקישור מהמייל
export async function redeemEmailLink(env, token) {
    if (!token || !String(token).startsWith('ml_')) return { status: 'invalid' };
    const id = await sha256(String(token));
    const link = await env.DB.prepare("SELECT * FROM chat_email_links WHERE id = ?").bind(id).first();
    if (!link) return { status: 'invalid' };
    if (link.used_at) return { status: 'used', link };
    if (isPastIsraelTime(link.expires_at)) return { status: 'expired', link };
    return { status: 'ok', link, id };
}
