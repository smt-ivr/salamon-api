// mail.js
// מערכת הדיוור של מרכז השליטה: בחירת נמענים (אנשים, כתובות או קהל לפי פילוח), עיצוב, תצוגה מקדימה,
// מייל בדיקה, שליחה מיידית או מתוזמנת, ומעקב פתיחות והקלקות לכל נמען.
// כתובות שנחסמו (email_blocklist) לעולם לא מקבלות מייל. מי שביטל קבלת עדכונים מקבל רק "מייל שירות".

import { isMainAdmin, sessionExpired, forbidden } from './adminAuth.js';
import { getIsraelTimeForDB, getFutureIsraelTimeForDB, isPastIsraelTime } from './timeUtils.js';
import { getAllNamesFromIni } from './yemot.js';
import { getSuperAdminEmail } from './chatNotify.js';
import { renderEmail, renderText, normalizeDesign, collectLinks, THEMES } from './emailDesign.js';

const API_URL = 'https://smti.uk/salamon/api';
const SITE_URL = 'https://smti.uk/salamon';
const FROM = 'עכשיו סלומון <salamon@smti.uk>';
const BATCH = 100;              // Resend מקבל עד 100 מיילים בבקשה אחת
const PER_RUN = 500;            // כמה נשלחים בבקשה אחת; השאר ממשיכים במשימה המתוזמנת
const MAX_RECIPIENTS = 5000;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));

async function readBody(request) { return request.json().catch(() => ({})); }

async function requireAdmin(env, body) {
    if (!(await isMainAdmin(env, body.adminToken))) return body.adminToken ? sessionExpired() : forbidden();
    return null;
}

function newId(prefix) { return prefix + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8); }

// ---------- קהל ----------

export const SEGMENTS = {
    all: 'כל המשתמשים עם מייל',
    active: 'פעילים לאחרונה',
    inactive: 'לא נכנסו זמן מה',
    new: 'נרשמו לאחרונה',
    listeners: 'האזינו להודעות לאחרונה',
    staff: 'אנשי צוות',
};

function normalizeAudience(a = {}) {
    const mode = ['users', 'emails', 'segment'].includes(a.mode) ? a.mode : 'users';
    return {
        mode,
        phones: [...new Set((Array.isArray(a.phones) ? a.phones : []).map(p => String(p).replace(/[^\d]/g, '')).filter(p => p.length >= 9))].slice(0, MAX_RECIPIENTS),
        emails: [...new Set((Array.isArray(a.emails) ? a.emails : String(a.emails || '').split(/[\s,;]+/)).map(e => String(e).trim().toLowerCase()).filter(Boolean))].slice(0, MAX_RECIPIENTS),
        segment: SEGMENTS[a.segment] ? a.segment : 'all',
        days: Math.min(Math.max(parseInt(a.days, 10) || 30, 1), 3650),
        service: !!a.service,
    };
}

