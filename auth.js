import { checkPhoneStatus, getNameFromIni } from './yemot.js';

// 1. צומת הכוונה חכם - בדיקת טלפון (מורשה + האם כבר רשום)
export async function handleCheckPhone(request, env) {
    const { phone } = await request.json();
    const token = env.YEMOT_TOKEN;

    // שלב א: בודקים קודם כל אם הוא מורשה במערכת החיצונית (ימות)
    const phoneStatus = await checkPhoneStatus(phone, token);
    
    if (!phoneStatus.exists) {
        return Response.json({ 
            authorized: false, 
            registered: false,
            message: "המספר אינו מורשה במערכת (לא קיים בימות המשיח)." 
        });
    }

    // שלב ב: הוא מורשה. האם הוא כבר פתח חשבון בעבר?
    const existingUser = await env.DB.prepare("SELECT 1 FROM users WHERE phone = ?").bind(phone).first();
    
    if (existingUser) {
        return Response.json({
            authorized: true,
            registered: true,
            phone: phone,
            message: "המשתמש מורשה וכבר רשום. יש להפנות להתחברות."
        });
    }

    // שלב ג: הוא מורשה אך עדיין לא פתח חשבון (יש להפנות להרשמה + להחזיר את שמו)
    const name = await getNameFromIni(phone, token);

    return Response.json({
        authorized: true,
        registered: false,
        phone: phone,
        name: name, // הלקוח ישתמש בזה כדי למלא אוטומטית את הטופס
        message: "המשתמש מורשה וטרם נרשם. יש להפנות להרשמה."
    });
}

// 2. הרשמה
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

        const token = `${email || phone}:${password}`;
        
        return Response.json({ 
            success: true, 
            message: "נרשמת בהצלחה",
            token: token
        });
    } catch (e) {
        return Response.json({ error: "שגיאת רישום: " + e.message }, { status: 400 });
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
            connectedToTzintukim: phoneStatus.active
        }
    });
}

// 4. עדכון פרופיל משתמש
export async function handleUpdateProfile(request, env) {
    const { phone, oldPassword, newPassword, newEmail } = await request.json();

    if (!phone || !oldPassword) {
        return Response.json({ error: "חובה להזין מספר טלפון וסיסמה נוכחית" }, { status: 400 });
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
        return Response.json({ error: "שגיאה בעדכון הנתונים" }, { status: 400 });
    }
}
