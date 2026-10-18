// systemMessage.js
// קמפיינים באתר: מודעת צד, פופאפ, פס עליון והודעה צפה.
// כולל תזמון (התחלה וסיום), השהיה, קהל יעד (מספרים, מכשיר, משתמשים חדשים), כפתור פעולה עם מעקב הקלקות,
// עיצוב מתקדם עם ערכות עיצוב שמורות, ונתונים מפורטים: מי ראה, מתי, מאיזה מכשיר, מי לחץ ומי סגר.

import { authenticateUser } from './auth.js';
import { isMainAdmin } from './adminAuth.js';
import { getIsraelTimeForDB, getMinutesSinceIsraelDbTime, getFutureIsraelTimeForDB } from './timeUtils.js';
import { describeDevice } from './activity.js';
import { getAllNamesFromIni } from './yemot.js';

const PLACEMENTS = ['sidebar', 'popup', 'banner', 'toast'];
const HEX = /^#[0-9a-f]{6}$/i;
const safeUrl = u => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '').trim()) ? String(u).trim() : '');

function isMobileUa(ua) { return /Mobi|Android|iPhone|iPad|iPod/i.test(String(ua || '')); }

function placementOf(msg) {
    return PLACEMENTS.includes(msg.placement) ? msg.placement : (msg.is_mandatory === 1 ? 'popup' : 'sidebar');
}

function parseJson(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; } }

export function normalizeAdDesign(d = {}) {
    return {
        gradient: HEX.test(d.gradient || '') ? d.gradient : '',
        // null = ברירת המחדל של כל מיקום (פינות ויישור), כדי שקמפיינים ישנים ייראו בדיוק כמו קודם
        radius: d.radius === undefined || d.radius === null || d.radius === '' ? null : Math.min(Math.max(parseInt(d.radius, 10) || 0, 0), 40),
        align: ['right', 'center'].includes(d.align) ? d.align : 'auto',
        size: ['sm', 'md', 'lg'].includes(d.size) ? d.size : 'md',
        imagePos: ['top', 'bottom', 'cover'].includes(d.imagePos) ? d.imagePos : 'top',
        shadow: d.shadow === false ? false : true,
        border: HEX.test(d.border || '') ? d.border : '',
        icon: /^fa-[a-z0-9-]{2,40}$/.test(d.icon || '') ? d.icon : '',
        animation: ['none', 'fade', 'slide', 'pop'].includes(d.animation) ? d.animation : 'fade',
        ctaColor: HEX.test(d.ctaColor || '') ? d.ctaColor : '',
        ctaText: HEX.test(d.ctaText || '') ? d.ctaText : '',
        badge: String(d.badge || '').slice(0, 30),
    };
}

function normalizeAdAudience(a = {}) {
    return {
        mode: ['all', 'include', 'exclude'].includes(a.mode) ? a.mode : 'all',
        phones: [...new Set((Array.isArray(a.phones) ? a.phones : String(a.phones || '').split(/[\s,;]+/)).map(p => String(p).replace(/[^\d]/g, '')).filter(p => p.length >= 9))].slice(0, 2000),
        device: ['all', 'mobile', 'desktop'].includes(a.device) ? a.device : 'all',
        newDays: Math.min(Math.max(parseInt(a.newDays, 10) || 0, 0), 3650),
    };
}

// האם הקמפיין מיועד למשתמש הזה עכשיו
function targets(msg, user, ua, now) {
    if (msg.is_paused === 1) return false;
    if (msg.starts_at && msg.starts_at > now) return false;
    const a = normalizeAdAudience(parseJson(msg.audience, {}));
    if (a.mode === 'include' && !a.phones.includes(user.phone)) return false;
    if (a.mode === 'exclude' && a.phones.includes(user.phone)) return false;
    if (a.device === 'mobile' && !isMobileUa(ua)) return false;
    if (a.device === 'desktop' && isMobileUa(ua)) return false;
    if (a.newDays > 0 && (!user.created_at || getMinutesSinceIsraelDbTime(user.created_at) > a.newDays * 24 * 60)) return false;
    return true;
}

