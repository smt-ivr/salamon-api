import { checkPhoneStatus, getNameFromIni } from './yemot.js';

export async function handleAdminLogin(request, env) {
    const body = await request.json().catch(() => ({}));
    const { username, password } = body;

    // הגנה מקריסת המסד
    if (!username || !password) {
        return Response.json({ error: "חובה להזין שם משתמש וסיסמה" }, { status: 400 });
    }

    const admin = await env.DB.prepare("SELECT * FROM admins WHERE username = ? AND password = ?")
        .bind(username, password).first();

    if (!admin) {
        return Response.json({ error: "שם משתמש או סיסמת מנהל שגויים" }, { status: 401 });
    }

    return Response.json({ 
        success: true, 
        message: "התחברת כמנהל בהצלחה", 
        admin: {
            username: admin.username,
            password: admin.password
        },
        adminToken: `${admin.username}:${admin.password}` 
    });
}

export async function handleAdminGetUsers(request, env) {
    const body = await request.json().catch(() => ({}));
    const { adminToken } = body;
    
    if (!adminToken || !adminToken.includes(':')) {
        return Response.json({ error: "חסר אימות מנהל תקין" }, { status: 401 });
    }

    const [username, password] = adminToken.split(':');
    const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, password).first();
    if (!admin) return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });

    try {
        const { results } = await env.DB.prepare("SELECT phone, email, password, can_upload, can_record FROM users").all();
        
        const usersWithFullDetails = await Promise.all(results.map(async (u) => {
            const name = await getNameFromIni(u.phone, env.YEMOT_TOKEN);
            const phoneStatus = await checkPhoneStatus(u.phone, env.YEMOT_TOKEN);
            return {
                phone: u.phone,
                email: u.email,
                password: u.password,
                name: name || "לא נמצא שם בימות",
                connectedToTzintukim: phoneStatus.active,
                canUpload: !!u.can_upload,
                canRecord: u.can_record !== 0
            };
        }));

        return Response.json({ success: true, users: usersWithFullDetails });
    } catch (e) {
        return Response.json({ error: "שגיאה בשליפת המשתמשים: " + e.message }, { status: 400 });
    }
}

export async function handleAdminUpdateUser(request, env) {
    const body = await request.json().catch(() => ({}));
    const { adminToken, phone, newEmail, newPassword, canUpload, canRecord } = body;

    if (!adminToken || !adminToken.includes(':')) {
        return Response.json({ error: "חסר אימות מנהל תקין" }, { status: 401 });
    }

    const [username, adminPass] = adminToken.split(':');
    const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, adminPass).first();
    if (!admin) return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });

    if (!phone) {
        return Response.json({ error: "חובה לציין מספר טלפון של המשתמש לעדכון" }, { status: 400 });
    }

    try {
        const user = await env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first();
        if (!user) {
            return Response.json({ error: "המשתמש שביקשת לעדכן לא נמצא" }, { status: 404 });
        }

        const finalPassword = newPassword || user.password;
        const finalEmail = newEmail === undefined ? user.email : (newEmail || null); // הגנה מערכים חסרים
        
        const finalCanUpload = canUpload === undefined ? user.can_upload : (canUpload ? 1 : 0);
        const finalCanRecord = canRecord === undefined ? user.can_record : (canRecord ? 1 : 0);

        await env.DB.prepare("UPDATE users SET email = ?, password = ?, can_upload = ?, can_record = ? WHERE phone = ?")
            .bind(finalEmail, finalPassword, finalCanUpload, finalCanRecord, phone).run();

        return Response.json({ success: true, message: "נתוני המשתמש והרשאותיו עודכנו בהצלחה על ידי המנהל" });
    } catch (e) {
        return Response.json({ error: "שגיאה בעדכון המשתמש: " + e.message }, { status: 400 });
    }
}
