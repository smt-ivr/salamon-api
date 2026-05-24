import { checkPhoneStatus, getNameFromIni } from './yemot.js';

// 1. כניסת מנהל
export async function handleAdminLogin(request, env) {
    const { username, password } = await request.json();

    const admin = await env.DB.prepare("SELECT * FROM admins WHERE username = ? AND password = ?")
        .bind(username, password).first();

    if (!admin) {
        return Response.json({ error: "שם משתמש או סיסמת מנהל שגויים" }, { status: 401 });
    }

    // מחזיר את פרטי המנהל האמיתיים כפי שביקשת (במקום "admin:admin")
    return Response.json({ 
        success: true, 
        message: "התחברת כמנהל בהצלחה", 
        admin: {
            username: admin.username,
            password: admin.password
        },
        // טוקן לאימות הפעולות הבאות (מבוסס על הנתונים האמיתיים מהמסד)
        adminToken: `${admin.username}:${admin.password}` 
    });
}

// 2. שליפת משתמשים (למנהל בלבד)
export async function handleAdminGetUsers(request, env) {
    const { adminToken } = await request.json();
    
    if (!adminToken) return Response.json({ error: "חסר אימות מנהל" }, { status: 401 });
    const [username, password] = adminToken.split(':');
    const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, password).first();
    if (!admin) return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });

    try {
        const { results } = await env.DB.prepare("SELECT phone, email, password FROM users").all();
        
        const usersWithFullDetails = await Promise.all(results.map(async (u) => {
            const name = await getNameFromIni(u.phone, env.YEMOT_TOKEN);
            const phoneStatus = await checkPhoneStatus(u.phone, env.YEMOT_TOKEN);
            return {
                phone: u.phone,
                email: u.email,
                password: u.password,
                name: name || "לא נמצא שם בימות",
                connectedToTzintukim: phoneStatus.active
            };
        }));

        return Response.json({ success: true, users: usersWithFullDetails });
    } catch (e) {
        return Response.json({ error: "שגיאה בשליפת המשתמשים: " + e.message }, { status: 400 });
    }
}

// 3. עדכון משתמש (למנהל בלבד)
export async function handleAdminUpdateUser(request, env) {
    const { adminToken, phone, newEmail, newPassword } = await request.json();

    if (!adminToken) return Response.json({ error: "חסר אימות מנהל" }, { status: 401 });
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
        const finalEmail = newEmail !== undefined ? (newEmail || null) : user.email;

        // עדכון משתמש במסד
        await env.DB.prepare("UPDATE users SET email = ?, password = ? WHERE phone = ?")
            .bind(finalEmail, finalPassword, phone).run();

        return Response.json({ success: true, message: "נתוני המשתמש עודכנו בהצלחה על ידי המנהל" });
    } catch (e) {
        return Response.json({ error: "שגיאה בעדכון המשתמש: " + e.message }, { status: 400 });
    }
}
