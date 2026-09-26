// delete.js
import { getMinutesSinceIsraelDbTime, getIsraelTimeForDB } from './timeUtils.js';
import { authenticateUser } from './auth.js';

const DELETE_WINDOW_HOURS = 12; // חלון מחיקה למשתמש רגיל או למחיקה עצמית
const ADMIN_DELETE_WINDOW_DAYS = 7; // חלון מחיקה למנהלים (שבוע)
const FOLDER_PATH = 'ivr2:/1/2'; 
const DELETE_ARCHIVE_PATH = 'ivr2:/delete';

// פונקציית עזר למשיכת נתוני קובץ שהוקלט בטלפון ישירות מתוך קובץ הטקסט בימות
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

            const phoneMatch = data.contents.match(/Phone-(\d+)/);
            if (phoneMatch) phone = phoneMatch[1];

            const dateMatch = data.contents.match(/Date-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})/);
            if (dateMatch) {
                const parts = dateMatch[1].split('-');
                if (parts.length === 6) {
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
    
    // בדיקה מקורית מדויקת לשם הקובץ
    if (!fileName || !fileName.match(/^\d+\.wav$/)) {
        return { allowed: false, message: "שם קובץ לא חוקי. ניתן למחוק קבצי שמע מסוג מספרי בלבד." };
    }

    // בדיקה מקורית מדויקת למאסטר
    if (user.is_master) {
        return { allowed: true, isAdminDelete: true, uploaderPhone: "master_override" };
    }

    // בדיקה מקורית מדויקת של הקובץ במסד הנתונים
    const anyUpload = await db.prepare(
        `SELECT phone FROM upload_events WHERE file_name = ?`
    ).bind(fileName).first();

    const isOwnFile = anyUpload && anyUpload.phone === user.phone;

    // =========================================================
    // מסלול מחיקת מנהל (אם הקובץ לא נמצא, או שהוא של מישהו אחר)
    // =========================================================
    if (!isOwnFile) {
        let isAdminAuthorized = false;
        if (user.is_admin === 1) {
            const perms = user.admin_permissions ? user.admin_permissions.split(',') : [];
            if (perms.includes('all') || perms.includes('delete_messages')) {
                isAdminAuthorized = true;
            }
        }

        // אם המשתמש הוא לא מנהל מורשה - נחזיר לו את ההודעות המקוריות בדיוק!
        if (!isAdminAuthorized) {
            if (!anyUpload) {
                return { 
                    allowed: false, 
                    message: "לא ניתן למחוק. ההודעה הוקלטה דרך הטלפון או לפני שדרוג המערכת." 
                };
            } else {
                return { 
                    allowed: false, 
                    message: "פעולה חסומה! אינך מורשה למחוק הודעה שהועלתה על ידי משתמש אחר." 
                };
            }
        }

        // מכאן ומטה - זה בוודאות מנהל מורשה שמנסה למחוק הודעה שלא שלו.
        let targetPhone = null;
        let targetUploadTime = null;
        let isTargetAdmin = 0;

        if (anyUpload) {
            // הקובץ במסד הנתונים (של משתמש אחר)
            const uploaderRecord = await db.prepare(
                `SELECT u.phone, u.upload_time, usr.is_admin 
                 FROM upload_events u 
                 LEFT JOIN users usr ON u.phone = usr.phone 
                 WHERE u.file_name = ?`
            ).bind(fileName).first();
            
            targetPhone = uploaderRecord.phone;
            targetUploadTime = uploaderRecord.upload_time;
            isTargetAdmin = uploaderRecord.is_admin || 0;
        } else {
            // הקובץ הוקלט בטלפון ולא מופיע במסד - נשלוף פרטים מימות כדי שהמנהל יוכל למחוק
            const yemotDetails = await getFileDetailsFromYemot(env, fileName);
            if (!yemotDetails || !yemotDetails.phone || !yemotDetails.recordTime) {
                return { allowed: false, message: "לא ניתן לבצע פעולת הנהלה: חסרים נתוני זיהוי של ההודעה (בימות המשיח)." };
            }
            targetPhone = yemotDetails.phone;
            targetUploadTime = yemotDetails.recordTime;

            const targetUser = await db.prepare("SELECT is_admin FROM users WHERE phone = ?").bind(targetPhone).first();
            if (targetUser) {
                isTargetAdmin = targetUser.is_admin || 0;
            }
        }

        // הגבלות מנהל
        if (isTargetAdmin === 1) {
            return { allowed: false, message: "פעולה חסומה: לא ניתן למחוק הודעות של מנהלים אחרים במערכת." };
        }

        const minutesPassed = getMinutesSinceIsraelDbTime(targetUploadTime);
        if (minutesPassed > (ADMIN_DELETE_WINDOW_DAYS * 24 * 60) || minutesPassed < 0) {
            return { allowed: false, message: "לא ניתן למחוק: ההרשאה מאפשרת פעולה רק על הודעות שהוקלטו בשבוע האחרון." };
        }

        return { allowed: true, isAdminDelete: true, uploaderPhone: targetPhone };
    }

    // =========================================================
    // מסלול מחיקה עצמית (למשתמש רגיל או מנהל שמוחק לעצמו) - זהה למקור לחלוטין!
    // =========================================================
    const uploadRecord = await db.prepare(
        `SELECT upload_time, tzintuk_sent FROM upload_events WHERE phone = ? AND file_name = ?`
    ).bind(user.phone, fileName).first();

    if (uploadRecord.tzintuk_sent === 1) {
        return { allowed: false, message: " לא ניתן למחוק הודעה שנשלחה עליה צינתוק" };
    }

    const minutesPassed = getMinutesSinceIsraelDbTime(uploadRecord.upload_time);
    if (minutesPassed > (DELETE_WINDOW_HOURS * 60) || minutesPassed < 0) {
        return { allowed: false, message: `לא ניתן למחוק הודעה שהוקלטה לפני יותר מ ${DELETE_WINDOW_HOURS} שעות.` };
    }

    return { allowed: true, isAdminDelete: false, uploaderPhone: user.phone };
}

export async function handleCheckDeleteEligibility(request, env) {
    const body = await request.json();
    const userToken = body.userToken;
    const fileName = body.fileName;

    const user = await authenticateUser(env.DB, userToken);
    if (!user) return Response.json({ success: false, message: "אימות נכשל, התחבר מחדש." }, { status: 403 });

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
        // מנהל - העברה לארכיון באמצעות פקודת move כפי שמופיע בתיעוד
        const targetPath = `${DELETE_ARCHIVE_PATH}/${fileName}`;
        yemotActionUrl = `https://www.call2all.co.il/ym/api/FileAction?token=${env.YEMOT_TOKEN}&action=move&what=${encodeURIComponent(exactFilePath)}&target=${encodeURIComponent(targetPath)}`;
    } else {
        // מחיקה עצמית - מחיקה מוחלטת עם פקודת delete, בדיוק כמו במקור
        yemotActionUrl = `https://www.call2all.co.il/ym/api/FileAction?token=${env.YEMOT_TOKEN}&action=delete&what=${encodeURIComponent(exactFilePath)}`;
    }

    let yemotSuccess = false;
    
    // הודעת השגיאה המקורית המדויקת למקרה כישלון בימות
    let errorMessage = "השרת של ימות המשיח סירב למחוק את הקובץ. ייתכן שהוא כבר נמחק.";

    try {
        const res = await fetch(yemotActionUrl);
        const data = await res.json();

        // בדיקת success על פי התיעוד 
        if (data.success === true) {
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
                // לוג מפורט למנהל ב- admin_audit_logs
                const targetPhone = eligibility.uploaderPhone || 'unknown';
                const beforeDetails = { file_name: fileName, original_folder: FOLDER_PATH };
                const afterDetails = { status: 'moved_to_archive', new_folder: DELETE_ARCHIVE_PATH, performed_from_ip: safeIp };
                
                queries.push(
                    env.DB.prepare(
                        `INSERT INTO admin_audit_logs (admin_phone, action_type, target_phone, details_before, details_after, timestamp) VALUES (?, ?, ?, ?, ?, ?)`
                    ).bind(user.phone, 'ADMIN_DELETE_MESSAGE', targetPhone, JSON.stringify(beforeDetails), JSON.stringify(afterDetails), currentTimeIsrael)
                );
            } else {
                // מחיקה עצמית נרשמת ללוג הרגיל של המחיקות delete_logs
                queries.push(
                    env.DB.prepare(`INSERT INTO delete_logs (phone, ip_address, file_name, deleted_at) VALUES (?, ?, ?, ?)`).bind(user.phone, safeIp, fileName, currentTimeIsrael)
                );
            }

            await env.DB.batch(queries);
                
            return Response.json({ success: true, message: "ההודעה נמחקה בהצלחה." });
        } catch (dbErr) {
            console.error("DB Log Error: ", dbErr);
            // הטקסט חזר במדויק למקור
            return Response.json({ 
                success: true, 
                message: `ההודעה נמחקה, אך אירעה שגיאת SQL ברישום הלוג: ${dbErr.message}` 
            });
        }
    } else {
        return Response.json({ success: false, message: errorMessage });
    }
}
