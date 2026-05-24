import { checkPhoneStatus, getNameFromIni } from './yemot.js';

// 1. בדיקת מספר טלפון (רק אם לא קיים חשבון)
export async function handleCheckPhone(request, env) {
    const { phone } = await request.json();
    const token = env.YEMOT_TOKEN;

    // בדיקה האם המספר כבר רשום במסד הנתונים שלנו
    const existingUser = await env.DB.prepare("SELECT 1 FROM users WHERE phone = ?").bind(phone).first();
    if (existingUser) {
        return Response.json({ error: "המספר כבר רשום במערכת כמשתמש קיים." }, { status: 400 });
    }

    const phoneStatus = await checkPhoneStatus(phone, token);
    
    if (!phoneStatus.exists) {
        return Response.json({ error: "המספר אינו מורשה להירשם בימות המשיח." }, { status: 403 });
    }

    // שליפת השם ישירות מימות המשיח
    const name = await getNameFromIni(phone, token);

    return Response.json({
        allowed: true,
        phone: phone,
        name: name, 
        connectedToTzintukim: phoneStatus.active // שונה לסטטוס חיבור לצינתוקים
    });
}

// 2. הרשמה (ללא שמירת שם בטבלה)
export async function handleRegister(request, env) {
    const { phone, email, password, passwordConfirm } = await request.json();

    if (!phone || !password || !passwordConfirm) {
        return Response.json({ error: "חסרים פרטי חובה (טלפון וסיסמה)" }, { status: 400 });
    }
    if (password !== passwordConfirm) {
        return Response.json({ error: "הסיסמאות אינן תואמות" }, { status: 400 });
    }
    if (!/^\d{4,10}$/.test(password)) {
        return Response.json({ error: "הסיסמה חייבת להכיל בין 4 ל-10 ספרות" }, { status: 400 });
    }

    // ודוא שוב שלא קיים
    const existingUser = await env.DB.prepare("SELECT 1 FROM users WHERE phone = ?").bind(phone).first();
    if (existingUser) {
        return Response.json({ error: "מספר הטלפון הזה כבר רשום במערכת" }, { status: 400 });
    }

    const phoneStatus = await checkPhoneStatus(phone, env.YEMOT_TOKEN);
    if (!phoneStatus.exists) {
        return Response.json({ error: "המספר אינו מורשה להירשם במערכת החיצונית" }, { status: 403 });
    }

    try {
        // הכנסה ללא עמודת השם כפי שביקשת
        await env.DB.prepare(
            `INSERT INTO users (phone, email, password) VALUES (?, ?, ?)`
        ).bind(phone, email || null, password).run();

        const token = `${email || phone}:${password}`;
        
        return Response.json({ 
            success: true, 
            message: "נרשמת בהצלחה",
            token: token
        });
    } catch (e) {
        if (e.message.includes("UNIQUE constraint failed")) {
            if (e.message.includes("phone")) return Response.json({ error: "מספר הטלפון כבר קיים במערכת" }, { status: 400 });
            if (e.message.includes("email")) return Response.json({ error: "כתובת האימייל כבר קיימת במערכת" }, { status: 400 });
        }
        return Response.json({ error: "שגיאת רישום: " + e.message }, { status: 400 });
    }
}

// 3. התחברות משתמש
export async function handleLogin(request, env) {
    const { identifier, password } = await request.json();

    const user = await env.DB.prepare(
        `SELECT * FROM users WHERE (phone = ? OR email = ?) AND password = ?`
    ).bind(identifier, identifier, password).first();

    if (!user) {
        return Response.json({ error: "שם משתמש או סיסמה שגויים" }, { status: 401 });
    }

    // טעינת השם והסטטוס תמיד ובזמן אמת מימות המשיח בלבד
    const name = await getNameFromIni(user.phone, env.YEMOT_TOKEN);
    const phoneStatus = await checkPhoneStatus(user.phone, env.YEMOT_TOKEN);

    const token = `${identifier}:${password}`;

    return Response.json({
        success: true,
        token: token,
        user: {
            phone: user.phone,
            name: name, // נטען דינמית מימות
            email: user.email,
            connectedToTzintukim: phoneStatus.active
        }
    });
}

// 4. עדכון פרופיל משתמש (שינוי סיסמה ומייל עם אימות סיסמה ישנה)
export async function handleUpdateProfile(request, env) {
    const { phone, oldPassword, newPassword, newEmail } = await request.json();

    if (!phone || !oldPassword) {
        return Response.json({ error: "חובה להזין מספר טלפון וסיסמה נוכחית לצורך אימות" }, { status: 400 });
    }

    const user = await env.DB.prepare("SELECT * FROM users WHERE phone = ? AND password = ?")
        .bind(phone, oldPassword).first();
    
    if (!user) {
        return Response.json({ error: "הסיסמה הנוכחית שהוזנה שגויה" }, { status: 401 });
    }

    if (newPassword && !/^\d{4,10}$/.test(newPassword)) {
        return Response.json({ error: "הסיסמה החדשה חייבת להכיל בין 4 ל-10 ספרות" }, { status: 400 });
    }

    try {
        const finalPassword = newPassword || oldPassword;
        const finalEmail = newEmail !== undefined ? (newEmail || null) : user.email;

        await env.DB.prepare("UPDATE users SET password = ?, email = ? WHERE phone = ?")
            .bind(finalPassword, finalEmail, phone).run();

        return Response.json({ success: true, message: "הפרטים עודכנו בהצלחה" });
    } catch (e) {
        if (e.message.includes("UNIQUE constraint failed")) {
            return Response.json({ error: "כתובת האימייל הזו כבר תפוסה על ידי משתמש אחר" }, { status: 400 });
        }
        return Response.json({ error: "שגיאה בעדכון הנתונים: " + e.message }, { status: 400 });
    }
}

// ==========================================
// 5. אזור מנהל (Admin)
// ==========================================

export async function handleAdminLogin(request, env) {
    const { username, password } = await request.json();

    const admin = await env.DB.prepare("SELECT * FROM admins WHERE username = ? AND password = ?")
        .bind(username, password).first();

    if (!admin) {
        return Response.json({ error: "שם משתמש או סיסמת מנהל שגויים" }, { status: 401 });
    }

    return Response.json({ success: true, message: "התחברת כמנהל בהצלחה", adminToken: `admin:${username}` });
}

// צפייה בכל המשתמשים ופרטיהם המלאים (כולל טעינת שם מימות המשיח בזמן אמת)
export async function handleAdminGetUsers(request, env) {
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

// עדכון פרטי משתמש על ידי מנהל
export async function handleAdminUpdateUser(request, env) {
    const { phone, newEmail, newPassword } = await request.json();

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

        await env.DB.prepare("UPDATE users SET email = ?, password = ? WHERE phone = ?")
            .bind(finalPassword, finalEmail, phone).run();

        return Response.json({ success: true, message: "נתוני המשתמש עודכנו בהצלחה על ידי המנהל" });
    } catch (e) {
        return Response.json({ error: "שגיאה בעדכון המשתמש: " + e.message }, { status: 400 });
    }
}
