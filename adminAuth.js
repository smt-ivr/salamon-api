// adminAuth.js
// אימות המנהל הראשי (חשבון המנהל מטבלת admins). רק הוא מורשה לצ'אט, למעקב ולנעילות.

export async function isMainAdmin(env, adminToken) {
    if (!adminToken || typeof adminToken !== 'string' || !adminToken.includes(':')) return false;
    const sep = adminToken.indexOf(':');
    const username = adminToken.slice(0, sep);
    const password = adminToken.slice(sep + 1);
    const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, password).first();
    return !!admin;
}

export function forbidden(message = "פעולה זו שמורה למנהל הראשי בלבד") {
    return Response.json({ error: message }, { status: 403 });
}
