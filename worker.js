// admin.js
import { checkPhoneStatus, getAllYemotUsers, getAllNamesFromIni } from './yemot.js';
import { getIsraelTimeForDB, getFutureIsraelTimeForDB } from './timeUtils.js';

async function verifyAdmin(env, adminToken) {
    if (!adminToken || !adminToken.includes(':')) return false;
    const [username, password] = adminToken.split(':');
    const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, password).first();
    return !!admin;
}

export async function handleAdminLogin(request, env) {
    const body = await request.json().catch(() => ({}));
    const { username, password } = body;
    if (!username || !password) return Response.json({ error: "חובה להזין שם משתמש וסיסמה" }, { status: 400 });
    const admin = await env.DB.prepare("SELECT * FROM admins WHERE username = ? AND password = ?").bind(username, password).first();
    if (!admin) return Response.json({ error: "שם משתמש או סיסמת מנהל שגויים" }, { status: 401 });
    return Response.json({ success: true, message: "התחברת כמנהל בהצלחה", adminToken: `${admin.username}:${admin.password}` });
}

export async function handleAdminGetUsers(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });

    try {
        const [dbUsersRes, yemotUsers, namesMap] = await Promise.all([
            env.DB.prepare("SELECT phone, email, can_upload, can_record, can_tzintuk, created_at FROM users").all(),
            getAllYemotUsers(env.YEMOT_TOKEN),
            getAllNamesFromIni(env.YEMOT_TOKEN)
        ]);

        const dbUsersMap = {};
        dbUsersRes.results.forEach(u => dbUsersMap[u.phone] = u);
        const mergedUsers = [];
        const processedPhones = new Set();

        for (const yu of yemotUsers) {
            const phone = yu.phone;
            processedPhones.add(phone);
            const dbUser = dbUsersMap[phone];
            mergedUsers.push({
                phone: phone,
                name: namesMap[phone] || "לא הוגדר (בימות)",
                hasWebAccount: !!dbUser,
                yemotActive: yu.active,
                email: dbUser ? dbUser.email : null,
                canUpload: dbUser ? !!dbUser.can_upload : false,
                canRecord: dbUser ? dbUser.can_record !== 0 : false,
                canTzintuk: dbUser ? dbUser.can_tzintuk !== 0 : false,
                createdAt: dbUser ? dbUser.created_at : null
            });
        }

        for (const du of dbUsersRes.results) {
            if (!processedPhones.has(du.phone)) {
                mergedUsers.push({
                    phone: du.phone,
                    name: namesMap[du.phone] || "משתמש חסר בימות",
                    hasWebAccount: true,
                    yemotActive: false,
                    email: du.email,
                    canUpload: !!du.can_upload,
                    canRecord: du.can_record !== 0,
                    canTzintuk: du.can_tzintuk !== 0,
                    createdAt: du.created_at
                });
            }
        }
        return Response.json({ success: true, users: mergedUsers });
    } catch (e) { return Response.json({ error: "שגיאה בשליפת המשתמשים: " + e.message }, { status: 500 }); }
}

export async function handleAdminGetUserFullProfile(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });
    const phone = body.phone;
    if (!phone) return Response.json({ error: "חובה לשלוח מספר טלפון" }, { status: 400 });

    try {
        const userDb = await env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first();
        const tokens = await env.DB.prepare("SELECT id, token_type, created_at, expires_at, last_used_at, session_email FROM user_tokens WHERE phone = ? ORDER BY last_used_at DESC").bind(phone).all();
        const blocks = await env.DB.prepare("SELECT * FROM verification_blocks WHERE block_type = 'phone' AND block_value = ?").bind(phone).all();
        const yemotStatus = await checkPhoneStatus(phone, env.YEMOT_TOKEN);
        const name = (await getAllNamesFromIni(env.YEMOT_TOKEN))[phone] || null;

        return Response.json({
            success: true,
            profile: {
                user: userDb || null,
                yemot: { exists: yemotStatus.exists, active: yemotStatus.active, name: name },
                activeSessions: tokens.results,
                blocks: blocks.results
            }
        });
    } catch (e) { return Response.json({ error: "שגיאה בשליפת נתוני הפרופיל: " + e.message }, { status: 500 }); }
}

