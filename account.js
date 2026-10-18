// account.js
// אזור "הגדרות חשבון" של הלקוח: מכשירים מחוברים (עם ניתוק) והיסטוריית התחברויות ואבטחה.
// הטוקנים עצמם לעולם לא נשלחים לדפדפן - כל חיבור מזוהה במזהה מקוצר שנגזר מה-hash שלו.

import { authenticateUser } from './auth.js';
import { describeDevice } from './activity.js';
import { sha256 } from './chatNotify.js';

const SECURITY_ACTIONS = ['LOGIN', 'LOGIN_MASTER', 'LOGIN_FAILED', 'LOGOUT', 'PASSWORD_CHANGE', 'PASSWORD_RESET', 'PROFILE_UPDATE', 'EMAIL_LINK_OPENED', 'REGISTER'];

async function handleOf(tokenId) {
    return (await sha256('session:' + tokenId)).slice(0, 20);
}

function sessionLabel(type) {
    switch (type) {
        case 'google_perm': return { method: 'google', persistent: true };
        case 'password_perm': return { method: 'password', persistent: true };
        case 'email_link': return { method: 'email_link', persistent: false };
        default: return { method: 'password', persistent: false };
    }
}

export async function handleAccountSecurity(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!body.userToken) return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
    const user = await authenticateUser(env.DB, body.userToken);
    if (!user) return Response.json({ error: "החיבור פג תוקף, יש להתחבר מחדש" }, { status: 401 });

    const { results: tokens } = await env.DB.prepare("SELECT id, token_type, created_at, expires_at, last_used_at, session_email FROM user_tokens WHERE phone = ? AND token_type != 'master' ORDER BY last_used_at DESC").bind(user.phone).all();

    // ניתוק מכשיר בודד או כל המכשירים האחרים
    if (body.revoke || body.revokeOthers) {
        for (const t of tokens || []) {
            if (t.id === body.userToken) continue;
            if (body.revokeOthers || (await handleOf(t.id)) === body.revoke) {
                await env.DB.prepare("DELETE FROM user_tokens WHERE id = ? AND phone = ?").bind(t.id, user.phone).run();
            }
        }
    }
    return Response.json({ success: true, ...(await buildSecurity(env, user.phone, body.userToken)) });
}

async function buildSecurity(env, phone, currentToken) {
    const { results: tokens } = await env.DB.prepare("SELECT id, token_type, created_at, expires_at, last_used_at, session_email FROM user_tokens WHERE phone = ? AND token_type != 'master' ORDER BY last_used_at DESC").bind(phone).all();
    const sessions = [];
    for (const t of tokens || []) {
        sessions.push({
            handle: await handleOf(t.id), current: t.id === currentToken, ...sessionLabel(t.token_type),
            createdAt: t.created_at, lastUsedAt: t.last_used_at, expiresAt: t.expires_at, email: t.session_email || '',
        });
    }

    const { results: events } = await env.DB.prepare(`SELECT action, details, ip, user_agent, created_at FROM user_activity
        WHERE phone = ? AND action IN (${SECURITY_ACTIONS.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 25`).bind(phone, ...SECURITY_ACTIONS).all();

    return {
        sessions,
        history: (events || []).map(e => {
            let meta = null;
            if (e.details && e.details.startsWith('{')) { try { meta = JSON.parse(e.details); } catch (err) {} }
            return { action: e.action, meta, details: meta ? '' : e.details, ip: e.ip, device: describeDevice(e.user_agent), createdAt: e.created_at };
        }),
    };
}
