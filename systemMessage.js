// systemMessage.js
import { authenticateUser } from './auth.js';
import { getIsraelTimeForDB, getMinutesSinceIsraelDbTime } from './timeUtils.js';

/**
 * 1. שליפת מודעות פעילות ומתאימות עבור משתמש הקצה (POST)
 * הפונקציה בודקת תוקף, עדיפות, מגבלת צפיות מקסימלית ומרווחי זמן קירור (Cooldown) עבור המשתמש הנוכחי.
 */
export async function handleGetSystemMessagesForUser(request, env, userIp) {
    try {
        const body = await request.json().catch(() => ({}));
        const { userToken } = body;

        if (!userToken) {
            return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
        }

        // אימות משתמש גלובלי
        const user = await authenticateUser(env.DB, userToken);
        if (!user) {
            return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });
        }

        const nowIsraelStr = getIsraelTimeForDB();
        const safeIp = userIp || '0.0.0.0';

        // שליפת כל המודעות שעדיין לא פגו, ממוינות לפי עדיפות (הגבוה ביותר ראשון)
        const { results: candidates } = await env.DB.prepare(
            `SELECT * FROM system_messages 
             WHERE expires_at IS NULL OR expires_at > ? 
             ORDER BY priority DESC, id DESC`
        ).bind(nowIsraelStr).all();

        const eligibleMessages = [];

        // סינון המודעות בהתאם להיסטוריית הצפיות האישית של המשתמש
        for (const msg of candidates) {
            // שליפת נתוני צפייה קודמים של המשתמש עבור מודעה זו
            const stats = await env.DB.prepare(
                `SELECT COUNT(*) as total_views, MAX(viewed_at) as last_view 
                 FROM system_message_logs 
                 WHERE message_id = ? AND phone = ?`
            ).bind(msg.id, user.phone).first();

            const totalViews = stats ? stats.total_views : 0;
            const lastView = stats ? stats.last_view : null;

            // א. בדיקת מקסימום צפיות מותרות למשתמש
            if (msg.max_views_per_user > 0 && totalViews >= msg.max_views_per_user) {
                continue; // המשתמש הגיע למכסה, מדלגים על המודעה
            }

            // ב. בדיקת זמן צינון/קירור בין הצגות (Interval)
            if (msg.view_interval_minutes > 0 && lastView) {
                const minutesPassed = getMinutesSinceIsraelDbTime(lastView);
                if (minutesPassed < msg.view_interval_minutes && minutesPassed >= 0) {
                    continue; // טרם עבר מספיק זמן מההצגה האחרונה, מדלגים
                }
            }

            // אם המודעה עברה את כל הסינונים, היא מתאימה להצגה
            eligibleMessages.push({
                id: msg.id,
                title: msg.title,
                htmlContent: msg.html_content,
                priority: msg.priority,
                isMandatory: msg.is_mandatory === 1,
                closeCooldownSeconds: msg.close_cooldown_seconds,
                expiresAt: msg.expires_at
            });

            // רישום לוג מיידי שהמודעה הוגשה למשתמש (שעון ישראל)
            await env.DB.prepare(
                `INSERT INTO system_message_logs (message_id, phone, viewed_at, ip_address) 
                 VALUES (?, ?, ?, ?)`
            ).bind(msg.id, user.phone, nowIsraelStr, safeIp).run();
        }

        return Response.json({
            success: true,
            messages: eligibleMessages
        });

    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת שליפת המודעות", details: error.message }, { status: 500 });
    }
}

/**
 * 2. ממשק מנהל: שליפת רשימת כל המודעות במערכת כולל כמות צפיות כוללת (POST)
 */
export async function handleAdminListSystemMessages(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        const { adminToken } = body;

        if (!adminToken || !adminToken.includes(':')) {
            return Response.json({ error: "חסר אימות מנהל או פורמט שגוי" }, { status: 401 });
        }

        const [username, adminPass] = adminToken.split(':');
        const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, adminPass).first();
        if (!admin) {
            return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });
        }

        // שליפת המודעות יחד עם כמות החשיפות המצטברת מתוך טבלת הלוגים
        const { results: messages } = await env.DB.prepare(
            `SELECT m.*, COUNT(l.id) as total_impressions 
             FROM system_messages m 
             LEFT JOIN system_message_logs l ON m.id = l.message_id 
             GROUP BY m.id 
             ORDER BY m.priority DESC, m.id DESC`
        ).all();

        return Response.json({
            success: true,
            messages: messages.map(msg => ({
                ...msg,
                is_mandatory: msg.is_mandatory === 1
            }))
        });

    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בשליפת רשימת הניהול", details: error.message }, { status: 500 });
    }
}

