// delete.js
import { getMinutesSinceIsraelDbTime, getIsraelTimeForDB } from './timeUtils.js';
import { authenticateUser } from './auth.js';

const DELETE_WINDOW_HOURS = 12; // חלון מחיקה למשתמש רגיל
const ADMIN_DELETE_WINDOW_DAYS = 7; // חלון מחיקה למנהלים (שבוע)
const FOLDER_PATH = 'ivr2:/1/2'; 
const DELETE_ARCHIVE_PATH = 'ivr2:/delete';

// פונקציית עזר למשיכת נתוני קובץ שהוקלט ישירות בטלפון מתוך קובץ הטקסט בימות
async function getFileDetailsFromYemot(env, fileName) {
    const txtFileName = fileName.replace('.wav', '.txt');
    const txtPath = `${FOLDER_PATH}/${txtFileName}`;
    const url = `https://www.call2all.co.il/ym/api/GetTextFile?token=${env.YEMOT_TOKEN}&what=${encodeURIComponent(txtPath)}`;

    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.responseStatus === 'OK' && data.contents) {
            let phone = null;
            let recordTime = null;

            // חילוץ המספר
            const phoneMatch = data.contents.match(/Phone-(\d+)/);
            if (phoneMatch) phone = phoneMatch[1];

            // חילוץ התאריך מפורמט YYYY-MM-DD-HH-MM-SS
            const dateMatch = data.contents.match(/Date-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})/);
            if (dateMatch) {
                const parts = dateMatch[1].split('-');
                if (parts.length === 6) {
                    // המרה לפורמט סטנדרטי למערכת YYYY-MM-DD HH:MM:SS
                    recordTime = `${parts[0]}-${parts[1]}-${parts[2]} ${parts[3]}:${parts[4]}:${parts[5]}`;
                }
            }
            return { phone, recordTime };
        }
    } catch (e) {
        console.error("Error fetching Yemot txt:", e);
    }
    return null;
}

async function checkEligibility(env, user, fileName) {
    const db = env.DB;
    if (!fileName || !fileName.match(/^\d+\.wav$/)) {
        return { allowed: false, message: "שם קובץ לא חוקי. ניתן לבצע פעולות על קבצי שמע מסוג מספרי בלבד." };
    }

    // מאסטר עוקף את כל ההגבלות
    if (user.is_master) {
        return { allowed: true, isAdminDelete: true, uploaderPhone: "master_override" };
    }

    let uploaderPhone = null;
    let uploadTime = null;
    let tzintukSent = 0;
    let isUploaderAdmin = 0;

    // שליפת פרטי ההעלאה מהמסד המקומי יחד עם נתוני המשתמש
    const uploaderRecord = await db.prepare(
        `SELECT u.phone, u.upload_time, u.tzintuk_sent, usr.is_admin 
         FROM upload_events u 
         LEFT JOIN users usr ON u.phone = usr.phone 
         WHERE u.file_name = ?`
    ).bind(fileName).first();

    if (uploaderRecord) {
        // נמצא במסד הנתונים
        uploaderPhone = uploaderRecord.phone;
        uploadTime = uploaderRecord.upload_time;
        tzintukSent = uploaderRecord.tzintuk_sent;
        isUploaderAdmin = uploaderRecord.is_admin || 0;
    } else {
        // הקובץ הוקלט בטלפון - נשלוף את נתוניו מימות המשיח
        const yemotDetails = await getFileDetailsFromYemot(env, fileName);
        
        if (!yemotDetails || !yemotDetails.phone || !yemotDetails.recordTime) {
            return { 
                allowed: false, 
                message: "לא ניתן לבצע פעולה: ההודעה לא מופיעה במסד וחסרים נתוני זיהוי בקובץ (בימות המשיח)." 
            };
        }
        
        uploaderPhone = yemotDetails.phone;
        uploadTime = yemotDetails.recordTime;

        // בדיקה האם המספר ששלפנו מהטלפון שייך למנהל
        const uploaderUser = await db.prepare("SELECT is_admin FROM users WHERE phone = ?").bind(uploaderPhone).first();
        if (uploaderUser) {
            isUploaderAdmin = uploaderUser.is_admin || 0;
        }
    }

    const isOwnFile = (uploaderPhone === user.phone);

    // ==========================================
    // לוגיקת מחיקה למנהלים (על הודעות של אחרים)
    // ==========================================
    if (!isOwnFile) {
        
        if (user.is_admin !== 1) {
            return { allowed: false, message: "פעולה חסומה! אינך מורשה למחוק הודעה שהועלתה על ידי משתמש אחר." };
        }

        const perms = user.admin_permissions ? user.admin_permissions.split(',') : [];
        if (!perms.includes('all') && !perms.includes('delete_messages')) {
            return { allowed: false, message: "פעולה חסומה: חסרה לך הרשאת מחיקת הודעות." };
        }

        if (isUploaderAdmin === 1) {
            return { allowed: false, message: "פעולה חסומה: לא ניתן למחוק הודעות של מנהלים אחרים במערכת." };
        }

        const minutesPassed = getMinutesSinceIsraelDbTime(uploadTime);
        if (minutesPassed > (ADMIN_DELETE_WINDOW_DAYS * 24 * 60) || minutesPassed < 0) {
            return { allowed: false, message: `לא ניתן להעביר לארכיון: ההרשאה מאפשרת פעולה רק על הודעות שהוקלטו בשבוע האחרון.` };
        }

        return { allowed: true, isAdminDelete: true, uploaderPhone: uploaderPhone };
    }

    // ==========================================
    // לוגיקת מחיקה עצמית (משתמש מוחק לעצמו)
    // ==========================================
    if (tzintukSent === 1) {
        return { allowed: false, message: "לא ניתן למחוק הודעה שנשלחה עליה צינתוק." };
    }

    const minutesPassed = getMinutesSinceIsraelDbTime(uploadTime);
    if (minutesPassed > (DELETE_WINDOW_HOURS * 60) || minutesPassed < 0) {
        return { allowed: false, message: `לא ניתן למחוק הודעה שהוקלטה לפני יותר מ-${DELETE_WINDOW_HOURS} שעות.` };
    }

    return { allowed: true, isAdminDelete: false, uploaderPhone: user.phone };
}

