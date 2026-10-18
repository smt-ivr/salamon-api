// nameLocks.js
// נעילת שמות בספר הטלפונים של ימות המשיח.
// מצבים:
//   staff   - חברי צוות לא יכולים לשנות את השם דרך המערכת (המנהל הראשי כן).
//   enforce - בנוסף, אם השם שונה בכל דרך אחרת (למשל בטלפון), הוא משוחזר אוטומטית בכל הרצה של ה-cron.
// לכל נעילה אפשר להגדיר תאריך התחלה ותאריך סיום (ריק = מיד / ללא הגבלה).

import { getIsraelTimeForDB, getFutureIsraelTimeForDB } from './timeUtils.js';
import { getAllNamesFromIni, updateNamesInIni } from './yemot.js';
import { isMainAdmin, forbidden } from './adminAuth.js';
import { logActivity } from './activity.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;

function normalizeDate(value) {
    if (!value) return null;
    const v = String(value).replace('T', ' ').trim();
    if (!DATE_RE.test(v)) return undefined;
    return v.length === 16 ? v + ':00' : v;
}

export function lockStatus(lock, now = getIsraelTimeForDB()) {
    if (lock.starts_at && lock.starts_at > now) return 'scheduled';
    if (lock.expires_at && lock.expires_at <= now) return 'expired';
    return 'active';
}

function present(lock, now) {
    return {
        phone: lock.phone, lockedName: lock.locked_name, mode: lock.mode, startsAt: lock.starts_at, expiresAt: lock.expires_at,
        reason: lock.reason || '', createdAt: lock.created_at, updatedAt: lock.updated_at,
        lastEnforcedAt: lock.last_enforced_at, enforceCount: lock.enforce_count || 0, status: lockStatus(lock, now),
    };
}

export async function getLocksMap(env) {
    const now = getIsraelTimeForDB();
    const { results } = await env.DB.prepare("SELECT * FROM name_locks").all();
    const map = {};
    for (const l of results || []) map[l.phone] = present(l, now);
    return map;
}

export async function getActiveLock(env, phone) {
    const lock = await env.DB.prepare("SELECT * FROM name_locks WHERE phone = ?").bind(phone).first();
    if (!lock) return null;
    const p = present(lock, getIsraelTimeForDB());
    return p.status === 'active' ? p : null;
}

// כשהמנהל הראשי משנה שם נעול, השם החדש הופך לשם הנעול כדי שהאכיפה לא תחזיר את הישן
export async function syncLockedName(env, phone, newName) {
    await env.DB.prepare("UPDATE name_locks SET locked_name = ?, updated_at = ? WHERE phone = ?").bind(newName, getIsraelTimeForDB(), phone).run();
}

export function describeLock(lock) {
    const until = lock.expiresAt ? ` עד ${lock.expiresAt.slice(8, 10)}/${lock.expiresAt.slice(5, 7)}/${lock.expiresAt.slice(0, 4)} ${lock.expiresAt.slice(11, 16)}` : '';
    return `השם של מספר זה נעול${until}${lock.reason ? ` (${lock.reason})` : ''}. רק המנהל הראשי רשאי לשנות אותו.`;
}

// ---------- נתיבי ניהול (מנהל ראשי בלבד) ----------

export async function handleAdminNameLocksList(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await isMainAdmin(env, body.adminToken))) return forbidden();
    const map = await getLocksMap(env);
    return Response.json({ success: true, locks: Object.values(map) });
}