/**
 * 3. ממשק מנהל: יצירה או עדכון/עריכה של מודעת מערכת (POST)
 */
export async function handleAdminSaveSystemMessage(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        const { 
            adminToken, 
            id, // אם קיים -> מבצעים עדכון (Update), אם חסר -> יצירה חדשה (Insert)
            title, 
            htmlContent, 
            priority, 
            expiresAt, 
            isMandatory, 
            closeCooldownSeconds, 
            maxViewsPerUser, 
            viewIntervalMinutes 
        } = body;

        if (!adminToken || !adminToken.includes(':')) {
            return Response.json({ error: "חסר אימות מנהל" }, { status: 401 });
        }

        const [username, adminPass] = adminToken.split(':');
        const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, adminPass).first();
        if (!admin) {
            return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });
        }

        if (!title || !htmlContent) {
            return Response.json({ error: "חובה להזין כותרת ותוכן מעוצב למודעה" }, { status: 400 });
        }

        const nowIsraelStr = getIsraelTimeForDB();
        
        // סידור הפרמטרים וערכי ברירת מחדל
        const p_priority = parseInt(priority, 10) || 0;
        const p_expires_at = expiresAt || null; // תאריך בפורמט YYYY-MM-DD HH:MM:SS או ריק ללא הגבלה
        const p_is_mandatory = isMandatory ? 1 : 0;
        const p_cooldown = parseInt(closeCooldownSeconds, 10) || 0;
        const p_max_views = parseInt(maxViewsPerUser, 10) || 0;
        const p_interval = parseInt(viewIntervalMinutes, 10) || 0;

        if (id) {
            // מודל עריכה ועדכון מודעה קיימת
            const existing = await env.DB.prepare("SELECT 1 FROM system_messages WHERE id = ?").bind(id).first();
            if (!existing) {
                return Response.json({ error: "המודעה המבוקשת לעריכה אינה קיימת" }, { status: 404 });
            }

            await env.DB.prepare(
                `UPDATE system_messages 
                 SET title = ?, html_content = ?, priority = ?, expires_at = ?, 
                     is_mandatory = ?, close_cooldown_seconds = ?, max_views_per_user = ?, 
                     view_interval_minutes = ?, updated_at = ? 
                 WHERE id = ?`
            ).bind(title, htmlContent, p_priority, p_expires_at, p_is_mandatory, p_cooldown, p_max_views, p_interval, nowIsraelStr, id).run();

            return Response.json({ success: true, message: "המודעה עודכנה בהצלחה במערכת!" });
        } else {
            // מודל יצירת מודעה חדשה מאפס
            await env.DB.prepare(
                `INSERT INTO system_messages 
                 (title, html_content, priority, expires_at, is_mandatory, close_cooldown_seconds, max_views_per_user, view_interval_minutes, created_at, updated_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(title, htmlContent, p_priority, p_expires_at, p_is_mandatory, p_cooldown, p_max_views, p_interval, nowIsraelStr, nowIsraelStr).run();

            return Response.json({ success: true, message: "מודעה חדשה נוצרה ופורסמה בהצלחה!" });
        }

    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת שמירת המודעה", details: error.message }, { status: 500 });
    }
}

/**
 * 4. ממשק מנהל: מחיקת מודעת מערכת לחלוטין (POST)
 */
export async function handleAdminDeleteSystemMessage(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        const { adminToken, id } = body;

        if (!adminToken || !adminToken.includes(':')) {
            return Response.json({ error: "חסר אימות מנהל" }, { status: 401 });
        }

        const [username, adminPass] = adminToken.split(':');
        const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, adminPass).first();
        if (!admin) {
            return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });
        }

        if (!id) {
            return Response.json({ error: "חובה לציין מזהה מודעה למחיקה" }, { status: 400 });
        }

        const result = await env.DB.prepare("DELETE FROM system_messages WHERE id = ?").bind(id).run();

        if (result.meta && result.meta.changes > 0) {
            return Response.json({ success: true, message: "המודעה והיסטוריית הלוגים המשויכת אליה נמחקו לצמיתות." });
        } else {
            return Response.json({ error: "לא נמצאה מודעה תואמת למחיקה במערכת" }, { status: 404 });
        }

    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת מחיקת המודעה", details: error.message }, { status: 500 });
    }
}
