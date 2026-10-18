// chatNotify.js
// התראות חכמות במייל על הודעות צ'אט:
// • למנהל - רק כשלא היה פעיל בצ'אט זמן מה, ופעם אחת לכל שיחה עד שיחזור.
// • ללקוח - כשאינו מחובר לאתר, פעם אחת עד שיפתח את הצ'אט, עם קישור שפותח את הצ'אט מיד.

import { sendEmail, escapeHtml, getBaseTemplate } from './emailService.js';
import { getIsraelTimeForDB, getMinutesSinceIsraelDbTime } from './timeUtils.js';
import { getSettings, setSettings } from './schema.js';
import { getNameFromIni } from './yemot.js';

const ADMIN_CHAT_URL = 'https://smti.uk/salamon/admin#chat/';
const CUSTOMER_CHAT_URL = 'https://smti.uk/salamon?chat=open';

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

function formatTime(dbTime) {
    if (!dbTime) return '';
    const [d, t] = String(dbTime).split(' ');
    const [y, m, day] = (d || '').split('-');
    return `${day}/${m} ${String(t || '').slice(0, 5)}`;
}

// בועות שיחה בטבלאות, כדי שיוצגו נכון גם ב-Gmail וב-Outlook
function bubble(text, time, side, label) {
    const isRight = side === 'right';
    const bg = isRight ? '#dcfce7' : '#ffffff';
    const border = isRight ? '#bbf7d0' : '#e2e8f0';
    return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 10px 0;">
        <tr><td align="${isRight ? 'right' : 'left'}">
            <table role="presentation" cellspacing="0" cellpadding="0" style="max-width: 85%;">
                <tr><td style="background: ${bg}; border: 1px solid ${border}; border-radius: 14px; padding: 10px 14px; text-align: right; direction: rtl;">
                    ${label ? `<div style="font-size: 12px; font-weight: 700; color: #6d4aff; margin-bottom: 3px;">${escapeHtml(label)}</div>` : ''}
                    <div style="font-size: 15px; color: #0f172a; line-height: 1.55; white-space: pre-wrap; word-break: break-word;">${escapeHtml(text)}</div>
                    <div style="font-size: 11px; color: #94a3b8; margin-top: 4px; text-align: left; direction: ltr;">${escapeHtml(formatTime(time))}</div>
                </td></tr>
            </table>
        </td></tr>
    </table>`;
}

function ctaButton(href, label) {
    return `
    <table role="presentation" cellspacing="0" cellpadding="0" align="center" style="margin: 30px auto 6px auto;">
        <tr><td style="border-radius: 999px; background: #6d4aff; background-image: linear-gradient(135deg, #6d4aff, #0ea5e9);">
            <a href="${href}" style="display: inline-block; padding: 14px 34px; color: #ffffff; font-size: 16px; font-weight: 700; text-decoration: none; border-radius: 999px;">${escapeHtml(label)}</a>
        </td></tr>
    </table>`;
}

function chatPanel(innerHtml) {
    return `<div style="background: #f4f5fa; border: 1px solid #e3e6ee; border-radius: 16px; padding: 18px 16px 8px 16px; margin: 20px 0 6px 0;">${innerHtml}</div>`;
}

// ---------- התראה למנהל ----------

export async function maybeNotifyAdmin(env, phone) {
    const s = await getSettings(env);
    if (s.notify_admin_enabled !== '1' || !s.notify_admin_email) return { sent: false, reason: 'disabled' };

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
        env.DB.prepare("SELECT message_text, created_at FROM chat_messages WHERE user_phone = ? AND sender = 'user' AND is_read = 0 AND is_deleted = 0 ORDER BY id DESC LIMIT 5").bind(phone).all(),
        getNameFromIni(phone, env.YEMOT_TOKEN).catch(() => null),
    ]);
    const msgs = (unread || []).reverse();
    if (!msgs.length) return { sent: false, reason: 'nothing_unread' };

    const who = name || phone;
    const content = `
        <p style="margin: 0 0 6px 0; font-size: 18px;">יש הודעה חדשה בצ'אט 💬</p>
        <p style="margin: 0; color: #64748b;"><strong style="color: #0f172a;">${escapeHtml(who)}</strong> · <span style="direction: ltr; unicode-bidi: embed;">${escapeHtml(phone)}</span></p>
        ${chatPanel(msgs.map(m => bubble(m.message_text, m.created_at, 'left', '')).join(''))}
        ${ctaButton(ADMIN_CHAT_URL + encodeURIComponent(phone), 'פתיחת השיחה במרכז השליטה')}
        <p style="margin: 18px 0 0 0; font-size: 13px; color: #94a3b8; text-align: center;">לא יישלחו מיילים נוספים על שיחה זו עד שתחזור לצ'אט.</p>`;
    const text = `הודעה חדשה מ${who} (${phone}):\n\n${msgs.map(m => m.message_text).join('\n')}\n\nפתיחת השיחה: ${ADMIN_CHAT_URL}${phone}`;

    const ok = await sendEmail(env, s.notify_admin_email, `💬 הודעה חדשה מ${who}`, getBaseTemplate('הודעה חדשה מלקוח', content), text);
    if (ok) await setThreadField(env, phone, 'admin_notified_at', getIsraelTimeForDB());
    return { sent: ok, reason: ok ? 'sent' : 'email_failed' };
}

