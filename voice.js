// voice.js
// "הודעות קוליות" במרכז השליטה: לכל הודעה בשלוחה 1/2 - מי ראה אותה באתר, מי השמיע באתר ומי שמע בטלפון.
// השמיעות בטלפון נקראות מקובץ נתוני ההאזנה של ימות המשיח (Log/Listening/1/2/<מספר>.ini),
// שנשמר כשבשלוחה מוגדר save_listening_data=yes. הקובץ כולל את מספר השומעים ושורה לכל טלפון ששמע.

import { isMainAdmin, sessionExpired, forbidden } from './adminAuth.js';
import { getAllNamesFromIni } from './yemot.js';

const FOLDER = 'ivr2:/1/2';
const LISTEN_LOG = 'ivr2:Log/Listening/1/2';

async function readBody(request) { return request.json().catch(() => ({})); }

async function requireAdmin(env, body) {
    if (!(await isMainAdmin(env, body.adminToken))) return body.adminToken ? sessionExpired() : forbidden();
    return null;
}

async function yemotText(env, what) {
    try {
        const res = await fetch(`https://www.call2all.co.il/ym/api/GetTextFile?token=${env.YEMOT_TOKEN}&what=${encodeURIComponent(what)}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.responseStatus === 'OK' ? (data.contents || '') : null;
    } catch (e) { return null; }
}

function normPhone(raw) {
    let d = String(raw || '').replace(/[^\d]/g, '');
    if (d.startsWith('972')) d = '0' + d.slice(3);
    return d;
}

// תאריך מימות המשיח (כמה פורמטים אפשריים) -> "YYYY-MM-DD HH:MM:SS"
function parseDates(value) {
    const out = [];
    const v = String(value || '');
    const pad = n => String(n).padStart(2, '0');
    let m;
    const iso = /(\d{4})-(\d{1,2})-(\d{1,2})[ T_-](\d{1,2})[:-](\d{2})(?:[:-](\d{2}))?/g;
    while ((m = iso.exec(v))) out.push(`${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4])}:${m[5]}:${m[6] || '00'}`);
    const il = /(\d{1,2})[./](\d{1,2})[./](\d{4})[ ,_-]+(\d{1,2}):(\d{2})(?::(\d{2}))?/g;
    while ((m = il.exec(v))) out.push(`${m[3]}-${pad(m[2])}-${pad(m[1])} ${pad(m[4])}:${m[5]}:${m[6] || '00'}`);
    if (!out.length) {
        const unix = v.match(/\b(1[5-9]\d{8})\b/);
        if (unix) {
            const d = new Date(Number(unix[1]) * 1000);
            out.push(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d));
        }
    }
    return out.sort();
}

// פענוח קובץ נתוני ההאזנה: ListenAmount ושורה (או קבוצת שורות) לכל טלפון.
// הפענוח סובלני לכמה מבנים: "טלפון=תאריך", "מפתח=ערך" שמכיל טלפון, ומקטעים בסגנון [..] עם Phone=/Date=.
export function parseListeningIni(text) {
    const result = { amount: 0, listeners: [] };
    if (!text) return result;
    const byPhone = {};
    const PHONE_RE = /(?:^|[^\d])((?:972|0)5\d{8}|(?:972|0)[2-9]\d{7,8}|0\d{8,9})(?![\d])/g;
    const add = (phone, times, count, raw) => {
        phone = normPhone(phone);
        if (phone.length < 9 || phone.length > 10) return;
        const p = byPhone[phone] = byPhone[phone] || { phone, times: [], count: 0, raw: '' };
        p.times.push(...times);
        p.count += count || Math.max(times.length, 1);
        if (raw) p.raw = (p.raw ? p.raw + ' | ' : '') + raw.slice(0, 120);
    };
    const phonesIn = s => { const out = []; let m; PHONE_RE.lastIndex = 0; while ((m = PHONE_RE.exec(s))) out.push(m[1]); return [...new Set(out)]; };

    let section = null;
    const flush = () => {
        if (section && section.phones.length) for (const ph of section.phones) add(ph, section.times, section.count, section.raw);
        section = null;
    };
    for (const rawLine of String(text).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (/^\[.*\]$/.test(line)) { flush(); section = { phones: phonesIn(line), times: [], count: 0, raw: line }; continue; }
        const eq = line.indexOf('=');
        const key = eq > 0 ? line.slice(0, eq).trim() : '';
        const value = eq > 0 ? line.slice(eq + 1).trim() : line;
        if (/^ListenAmount$/i.test(key)) { result.amount = parseInt(value, 10) || 0; continue; }
        if (section) {
            section.phones.push(...phonesIn(line).filter(p => !section.phones.includes(p)));
            section.times.push(...parseDates(value));
            if (/count|amount|times|כמות/i.test(key) && /^\d+$/.test(value)) section.count = parseInt(value, 10);
            section.raw += ' ' + line;
            continue;
        }
        const phones = phonesIn(key).length ? phonesIn(key) : phonesIn(value);
        if (!phones.length) continue;
        const times = parseDates(value);
        const cnt = !times.length && /^\d{1,4}$/.test(value) ? parseInt(value, 10) : 0;
        for (const ph of phones) add(ph, times, cnt, times.length ? '' : value);
    }
    flush();
    result.listeners = Object.values(byPhone).map(p => {
        const times = [...new Set(p.times)].sort();
        return { ...p, times, first: times[0] || null, last: times[times.length - 1] || null };
    });
    if (!result.amount) result.amount = result.listeners.length;
    return result;
}

function parseTxt(contents) {
    let phone = '', name = '', source = 'phone', date = null;
    if (!contents) return { phone, name, source, date };
    if (contents.includes('Phone-')) phone = contents.split('Phone-')[1].split('-')[0].trim();
    if (contents.includes('ValName-')) {
        name = contents.split('ValName-')[1].trim();
        if (/\[WEB_FILE\]/.test(name)) source = 'web_file';
        else if (/\[WEB_REC\]|\[WEB\]|\(דרך האתר\)/.test(name)) source = 'web_record';
        name = name.replace(/\[WEB_FILE\]|\[WEB_REC\]|\[WEB\]|\(דרך האתר\)/g, '').trim();
    }
    const dm = contents.match(/Date-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
    if (dm) date = `${dm[1]}-${dm[2]}-${dm[3]} ${dm[4]}:${dm[5]}:${dm[6]}`;
    return { phone, name, source, date };
}

async function dbStats(env, ids) {
    const map = {};
    for (const id of ids) map[id] = { views: 0, viewers: 0, listens: 0, listeners: 0, lastListen: null };
    if (!ids.length) return map;
    const marks = ids.map(() => '?').join(',');
    const [v, l] = await Promise.all([
        env.DB.prepare(`SELECT file_id, COUNT(*) AS viewers, SUM(view_count) AS views FROM message_views WHERE file_id IN (${marks}) GROUP BY file_id`).bind(...ids).all(),
        env.DB.prepare(`SELECT file_id, COUNT(*) AS listeners, SUM(COALESCE(listen_count, 1)) AS listens, MAX(COALESCE(last_listened_at, listened_at)) AS last FROM message_listens WHERE file_id IN (${marks}) GROUP BY file_id`).bind(...ids).all(),
    ]);
    for (const r of v.results || []) Object.assign(map[r.file_id], { views: r.views || 0, viewers: r.viewers || 0 });
    for (const r of l.results || []) Object.assign(map[r.file_id], { listens: r.listens || 0, listeners: r.listeners || 0, lastListen: r.last });
    return map;
}

// רשימת ההודעות עם נתוני האתר (נתוני הטלפון נטענים בנפרד, בקבוצות קטנות)
export async function handleAdminVoiceList(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 25, 5), 40);
    const page = Math.max(parseInt(body.page, 10) || 1, 1);

    let data;
    try {
        const res = await fetch(`https://www.call2all.co.il/ym/api/GetIVR2Dir?token=${env.YEMOT_TOKEN}&path=${encodeURIComponent(FOLDER)}&filesLimit=${limit}&filesFrom=${(page - 1) * limit}`);
        data = await res.json();
    } catch (e) { return Response.json({ error: "אין חיבור לימות המשיח" }, { status: 502 }); }
    if (!data || data.responseStatus !== 'OK') return Response.json({ error: "שגיאה בקבלת ההודעות מימות המשיח" }, { status: 502 });

    const files = (data.files || []).filter(f => f.fileType === 'AUDIO' && /^\d+\.(wav|mp3)$/i.test(f.name));
    const ids = files.map(f => f.name.split('.')[0]);
    const [stats, txts] = await Promise.all([
        dbStats(env, ids),
        Promise.all(ids.map(id => yemotText(env, `${FOLDER}/${id}.txt`))),
    ]);
    const messages = files.map((f, i) => {
        const t = parseTxt(txts[i]);
        return {
            fileId: ids[i], name: f.name, duration: f.durationStr || '', size: f.size || 0, mtime: f.mtime || t.date || '',
            recorder: { phone: t.phone || f.phone || '', name: t.name || '', source: t.source },
            site: stats[ids[i]],
        };
    });
    return Response.json({ success: true, messages, page, hasMore: (data.files || []).length >= limit });
}

