import { checkPhoneStatus, getNameFromIni } from './yemot.js';

// 1. כניסת מנהל
export async function handleAdminLogin(request, env) {
    const { username, password } = await request.json();

    const admin = await env.DB.prepare("SELECT * FROM admins WHERE username = ? AND password = ?")
        .bind(username, password).first();

    if (!admin) {
        return Response.json({ error: "שם משתמש או סיסמת מנהל שגויים" }, { status: 401 });
    }

    // מחזיר את פרטי המנהל האמיתיים
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

// 2. שליפת משתמשים (למנהל בלבד) - עודכן כדי לכלול הרשאות העלאה
export async function handleAdminGetUsers(request, env) {
    const { adminToken } = await request.json();
    
    if (!adminToken) return Response.json({ error: "חסר אימות מנהל" }, { status: 401 });
    const [username, password] = adminToken.split(':');
    const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, password).first();
    if (!admin) return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });

    try {
        // הוספנו את can_upload לשאילתה
        const { results } = await env.DB.prepare("SELECT phone, email, password, can_upload FROM users").all();
        
        const usersWithFullDetails = await Promise.all(results.map(async (u) => {
            const name = await getNameFromIni(u.phone, env.YEMOT_TOKEN);
            const phoneStatus = await checkPhoneStatus(u.phone, env.YEMOT_TOKEN);
            return {
                phone: u.phone,
                email: u.email,
                password: u.password,
                name: name || "לא נמצא שם בימות",
                connectedToTzintukim: phoneStatus.active,
                canUpload: !!u.can_upload // המרה ל- true/false עבור צד הלקוח
            };
        }));

        return Response.json({ success: true, users: usersWithFullDetails });
    } catch (e) {
        return Response.json({ error: "שגיאה בשליפת המשתמשים: " + e.message }, { status: 400 });
    }
}

// 3. עדכון משתמש (למנהל בלבד) - עודכן כדי לשמור הרשאות העלאה
export async function handleAdminUpdateUser(request, env) {
    // הוספנו את קבלת canUpload מהממשק
    const { adminToken, phone, newEmail, newPassword, canUpload } = await request.json();

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
        
        // המרה למספר (1 או 0) עבור מסד הנתונים. אם הערך לא התקבל, שומרים על הערך הקיים
        const finalCanUpload = canUpload !== undefined ? (canUpload ? 1 : 0) : user.can_upload;

        // עדכון משתמש במסד - הוספנו את can_upload = ? לשאילתה
        await env.DB.prepare("UPDATE users SET email = ?, password = ?, can_upload = ? WHERE phone = ?")
            .bind(finalEmail, finalPassword, finalCanUpload, phone).run();

        return Response.json({ success: true, message: "נתוני המשתמש והרשאותיו עודכנו בהצלחה על ידי המנהל" });
    } catch (e) {
        return Response.json({ error: "שגיאה בעדכון המשתמש: " + e.message }, { status: 400 });
    }
}