export async function handleCheckDeleteEligibility(request, env) {
    const body = await request.json();
    const userToken = body.userToken;
    const fileName = body.fileName;

    const user = await authenticateUser(env.DB, userToken);
    if (!user) return Response.json({ success: false, message: "אימות נכשל, התחבר מחדש." }, { status: 403 });

    // כאן אנחנו מעבירים גם את env כדי לאפשר תקשורת עם ימות
    const eligibility = await checkEligibility(env, user, fileName);
    return Response.json({ success: eligibility.allowed, message: eligibility.message });
}

export async function handleDeleteMessage(request, env, userIp) {
    const body = await request.json();
    const userToken = body.userToken;
    const fileName = body.fileName;

    const user = await authenticateUser(env.DB, userToken);
    if (!user) return Response.json({ success: false, message: "אימות נכשל" }, { status: 403 });

    const eligibility = await checkEligibility(env, user, fileName);
    if (!eligibility.allowed) {
        return Response.json({ success: false, message: eligibility.message });
    }

    const exactFilePath = `${FOLDER_PATH}/${fileName}`;
    let yemotActionUrl = "";

    if (eligibility.isAdminDelete) {
        // מנהל - העברה לארכיון באמצעות שינוי נתיב בימות המשיח
        const targetPath = `${DELETE_ARCHIVE_PATH}/${fileName}`;
        yemotActionUrl = `https://www.call2all.co.il/ym/api/FileAction?token=${env.YEMOT_TOKEN}&action=rename&what=${encodeURIComponent(exactFilePath)}&target=${encodeURIComponent(targetPath)}`;
    } else {
        // מחיקה עצמית - מחיקה מוחלטת כרגיל
        yemotActionUrl = `https://www.call2all.co.il/ym/api/FileAction?token=${env.YEMOT_TOKEN}&action=delete&what=${encodeURIComponent(exactFilePath)}`;
    }

    let yemotSuccess = false;
    let errorMessage = "השרת של ימות המשיח סירב לבצע את הפעולה. ייתכן והקובץ לא קיים.";

    try {
        const res = await fetch(yemotActionUrl);
        const data = await res.json();

        if (data.responseStatus === "OK") {
            yemotSuccess = true;
        }
    } catch (err) {
        return Response.json({ success: false, message: "שגיאת רשת בנסיון ההתחברות לשרתי ימות המשיח." });
    }

    if (yemotSuccess) {
        try {
            const currentTimeIsrael = getIsraelTimeForDB();
            const safeIp = userIp || '0.0.0.0';

            const queries = [
                env.DB.prepare(`DELETE FROM upload_events WHERE file_name = ?`).bind(fileName)
            ];

            if (eligibility.isAdminDelete) {
                // לוג למנהל
                const targetPhone = eligibility.uploaderPhone || 'unknown';
                const beforeDetails = { file_name: fileName, original_folder: FOLDER_PATH };
                const afterDetails = { status: 'moved_to_archive', new_folder: DELETE_ARCHIVE_PATH, performed_from_ip: safeIp };
                
                queries.push(
                    env.DB.prepare(
                        `INSERT INTO admin_audit_logs (admin_phone, action_type, target_phone, details_before, details_after, timestamp) VALUES (?, ?, ?, ?, ?, ?)`
                    ).bind(user.phone, 'ADMIN_DELETE_MESSAGE', targetPhone, JSON.stringify(beforeDetails), JSON.stringify(afterDetails), currentTimeIsrael)
                );
            } else {
                // לוג למחיקה עצמית
                queries.push(
                    env.DB.prepare(`INSERT INTO delete_logs (phone, ip_address, file_name, deleted_at) VALUES (?, ?, ?, ?)`).bind(user.phone, safeIp, fileName, currentTimeIsrael)
                );
            }

            await env.DB.batch(queries);
            
            const successMsg = eligibility.isAdminDelete ? 
                "ההודעה הועברה בהצלחה לארכיון ההנהלה." : 
                "ההודעה נמחקה בהצלחה.";
                
            return Response.json({ success: true, message: successMsg });
        } catch (dbErr) {
            console.error("DB Log Error: ", dbErr);
            return Response.json({ 
                success: true, 
                message: `הפעולה בוצעה בימות המשיח, אך אירעה שגיאת SQL ברישום הלוג: ${dbErr.message}` 
            });
        }
    } else {
        return Response.json({ success: false, message: errorMessage });
    }
}