export async function handleGetSystemMessagesForUser(request, env, userIp) {
    try {
        const body = await request.json().catch(() => ({}));
        const { userToken } = body;
        if (!userToken) return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });

        const user = await authenticateUser(env.DB, userToken);
        if (!user) return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });

        const nowIsraelStr = getIsraelTimeForDB();
        const safeIp = userIp || '0.0.0.0';
        const ua = request.headers.get('user-agent') || '';

        const { results: candidates } = await env.DB.prepare(
            `SELECT * FROM system_messages WHERE expires_at IS NULL OR expires_at > ? ORDER BY priority DESC, id DESC`
        ).bind(nowIsraelStr).all();

        const eligibleMessages = [];

        for (const msg of candidates) {
            if (!targets(msg, user, ua, nowIsraelStr)) continue;
            const stats = await env.DB.prepare(
                `SELECT COUNT(*) as total_views, MAX(viewed_at) as last_view FROM system_message_logs WHERE message_id = ? AND phone = ?`
            ).bind(msg.id, user.phone).first();

            const totalViews = stats ? stats.total_views : 0;
            const lastView = stats ? stats.last_view : null;

            let placement = placementOf(msg);

            if (msg.max_views_per_user > 0 && totalViews >= msg.max_views_per_user) {
                if (msg.behavior_after_limit === 'downgrade') {
                    placement = 'sidebar'; // ממשיך להיות מוצג, אבל רק כמודעת צד
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
                priority: msg.priority, isMandatory: placement === 'popup', placement, closeCooldownSeconds: msg.close_cooldown_seconds,
                expiresAt: msg.expires_at, showViewCount: msg.show_view_count === 1, globalViews: globalViews,
                ctaLabel: msg.cta_label || '', ctaUrl: safeUrl(msg.cta_url), design: normalizeAdDesign(parseJson(msg.design, {})),
            });

            // רישום צפייה מתבצע אך ורק אם המשתמש הוא לא מאסטר
            if (!user.is_master) {
                await env.DB.prepare(`INSERT INTO system_message_logs (message_id, phone, viewed_at, ip_address, device) VALUES (?, ?, ?, ?, ?)`).bind(msg.id, user.phone, nowIsraelStr, safeIp, describeDevice(ua)).run();
            }
        }

        return Response.json({ success: true, messages: eligibleMessages });
    } catch (error) { return Response.json({ error: "שגיאת שרת פנימית", details: error.message }, { status: 500 }); }
}

// הקלקה על כפתור הפעולה או סגירה של קמפיין (נשלח מהאתר)
export async function handleSystemMessageEvent(request, env, userIp) {
    const body = await request.json().catch(() => ({}));
    if (!body.userToken || !['click', 'close'].includes(body.event)) return Response.json({ error: "נתונים חסרים" }, { status: 400 });
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });
    const msg = await env.DB.prepare("SELECT id FROM system_messages WHERE id = ?").bind(Number(body.id) || 0).first();
    if (!msg) return Response.json({ error: "הקמפיין לא נמצא" }, { status: 404 });
    if (!user.is_master) {
        await env.DB.prepare("INSERT INTO system_message_events (message_id, phone, event, created_at, ip, device) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(msg.id, user.phone, body.event, getIsraelTimeForDB(), userIp || '', describeDevice(request.headers.get('user-agent'))).run();
    }
    return Response.json({ success: true });
}

export async function handleAdminListSystemMessages(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        if (!(await isMainAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 401 });

        const today = getIsraelTimeForDB().slice(0, 10);
        const { results: messages } = await env.DB.prepare(`
            SELECT m.*,
                (SELECT COUNT(*) FROM system_message_logs l WHERE l.message_id = m.id) AS total_impressions,
                (SELECT COUNT(DISTINCT phone) FROM system_message_logs l WHERE l.message_id = m.id) AS unique_viewers,
                (SELECT COUNT(*) FROM system_message_logs l WHERE l.message_id = m.id AND l.viewed_at >= ?) AS views_today,
                (SELECT COUNT(*) FROM system_message_events e WHERE e.message_id = m.id AND e.event = 'click') AS clicks,
                (SELECT COUNT(DISTINCT phone) FROM system_message_events e WHERE e.message_id = m.id AND e.event = 'click') AS unique_clickers,
                (SELECT COUNT(*) FROM system_message_events e WHERE e.message_id = m.id AND e.event = 'close') AS closes
            FROM system_messages m ORDER BY m.priority DESC, m.id DESC
        `).bind(today + ' 00:00:00').all();

        return Response.json({
            success: true,
            messages: (messages || []).map(m => ({ ...m, placement: placementOf(m), design: normalizeAdDesign(parseJson(m.design, {})), audience: normalizeAdAudience(parseJson(m.audience, {})) })),
        });
    } catch (error) { return Response.json({ error: "שגיאת שרת", details: error.message }, { status: 500 }); }
}

