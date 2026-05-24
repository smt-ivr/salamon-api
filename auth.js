import { checkPhoneStatus, getNameFromIni } from './yemot.js';

export async function handleCheckPhone(request, env) {
    const { phone } = await request.json();
    const token = env.YEMOT_TOKEN;

    const phoneStatus = await checkPhoneStatus(phone, token);
    
    if (!phoneStatus.exists) {
        return Response.json({ error: "המספר אינו מורשה להירשם." }, { status: 403 });
    }

    // אם קיים, נחפש את השם בקובץ השני
    const name = await getNameFromIni(phone, token);

    return Response.json({
        allowed: true,
        phone: phone,
        name: name, // יהיה null אם לא נמצא שם, ואז הלקוח יצטרך להזין ידנית
        activeStatus: phoneStatus.active
    });
}

export async function handleRegister(request, env) {
    const { phone, name, email, password, passwordConfirm } = await request.json();

    // ולידציות
    if (!phone || !password || !passwordConfirm) {
        return Response.json({ error: "חסרים פרטי חובה" }, { status: 400 });
    }
    if (password !== passwordConfirm) {
        return Response.json({ error: "הסיסמאות אינן תואמות" }, { status: 400 });
    }
    if (!/^\d{4,10}$/.test(password)) {
        return Response.json({ error: "הסיסמה חייבת להכיל בין 4 ל-10 ספרות" }, { status: 400 });
    }

    // נוודא שוב שהמספר קיים (כדי למנוע עקיפה של השלב הקודם)
    const phoneStatus = await checkPhoneStatus(phone, env.YEMOT_TOKEN);
    if (!phoneStatus.exists) {
        return Response.json({ error: "המספר אינו מורשה להירשם" }, { status: 403 });
    }

    // הכנסה למסד הנתונים
    try {
        await env.DB.prepare(
            `INSERT INTO users (phone, name, email, password) VALUES (?, ?, ?, ?)`
        ).bind(phone, name, email || null, password).run();

        const token = `${email || phone}:${password}`; // יצירת טוקן לפי הבקשה
        
        return Response.json({ 
            success: true, 
            message: "נרשמת בהצלחה",
            token: token
        });
    } catch (e) {
        return Response.json({ error: "משתמש זה כבר קיים במערכת או שגיאת מסד נתונים" }, { status: 500 });
    }
}

export async function handleLogin(request, env) {
    const { identifier, password } = await request.json(); // identifier יכול להיות טלפון או מייל

    // חיפוש במסד הנתונים
    const user = await env.DB.prepare(
        `SELECT * FROM users WHERE (phone = ? OR email = ?) AND password = ?`
    ).bind(identifier, identifier, password).first();

    if (!user) {
        return Response.json({ error: "שם משתמש או סיסמה שגויים" }, { status: 401 });
    }

    // בדיקת מצב active נוכחי במערכת החיצונית
    const phoneStatus = await checkPhoneStatus(user.phone, env.YEMOT_TOKEN);

    const token = `${identifier}:${password}`;

    return Response.json({
        success: true,
        token: token,
        user: {
            phone: user.phone,
            name: user.name,
            email: user.email,
            active: phoneStatus.active // מוחזר כמידע בלבד מהצינתוקים
        }
    });
}