export async function sendTestAdminEmail(env, to) {
    const content = `
        <p style="margin: 0 0 12px 0; font-size: 18px;">ההתראות מוגדרות כראוי ✅</p>
        <p style="margin: 0;">מעכשיו יישלח אליך מייל כשלקוח כותב בצ'אט ואתה לא פעיל במרכז השליטה.</p>
        ${ctaButton(ADMIN_CHAT_URL, 'מעבר לתיבת התמיכה')}`;
    return sendEmail(env, to, 'בדיקת התראות צ\'אט | עכשיו סלומון', getBaseTemplate('התראות צ\'אט', content), 'בדיקת התראות צ\'אט - ההגדרה תקינה.');
}

// ---------- מייל ללקוח ----------

// mode: 'auto' | 'always' | 'never'
export async function decideCustomerEmail(env, phone, mode) {
    if (mode === 'never') return { send: false, reason: 'disabled' };
    const user = await env.DB.prepare("SELECT email, receive_emails FROM users WHERE phone = ?").bind(phone).first();
    if (!user || !user.email) return { send: false, reason: 'no_email' };
    if (user.receive_emails === 0) return { send: false, reason: 'opted_out' };
    const blocked = await env.DB.prepare("SELECT 1 FROM email_blocklist WHERE email = ?").bind(user.email).first();
    if (blocked) return { send: false, reason: 'blocked' };
    if (mode === 'always') return { send: true, reason: 'always', email: user.email };

    const s = await getSettings(env);
    const offlineMinutes = Number(s.customer_offline_minutes) || 3;
    const [presence, thread] = await Promise.all([
        env.DB.prepare("SELECT last_seen_at FROM user_presence WHERE phone = ?").bind(phone).first(),
        env.DB.prepare("SELECT user_notified_at, user_seen_at FROM chat_threads WHERE user_phone = ?").bind(phone).first(),
    ]);
    if (presence && getMinutesSinceIsraelDbTime(presence.last_seen_at) < offlineMinutes) return { send: false, reason: 'customer_online' };
    if (thread && thread.user_notified_at && (!thread.user_seen_at || thread.user_notified_at > thread.user_seen_at)) return { send: false, reason: 'already_notified' };
    return { send: true, reason: 'customer_offline', email: user.email };
}

export async function sendCustomerReplyEmail(env, phone, email) {
    const [thread, lastUser, name] = await Promise.all([
        env.DB.prepare("SELECT user_seen_at FROM chat_threads WHERE user_phone = ?").bind(phone).first(),
        env.DB.prepare("SELECT id, message_text, created_at FROM chat_messages WHERE user_phone = ? AND sender = 'user' AND is_deleted = 0 ORDER BY id DESC LIMIT 1").bind(phone).first(),
        getNameFromIni(phone, env.YEMOT_TOKEN).catch(() => null),
    ]);
    // רק התשובות שהלקוח עוד לא ראה, ושנכתבו אחרי ההודעה האחרונה שלו
    const seenAt = (thread && thread.user_seen_at) || '';
    const afterId = lastUser ? lastUser.id : 0;
    const { results: adminMsgs } = await env.DB.prepare("SELECT message_text, created_at FROM chat_messages WHERE user_phone = ? AND sender = 'admin' AND is_deleted = 0 AND created_at >= ? AND id > ? ORDER BY id DESC LIMIT 5")
        .bind(phone, seenAt, afterId).all();
    const replies = (adminMsgs || []).reverse();
    if (!replies.length) return false;

    const token = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO unsubscribe_tokens (token, email, created_at) VALUES (?, ?, ?)").bind(token, email, getIsraelTimeForDB()).run();
    const unsubscribeUrl = `https://smti.uk/salamon/unsubscribe?token=${token}`;

    const greeting = name ? `שלום ${escapeHtml(name)},` : 'שלום,';
    const history = (lastUser ? bubble(lastUser.message_text, lastUser.created_at, 'right', 'אתה') : '')
        + replies.map(m => bubble(m.message_text, m.created_at, 'left', 'צוות עכשיו סלומון')).join('');
    const content = `
        <p style="margin: 0 0 8px 0; font-size: 18px;">${greeting}</p>
        <p style="margin: 0; color: #475569;">קיבלת ${replies.length > 1 ? `${replies.length} תשובות חדשות` : 'תשובה חדשה'} מצוות עכשיו סלומון:</p>
        ${chatPanel(history)}
        ${ctaButton(CUSTOMER_CHAT_URL, 'פתיחת הצ\'אט והמשך השיחה')}
        <p style="margin: 16px 0 0 0; font-size: 13px; color: #94a3b8; text-align: center;">הקישור יפתח את הצ'אט באתר מיד לאחר ההתחברות.</p>`;
    const text = `${name ? `שלום ${name},` : 'שלום,'}\n\nקיבלת תשובה מצוות עכשיו סלומון:\n\n${replies.map(m => m.message_text).join('\n\n')}\n\nלהמשך השיחה: ${CUSTOMER_CHAT_URL}`;

    const ok = await sendEmail(env, email, 'יש לך תשובה חדשה בצ\'אט | עכשיו סלומון', getBaseTemplate('תשובה חדשה בצ\'אט', content, unsubscribeUrl), text);
    if (ok) await setThreadField(env, phone, 'user_notified_at', getIsraelTimeForDB());
    return ok;
}
