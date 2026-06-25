// systemMessage.js

/**
 * 1. שליפת מודעת המערכת עבור משתמש קצה (POST)
 * נתיב מיועד: /api/system-message
 */
export async function handleGetSystemMessage(request, env) {
    try {
        const body = await request.json();
        const { userToken } = body;

        // בדיקת קיומו של הטוקן
        if (!userToken) {
            return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
        }

        // פיצול ואימות מול טבלת המשתמשים (בדומה לשאר חלקי המערכת)
        const [identifier, password] = userToken.split(':');
        const user = await env.DB.prepare(
            "SELECT 1 FROM users WHERE (phone = ? OR email = ?) AND password = ?"
        ).bind(identifier, identifier, password).first();

        if (!user) {
            return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });
        }

        // שליפת המודעה הקבועה (id=1) ממסד הנתונים
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
 * נתיב מיועד: /api/admin/system-message/update
 */
export async function handleAdminUpdateSystemMessage(request, env) {
    try {
        const body = await request.json();
        const { adminToken, htmlContent } = body;

        // בדיקת קיומו של טוקן המנהל
        if (!adminToken) {
            return Response.json({ error: "חסר אימות מנהל" }, { status: 401 });
        }

        // פיצול ואימות מול טבלת המנהלים
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

        // עדכון הרשומה הקבועה או יצירתה מחדש במידה ונמחקה (UPSERT חסין תקלות)
        await env.DB.prepare(`
            INSERT INTO system_messages (id, html_content) 
            VALUES (1, ?) 
            ON CONFLICT(id) DO UPDATE SET html_content = excluded.html_content, updated_at = CURRENT_TIMESTAMP
        `).bind(htmlContent).run();

        return Response.json({
            success: true,
            message: "מודעת המערכת עודכנה בהצלחה!"
        });

    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת עדכון המודעה", details: error.message }, { status: 500 });
    }
}
