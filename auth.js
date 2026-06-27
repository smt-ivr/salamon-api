// auth.js
import { checkPhoneStatus, getNameFromIni } from './yemot.js';
import { getIsraelTimeForDB, getFutureIsraelTimeForDB, isPastIsraelTime } from './timeUtils.js';

// פונקציית עזר גלובלית לאימות משתמש - מעודכנת לטוקנים בלבד (ללא סיסמאות חשופות)
export async function authenticateUser(db, userToken) {
    if (!userToken) return null;

    const session = await db.prepare("SELECT * FROM user_tokens WHERE id = ?").bind(userToken).first();
    if (!session) return null;

    if (session.token_type === 'temporary') {
        if (isPastIsraelTime(session.expires_at)) {
            await db.prepare("DELETE FROM user_tokens WHERE id = ?").bind(userToken).run();
            return null;
        }

        const newExpiryStr = getFutureIsraelTimeForDB(30);
        const nowStr = getIsraelTimeForDB();

        await db.prepare(
            "UPDATE user_tokens SET expires_at = ?, last_used_at = ? WHERE id = ?"
        ).bind(newExpiryStr, nowStr, userToken).run();
    } else {
        const nowStr = getIsraelTimeForDB();
        await db.prepare(
            "UPDATE user_tokens SET last_used_at = ? WHERE id = ?"
        ).bind(nowStr, userToken).run();
    }

    return await db.prepare("SELECT * FROM users WHERE phone = ?").bind(session.phone).first();
}

// 1. צומת הכוונה חכם
export async function handleCheckIdentifier(request, env) {
    const body = await request.json().catch(() => ({}));
    const { identifier } = body;

    if (!identifier) {
        return Response.json({ error: "אנא הזינו מספר טלפון או כתובת אימייל" }, { status: 400 });
    }

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
    const body = await request.json().catch(() => ({}));
    const { phone, email, password, passwordConfirm, sessionId } = body;

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
        const safeEmail = email || null;
        const nowIsraelStr = getIsraelTimeForDB();
        await env.DB.prepare(
            `INSERT INTO users (phone, email, password, can_record, can_upload, created_at) VALUES (?, ?, ?, 1, 0, ?)`
        ).bind(phone, safeEmail, password, nowIsraelStr).run();

        await env.DB.prepare(`UPDATE verification_sessions SET status = 'used' WHERE id = ?`).bind(sessionId).run();
        
        return Response.json({ 
            success: true, 
            message: "נרשמת בהצלחה"
        });
    } catch (e) {
        return Response.json({ error: "שגיאת רישום. ייתכן והאימייל כבר תפוס." }, { status: 400 });
    }
}

