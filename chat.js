// chat.js
import { authenticateUser } from './auth.js';
import { getIsraelTimeForDB } from './timeUtils.js';
import { sendEmail } from './emailService.js';
import { getNameFromIni, getAllNamesFromIni } from './yemot.js';

async function verifyAdmin(env, adminToken) {
    if (!adminToken || !adminToken.includes(':')) return false;
    const [username, password] = adminToken.split(':');
    const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, password).first();
    return !!admin;
}

// ==========================================
// פונקציות צד משתמש
// ==========================================

export async function handleUserGetChat(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!body.userToken) return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return Response.json({ error: "הרשאות לא חוקיות" }, { status: 403 });

    try {
        const { results } = await env.DB.prepare("SELECT * FROM chat_messages WHERE user_phone = ? ORDER BY created_at ASC").bind(user.phone).all();
        const messages = results.map(msg => ({
            id: msg.id, sender: msg.sender, text: msg.is_deleted === 1 ? "🚫 ההודעה נמחקה" : msg.message_text,
            isRead: msg.is_read === 1, isDeleted: msg.is_deleted === 1, createdAt: msg.created_at
        }));
        return Response.json({ success: true, messages });
    } catch (e) { return Response.json({ error: "שגיאה בשליפת ההודעות" }, { status: 500 }); }
}

export async function handleUserCheckUnread(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!body.userToken) return Response.json({ error: "חסר אימות" }, { status: 401 });
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return Response.json({ error: "הרשאות לא חוקיות" }, { status: 403 });

    try {
        const countRes = await env.DB.prepare("SELECT COUNT(*) as unread FROM chat_messages WHERE user_phone = ? AND sender = 'admin' AND is_read = 0").bind(user.phone).first();
        return Response.json({ success: true, unreadCount: countRes.unread || 0 });
    } catch (e) { return Response.json({ error: "שגיאה בבדיקת הודעות" }, { status: 500 }); }
}

export async function handleUserSendMessage(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!body.userToken || !body.text) return Response.json({ error: "נתונים חסרים" }, { status: 400 });
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return Response.json({ error: "הרשאות לא חוקיות" }, { status: 403 });

    try {
        const nowIsrael = getIsraelTimeForDB();
        await env.DB.prepare("INSERT INTO chat_messages (user_phone, sender, message_text, created_at, updated_at) VALUES (?, 'user', ?, ?, ?)").bind(user.phone, body.text, nowIsrael, nowIsrael).run();
        return Response.json({ success: true, message: "ההודעה נשלחה בהצלחה" });
    } catch (e) { return Response.json({ error: "שגיאה בשליחת ההודעה" }, { status: 500 }); }
}

export async function handleUserMarkRead(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!body.userToken) return Response.json({ error: "חסר אימות" }, { status: 401 });
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return Response.json({ error: "הרשאות לא חוקיות" }, { status: 403 });

    try {
        await env.DB.prepare("UPDATE chat_messages SET is_read = 1 WHERE user_phone = ? AND sender = 'admin' AND is_read = 0").bind(user.phone).run();
        return Response.json({ success: true });
    } catch (e) { return Response.json({ error: "שגיאה בעדכון קריאה" }, { status: 500 }); }
}

export async function handleUserDeleteMessage(request, env) {
    return Response.json({ error: "הנהלת האתר ביטלה את האפשרות למחוק הודעות מצד המשתמש." }, { status: 403 });
}

// ==========================================
// פונקציות הנהלה
// ==========================================

export async function handleAdminGetConversations(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 403 });

    try {
        const { results } = await env.DB.prepare(`
            SELECT user_phone, MAX(created_at) as last_message_time, SUM(CASE WHEN sender = 'user' AND is_read = 0 THEN 1 ELSE 0 END) as unread_count
            FROM chat_messages GROUP BY user_phone ORDER BY last_message_time DESC
        `).all();

        const namesMap = await getAllNamesFromIni(env.YEMOT_TOKEN) || {};
        const enriched = results.map(r => ({
            ...r,
            user_name: namesMap[r.user_phone] || 'משתמש לא מזוהה'
        }));

        return Response.json({ success: true, conversations: enriched });
    } catch (e) { return Response.json({ error: "שגיאה בשליפת שיחות" }, { status: 500 }); }
}

export async function handleAdminGetChat(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 403 });
    if (!body.targetPhone) return Response.json({ error: "חסר טלפון יעד" }, { status: 400 });

    try {
        const { results } = await env.DB.prepare("SELECT * FROM chat_messages WHERE user_phone = ? ORDER BY created_at ASC").bind(body.targetPhone).all();
        const userName = await getNameFromIni(body.targetPhone, env.YEMOT_TOKEN) || 'משתמש לא מזוהה';
        return Response.json({ success: true, messages: results, userName: userName });
    } catch (e) { return Response.json({ error: "שגיאה בשליפת הודעות" }, { status: 500 }); }
}