function dbTime(v) {
    if (!v) return null;
    const s = String(v).replace('T', ' ');
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.slice(0, 16) + ':00' : null;
}

export async function handleAdminSaveSystemMessage(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        const { adminToken, id, title, htmlContent, imageUrl, bgColor, textColor, priority, expiresAt, isMandatory, closeCooldownSeconds, maxViewsPerUser, behaviorAfterLimit, viewIntervalMinutes, showViewCount } = body;

        if (!(await isMainAdmin(env, adminToken))) return Response.json({ error: "לא מורשה" }, { status: 401 });
        if (!title || !htmlContent) return Response.json({ error: "חובה להזין כותרת ותוכן" }, { status: 400 });

        const nowIsraelStr = getIsraelTimeForDB();
        const placement = PLACEMENTS.includes(body.placement) ? body.placement : (isMandatory ? 'popup' : 'sidebar');
        const p_prior = parseInt(priority, 10) || 0;
        const p_exp = dbTime(expiresAt);
        const p_start = dbTime(body.startsAt);
        if (p_start && p_exp && p_start >= p_exp) return Response.json({ error: "זמן הסיום חייב להיות אחרי זמן ההתחלה" }, { status: 400 });
        const p_man = placement === 'popup' ? 1 : 0;
        const p_cool = parseInt(closeCooldownSeconds, 10) || 0;
        const p_max = parseInt(maxViewsPerUser, 10) || 0;
        const p_int = parseInt(viewIntervalMinutes, 10) || 0;
        const p_show = showViewCount ? 1 : 0;
        const p_beh = behaviorAfterLimit === 'downgrade' ? 'downgrade' : 'hide';
        const p_img = safeUrl(imageUrl) || null;
        const p_bg = HEX.test(bgColor || '') ? bgColor : '#ffffff';
        const p_txt = HEX.test(textColor || '') ? textColor : '#1a202c';
        const p_cta_label = String(body.ctaLabel || '').slice(0, 60) || null;
        const p_cta_url = safeUrl(body.ctaUrl) || null;
        if (p_cta_label && !p_cta_url) return Response.json({ error: "לכפתור הפעולה חסרה כתובת קישור (https://…)" }, { status: 400 });
        const p_design = JSON.stringify(normalizeAdDesign(body.design || {}));
        const p_aud = JSON.stringify(normalizeAdAudience(body.audience || {}));
        const p_paused = body.isPaused ? 1 : 0;

        const cols = [title, htmlContent, p_img, p_bg, p_txt, p_prior, p_exp, p_man, p_cool, p_max, p_beh, p_int, p_show, placement, p_start, p_paused, p_aud, p_cta_label, p_cta_url, p_design];
        if (id) {
            await env.DB.prepare(`UPDATE system_messages SET title=?, html_content=?, image_url=?, bg_color=?, text_color=?, priority=?, expires_at=?, is_mandatory=?, close_cooldown_seconds=?, max_views_per_user=?, behavior_after_limit=?, view_interval_minutes=?, show_view_count=?,
                placement=?, starts_at=?, is_paused=?, audience=?, cta_label=?, cta_url=?, design=?, updated_at=? WHERE id=?`)
                .bind(...cols, nowIsraelStr, id).run();
            return Response.json({ success: true, id: Number(id) });
        }
        const r = await env.DB.prepare(`INSERT INTO system_messages (title, html_content, image_url, bg_color, text_color, priority, expires_at, is_mandatory, close_cooldown_seconds, max_views_per_user, behavior_after_limit, view_interval_minutes, show_view_count,
            placement, starts_at, is_paused, audience, cta_label, cta_url, design, created_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`)
            .bind(...cols, nowIsraelStr, nowIsraelStr).run();
        return Response.json({ success: true, id: r.meta.last_row_id });
    } catch (error) { return Response.json({ error: "שגיאת שמירה", details: error.message }, { status: 500 }); }
}