// מספר השומעים בטלפון לכמה הודעות (עד 10 בבקשה)
export async function handleAdminVoicePhoneStats(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const ids = [...new Set((body.fileIds || []).map(String).filter(id => /^\d+$/.test(id)))].slice(0, 10);
    const texts = await Promise.all(ids.map(id => yemotText(env, `${LISTEN_LOG}/${id}.ini`)));
    const stats = {};
    ids.forEach((id, i) => {
        const p = parseListeningIni(texts[i]);
        stats[id] = { available: texts[i] !== null, amount: p.amount, detailed: p.listeners.length };
    });
    return Response.json({ success: true, stats });
}

// הקהל המלא של הודעה אחת: כל אדם, מה עשה ובאיזה ערוץ, ומי עוד לא שמע
export async function handleAdminVoiceAudience(request, env) {
    const body = await readBody(request);
    const denied = await requireAdmin(env, body);
    if (denied) return denied;
    const fileId = String(body.fileId || '');
    if (!/^\d+$/.test(fileId)) return Response.json({ error: "מזהה הודעה לא חוקי" }, { status: 400 });
    return Response.json({ success: true, ...(await buildAudience(env, fileId, true)) });
}

// משמש גם את מרכז השליטה וגם את מנהל-העל באתר החדש
export async function buildAudience(env, fileId, withRaw = false) {

    const [views, listens, users, iniText, txt, names] = await Promise.all([
        env.DB.prepare("SELECT phone, first_seen_at, last_seen_at, view_count FROM message_views WHERE file_id = ?").bind(fileId).all(),
        env.DB.prepare("SELECT phone, listened_at, COALESCE(listen_count, 1) AS listen_count, COALESCE(last_listened_at, listened_at) AS last_listened_at FROM message_listens WHERE file_id = ?").bind(fileId).all(),
        env.DB.prepare("SELECT phone FROM users").all(),
        yemotText(env, `${LISTEN_LOG}/${fileId}.ini`),
        yemotText(env, `${FOLDER}/${fileId}.txt`),
        getAllNamesFromIni(env.YEMOT_TOKEN).catch(() => ({})),
    ]);
    const phoneLog = parseListeningIni(iniText);
    const accounts = new Set((users.results || []).map(u => u.phone));
    const people = {};
    const person = phone => (people[phone] = people[phone] || { phone, name: names[phone] || '', hasAccount: accounts.has(phone), site: null, web: null, tel: null });

    for (const v of views.results || []) person(v.phone).site = { first: v.first_seen_at, last: v.last_seen_at, count: v.view_count || 1 };
    for (const l of listens.results || []) person(l.phone).web = { first: l.listened_at, last: l.last_listened_at, count: l.listen_count };
    for (const t of phoneLog.listeners) person(t.phone).tel = { first: t.first, last: t.last, count: t.count, times: t.times.slice(-20), raw: t.times.length ? '' : t.raw };

    const list = Object.values(people).map(p => {
        const last = [p.site && p.site.last, p.web && p.web.last, p.tel && p.tel.last].filter(Boolean).sort().pop() || null;
        return { ...p, heard: !!(p.web || p.tel), last };
    }).sort((a, b) => (b.last || '').localeCompare(a.last || ''));

    // מי עוד לא שמע: כל מי שבספר הטלפונים או עם חשבון באתר, ולא שמע באף ערוץ
    const heard = new Set(list.filter(p => p.heard).map(p => p.phone));
    const recorder = parseTxt(txt);
    const everyone = new Set([...Object.keys(names).filter(p => /^\d{9,12}$/.test(p)), ...accounts]);
    const notHeard = [...everyone].filter(p => !heard.has(p) && p !== recorder.phone).slice(0, 3000)
        .map(p => ({ phone: p, name: names[p] || '', hasAccount: accounts.has(p), sawOnSite: !!(people[p] && people[p].site) }));

    return {
        fileId,
        raw: withRaw ? (iniText || '').slice(0, 20000) : undefined,
        recorder: { ...recorder, displayName: recorder.name || names[recorder.phone] || recorder.phone },
        phone: { available: iniText !== null, amount: phoneLog.amount, detailed: phoneLog.listeners.length > 0 },
        totals: {
            siteViewers: list.filter(p => p.site).length,
            webListeners: list.filter(p => p.web).length,
            phoneListeners: Math.max(phoneLog.amount, phoneLog.listeners.length),
            reached: heard.size,
        },
        people: list, notHeard,
    };
}