// מחזיר את רשימת הנמענים הסופית, ומה סונן ולמה
export async function resolveAudience(env, audienceIn) {
    const a = normalizeAudience(audienceIn);
    const since = getFutureIsraelTimeForDB(-a.days * 24 * 60);
    let rows = [];
    const invalid = [];

    if (a.mode === 'users') {
        for (let i = 0; i < a.phones.length; i += 90) {
            const chunk = a.phones.slice(i, i + 90);
            const { results } = await env.DB.prepare(`SELECT phone, email, receive_emails FROM users WHERE phone IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
            rows.push(...(results || []));
        }
    } else if (a.mode === 'emails') {
        const valid = a.emails.filter(e => EMAIL_RE.test(e));
        invalid.push(...a.emails.filter(e => !EMAIL_RE.test(e)));
        const known = {};
        for (let i = 0; i < valid.length; i += 90) {
            const chunk = valid.slice(i, i + 90);
            const { results } = await env.DB.prepare(`SELECT phone, email, receive_emails FROM users WHERE LOWER(email) IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
            for (const r of results || []) known[String(r.email).toLowerCase()] = r;
        }
        rows = valid.map(e => known[e] || { phone: '', email: e, receive_emails: 1 });
    } else {
        const q = {
            all: ["SELECT phone, email, receive_emails FROM users WHERE email IS NOT NULL AND email != ''", []],
            active: ["SELECT u.phone, u.email, u.receive_emails FROM users u JOIN user_presence p ON p.phone = u.phone WHERE u.email IS NOT NULL AND u.email != '' AND p.last_seen_at >= ?", [since]],
            inactive: ["SELECT u.phone, u.email, u.receive_emails FROM users u LEFT JOIN user_presence p ON p.phone = u.phone WHERE u.email IS NOT NULL AND u.email != '' AND (p.last_seen_at IS NULL OR p.last_seen_at < ?)", [since]],
            new: ["SELECT phone, email, receive_emails FROM users WHERE email IS NOT NULL AND email != '' AND created_at >= ?", [since]],
            listeners: ["SELECT u.phone, u.email, u.receive_emails FROM users u WHERE u.email IS NOT NULL AND u.email != '' AND EXISTS (SELECT 1 FROM message_listens l WHERE l.phone = u.phone AND COALESCE(l.last_listened_at, l.listened_at) >= ?)", [since]],
            staff: ["SELECT phone, email, receive_emails FROM users WHERE email IS NOT NULL AND email != '' AND is_admin = 1", []],
        }[a.segment];
        const { results } = await env.DB.prepare(q[0]).bind(...q[1]).all();
        rows = results || [];
    }

    const { results: blocked } = await env.DB.prepare("SELECT LOWER(email) AS email FROM email_blocklist").all();
    const blockSet = new Set((blocked || []).map(b => b.email));
    const seen = new Set();
    const out = [];
    const excluded = { noEmail: 0, optedOut: 0, blocked: 0, invalid: invalid.length, duplicate: 0 };
    for (const r of rows) {
        const email = String(r.email || '').trim().toLowerCase();
        if (!email || !EMAIL_RE.test(email)) { excluded.noEmail++; continue; }
        if (seen.has(email)) { excluded.duplicate++; continue; }
        seen.add(email);
        if (blockSet.has(email)) { excluded.blocked++; continue; }
        if (r.receive_emails === 0 && !a.service) { excluded.optedOut++; continue; }
        out.push({ phone: r.phone || '', email });
    }
    if (a.mode === 'users') excluded.noEmail += a.phones.length - rows.length;
    return { audience: a, recipients: out.slice(0, MAX_RECIPIENTS), excluded };
}

async function withNames(env, recipients) {
    if (!recipients.some(r => r.phone)) return recipients;
    const names = await getAllNamesFromIni(env.YEMOT_TOKEN).catch(() => ({}));
    return recipients.map(r => ({ ...r, name: (r.phone && names[r.phone]) || '' }));
}

// ---------- בניית המייל לנמען ----------

async function buildFor(env, campaign, send, unsubscribeUrl) {
    const design = JSON.parse(campaign.design || '{}');
    const links = JSON.parse(campaign.links || '[]');
    const person = { name: send.name, phone: send.phone, email: send.email };
    const link = u => {
        const i = links.indexOf(u);
        return i >= 0 ? `${API_URL}/m/c/${send.id}/${i}` : u;
    };
    return {
        html: renderEmail({ design, subject: campaign.subject, preheader: campaign.preheader, person, link, pixelUrl: `${API_URL}/m/o/${send.id}.gif`, unsubscribeUrl }),
        text: renderText({ design, person }) + (unsubscribeUrl ? `\n\nהסרה מרשימת התפוצה: ${unsubscribeUrl}` : ''),
        subject: personalizeSubject(campaign.subject, person),
    };
}

function personalizeSubject(s, person) {
    const name = person.name || '';
    return String(s || '').replace(/\{\{\s*name\s*\}\}/g, name || 'לקוח יקר').replace(/\{\{\s*first_name\s*\}\}/g, name.split(/\s+/)[0] || 'לקוח יקר');
}

async function postResend(env, payload, batch) {
    if (!env.RESEND_API_KEY) return { ok: false, error: 'חסר מפתח שליחת מיילים' };
    try {
        const res = await fetch(batch ? 'https://api.resend.com/emails/batch' : 'https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) return { ok: false, error: `שרת הדואר החזיר ${res.status}` };
        return { ok: true };
    } catch (e) { return { ok: false, error: 'שרת הדואר לא זמין' }; }
}

// שליחת הנמענים שעדיין ממתינים, עד PER_RUN בכל הרצה
async function deliver(env, campaignId) {
    const campaign = await env.DB.prepare("SELECT * FROM mail_campaigns WHERE id = ?").bind(campaignId).first();
    if (!campaign || !['sending', 'scheduled'].includes(campaign.status)) return;
    const now = getIsraelTimeForDB();
    if (campaign.status === 'scheduled') await env.DB.prepare("UPDATE mail_campaigns SET status = 'sending', started_at = ? WHERE id = ?").bind(now, campaignId).run();

    const { results: pending } = await env.DB.prepare(`SELECT * FROM mail_sends WHERE campaign_id = ? AND status = 'pending' LIMIT ${PER_RUN}`).bind(campaignId).all();
    for (let i = 0; i < (pending || []).length; i += BATCH) {
        const chunk = pending.slice(i, i + BATCH);
        const items = [];
        const tokenStmts = [];
        for (const s of chunk) {
            const token = crypto.randomUUID();
            tokenStmts.push(env.DB.prepare("INSERT INTO unsubscribe_tokens (token, email, created_at) VALUES (?, ?, ?)").bind(token, s.email, now));
            const unsub = `${SITE_URL}/unsubscribe?token=${token}`;
            const m = await buildFor(env, campaign, s, unsub);
            items.push({ from: FROM, to: [s.email], subject: m.subject, html: m.html, text: m.text, headers: { 'List-Unsubscribe': `<${unsub}>` } });
        }
        await env.DB.batch(tokenStmts);
        const r = await postResend(env, items, true);
        const at = getIsraelTimeForDB();
        await env.DB.batch(chunk.map(s => r.ok
            ? env.DB.prepare("UPDATE mail_sends SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?").bind(at, s.id)
            : env.DB.prepare("UPDATE mail_sends SET status = 'failed', error = ? WHERE id = ?").bind(r.error, s.id)));
    }
    await refreshCounters(env, campaignId);
}

async function refreshCounters(env, campaignId) {
    const c = await env.DB.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending FROM mail_sends WHERE campaign_id = ?`).bind(campaignId).first();
    const done = !c.pending;
    await env.DB.prepare(`UPDATE mail_campaigns SET total = ?, sent_ok = ?, sent_fail = ?, status = CASE WHEN ? THEN (CASE WHEN ? > 0 AND ? = 0 THEN 'failed' ELSE 'sent' END) ELSE status END,
        sent_at = CASE WHEN ? THEN ? ELSE sent_at END WHERE id = ?`)
        .bind(c.total || 0, c.sent || 0, c.failed || 0, done ? 1 : 0, c.failed || 0, c.sent || 0, done ? 1 : 0, getIsraelTimeForDB(), campaignId).run();
}

// משימה מתוזמנת: מיילים מתוזמנים שהגיע זמנם, ומשלוחים גדולים שלא הסתיימו
export async function processScheduledMail(env) {
    const { results } = await env.DB.prepare("SELECT id, status, scheduled_at FROM mail_campaigns WHERE status IN ('scheduled', 'sending') ORDER BY id LIMIT 5").all();
    for (const c of results || []) {
        if (c.status === 'scheduled' && c.scheduled_at && !isPastIsraelTime(c.scheduled_at)) continue;
        await deliver(env, c.id);
    }
}

// ---------- נקודות קצה ----------

function themeList() {
    return Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, { label: v.label, accent: v.accent, accent2: v.accent2, page: v.page, card: v.card }]));
}

export async function handleAdminMailAudience(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const { recipients, excluded } = await resolveAudience(env, body.audience);
    const sample = await withNames(env, recipients.slice(0, 8));
    return Response.json({ success: true, count: recipients.length, excluded, sample, segments: SEGMENTS });
}

export async function handleAdminMailPreview(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const person = { name: 'ישראל ישראלי', phone: '0501234567', email: 'israel@example.com' };
    const html = renderEmail({ design: body.design, subject: body.subject, preheader: body.preheader, person, unsubscribeUrl: `${SITE_URL}/unsubscribe` });
    return Response.json({ success: true, html, themes: themeList() });
}

export async function handleAdminMailTest(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const to = String(body.to || '').trim() || await getSuperAdminEmail(env);
    if (!to || !EMAIL_RE.test(to)) return Response.json({ error: "אין כתובת לבדיקה. הזן כתובת או הגדר מייל למנהל-העל" }, { status: 400 });
    if (!body.subject) return Response.json({ error: "חסר נושא" }, { status: 400 });
    const person = { name: 'ישראל ישראלי', phone: '0501234567', email: to };
    const r = await postResend(env, {
        from: FROM, to: [to], subject: '[בדיקה] ' + personalizeSubject(body.subject, person),
        html: renderEmail({ design: body.design, subject: body.subject, preheader: body.preheader, person }), text: renderText({ design: body.design, person }),
    }, false);
    if (!r.ok) return Response.json({ error: r.error }, { status: 502 });
    return Response.json({ success: true, to });
}

// שמירה כטיוטה, תזמון או שליחה מיידית
export async function handleAdminMailSend(request, env, ctx) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const subject = String(body.subject || '').trim().slice(0, 200);
    const design = normalizeDesign(body.design);
    const action = ['draft', 'schedule', 'send'].includes(body.action) ? body.action : 'send';
    if (!subject) return Response.json({ error: "חסר נושא למייל" }, { status: 400 });
    if (action !== 'draft' && !design.body.trim() && !design.title.trim()) return Response.json({ error: "המייל ריק. כתוב כותרת או תוכן" }, { status: 400 });

    let scheduledAt = null;
    if (action === 'schedule') {
        scheduledAt = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(body.scheduleAt || '') ? String(body.scheduleAt).replace('T', ' ').slice(0, 16) + ':00' : null;
        if (!scheduledAt || isPastIsraelTime(scheduledAt)) return Response.json({ error: "זמן התזמון חייב להיות בעתיד" }, { status: 400 });
    }

    const now = getIsraelTimeForDB();
    const audience = normalizeAudience(body.audience);
    const fields = [subject, String(body.preheader || '').slice(0, 200), JSON.stringify(design), JSON.stringify(audience), JSON.stringify(collectLinks(design)), now];
    let id = Number(body.id) || 0;
    if (id) {
        const existing = await env.DB.prepare("SELECT status FROM mail_campaigns WHERE id = ?").bind(id).first();
        if (!existing) return Response.json({ error: "הדיוור לא נמצא" }, { status: 404 });
        if (!['draft', 'scheduled'].includes(existing.status)) return Response.json({ error: "דיוור שכבר נשלח אי אפשר לערוך. אפשר לשכפל אותו" }, { status: 400 });
        await env.DB.prepare("UPDATE mail_campaigns SET subject = ?, preheader = ?, design = ?, audience = ?, links = ?, updated_at = ?, status = 'draft', scheduled_at = NULL WHERE id = ?").bind(...fields, id).run();
        await env.DB.prepare("DELETE FROM mail_sends WHERE campaign_id = ? AND status = 'pending'").bind(id).run();
    } else {
        const r = await env.DB.prepare("INSERT INTO mail_campaigns (subject, preheader, design, audience, links, updated_at, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')").bind(...fields, now).run();
        id = r.meta.last_row_id;
    }
    if (action === 'draft') return Response.json({ success: true, id, status: 'draft' });

    const { recipients } = await resolveAudience(env, audience);
    if (!recipients.length) return Response.json({ error: "אין נמענים שאפשר לשלוח אליהם", id }, { status: 400 });
    const named = await withNames(env, recipients);
    const stmts = named.map(r => env.DB.prepare("INSERT INTO mail_sends (id, campaign_id, phone, email, name, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)").bind(newId('ms_'), id, r.phone, r.email, r.name || '', now));
    for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
    await env.DB.prepare("UPDATE mail_campaigns SET status = ?, scheduled_at = ?, total = ? WHERE id = ?").bind(action === 'schedule' ? 'scheduled' : 'sending', scheduledAt, named.length, id).run();

    if (action === 'schedule') return Response.json({ success: true, id, status: 'scheduled', total: named.length });
    await deliver(env, id);
    const c = await env.DB.prepare("SELECT status, total, sent_ok, sent_fail FROM mail_campaigns WHERE id = ?").bind(id).first();
    return Response.json({ success: true, id, status: c.status, total: c.total, sent: c.sent_ok, failed: c.sent_fail });
}

function stats(row) {
    return {
        total: row.total || 0, sent: row.sent_ok || 0, failed: row.sent_fail || 0,
        opened: row.opened || 0, clicked: row.clicked || 0,
    };
}

export async function handleAdminMailList(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const { results } = await env.DB.prepare(`SELECT c.id, c.subject, c.status, c.created_at, c.updated_at, c.scheduled_at, c.sent_at, c.total, c.sent_ok, c.sent_fail, c.audience, c.design,
        (SELECT COUNT(*) FROM mail_sends s WHERE s.campaign_id = c.id AND s.opened_at IS NOT NULL) AS opened,
        (SELECT COUNT(*) FROM mail_sends s WHERE s.campaign_id = c.id AND s.clicked_at IS NOT NULL) AS clicked
        FROM mail_campaigns c ORDER BY c.id DESC LIMIT 200`).all();
    return Response.json({
        success: true, segments: SEGMENTS, themes: themeList(),
        campaigns: (results || []).map(r => {
            const design = JSON.parse(r.design || '{}');
            return { id: r.id, subject: r.subject, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, scheduledAt: r.scheduled_at, sentAt: r.sent_at, audience: JSON.parse(r.audience || '{}'), theme: design.theme || 'salamon', layout: design.layout || 'card', ...stats(r) };
        }),
    });
}

export async function handleAdminMailGet(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const c = await env.DB.prepare("SELECT * FROM mail_campaigns WHERE id = ?").bind(Number(body.id) || 0).first();
    if (!c) return Response.json({ error: "הדיוור לא נמצא" }, { status: 404 });
    const { results: sends } = await env.DB.prepare("SELECT phone, email, name, status, error, sent_at, opened_at, open_count, clicked_at, click_count, last_ip, last_device FROM mail_sends WHERE campaign_id = ? ORDER BY (opened_at IS NULL), opened_at DESC, email LIMIT 2000").bind(c.id).all();
    const { results: clicks } = await env.DB.prepare("SELECT link_index, COUNT(*) AS clicks, COUNT(DISTINCT send_id) AS people FROM mail_clicks WHERE campaign_id = ? GROUP BY link_index").bind(c.id).all();
    const links = JSON.parse(c.links || '[]');
    const list = sends || [];
    return Response.json({
        success: true,
        campaign: {
            id: c.id, subject: c.subject, preheader: c.preheader, status: c.status, design: JSON.parse(c.design || '{}'), audience: JSON.parse(c.audience || '{}'),
            createdAt: c.created_at, scheduledAt: c.scheduled_at, sentAt: c.sent_at,
            ...stats({ ...c, opened: list.filter(s => s.opened_at).length, clicked: list.filter(s => s.clicked_at).length }),
        },
        recipients: list,
        links: links.map((url, i) => { const k = (clicks || []).find(x => x.link_index === i) || {}; return { url, clicks: k.clicks || 0, people: k.people || 0 }; }),
    });
}

export async function handleAdminMailDelete(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const id = Number(body.id) || 0;
    await env.DB.batch([
        env.DB.prepare("DELETE FROM mail_clicks WHERE campaign_id = ?").bind(id),
        env.DB.prepare("DELETE FROM mail_sends WHERE campaign_id = ?").bind(id),
        env.DB.prepare("DELETE FROM mail_campaigns WHERE id = ?").bind(id),
    ]);
    return Response.json({ success: true });
}

// ביטול תזמון: הדיוור חוזר לטיוטה
export async function handleAdminMailCancel(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const id = Number(body.id) || 0;
    const r = await env.DB.prepare("UPDATE mail_campaigns SET status = 'draft', scheduled_at = NULL WHERE id = ? AND status = 'scheduled'").bind(id).run();
    if (!r.meta.changes) return Response.json({ error: "אפשר לבטל רק דיוור מתוזמן שעוד לא יצא" }, { status: 400 });
    await env.DB.prepare("DELETE FROM mail_sends WHERE campaign_id = ? AND status = 'pending'").bind(id).run();
    return Response.json({ success: true });
}

// ---------- מעקב פתיחה והקלקה (נקראים מתוך המייל עצמו) ----------

function deviceOf(ua) {
    ua = String(ua || '');
    if (/GoogleImageProxy/i.test(ua)) return 'Gmail';
    if (/iPhone|iPad/i.test(ua)) return 'iPhone';
    if (/Android/i.test(ua)) return 'Android';
    if (/Outlook|Microsoft/i.test(ua)) return 'Outlook';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac OS/i.test(ua)) return 'Mac';
    return ua ? 'אחר' : '';
}

export async function handleMailOpen(request, env, ip) {
    const id = (new URL(request.url).pathname.match(/\/m\/o\/(ms_[a-f0-9]+)/) || [])[1];
    if (id) {
        const now = getIsraelTimeForDB();
        await env.DB.prepare("UPDATE mail_sends SET opened_at = COALESCE(opened_at, ?), open_count = COALESCE(open_count, 0) + 1, last_ip = ?, last_device = ? WHERE id = ?")
            .bind(now, ip || '', deviceOf(request.headers.get('user-agent')), id).run().catch(() => {});
    }
    return new Response(PIXEL, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' } });
}

export async function handleMailClick(request, env, ip) {
    const m = new URL(request.url).pathname.match(/\/m\/c\/(ms_[a-f0-9]+)\/(\d+)/);
    let target = SITE_URL;
    if (m) {
        const send = await env.DB.prepare("SELECT s.id, s.campaign_id, c.links FROM mail_sends s JOIN mail_campaigns c ON c.id = s.campaign_id WHERE s.id = ?").bind(m[1]).first();
        const links = send ? JSON.parse(send.links || '[]') : [];
        const idx = Number(m[2]);
        // מפנים רק לכתובות שנשמרו בדיוור עצמו, כדי שהקישור לא ישמש להפניה לאתרים זרים
        if (send && links[idx]) {
            target = links[idx];
            const now = getIsraelTimeForDB();
            await env.DB.batch([
                env.DB.prepare("UPDATE mail_sends SET clicked_at = COALESCE(clicked_at, ?), click_count = COALESCE(click_count, 0) + 1, opened_at = COALESCE(opened_at, ?), last_ip = ?, last_device = ? WHERE id = ?")
                    .bind(now, now, ip || '', deviceOf(request.headers.get('user-agent')), send.id),
                env.DB.prepare("INSERT INTO mail_clicks (send_id, campaign_id, link_index, clicked_at, ip) VALUES (?, ?, ?, ?, ?)").bind(send.id, send.campaign_id, idx, now, ip || ''),
            ]).catch(() => {});
        }
    }
    return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } });
}