export async function handleAdminNameLocksSave(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await isMainAdmin(env, body.adminToken))) return forbidden();

    const phones = [...new Set((Array.isArray(body.phones) ? body.phones : [body.phone]).map(p => String(p || '').trim()).filter(Boolean))];
    if (!phones.length) return Response.json({ error: "לא נבחרו מספרים לנעילה" }, { status: 400 });
    if (phones.length > 5000) return Response.json({ error: "יותר מדי מספרים בבקשה אחת" }, { status: 400 });

    const mode = body.mode === 'enforce' ? 'enforce' : 'staff';
    const startsAt = normalizeDate(body.startsAt);
    const expiresAt = normalizeDate(body.expiresAt);
    if (startsAt === undefined || expiresAt === undefined) return Response.json({ error: "פורמט תאריך לא תקין" }, { status: 400 });
    const now = getIsraelTimeForDB();
    if (expiresAt && expiresAt <= now) return Response.json({ error: "תאריך הסיום כבר עבר" }, { status: 400 });
    if (startsAt && expiresAt && expiresAt <= startsAt) return Response.json({ error: "תאריך הסיום חייב להיות אחרי תאריך ההתחלה" }, { status: 400 });

    const reason = String(body.reason || '').slice(0, 200);
    let customName = null;
    if (body.nameMode === 'custom') {
        customName = String(body.name || '').trim().replace(/[\r\n=]/g, ' ');
        if (!customName) return Response.json({ error: "יש להזין את השם לנעילה" }, { status: 400 });
    }

    const names = customName === null ? await getAllNamesFromIni(env.YEMOT_TOKEN) : {};
    const stmts = phones.map(phone => env.DB.prepare(`INSERT INTO name_locks (phone, locked_name, mode, starts_at, expires_at, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET locked_name = excluded.locked_name, mode = excluded.mode, starts_at = excluded.starts_at,
        expires_at = excluded.expires_at, reason = excluded.reason, updated_at = excluded.updated_at`)
        .bind(phone, customName ?? (names[phone] || ''), mode, startsAt, expiresAt, reason, now, now));
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

    // נעילה עם שם מותאם: מעדכנים מיד את ימות
    let applied = null;
    if (customName !== null && (!startsAt || startsAt <= now)) {
        const updates = {};
        for (const p of phones) updates[p] = customName;
        const res = await updateNamesInIni(updates, env.YEMOT_TOKEN).catch(e => ({ responseStatus: 'ERROR', message: e.message }));
        applied = res && res.responseStatus === 'OK';
    }

    return Response.json({ success: true, message: `${phones.length} מספרים ננעלו`, count: phones.length, applied });
}

export async function handleAdminNameLocksDelete(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await isMainAdmin(env, body.adminToken))) return forbidden();
    const phones = (Array.isArray(body.phones) ? body.phones : [body.phone]).map(p => String(p || '').trim()).filter(Boolean);
    if (!phones.length) return Response.json({ error: "לא נבחרו מספרים" }, { status: 400 });
    for (let i = 0; i < phones.length; i += 90) {
        const chunk = phones.slice(i, i + 90);
        await env.DB.prepare(`DELETE FROM name_locks WHERE phone IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).run();
    }
    return Response.json({ success: true, message: `הנעילה הוסרה מ-${phones.length} מספרים` });
}

export async function handleAdminNameLocksEnforce(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await isMainAdmin(env, body.adminToken))) return forbidden();
    const result = await enforceNameLocks(env);
    return Response.json({ success: true, ...result });
}

// ---------- אכיפה (cron) ----------

export async function enforceNameLocks(env) {
    const now = getIsraelTimeForDB();
    const { results } = await env.DB.prepare("SELECT * FROM name_locks WHERE mode = 'enforce'").all();
    const active = (results || []).filter(l => lockStatus(l, now) === 'active' && l.locked_name);
    if (!active.length) return { checked: 0, restored: [] };

    const names = await getAllNamesFromIni(env.YEMOT_TOKEN);
    if (!Object.keys(names).length) return { checked: 0, restored: [], error: 'לא ניתן לקרוא את קובץ השמות' };

    const updates = {};
    for (const l of active) if ((names[l.phone] || '') !== l.locked_name) updates[l.phone] = l.locked_name;
    const restored = Object.keys(updates);

    if (restored.length) {
        const res = await updateNamesInIni(updates, env.YEMOT_TOKEN);
        if (!res || res.responseStatus !== 'OK') return { checked: active.length, restored: [], error: 'עדכון ימות נכשל' };
        await env.DB.batch(restored.map(p => env.DB.prepare("UPDATE name_locks SET enforce_count = enforce_count + 1 WHERE phone = ?").bind(p)));
        for (const p of restored) {
            await logActivity(env, p, 'NAME_RESTORED', JSON.stringify({ from: names[p] || '', to: updates[p] }), '', '', now).catch(() => {});
        }
    }
    await env.DB.prepare("UPDATE name_locks SET last_enforced_at = ? WHERE mode = 'enforce'").bind(now).run();
    // נעילות שפג תוקפן לפני יותר מ-90 יום נמחקות
    await env.DB.prepare("DELETE FROM name_locks WHERE expires_at IS NOT NULL AND expires_at < ?").bind(getFutureIsraelTimeForDB(-90 * 24 * 60)).run();
    return { checked: active.length, restored };
}