export async function handleAdminSendMessage(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 403 });
    if (!body.targetPhone || !body.text) return Response.json({ error: "נתונים חסרים" }, { status: 400 });

    try {
        const nowIsrael = getIsraelTimeForDB();
        await env.DB.prepare("INSERT INTO chat_messages (user_phone, sender, message_text, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)").bind(body.targetPhone, body.text, nowIsrael, nowIsrael).run();

        if (body.sendEmail) {
            const userDb = await env.DB.prepare("SELECT email, receive_emails FROM users WHERE phone = ?").bind(body.targetPhone).first();
            if (userDb && userDb.email && userDb.receive_emails !== 0) {
                const userName = await getNameFromIni(body.targetPhone, env.YEMOT_TOKEN) || "משתמש יקר";
                const lastUserMsg = await env.DB.prepare("SELECT message_text FROM chat_messages WHERE user_phone = ? AND sender = 'user' AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1").bind(body.targetPhone).first();
                
                let chatHistoryHtml = '';
                if (lastUserMsg && lastUserMsg.message_text) {
                    chatHistoryHtml += `<div style="background: #dcf8c6; padding: 12px 16px; border-radius: 12px 0 12px 12px; margin-bottom: 12px; margin-left: auto; width: fit-content; max-width: 85%; font-size: 15px; color: #111b21; box-shadow: 0 1px 2px rgba(0,0,0,0.05);"><strong>ההודעה שלך:</strong><br>${lastUserMsg.message_text}</div>`;
                }
                
                chatHistoryHtml += `<div style="background: #ffffff; padding: 12px 16px; border-radius: 0 12px 12px 12px; margin-right: auto; width: fit-content; max-width: 85%; font-size: 15px; color: #111b21; border: 1px solid #e2e8f0; box-shadow: 0 1px 2px rgba(0,0,0,0.05);"><strong>מענה צוות ההנהלה:</strong><br>${body.text}</div>`;

                const subject = "תגובה חדשה לפנייתך | עכשיו סלומון";
                const htmlContent = `
                <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; direction: rtl; text-align: right; background: #efeae2; padding: 30px 15px; border-radius: 12px;">
                    <div style="max-width: 500px; margin: 0 auto;">
                        <h2 style="color: #0f172a; margin-bottom: 20px;">שלום ${userName},</h2>
                        <p style="color: #475569; margin-bottom: 25px;">צוות ההנהלה השיב לפנייתך במערכת הצ'אט:</p>
                        
                        <div style="display: flex; flex-direction: column;">
                            ${chatHistoryHtml}
                        </div>
                        
                        <div style="text-align: center; margin-top: 35px;">
                            <a href="https://smti.uk/salamon" style="background: #3b82f6; color: #ffffff; padding: 12px 25px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(59, 130, 246, 0.25);">השב להודעה באתר</a>
                        </div>
                    </div>
                </div>`;
                
                await sendEmail(env, userDb.email, subject, htmlContent, body.text);
            }
        }
        return Response.json({ success: true, message: "ההודעה נשלחה" });
    } catch (e) { return Response.json({ error: "שגיאה בשליחת הודעה" }, { status: 500 }); }
}

export async function handleAdminSendCustomEmail(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 403 });
    if (!body.email || !body.subject || !body.content) return Response.json({ error: "חסרים פרטים לשליחה" }, { status: 400 });

    try {
        const htmlContent = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; direction: rtl; text-align: right;">
            <p style="white-space: pre-wrap; font-size: 16px; color: #334155; line-height: 1.6;">${body.content}</p>
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
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 403 });
    if (!body.targetPhone) return Response.json({ error: "נתונים חסרים" }, { status: 400 });

    try {
        await env.DB.prepare("UPDATE chat_messages SET is_read = 1 WHERE user_phone = ? AND sender = 'user' AND is_read = 0").bind(body.targetPhone).run();
        return Response.json({ success: true });
    } catch (e) { return Response.json({ error: "שגיאה בעדכון קריאה" }, { status: 500 }); }
}

export async function handleAdminDeleteMessage(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 403 });
    if (!body.messageId) return Response.json({ error: "חסר מזהה הודעה" }, { status: 400 });

    try {
        if (body.hardDelete) await env.DB.prepare("DELETE FROM chat_messages WHERE id = ?").bind(body.messageId).run();
        else await env.DB.prepare("UPDATE chat_messages SET is_deleted = 1, message_text = '' WHERE id = ?").bind(body.messageId).run();
        return Response.json({ success: true, message: "ההודעה נמחקה בהצלחה" });
    } catch (e) { return Response.json({ error: "שגיאה במחיקת ההודעה" }, { status: 500 }); }
}