export async function handleAdminUpdateUser(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });

    const { phone, newEmail, newPassword, canUpload, canRecord, canTzintuk, receiveEmails, googleLoginOnly } = body;
    if (!phone) return Response.json({ error: "חובה לציין מספר טלפון של המשתמש לעדכון" }, { status: 400 });

    try {
        const user = await env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first();
        if (!user) return Response.json({ error: "המשתמש שביקשת לעדכן לא נמצא במסד הנתונים של האתר" }, { status: 404 });

        const finalPassword = newPassword || user.password;
        const finalEmail = newEmail === undefined ? user.email : (newEmail ? String(newEmail).toLowerCase() : null); 
        const f_upload = canUpload === undefined ? user.can_upload : (canUpload ? 1 : 0);
        const f_record = canRecord === undefined ? user.can_record : (canRecord ? 1 : 0);
        const f_tzintuk = canTzintuk === undefined ? (user.can_tzintuk ?? 1) : (canTzintuk ? 1 : 0);
        const f_receive = receiveEmails === undefined ? (user.receive_emails ?? 1) : (receiveEmails ? 1 : 0);
        const f_googleOnly = googleLoginOnly === undefined ? (user.google_login_only ?? 0) : (googleLoginOnly ? 1 : 0);

        await env.DB.prepare(
            `UPDATE users SET email=?, password=?, can_upload=?, can_record=?, can_tzintuk=?, receive_emails=?, google_login_only=? WHERE phone=?`
        ).bind(finalEmail, finalPassword, f_upload, f_record, f_tzintuk, f_receive, f_googleOnly, phone).run();

        return Response.json({ success: true, message: "נתוני המשתמש והרשאותיו עודכנו בהצלחה" });
    } catch (e) { return Response.json({ error: "שגיאה בעדכון המשתמש: " + e.message }, { status: 500 }); }
}

export async function handleAdminDisconnectUserTokens(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });

    const { phone, tokenId } = body;
    if (!phone) return Response.json({ error: "חובה לציין מספר טלפון" }, { status: 400 });

    try {
        if (tokenId) {
            await env.DB.prepare("DELETE FROM user_tokens WHERE phone = ? AND id = ?").bind(phone, tokenId).run();
            return Response.json({ success: true, message: "החיבור נותק בהצלחה" });
        } else {
            await env.DB.prepare("DELETE FROM user_tokens WHERE phone = ?").bind(phone).run();
            return Response.json({ success: true, message: "המשתמש נותק מכל המכשירים המחוברים" });
        }
    } catch (e) { return Response.json({ error: "שגיאה בניתוק המשתמש: " + e.message }, { status: 500 }); }
}

// יצירת חשבון מתקדמת (כולל מייל והרשאות)
export async function handleAdminCreateUser(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });

    const { phone, password, email, canRecord, canUpload, canTzintuk, receiveEmails, googleLoginOnly } = body;
    if (!phone || !password) return Response.json({ error: "חובה לציין מספר טלפון וסיסמה" }, { status: 400 });

    try {
        const existingUser = await env.DB.prepare("SELECT 1 FROM users WHERE phone = ?").bind(phone).first();
        if (existingUser) return Response.json({ error: "למשתמש זה כבר קיים חשבון באתר" }, { status: 400 });

        const finalEmail = email ? String(email).toLowerCase() : null;
        const f_record = canRecord !== undefined ? (canRecord ? 1 : 0) : 1;
        const f_upload = canUpload !== undefined ? (canUpload ? 1 : 0) : 0;
        const f_tzintuk = canTzintuk !== undefined ? (canTzintuk ? 1 : 0) : 1;
        const f_receive = receiveEmails !== undefined ? (receiveEmails ? 1 : 0) : 1;
        const f_google = googleLoginOnly !== undefined ? (googleLoginOnly ? 1 : 0) : 0;

        const nowIsraelStr = getIsraelTimeForDB();
        await env.DB.prepare(
            `INSERT INTO users (phone, email, password, can_record, can_upload, can_tzintuk, receive_emails, google_login_only, created_at) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(phone, finalEmail, password, f_record, f_upload, f_tzintuk, f_receive, f_google, nowIsraelStr).run();

        return Response.json({ success: true, message: "החשבון נוצר בהצלחה!" });
    } catch (e) { return Response.json({ error: "שגיאה ביצירת החשבון: " + e.message }, { status: 500 }); }
}

// פונקציית מחיקת חשבון
export async function handleAdminDeleteUser(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body.adminToken))) return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });

    const { phone } = body;
    if (!phone) return Response.json({ error: "חובה לציין מספר טלפון" }, { status: 400 });

    try {
        await env.DB.prepare("DELETE FROM user_tokens WHERE phone = ?").bind(phone).run();
        await env.DB.prepare("DELETE FROM users WHERE phone = ?").bind(phone).run();
        return Response.json({ success: true, message: "החשבון נמחק בהצלחה לצמיתות" });
    } catch (e) { return Response.json({ error: "שגיאה במחיקת החשבון: " + e.message }, { status: 500 }); }
}