// השהיה / חידוש ושכפול
export async function handleAdminSystemMessageAction(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await isMainAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 401 });
    const id = Number(body.id) || 0;
    const now = getIsraelTimeForDB();
    if (body.action === 'pause' || body.action === 'resume') {
        await env.DB.prepare("UPDATE system_messages SET is_paused = ?, updated_at = ? WHERE id = ?").bind(body.action === 'pause' ? 1 : 0, now, id).run();
        return Response.json({ success: true });
    }
    if (body.action === 'duplicate') {
        const r = await env.DB.prepare(`INSERT INTO system_messages (title, html_content, image_url, bg_color, text_color, priority, expires_at, is_mandatory, close_cooldown_seconds, max_views_per_user, behavior_after_limit, view_interval_minutes, show_view_count,
            placement, starts_at, is_paused, audience, cta_label, cta_url, design, created_at, updated_at)
            SELECT title || ' (עותק)', html_content, image_url, bg_color, text_color, priority, expires_at, is_mandatory, close_cooldown_seconds, max_views_per_user, behavior_after_limit, view_interval_minutes, show_view_count,
            placement, starts_at, 1, audience, cta_label, cta_url, design, ?, ? FROM system_messages WHERE id = ?`).bind(now, now, id).run();
        return Response.json({ success: true, id: r.meta.last_row_id });
    }
    if (body.action === 'reset-stats') {
        await env.DB.batch([
            env.DB.prepare("DELETE FROM system_message_logs WHERE message_id = ?").bind(id),
            env.DB.prepare("DELETE FROM system_message_events WHERE message_id = ?").bind(id),
        ]);
        return Response.json({ success: true });
    }
    return Response.json({ error: "פעולה לא מוכרת" }, { status: 400 });
}

export async function handleAdminDeleteSystemMessage(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        if (!(await isMainAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 401 });
        if (!body.id) return Response.json({ error: "שגיאה" }, { status: 400 });
        await env.DB.batch([
            env.DB.prepare("DELETE FROM system_message_logs WHERE message_id = ?").bind(body.id),
            env.DB.prepare("DELETE FROM system_message_events WHERE message_id = ?").bind(body.id),
            env.DB.prepare("DELETE FROM system_messages WHERE id=?").bind(body.id),
        ]);
        return Response.json({ success: true });
    } catch (e) { return Response.json({ error: "שגיאה" }, { status: 500 }); }
}