// 3. התחברות (מחזיר טוקן בלבד)
export async function handleLogin(request, env) {
    const body = await request.json().catch(() => ({}));
    const { identifier, password, rememberMe } = body;

    if (!identifier || !password) {
        return Response.json({ error: "חובה להזין מזהה (טלפון/אימייל) וסיסמה" }, { status: 400 });
    }

    const user = await env.DB.prepare(
        `SELECT * FROM users WHERE (phone = ? OR email = ?) AND password = ?`
    ).bind(identifier, identifier, password).first();

    if (!user) {
        return Response.json({ error: "שם משתמש או סיסמה שגויים" }, { status: 401 });
    }

    const sessionToken = crypto.randomUUID();
    const tokenType = rememberMe ? 'permanent' : 'temporary';
    const createdAtStr = getIsraelTimeForDB();
    
    let expiresAtStr = null;
    if (tokenType === 'temporary') {
        expiresAtStr = getFutureIsraelTimeForDB(30);
    }

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

    await env.DB.prepare(
        `INSERT INTO user_tokens (id, phone, token_type, created_at, expires_at, last_used_at) 
         VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(sessionToken, user.phone, tokenType, createdAtStr, expiresAtStr, createdAtStr).run();

    return Response.json({
        success: true,
        message: "התחברת בהצלחה",
        token: sessionToken
    });
}

// 4. שליפת פרופיל משתמש
export async function handleGetProfile(request, env) {
    const body = await request.json().catch(() => ({}));
    const { userToken } = body;

    if (!userToken) {
        return Response.json({ error: "חסר אימות משתמש (טוקן)" }, { status: 401 });
    }

    const user = await authenticateUser(env.DB, userToken);
    
    if (!user) {
        return Response.json({ error: "הטוקן שגוי או שפג תוקפו, אנא התחבר מחדש" }, { status: 401 });
    }

    const name = await getNameFromIni(user.phone, env.YEMOT_TOKEN);
    const phoneStatus = await checkPhoneStatus(user.phone, env.YEMOT_TOKEN);

    return Response.json({
        success: true,
        user: {
            phone: user.phone,
            name: name || "לא מזוהה",
            email: user.email || "",
            connectedToTzintukim: phoneStatus.active,
            canUpload: !!user.can_upload,
            canRecord: user.can_record !== 0
        }
    });
}

// 5. התנתקות
export async function handleLogout(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        const userToken = body.userToken;
        
        if (userToken) {
            await env.DB.prepare("DELETE FROM user_tokens WHERE id = ?").bind(userToken).run();
        }
        return Response.json({ success: true, message: "התנתקת מהמערכת בהצלחה" });
    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת ניתוק" }, { status: 500 });
    }
}

// 6. עדכון פרופיל (הוסר שינוי סיסמה, משתמש בטוקן בלבד)
export async function handleUpdateProfile(request, env) {
    const body = await request.json().catch(() => ({}));
    const { userToken, newEmail } = body;

    if (!userToken) {
        return Response.json({ error: "חסר אימות משתמש (טוקן)" }, { status: 401 });
    }

    const user = await authenticateUser(env.DB, userToken);
    
    if (!user) {
        return Response.json({ error: "הטוקן שגוי או שפג תוקפו, אנא התחבר מחדש" }, { status: 401 });
    }

    try {
        const finalEmail = newEmail === undefined ? user.email : (newEmail || null);

        await env.DB.prepare("UPDATE users SET email = ? WHERE phone = ?")
            .bind(finalEmail, user.phone).run();

        return Response.json({ success: true, message: "הפרטים עודכנו בהצלחה" });
    } catch (e) {
        return Response.json({ error: "שגיאה בעדכון הנתונים. ייתכן והמייל תפוס." }, { status: 400 });
    }
}

// 7. שינוי סיסמה (נתיב חדש לחלוטין)
export async function handleChangePassword(request, env) {
    const body = await request.json().catch(() => ({}));
    const { userToken, oldPassword, newPassword, newPasswordConfirm, logoutAllDevices } = body;

    if (!userToken) {
        return Response.json({ error: "חסר אימות משתמש (טוקן)" }, { status: 401 });
    }

    const user = await authenticateUser(env.DB, userToken);
    if (!user) {
        return Response.json({ error: "הטוקן שגוי או שפג תוקפו, אנא התחבר מחדש" }, { status: 401 });
    }

    if (!oldPassword || !newPassword || !newPasswordConfirm) {
        return Response.json({ error: "חובה להזין סיסמה נוכחית ואת הסיסמה החדשה פעמיים" }, { status: 400 });
    }

    if (user.password !== oldPassword) {
        return Response.json({ error: "הסיסמה הנוכחית שהוזנה שגויה" }, { status: 401 });
    }

    if (newPassword !== newPasswordConfirm) {
        return Response.json({ error: "הסיסמאות החדשות אינן תואמות" }, { status: 400 });
    }

    if (!/^\d{4,10}$/.test(newPassword)) {
        return Response.json({ error: "הסיסמה החדשה חייבת להכיל בין 4 ל-10 ספרות" }, { status: 400 });
    }

    try {
        // עדכון הסיסמה
        await env.DB.prepare("UPDATE users SET password = ? WHERE phone = ?")
            .bind(newPassword, user.phone).run();

        // ניתוק משתמשים במידת הצורך (מחיקת טוקנים)
        if (logoutAllDevices) {
            await env.DB.prepare("DELETE FROM user_tokens WHERE phone = ?").bind(user.phone).run();
            return Response.json({ success: true, message: "הסיסמה שונתה בהצלחה וכל המכשירים נותקו. אנא התחברו מחדש למערכת." });
        } else {
            return Response.json({ success: true, message: "הסיסמה שונתה בהצלחה" });
        }
    } catch (e) {
        return Response.json({ error: "שגיאה בעדכון הסיסמה: " + e.message }, { status: 500 });
    }
}

// 8. איפוס סיסמה (שכחתי סיסמה)
export async function handleResetPasswordConfirm(request, env) {
    const body = await request.json().catch(() => ({}));
    const { phone, password, passwordConfirm, token } = body;

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

// 9. התחברות באמצעות גוגל (טוקן קבוע - זכור אותי)
export async function handleGoogleLogin(request, env) {
    const body = await request.json().catch(() => ({}));
    const { token } = body;

    if (!token) {
        return Response.json({ error: "טוקן אימות של גוגל חסר" }, { status: 400 });
    }

    try {
        const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
        const googleData = await googleRes.json();

        if (!googleRes.ok || !googleData.email) {
            return Response.json({ error: "אימות מול שרתי גוגל נכשל או שהמשתמש חסם גישה לאימייל" }, { status: 401 });
        }

        if (googleData.aud !== "89500817024-tbvsuu4dci6bqh173l65ua9lc65pe24p.apps.googleusercontent.com") {
            return Response.json({ error: "בקשה חסומה: מזהה אפליקציה (Client ID) לא תואם" }, { status: 403 });
        }

        const email = googleData.email;

        const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();

        if (!user) {
            return Response.json({ 
                error: `כתובת האימייל (${email}) אינה משויכת לאף חשבון במערכת. עלייך להירשם תחילה דרך מספר טלפון.` 
            }, { status: 404 });
        }

        const sessionToken = crypto.randomUUID();
        const createdAtStr = getIsraelTimeForDB();
        const expiresAtStr = null; 

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

        await env.DB.prepare(
            `INSERT INTO user_tokens (id, phone, token_type, created_at, expires_at, last_used_at) 
             VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(sessionToken, user.phone, 'permanent', createdAtStr, expiresAtStr, createdAtStr).run();

        return Response.json({
            success: true,
            message: "התחברת בהצלחה באמצעות גוגל",
            token: sessionToken
        });

    } catch (err) {
        return Response.json({ error: "שגיאת תקשורת פנימית מול שרתי גוגל: " + err.message }, { status: 500 });
    }
}
