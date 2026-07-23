// chat.js
import { authenticateUser } from './auth.js';
import { getIsraelTimeForDB } from './timeUtils.js';
import { sendEmail } from './emailService.js';
import { getNameFromIni } from './yemot.js';

// פונקציית עזר לאימות מנהל
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
        const { results } = await env.DB.prepare(
            "SELECT * FROM chat_messages WHERE user_phone = ? ORDER BY created_at ASC"
        ).bind(user.phone).all();

        const messages = results.map(msg => ({
            id: msg.id,
            sender: msg.sender,
            text: msg.is_deleted === 1 ? "🚫 ההודעה נמחקה" : msg.message_text,
            isRead: msg.is_read === 1,
            isDeleted: msg.is_deleted === 1,
            createdAt: msg.created_at
        }));

        return Response.json({ success: true, messages });
    } catch (e) {
        return Response.json({ error: "שגיאה בשליפת ההודעות" }, { status: 500 });
    }
}

// פונקציה קלה ומהירה לבדיקת רקע (Polling) של הודעות שלא נקראו
export async function handleUserCheckUnread(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!body.userToken) return Response.json({ error: "חסר אימות" }, { status: 401 });

    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return Response.json({ error: "הרשאות לא חוקיות" }, { status: 403 });

    try {
        const countRes = await env.DB.prepare(
            "SELECT COUNT(*) as unread FROM chat_messages WHERE user_phone = ? AND sender = 'admin' AND is_read = 0"
        ).bind(user.phone).first();

        return Response.json({ success: true, unreadCount: countRes.unread || 0 });
    } catch (e) {
        return Response.json({ error: "שגיאה בבדיקת הודעות" }, { status: 500 });
    }
}

export async function handleUserSendMessage(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!body.userToken || !body.text) return Response.json({ error: "נתונים חסרים" }, { status: 400 });

    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return Response.json({ error: "הרשאות לא חוקיות" }, { status: 403 });

    try {
        const nowIsrael = getIsraelTimeForDB();
        await env.DB.prepare(
            "INSERT INTO chat_messages (user_phone, sender, message_text, created_at, updated_at) VALUES (?, 'user', ?, ?, ?)"
        ).bind(user.phone, body.text, nowIsrael, nowIsrael).run();

        return Response.json({ success: true, message: "ההודעה נשלחה בהצלחה" });
    } catch (e) {
        return Response.json({ error: "שגיאה בשליחת ההודעה" }, { status: 500 });
    }
}

export async function handleUserMarkRead(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!body.userToken) return Response.json({ error: "חסר אימות" }, { status: 401 });

    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return Response.json({ error: "הרשאות לא חוקיות" }, { status: 403 });

    try {
        await env.DB.prepare(
            "UPDATE chat_messages SET is_read = 1 WHERE user_phone = ? AND sender = 'admin' AND is_read = 0"
        ).bind(user.phone).run();
        return Response.json({ success: true });
    } catch (e) {
        return Response.json({ error: "שגיאה בעדכון קריאה" }, { status: 500 });
    }
}

export async function handleUserDeleteMessage(request, env) {
    // חסימה מוחלטת של אפשרות המחיקה מצד המשתמש בשרת
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
            SELECT user_phone, 
                   MAX(created_at) as last_message_time,
                   SUM(CASE WHEN sender = 'user' AND is_read = 0 THEN 1 ELSE 0 END) as unread_count
            FROM chat_messages
            GROUP BY user_phone
            ORDER BY last_message_time DESC
        `).all();

        return Response.json({ success: true, conversations: results });
    } catch (e) {
        return Response.json({ error: "שגיאה בשליפת שיחות" }, { status: 500 });
    }
}

export async function handleAdminGetChat(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 403 });
    if (!body.targetPhone) return Response.json({ error: "חסר טלפון יעד" }, { status: 400 });

    try {
        const { results } = await env.DB.prepare(
            "SELECT * FROM chat_messages WHERE user_phone = ? ORDER BY created_at ASC"
        ).bind(body.targetPhone).all();
        
        return Response.json({ success: true, messages: results });
    } catch (e) {
        return Response.json({ error: "שגיאה בשליפת הודעות" }, { status: 500 });
    }
}

export async function handleAdminSendMessage(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 403 });
    if (!body.targetPhone || !body.text) return Response.json({ error: "נתונים חסרים" }, { status: 400 });

    try {
        const nowIsrael = getIsraelTimeForDB();
        await env.DB.prepare(
            "INSERT INTO chat_messages (user_phone, sender, message_text, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)"
        ).bind(body.targetPhone, body.text, nowIsrael, nowIsrael).run();

        // שליחת אימייל למשתמש
        if (body.sendEmail) {
            const userDb = await env.DB.prepare("SELECT email, receive_emails FROM users WHERE phone = ?").bind(body.targetPhone).first();
            if (userDb && userDb.email && userDb.receive_emails !== 0) {
                const userName = await getNameFromIni(body.targetPhone, env.YEMOT_TOKEN) || "משתמש יקר";
                const subject = "הודעה חדשה מהנהלת עכשיו סלומון";
                
                const htmlContent = `
                <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right;">
                    <h2>שלום ${userName},</h2>
                    <p>התקבלה הודעה חדשה מצוות ההנהלה:</p>
                    <div style="background: #f1f5f9; padding: 15px; border-radius: 8px; border-right: 4px solid #3b82f6;">
                        ${body.text}
                    </div>
                    <p>היכנסו לאזור האישי באתר כדי לצפות בשיחה ולהגיב.</p>
                </div>`;
                
                await sendEmail(env, userDb.email, subject, htmlContent, body.text);
            }
        }

        return Response.json({ success: true, message: "ההודעה נשלחה" });
    } catch (e) {
        return Response.json({ error: "שגיאה בשליחת הודעה" }, { status: 500 });
    }
}

export async function handleAdminMarkRead(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 403 });
    if (!body.targetPhone) return Response.json({ error: "נתונים חסרים" }, { status: 400 });

    try {
        await env.DB.prepare(
            "UPDATE chat_messages SET is_read = 1 WHERE user_phone = ? AND sender = 'user' AND is_read = 0"
        ).bind(body.targetPhone).run();
        return Response.json({ success: true });
    } catch (e) {
        return Response.json({ error: "שגיאה בעדכון קריאה" }, { status: 500 });
    }
}

export async function handleAdminDeleteMessage(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 403 });
    if (!body.messageId) return Response.json({ error: "חסר מזהה הודעה" }, { status: 400 });

    try {
        if (body.hardDelete) {
            await env.DB.prepare("DELETE FROM chat_messages WHERE id = ?").bind(body.messageId).run();
        } else {
            await env.DB.prepare("UPDATE chat_messages SET is_deleted = 1, message_text = '' WHERE id = ?").bind(body.messageId).run();
        }
        return Response.json({ success: true, message: "ההודעה נמחקה בהצלחה" });
    } catch (e) {
        return Response.json({ error: "שגיאה במחיקת ההודעה" }, { status: 500 });
    }
}