// נתונים מפורטים לקמפיין: גרף יומי, כל צופה (כמה פעמים, מתי, מאיזה מכשיר, האם לחץ/סגר) ויומן אחרון
export async function handleAdminGetAdLogs(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        if (!(await isMainAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 401 });
        if (!body.messageId) return Response.json({ error: "שגיאה" }, { status: 400 });
        const id = Number(body.messageId);
        const since = getFutureIsraelTimeForDB(-30 * 24 * 60).slice(0, 10);

        const [viewers, events, daily, dailyEvents, logs] = await Promise.all([
            env.DB.prepare(`SELECT phone, COUNT(*) AS views, MIN(viewed_at) AS first_view, MAX(viewed_at) AS last_view,
                (SELECT device FROM system_message_logs x WHERE x.message_id = l.message_id AND x.phone = l.phone ORDER BY x.id DESC LIMIT 1) AS device,
                (SELECT ip_address FROM system_message_logs x WHERE x.message_id = l.message_id AND x.phone = l.phone ORDER BY x.id DESC LIMIT 1) AS ip
                FROM system_message_logs l WHERE message_id = ? GROUP BY phone ORDER BY last_view DESC LIMIT 1000`).bind(id).all(),
            env.DB.prepare("SELECT phone, event, COUNT(*) AS c, MAX(created_at) AS last_at FROM system_message_events WHERE message_id = ? GROUP BY phone, event").bind(id).all(),
            env.DB.prepare("SELECT substr(viewed_at, 1, 10) AS day, COUNT(*) AS views, COUNT(DISTINCT phone) AS people FROM system_message_logs WHERE message_id = ? AND viewed_at >= ? GROUP BY day ORDER BY day").bind(id, since).all(),
            env.DB.prepare("SELECT substr(created_at, 1, 10) AS day, SUM(CASE WHEN event = 'click' THEN 1 ELSE 0 END) AS clicks, SUM(CASE WHEN event = 'close' THEN 1 ELSE 0 END) AS closes FROM system_message_events WHERE message_id = ? AND created_at >= ? GROUP BY day").bind(id, since).all(),
            env.DB.prepare("SELECT phone, viewed_at, ip_address, device FROM system_message_logs WHERE message_id = ? ORDER BY id DESC LIMIT 200").bind(id).all(),
        ]);
        const names = await getAllNamesFromIni(env.YEMOT_TOKEN).catch(() => ({}));
        const ev = {};
        for (const e of events.results || []) {
            ev[e.phone] = ev[e.phone] || {};
            ev[e.phone][e.event] = { count: e.c, lastAt: e.last_at };
        }
        const de = {};
        for (const d of dailyEvents.results || []) de[d.day] = d;
        return Response.json({
            success: true,
            viewers: (viewers.results || []).map(v => ({
                phone: v.phone, name: names[v.phone] || '', views: v.views, firstView: v.first_view, lastView: v.last_view, device: v.device || '', ip: v.ip || '',
                clicks: (ev[v.phone] && ev[v.phone].click && ev[v.phone].click.count) || 0, closes: (ev[v.phone] && ev[v.phone].close && ev[v.phone].close.count) || 0,
                clickedAt: ev[v.phone] && ev[v.phone].click ? ev[v.phone].click.lastAt : null,
            })),
            daily: (daily.results || []).map(d => ({ day: d.day, views: d.views, people: d.people, clicks: (de[d.day] && de[d.day].clicks) || 0, closes: (de[d.day] && de[d.day].closes) || 0 })),
            logs: (logs.results || []).map(l => ({ ...l, name: names[l.phone] || '' })),
        });
    } catch (e) { return Response.json({ error: "שגיאה בשליפת לוגים" }, { status: 500 }); }
}

// ---------- ערכות עיצוב שמורות ----------

export async function handleAdminAdDesigns(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await isMainAdmin(env, body.adminToken))) return Response.json({ error: "לא מורשה" }, { status: 401 });
    const now = getIsraelTimeForDB();
    if (body.action === 'save') {
        const name = String(body.name || '').trim().slice(0, 60);
        if (!name) return Response.json({ error: "תן שם לערכת העיצוב" }, { status: 400 });
        const bg = HEX.test(body.bgColor || '') ? body.bgColor : '#ffffff';
        const fg = HEX.test(body.textColor || '') ? body.textColor : '#1a202c';
        const design = JSON.stringify(normalizeAdDesign(body.design || {}));
        if (body.id) await env.DB.prepare("UPDATE ad_designs SET name = ?, bg_color = ?, text_color = ?, design = ?, updated_at = ? WHERE id = ?").bind(name, bg, fg, design, now, Number(body.id)).run();
        else await env.DB.prepare("INSERT INTO ad_designs (name, bg_color, text_color, design, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(name, bg, fg, design, now, now).run();
    } else if (body.action === 'delete') {
        await env.DB.prepare("DELETE FROM ad_designs WHERE id = ?").bind(Number(body.id) || 0).run();
    }
    const { results } = await env.DB.prepare("SELECT * FROM ad_designs ORDER BY id DESC").all();
    return Response.json({ success: true, designs: (results || []).map(d => ({ id: d.id, name: d.name, bgColor: d.bg_color, textColor: d.text_color, design: normalizeAdDesign(parseJson(d.design, {})), updatedAt: d.updated_at })) });
}
