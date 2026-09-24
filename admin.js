// admin.js
import { checkPhoneStatus, getAllYemotUsers, getAllNamesFromIni, updateNameInIni, getNameFromIni } from './yemot.js';
import { getIsraelTimeForDB, getFutureIsraelTimeForDB } from './timeUtils.js';
import { authenticateUser } from './auth.js';

// בדיקת הרשאות למנהלי משנה
async function verifyAdmin(env, body, requiredPermission = null) {
    if (body.adminToken && typeof body.adminToken === 'string' && body.adminToken.includes(':')) {
        const [username, password] = body.adminToken.split(':');
        const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, password).first();
        if (admin) return true;
    }
    if (body.userToken) {
        const user = await authenticateUser(env.DB, body.userToken);
        if (user && user.is_admin === 1) {
            if (requiredPermission && user.admin_permissions) {
                const perms = user.admin_permissions.split(',');
                if (perms.includes('all') || perms.includes(requiredPermission)) return true;
                return false;
            }
            return true;
        }
    }
    return false;
}

// בדיקה האם זה המנהל הראשי (קוד מנהל)
async function isPrimaryAdmin(env, body) {
    if (body.adminToken && typeof body.adminToken === 'string' && body.adminToken.includes(':')) {
        const [username, password] = body.adminToken.split(':');
        const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, password).first();
        return !!admin;
    }
    return false;
}

// קבלת מזהה המנהל המבצע לצורך רישום בלוגים
async function getPerformingAdminPhone(env, body) {
    if (body.userToken) {
        const user = await authenticateUser(env.DB, body.userToken);
        return user ? user.phone : 'system';
    }
    return 'primary_admin';
}

