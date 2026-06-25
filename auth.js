// auth.js
import { checkPhoneStatus, getNameFromIni } from './yemot.js';

// פונקציית עזר גלובלית לאימות משתמש - תומכת בפורמט הישן ובפורמט הטוקנים החדש
export async function authenticateUser(db, userToken) {
    if (!userToken) return null;

    // תמיכה לאחור: אם הפורמט שנתקבל הוא טלפון:סיסמה או אימייל:סיסמה
    if (userToken.includes(':')) {
        const [identifier, password] = userToken.split(':');
        return await db.prepare(
            "SELECT * FROM users WHERE (phone = ? OR email = ?) AND password = ?"
        ).bind(identifier, identifier, password).first();
    }

    // פורמט חדש: בדיקת טוקן זמני או קבוע במסד הנתונים
    const session = await db.prepare("SELECT * FROM user_tokens WHERE id = ?").bind(userToken).first();
    if (!session) return null;

    const now = new Date();
    if (session.token_type === 'temporary') {
        const safeExpiry = session.expires_at.replace(' ', 'T') + 'Z';
        if (now > new Date(safeExpiry)) {
            // הטוקן פג תוקף - נמחק אותו ונחזיר שגיאת אימות
            await db.prepare("DELETE FROM user_tokens WHERE id = ?").bind(userToken).run();
            return null;
        }

        // הארכת תוקף בחצי שעה (30 דקות) בכל שימוש מוצלח
        const newExpiry = new Date(now.getTime() + 30 * 60 * 1000);
        const newExpiryStr = newExpiry.toISOString().replace('T', ' ').substring(0, 19);
        const nowStr = now.toISOString().replace('T', ' ').substring(0, 19);

        await db.prepare(
            "UPDATE user_tokens SET expires_at = ?, last_used_at = ? WHERE id = ?"
        ).bind(newExpiryStr, nowStr, userToken).run();
    } else {
        // טוקן קבוע - רק מעדכנים מתי נעשה בו שימוש לאחרונה
        const nowStr = now.toISOString().replace('T', ' ').substring(0, 19);
        await db.prepare(
            "UPDATE user_tokens SET last_used_at = ? WHERE id = ?"
        ).bind(nowStr, userToken).run();
    }

    // החזרת פרטי המשתמש המלאים עבור ה-API
    return await db.prepare("SELECT * FROM users WHERE phone = ?").bind(session.phone).first();
}

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

// 3. התחברות מעודכנת עם תמיכה בטוקנים זמניים וקבועים (זכור אותי) ומגבלת 2 מכשירים
export async function handleLogin(request, env) {
    const { identifier, password, rememberMe } = await request.json();

    const user = await env.DB.prepare(
        `SELECT * FROM users WHERE (phone = ? OR email = ?) AND password = ?`
    ).bind(identifier, identifier, password).first();

    if (!user) {
        return Response.json({ error: "שם משתמש או סיסמה שגויים" }, { status: 401 });
    }

    const name = await getNameFromIni(user.phone, env.YEMOT_TOKEN);
    const phoneStatus = await checkPhoneStatus(user.phone, env.YEMOT_TOKEN);

    // יצירת טוקן רנדומלי מאובטח
    const sessionToken = crypto.randomUUID();
    const tokenType = rememberMe ? 'permanent' : 'temporary';
    const now = new Date();
    const createdAtStr = now.toISOString().replace('T', ' ').substring(0, 19);
    
    let expiresAtStr = null;
    if (tokenType === 'temporary') {
        const expiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30 דקות תוקף התחלתי לטוקן זמני
        expiresAtStr = expiresAt.toISOString().replace('T', ' ').substring(0, 19);
    }

    // הגבלת טוקנים: מנקים את כל הטוקנים הישנים ומשאירים רק את ה-1 הכי חדש שהיה קיים למשתמש.
    // יחד עם הטוקן החדש שנוצר ברגע זה, למשתמש יהיו בדיוק 2 טוקנים פעילים לכל היותר במקביל.
    await env.DB.prepare(
        `DELETE FROM user_tokens 
         WHERE phone = ? 
           AND id NOT IN (
               SELECT id FROM user_tokens 
               WHERE phone = ? 
               ORDER BY created_at DESC 
               LIMIT 1
           )`
    ).bind(user.phone, user.phone).run();

    // שמירת הטוקן החדש במסד הנתונים
    await env.DB.prepare(
        `INSERT INTO user_tokens (id, phone, token_type, created_at, expires_at, last_used_at) 
         VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(sessionToken, user.phone, tokenType, createdAtStr, expiresAtStr, createdAtStr).run();

    return Response.json({
        success: true,
        token: sessionToken,
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

// 5. פונקציית התנתקות (מחיקת הטוקן מהמסד)
export async function handleLogout(request, env) {
    try {
        const body = await request.json();
        const userToken = body.userToken;
        if (userToken && !userToken.includes(':')) {
            await env.DB.prepare("DELETE FROM user_tokens WHERE id = ?").bind(userToken).run();
        }
        return Response.json({ success: true, message: "התנתקת מהמערכת בהצלחה" });
    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת ניתוק" }, { status: 500 });
    }
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

    const session = await env.DB.prepare(
        `SELECT * FROM verification_sessions 
         WHERE auth_token = ? AND phone = ? AND status = 'verified' AND intent = 'reset'`
    ).bind(token, phone).first();

    if (!session) {
        return Response.json({ error: "אימות פג תוקף, שגוי או שכבר בוצע בו שימוש. אנא בצע איפוס מחדש." }, { status: 403 });
    }

    try {
        await env.DB.prepare("UPDATE users SET password = ? WHERE phone = ?").bind(password, phone).run();
        await env.DB.prepare("UPDATE verification_sessions SET status = 'used' WHERE id = ?").bind(session.id).run();

        return Response.json({ success: true, message: "הסיסמה שלך אופסה ועודכנה בהצלחה!" });
    } catch (e) {
        return Response.json({ error: "שגיאת שרת פנימית בעת עדכון הסיסמה החדשה." }, { status: 500 });
    }
}
