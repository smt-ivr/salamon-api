// systemMessage.js
import { authenticateUser } from './auth.js';
import { getIsraelTimeForDB, getMinutesSinceIsraelDbTime } from './timeUtils.js';

export async function handleGetSystemMessagesForUser(request, env, userIp) {
    try {
        const body = await request.json().catch(() => ({}));
        const { userToken } = body;
        if (!userToken) return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });

        const user = await authenticateUser(env.DB, userToken);
        if (!user) return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });

        const nowIsraelStr = getIsraelTimeForDB();
        const safeIp = userIp || '0.0.0.0';

        const { results: candidates } = await env.DB.prepare(
            `SELECT * FROM system_messages WHERE expires_at IS NULL OR expires_at > ? ORDER BY priority DESC, id DESC`
        ).bind(nowIsraelStr).all();

        const eligibleMessages = [];

        for (const msg of candidates) {
            const stats = await env.DB.prepare(
                `SELECT COUNT(*) as total_views, MAX(viewed_at) as last_view FROM system_message_logs WHERE message_id = ? AND phone = ?`
            ).bind(msg.id, user.phone).first();

            const totalViews = stats ? stats.total_views : 0;
            const lastView = stats ? stats.last_view : null;
            
            let isMandatoryFinal = msg.is_mandatory === 1;

            if (msg.max_views_per_user > 0 && totalViews >= msg.max_views_per_user) {
                if (msg.behavior_after_limit === 'downgrade') {
                    isMandatoryFinal = false; // ממשיך להיות מוצג, אבל רק כמודעת צד (מבטל פופאפ)
                } else {
                    continue; // מסתיר את המודעה לגמרי
                }
            }

            if (msg.view_interval_minutes > 0 && lastView) {
                const minutesPassed = getMinutesSinceIsraelDbTime(lastView);
                if (minutesPassed < msg.view_interval_minutes && minutesPassed >= 0) continue; 
            }

            let globalViews = 0;
            if (msg.show_view_count === 1) {
                const globalStats = await env.DB.prepare("SELECT COUNT(*) as c FROM system_message_logs WHERE message_id = ?").bind(msg.id).first();
                globalViews = globalStats ? globalStats.c : 0;
            }

            eligibleMessages.push({
                id: msg.id, title: msg.title, htmlContent: msg.html_content,
                imageUrl: msg.image_url, bgColor: msg.bg_color, textColor: msg.text_color,
                priority: msg.priority, isMandatory: isMandatoryFinal, closeCooldownSeconds: msg.close_cooldown_seconds,
                expiresAt: msg.expires_at, showViewCount: msg.show_view_count === 1, globalViews: globalViews
            });

            // השינוי: רישום צפייה מתבצע אך ורק אם המשתמש הוא לא מאסטר
            if (!user.is_master) {
                await env.DB.prepare(`INSERT INTO system_message_logs (message_id, phone, viewed_at, ip_address) VALUES (?, ?, ?, ?)`).bind(msg.id, user.phone, nowIsraelStr, safeIp).run();
            }
        }

        return Response.json({ success: true, messages: eligibleMessages });
    } catch (error) { return Response.json({ error: "שגיאת שרת פנימית", details: error.message }, { status: 500 }); }
}

export async function handleAdminListSystemMessages(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        if (!body.adminToken || !body.adminToken.includes(':')) return Response.json({ error: "שגיאת אימות" }, { status: 401 });
        const [username, adminPass] = body.adminToken.split(':');
        const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, adminPass).first();
        if (!admin) return Response.json({ error: "לא מורשה" }, { status: 403 });

        // שליפת המודעות + משתמשים ייחודיים (DISTINCT) וסך חשיפות
        const { results: messages } = await env.DB.prepare(`
            SELECT m.*, COUNT(l.id) as total_impressions, COUNT(DISTINCT l.phone) as unique_viewers 
            FROM system_messages m LEFT JOIN system_message_logs l ON m.id = l.message_id 
            GROUP BY m.id ORDER BY m.priority DESC, m.id DESC
        `).all();

        return Response.json({ success: true, messages });
    } catch (error) { return Response.json({ error: "שגיאת שרת", details: error.message }, { status: 500 }); }
}

