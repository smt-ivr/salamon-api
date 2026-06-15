// auth.js
import { checkPhoneStatus, getNameFromIni } from './yemot.js';

// 1. צומת הכוונה חכם - מקבל טלפון או אימייל
export async function handleCheckIdentifier(request, env) {
    const { identifier } = await request.json();

    const existingUser = await env.DB.prepare("SELECT phone FROM users WHERE phone = ? OR email = ?").bind(identifier, identifier).first();
    
    if (existingUser) {
        return Response.json({
            isRegistered: true,
            identifier: identifier,
            message: "המשתמש קיים במערכת, מועבר להתחברות."
        });
    }

    if (identifier.includes('@')) {
        return Response.json({
            isRegistered: false,
            authorized: false,
            error: "לא נמצא חשבון עם אימייל זה. לפתיחת חשבון חדש חובה להזין מספר טלפון."
        }, { status: 404 });
    }

    const token = env.YEMOT_TOKEN;
    const phoneStatus = await checkPhoneStatus(identifier, token);
    
    if (!phoneStatus.exists) {
        return Response.json({ 
            isRegistered: false,
            authorized: false, 
            error: "המספר אינו קיים במערכת." 
        }, { status: 403 });
    }

    const name = await getNameFromIni(identifier, token);

    return Response.json({
        isRegistered: false,
        authorized: true,
        phone: identifier,
        name: name,
        message: "המשתמש מורשה וטרם נרשם. מועבר להרשמה."
    });
}

// 2. הרשמה מאובטחת - עם בדיקת צינתוק מצד השרת!
export async function handleRegister(request, env) {
    const { phone, email, password, passwordConfirm, sessionId } = await request.json();

    // בדיקת פרטים בסיסית מול מה שהתקבל
    if (!phone || !password || !passwordConfirm) {
        return Response.json({ error: "חסרים פרטי חובה (טלפון וסיסמה)" }, { status: 400 });
    }
    if (!sessionId) {
        return Response.json({ error: "בקשת ההרשמה נדחתה: חובה לאמת את מספר הטלפון בצינתוק לפני הרישום למערכת." }, { status: 403 });
    }
    if (password !== passwordConfirm) {
        return Response.json({ error: "הסיסמאות אינן תואמות" }, { status: 400 });
    }
    if (!/^\d{4,10}$/.test(password)) {
        return Response.json({ error: "הסיסמה חייבת להכיל בין 4 ל-10 ספרות" }, { status: 400 });
    }

    // =========================================================
    // חומת האבטחה (Server-Side Verification Check)
    // =========================================================
    const session = await env.DB.prepare(
        `SELECT * FROM verification_sessions 
         WHERE id = ? AND phone = ? AND status = 'verified' AND intent = 'register'`
    ).bind(sessionId, phone).first();

    if (!session) {
        return Response.json({ error: "שגיאת אבטחה: הטלפון לא אומת, תוקף האימות פג, או שהקוד שגוי. יש לבצע צינתוק מחדש." }, { status: 403 });
    }

    const existingUser = await env.DB.prepare("SELECT 1 FROM users WHERE phone = ?").bind(phone).first();
    if (existingUser) {
        return Response.json({ error: "מספר הטלפון הזה כבר רשום במערכת" }, { status: 400 });
    }

    const phoneStatus = await checkPhoneStatus(phone, env.YEMOT_TOKEN);
    if (!phoneStatus.exists) {
        return Response.json({ error: "המספר אינו מורשה להירשם במערכת החיצונית" }, { status: 403 });
    }

    try {
        await env.DB.prepare(
            `INSERT INTO users (phone, email, password) VALUES (?, ?, ?)`
        ).bind(phone, email || null, password).run();

        // סימון האימות כ"משומש" כדי שאי אפשר יהיה לעשות בו שימוש חוזר (Replay Attack)
        await env.DB.prepare(`UPDATE verification_sessions SET status = 'used' WHERE id = ?`).bind(sessionId).run();

        const token = `${email || phone}:${password}`;
        
        return Response.json({ 
            success: true, 
            message: "נרשמת בהצלחה",
            token: token
        });
    } catch (e) {
        return Response.json({ error: "שגיאת רישום. ייתכן והאימייל כבר תפוס." }, { status: 400 });
    }
}

// 3. התחברות (מעודכן עם שדה הרשאת העלאה)
export async function handleLogin(request, env) {
    const { identifier, password } = await request.json();

    const user = await env.DB.prepare(
        `SELECT * FROM users WHERE (phone = ? OR email = ?) AND password = ?`
    ).bind(identifier, identifier, password).first();

    if (!user) {
        return Response.json({ error: "שם משתמש או סיסמה שגויים" }, { status: 401 });
    }

    const name = await getNameFromIni(user.phone, env.YEMOT_TOKEN);
    const phoneStatus = await checkPhoneStatus(user.phone, env.YEMOT_TOKEN);

    const token = `${identifier}:${password}`;

    return Response.json({
        success: true,
        token: token,
        user: {
            phone: user.phone,
            name: name,
            email: user.email,
            connectedToTzintukim: phoneStatus.active,
            canUpload: !!user.can_upload // המרה לבוליאני (true/false) בהתאם לעמודה החדשה במסד
        }
    });
}

// 4. עדכון פרופיל
export async function handleUpdateProfile(request, env) {
    const { phone, oldPassword, newPassword, newEmail } = await request.json();

    if (!phone || !oldPassword) {
        return Response.json({ error: "חובה להזין מספר טלפון וסיסמה נוכחית לאימות" }, { status: 400 });
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

        await env.DB.prepare("UPDATE users SET email = ?, password = ? WHERE phone = ?")
            .bind(finalEmail, finalPassword, phone).run();

        return Response.json({ success: true, message: "הפרטים עודכנו בהצלחה" });
    } catch (e) {
        return Response.json({ error: "שגיאה בעדכון הנתונים. ייתכן והמייל תפוס." }, { status: 400 });
    }
}
