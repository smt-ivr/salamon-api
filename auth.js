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

// 2. הרשמה מאובטחת
export async function handleRegister(request, env) {
    const { phone, email, password, passwordConfirm, sessionId } = await request.json();

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
            `INSERT INTO users (phone, email, password, can_record, can_upload) VALUES (?, ?, ?, 1, 0)`
        ).bind(phone, email || null, password).run();

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

// 3. התחברות
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
            canUpload: !!user.can_upload,
            canRecord: user.can_record !== 0
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

// --- חדש: שמירה ועדכון סיסמה בפועל לאחר שקוד האימות אומת בהצלחה ---
export async function handleResetPasswordConfirm(request, env) {
    const { phone, password, passwordConfirm, token } = await request.json();

    if (!phone || !password || !passwordConfirm || !token) {
        return Response.json({ error: "חסרים פרטי חובה להשלמת איפוס הסיסמה." }, { status: 400 });
    }
    if (password !== passwordConfirm) {
        return Response.json({ error: "הסיסמאות החדשות שהוזנו אינן תואמות." }, { status: 400 });
    }
    if (!/^\d{4,10}$/.test(password)) {
        return Response.json({ error: "הסיסמה חייבת להכיל בין 4 ל-10 ספרות בלבד." }, { status: 400 });
    }

    // בדיקה שהטוקן שקיבל המשתמש מ-verifyCode אכן מאומת, שייך לטלפון שלו והוא מסוג reset
    const session = await env.DB.prepare(
        `SELECT * FROM verification_sessions 
         WHERE auth_token = ? AND phone = ? AND status = 'verified' AND intent = 'reset'`
    ).bind(token, phone).first();

    if (!session) {
        return Response.json({ error: "אימות פג תוקף, שגוי או שכבר בוצע בו שימוש. אנא בצע איפוס מחדש." }, { status: 403 });
    }

    try {
        // עדכון הסיסמה החדשה בטבלת המשתמשים
        await env.DB.prepare("UPDATE users SET password = ? WHERE phone = ?").bind(password, phone).run();
        
        // עדכון הסשן ל-used כדי שלא יהיה ניתן להשתמש בטוקן הזה שוב ושוב
        await env.DB.prepare("UPDATE verification_sessions SET status = 'used' WHERE id = ?").bind(session.id).run();

        return Response.json({ success: true, message: "הסיסמה שלך אופסה ועודכנה בהצלחה!" });
    } catch (e) {
        return Response.json({ error: "שגיאת שרת פנימית בעת עדכון הסיסמה החדשה." }, { status: 500 });
    }
}
