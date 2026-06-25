// systemMessage.js
import { authenticateUser } from './auth.js';
import { getIsraelTimeForDB } from './timeUtils.js';

/**
 * 1. שליפת מודעת המערכת עבור משתמש קצה (POST)
 */
export async function handleGetSystemMessage(request, env) {
    try {
        const body = await request.json();
        const { userToken } = body;

        if (!userToken) {
            return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
        }

        // אימות חכם גלובלי
        const user = await authenticateUser(env.DB, userToken);

        if (!user) {
            return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });
        }

        const messageRow = await env.DB.prepare(
            "SELECT html_content FROM system_messages WHERE id = 1"
        ).first();

        const htmlContent = messageRow ? messageRow.html_content : "<div style='text-align: center;'>אין הודעת מערכת זמינה</div>";

        return Response.json({
            success: true,
            htmlContent: htmlContent
        });

    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת שליפת המודעה", details: error.message }, { status: 500 });
    }
}

/**
 * 2. עדכון מודעת המערכת על ידי מנהל (POST)
 */
export async function handleAdminUpdateSystemMessage(request, env) {
    try {
        const body = await request.json();
        const { adminToken, htmlContent } = body;

        if (!adminToken) {
            return Response.json({ error: "חסר אימות מנהל" }, { status: 401 });
        }

        const [username, adminPass] = adminToken.split(':');
        const admin = await env.DB.prepare(
            "SELECT 1 FROM admins WHERE username = ? AND password = ?"
        ).bind(username, adminPass).first();

        if (!admin) {
            return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });
        }

        if (htmlContent === undefined || htmlContent === null) {
            return Response.json({ error: "חסר תוכן המודעה לעדכון" }, { status: 400 });
        }

        const nowIsraelStr = getIsraelTimeForDB();

        await env.DB.prepare(`
            INSERT INTO system_messages (id, html_content, updated_at) 
            VALUES (1, ?, ?) 
            ON CONFLICT(id) DO UPDATE SET html_content = excluded.html_content, updated_at = excluded.updated_at
        `).bind(htmlContent, nowIsraelStr).run();

        return Response.json({
            success: true,
            message: "מודעת המערכת עודכנה בהצלחה!"
        });

    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת עדכון המודעה", details: error.message }, { status: 500 });
    }
}