export async function handleAdminSaveSystemMessage(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        const { adminToken, id, title, htmlContent, imageUrl, bgColor, textColor, priority, expiresAt, isMandatory, closeCooldownSeconds, maxViewsPerUser, behaviorAfterLimit, viewIntervalMinutes, showViewCount } = body;
        
        const [username, adminPass] = adminToken.split(':');
        const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, adminPass).first();
        if (!admin) return Response.json({ error: "לא מורשה" }, { status: 403 });
        if (!title || !htmlContent) return Response.json({ error: "חובה להזין כותרת ותוכן" }, { status: 400 });

        const nowIsraelStr = getIsraelTimeForDB();
        const p_prior = parseInt(priority, 10) || 0;
        const p_exp = expiresAt || null;
        const p_man = isMandatory ? 1 : 0;
        const p_cool = parseInt(closeCooldownSeconds, 10) || 0;
        const p_max = parseInt(maxViewsPerUser, 10) || 0;
        const p_int = parseInt(viewIntervalMinutes, 10) || 0;
        const p_show = showViewCount ? 1 : 0;
        const p_beh = behaviorAfterLimit || 'hide';
        const p_img = imageUrl || null;
        const p_bg = bgColor || '#ffffff';
        const p_txt = textColor || '#1a202c';

        if (id) {
            await env.DB.prepare(`UPDATE system_messages SET title=?, html_content=?, image_url=?, bg_color=?, text_color=?, priority=?, expires_at=?, is_mandatory=?, close_cooldown_seconds=?, max_views_per_user=?, behavior_after_limit=?, view_interval_minutes=?, show_view_count=?, updated_at=? WHERE id=?`)
                .bind(title, htmlContent, p_img, p_bg, p_txt, p_prior, p_exp, p_man, p_cool, p_max, p_beh, p_int, p_show, nowIsraelStr, id).run();
        } else {
            await env.DB.prepare(`INSERT INTO system_messages (title, html_content, image_url, bg_color, text_color, priority, expires_at, is_mandatory, close_cooldown_seconds, max_views_per_user, behavior_after_limit, view_interval_minutes, show_view_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .bind(title, htmlContent, p_img, p_bg, p_txt, p_prior, p_exp, p_man, p_cool, p_max, p_beh, p_int, p_show, nowIsraelStr, nowIsraelStr).run();
        }
        return Response.json({ success: true });
    } catch (error) { return Response.json({ error: "שגיאת שמירה", details: error.message }, { status: 500 }); }
}

export async function handleAdminDeleteSystemMessage(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        const [username, adminPass] = body.adminToken.split(':');
        const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username=? AND password=?").bind(username, adminPass).first();
        if (!admin || !body.id) return Response.json({ error: "שגיאה" }, { status: 400 });
        await env.DB.prepare("DELETE FROM system_messages WHERE id=?").bind(body.id).run();
        return Response.json({ success: true });
    } catch (e) { return Response.json({ error: "שגיאה" }, { status: 500 }); }
}

export async function handleAdminGetAdLogs(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        const [username, adminPass] = body.adminToken.split(':');
        const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username=? AND password=?").bind(username, adminPass).first();
        if (!admin || !body.messageId) return Response.json({ error: "שגיאה" }, { status: 400 });

        const { results: logs } = await env.DB.prepare(
            `SELECT phone, viewed_at, ip_address FROM system_message_logs WHERE message_id = ? ORDER BY viewed_at DESC LIMIT 200`
        ).bind(body.messageId).all();

        return Response.json({ success: true, logs });
    } catch (e) { return Response.json({ error: "שגיאה בשליפת לוגים" }, { status: 500 }); }
}