// פונקציה לרישום לוג פעולות ניהול
async function logAdminAction(env, adminPhone, actionType, targetPhone, detailsBefore, detailsAfter) {
    const now = getIsraelTimeForDB();
    await env.DB.prepare(
        `INSERT INTO admin_audit_logs (admin_phone, action_type, target_phone, details_before, details_after, timestamp) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(adminPhone, actionType, targetPhone, JSON.stringify(detailsBefore), JSON.stringify(detailsAfter), now).run();
}

export async function handleAdminGetPermissions(request, env) {
    const permissions = [
        { id: 'manage_users', label: 'ניהול משתמשים בסיסי', desc: 'פתיחה, עריכה ומחיקת משתמשים (ללא הרשאות הנהלה)' },
        { id: 'manage_names', label: 'עדכון שמות (ימות המשיח)', desc: 'גישה לשינוי השם המוקרא בטלפון' },
        { id: 'manage_chat', label: 'מענה בצ\'אט', desc: 'מענה לפניות של לקוחות דרך האתר' },
        { id: 'manage_ads', label: 'ניהול מודעות פופאפ', desc: 'הוספה והסרה של מודעות וקמפיינים' },
        { id: 'manage_system', label: 'מסוף נתונים ולוגים', desc: 'גישה למסוף SQL ולוגי אבטחה' },
        { id: 'all', label: 'מנהל-על (הכל)', desc: 'גישה מלאה לכל המודולים במערכת החכמה' }
    ];
    return Response.json({ success: true, permissions });
}

export async function handleAdminGetAuditLogs(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await isPrimaryAdmin(env, body))) {
        return Response.json({ error: "פעולה חסומה: נדרשת גישת מנהל ראשי כדי לצפות בלוגים של מנהלי המשנה." }, { status: 403 });
    }
    try {
        const { results } = await env.DB.prepare("SELECT * FROM admin_audit_logs ORDER BY timestamp DESC LIMIT 200").all();
        return Response.json({ success: true, logs: results });
    } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
    }
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
    if (!(await verifyAdmin(env, body, 'manage_users'))) {
        return Response.json({ error: "פעולה חסומה: נדרשת הרשאת ניהול משתמשים." }, { status: 403 });
    }

    try {
        // שליפה מקבילית ויעילה של כלל הנתונים הדרושים
        const [dbUsersRes, yemotUsers, namesMap] = await Promise.all([
            env.DB.prepare("SELECT phone, email, can_upload, can_record, can_tzintuk, created_at, can_listen, listen_whitelist, listen_blacklist, profile_picture_url, lock_profile_picture, is_admin, admin_permissions, is_protected FROM users").all(),
            getAllYemotUsers(env.YEMOT_TOKEN),
            getAllNamesFromIni(env.YEMOT_TOKEN)
        ]);

        const dbUsersMap = {};
        if (dbUsersRes && dbUsersRes.results) {
            dbUsersRes.results.forEach(u => dbUsersMap[u.phone] = u);
        }
        
        const mergedUsers = [];
        const processedPhones = new Set();

        // 1. מיזוג כל המשתמשים שקיימים ברשימת ימות המשיח
        for (const yu of yemotUsers) {
            const phone = yu.phone;
            if (!phone) continue;

            processedPhones.add(phone);
            const dbUser = dbUsersMap[phone];
            
            mergedUsers.push({
                phone: phone, 
                name: namesMap[phone] || "לא הוגדר (בימות)", 
                hasWebAccount: !!dbUser, 
                yemotActive: yu.active,
                email: dbUser?.email || null, 
                canUpload: !!dbUser?.can_upload,
                canRecord: dbUser?.can_record !== 0, 
                canTzintuk: dbUser?.can_tzintuk !== 0,
                canListen: dbUser?.can_listen !== 0, 
                listenWhitelist: dbUser?.listen_whitelist || "",
                listenBlacklist: dbUser?.listen_blacklist || "", 
                profilePictureUrl: dbUser?.profile_picture_url || "",
                lockProfilePicture: dbUser?.lock_profile_picture === 1, 
                isAdmin: dbUser?.is_admin === 1,
                adminPermissions: dbUser?.admin_permissions || "", 
                isProtected: dbUser?.is_protected === 1, // סימון האם המשתמש מוגן מעריכה
                createdAt: dbUser?.created_at || null
            });
        }

        // 2. השלמת משתמשים שקיימים באתר אך חסרים ברשימה של ימות
        if (dbUsersRes && dbUsersRes.results) {
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
                        canListen: du.can_listen !== 0, 
                        listenWhitelist: du.listen_whitelist || "", 
                        listenBlacklist: du.listen_blacklist || "",
                        profilePictureUrl: du.profile_picture_url || "", 
                        lockProfilePicture: du.lock_profile_picture === 1,
                        isAdmin: du.is_admin === 1, 
                        adminPermissions: du.admin_permissions || "", 
                        isProtected: du.is_protected === 1,
                        createdAt: du.created_at
                    });
                }
            }
        }
        
        return Response.json({ success: true, users: mergedUsers });
    } catch (e) { 
        console.error("Error fetching users:", e);
        return Response.json({ error: "שגיאה בשליפת המשתמשים: " + e.message }, { status: 500 }); 
    }
}

export async function handleAdminGetUserFullProfile(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body, 'manage_users'))) return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });
    const phone = body.phone;
    if (!phone) return Response.json({ error: "חובה לשלוח מספר טלפון" }, { status: 400 });

    try {
        const userDb = await env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first();
        const tokens = await env.DB.prepare("SELECT id, token_type, created_at, expires_at, last_used_at, session_email FROM user_tokens WHERE phone = ? AND token_type != 'master' ORDER BY last_used_at DESC").bind(phone).all();
        const blocks = await env.DB.prepare("SELECT * FROM verification_blocks WHERE block_type = 'phone' AND block_value = ?").bind(phone).all();
        const yemotStatus = await checkPhoneStatus(phone, env.YEMOT_TOKEN);
        const name = await getNameFromIni(phone, env.YEMOT_TOKEN) || null; // אופטימיזציה לשליפת שם בודד

        return Response.json({ success: true, profile: { user: userDb || null, yemot: { exists: yemotStatus.exists, active: yemotStatus.active, name: name }, activeSessions: tokens.results, blocks: blocks.results } });
    } catch (e) { return Response.json({ error: "שגיאה בשליפת נתוני הפרופיל: " + e.message }, { status: 500 }); }
}

export async function handleAdminUpdateUser(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body, 'manage_users'))) return Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });

    const { phone, newEmail, newPassword, canUpload, canRecord, canTzintuk, receiveEmails, googleLoginOnly, canListen, listenWhitelist, listenBlacklist, profilePictureUrl, lockProfilePicture, isAdmin, adminPermissions, isProtected } = body;
    if (!phone) return Response.json({ error: "חובה לציין מספר טלפון של המשתמש לעדכון" }, { status: 400 });

    try {
        const user = await env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first();
        if (!user) return Response.json({ error: "המשתמש שביקשת לעדכן לא נמצא" }, { status: 404 });

        const isMainAdmin = await isPrimaryAdmin(env, body);
        
        // הגנת משתמשים - חסימת עריכה מתת-מנהלים
        if (!isMainAdmin && user.is_protected === 1) {
            return Response.json({ error: "פעולה חסומה: משתמש זה מוגן משינויים. רק מנהל ראשי רשאי לערוך אותו." }, { status: 403 });
        }

        const intentIsAdmin = isAdmin === undefined ? (user.is_admin ?? 0) : (isAdmin ? 1 : 0);
        const intentAdminPerms = adminPermissions === undefined ? (user.admin_permissions || "") : adminPermissions;
        const finalIsProtected = isMainAdmin && isProtected !== undefined ? (isProtected ? 1 : 0) : (user.is_protected ?? 0);

        if (!isMainAdmin && (intentIsAdmin !== (user.is_admin ?? 0) || intentAdminPerms !== (user.admin_permissions || ""))) {
            return Response.json({ error: "פעולה חסומה: רק מנהל ראשי רשאי לשנות הרשאות ניהול." }, { status: 403 });
        }

        const finalPassword = newPassword || user.password;
        const finalEmail = newEmail === undefined ? user.email : (newEmail ? String(newEmail).toLowerCase() : null); 
        const f_upload = canUpload === undefined ? user.can_upload : (canUpload ? 1 : 0);
        const f_record = canRecord === undefined ? user.can_record : (canRecord ? 1 : 0);
        const f_tzintuk = canTzintuk === undefined ? (user.can_tzintuk ?? 1) : (canTzintuk ? 1 : 0);
        const f_receive = receiveEmails === undefined ? (user.receive_emails ?? 1) : (receiveEmails ? 1 : 0);
        const f_googleOnly = googleLoginOnly === undefined ? (user.google_login_only ?? 0) : (googleLoginOnly ? 1 : 0);
        const f_listen = canListen === undefined ? (user.can_listen ?? 1) : (canListen ? 1 : 0);
        const f_whitelist = listenWhitelist === undefined ? (user.listen_whitelist || "") : listenWhitelist;
        const f_blacklist = listenBlacklist === undefined ? (user.listen_blacklist || "") : listenBlacklist;
        const f_picture = profilePictureUrl === undefined ? user.profile_picture_url : profilePictureUrl;
        const f_lockPic = lockProfilePicture === undefined ? (user.lock_profile_picture ?? 0) : (lockProfilePicture ? 1 : 0);

        const beforeData = { email: user.email, can_listen: user.can_listen, can_upload: user.can_upload, can_record: user.can_record, can_tzintuk: user.can_tzintuk };
        const afterData = { email: finalEmail, can_listen: f_listen, can_upload: f_upload, can_record: f_record, can_tzintuk: f_tzintuk };

        await env.DB.prepare(
            `UPDATE users SET email=?, password=?, can_upload=?, can_record=?, can_tzintuk=?, receive_emails=?, google_login_only=?, can_listen=?, listen_whitelist=?, listen_blacklist=?, profile_picture_url=?, lock_profile_picture=?, is_admin=?, admin_permissions=?, is_protected=? WHERE phone=?`
        ).bind(finalEmail, finalPassword, f_upload, f_record, f_tzintuk, f_receive, f_googleOnly, f_listen, f_whitelist, f_blacklist, f_picture, f_lockPic, intentIsAdmin, intentAdminPerms, finalIsProtected, phone).run();

        if (!isMainAdmin) {
            const adminPhone = await getPerformingAdminPhone(env, body);
            await logAdminAction(env, adminPhone, 'UPDATE_USER', phone, beforeData, afterData);
        }

        return Response.json({ success: true, message: "נתוני המשתמש עודכנו בהצלחה" });
    } catch (e) { return Response.json({ error: "שגיאה בעדכון: " + e.message }, { status: 500 }); }
}

export async function handleAdminUpdateYemotName(request, env) {
    const body = await request.json().catch(() => ({}));
    
    if (!(await verifyAdmin(env, body, 'manage_names')) && !(await verifyAdmin(env, body, 'manage_users'))) {
        return Response.json({ error: "פעולה חסומה: חסרות הרשאות לעדכון שמות משתמשים." }, { status: 403 });
    }

    const { phone, newName } = body;
    if (!phone || !newName) {
        return Response.json({ error: "נתונים חסרים: חובה לספק מספר טלפון ושם חדש." }, { status: 400 });
    }

    try {
        const isMainAdmin = await isPrimaryAdmin(env, body);
        
        // בדיקת הגנת המשתמש ממסד הנתונים אליו הוא משויך
        const user = await env.DB.prepare("SELECT is_protected FROM users WHERE phone = ?").bind(phone).first();
        if (user && user.is_protected === 1 && !isMainAdmin) {
            return Response.json({ error: "פעולה חסומה: משתמש זה מוגן מעריכה (is_protected). רק מנהל ראשי רשאי לעדכן את שמו." }, { status: 403 });
        }

        const adminPhone = await getPerformingAdminPhone(env, body);
        
        // אופטימיזציה: שליפת שם בודד במקום להוריד את כל קובץ הרשימה
        const oldNameStr = await getNameFromIni(phone, env.YEMOT_TOKEN) || "לא הוגדר בעבר";

        if (oldNameStr === newName) {
            return Response.json({ success: true, message: "השם המבוקש כבר מעודכן במערכת." });
        }

        const result = await updateNameInIni(phone, newName, env.YEMOT_TOKEN);
        
        if (result && result.responseStatus === 'OK') {
            if (!isMainAdmin) {
                await logAdminAction(env, adminPhone, 'UPDATE_NAME', phone, { name: oldNameStr }, { name: newName });
            }
            return Response.json({ success: true, message: "שם המשתמש עודכן בהצלחה במערכת ימות המשיח!" });
        } else {
            return Response.json({ error: "העדכון נדחה על ידי השרת החיצוני של ימות המשיח." }, { status: 400 });
        }
    } catch (e) { 
        console.error("Error updating Yemot name:", e);
        return Response.json({ error: "שגיאת מערכת פנימית בעת עדכון השם." }, { status: 500 }); 
    }
}

export async function handleAdminDisconnectUserTokens(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body, 'manage_users'))) return Response.json({ error: "לא מורשה" }, { status: 403 });
    const { phone, tokenId } = body;
    try {
        if (tokenId) {
            await env.DB.prepare("DELETE FROM user_tokens WHERE phone = ? AND id = ?").bind(phone, tokenId).run();
            return Response.json({ success: true, message: "החיבור נותק בהצלחה" });
        } else {
            await env.DB.prepare("DELETE FROM user_tokens WHERE phone = ?").bind(phone).run();
            return Response.json({ success: true, message: "המשתמש נותק מכל המכשירים" });
        }
    } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}

export async function handleAdminCreateUser(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body, 'manage_users'))) return Response.json({ error: "לא מורשה" }, { status: 403 });

    const { phone, password, email, canRecord, canUpload, canTzintuk, receiveEmails, googleLoginOnly, canListen, listenWhitelist, listenBlacklist, isAdmin, adminPermissions, isProtected } = body;
    if (!phone || !password) return Response.json({ error: "חובה לציין מספר טלפון וסיסמה" }, { status: 400 });

    const isMainAdmin = await isPrimaryAdmin(env, body);
    if (!isMainAdmin && (isAdmin === true || (adminPermissions && adminPermissions.length > 0) || isProtected === true)) {
        return Response.json({ error: "פעולה חסומה: רק מנהל ראשי רשאי ליצור מנהלים או משתמשים מוגנים." }, { status: 403 });
    }

    try {
        const existingUser = await env.DB.prepare("SELECT 1 FROM users WHERE phone = ?").bind(phone).first();
        if (existingUser) return Response.json({ error: "למשתמש זה כבר קיים חשבון באתר" }, { status: 400 });

        const finalEmail = email ? String(email).toLowerCase() : null;
        const nowIsraelStr = getIsraelTimeForDB();

        await env.DB.prepare(
            `INSERT INTO users (phone, email, password, can_record, can_upload, can_tzintuk, receive_emails, google_login_only, can_listen, listen_whitelist, listen_blacklist, profile_picture_url, lock_profile_picture, created_at, is_admin, admin_permissions, is_protected) 
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, 0, ?, ?, ?, ?)`
        ).bind(phone, finalEmail, password, canRecord?1:0, canUpload?1:0, canTzintuk?1:0, receiveEmails?1:0, canListen?1:0, listenWhitelist||'', listenBlacklist||'', nowIsraelStr, isAdmin?1:0, adminPermissions||'', isProtected?1:0).run();

        if (!isMainAdmin) {
            const adminPhone = await getPerformingAdminPhone(env, body);
            await logAdminAction(env, adminPhone, 'CREATE_USER', phone, {}, { phone: phone, email: finalEmail });
        }
        return Response.json({ success: true, message: "החשבון נוצר בהצלחה!" });
    } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}

export async function handleAdminDeleteUser(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body, 'manage_users'))) return Response.json({ error: "לא מורשה" }, { status: 403 });

    const { phone } = body;
    if (!phone) return Response.json({ error: "חסר טלפון" }, { status: 400 });

    try {
        const isMainAdmin = await isPrimaryAdmin(env, body);
        const user = await env.DB.prepare("SELECT is_protected FROM users WHERE phone = ?").bind(phone).first();
        
        if (user && user.is_protected === 1 && !isMainAdmin) {
            return Response.json({ error: "משתמש זה מוגן ממחיקה. רק מנהל ראשי יכול למחוק אותו." }, { status: 403 });
        }

        await env.DB.prepare("DELETE FROM user_tokens WHERE phone = ?").bind(phone).run();
        await env.DB.prepare("DELETE FROM users WHERE phone = ?").bind(phone).run();
        
        if (!isMainAdmin) {
            const adminPhone = await getPerformingAdminPhone(env, body);
            await logAdminAction(env, adminPhone, 'DELETE_USER', phone, { status: 'active' }, { status: 'deleted' });
        }
        return Response.json({ success: true, message: "החשבון נמחק לצמיתות" });
    } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}

export async function handleAdminGetTables(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body, 'manage_system'))) return Response.json({ error: "לא מורשה" }, { status: 403 });
    try {
        const { tableName } = body;
        if (tableName) {
            const data = await env.DB.prepare(`SELECT * FROM ${tableName} LIMIT 500`).all();
            return Response.json({ success: true, data: data.results });
        } else {
            const tables = await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
            return Response.json({ success: true, tables: tables.results.map(t => t.name) });
        }
    } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}

export async function handleAdminExecuteQuery(request, env) {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyAdmin(env, body, 'manage_system'))) return Response.json({ error: "לא מורשה" }, { status: 403 });
    try {
        if (!body.query) return Response.json({ error: "שאילתה ריקה" }, { status: 400 });
        const data = await env.DB.prepare(body.query).all();
        return Response.json({ success: true, results: data.results, meta: data.meta });
    } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}
