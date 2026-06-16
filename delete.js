// delete.js
import { getMinutesSinceIsraelDbTime, getIsraelTimeForDB } from './timeUtils.js';

const DELETE_WINDOW_HOURS = 12; // מותר למחוק רק עד 12 שעות מההעלאה
const FOLDER_PATH = 'ivr2:/1/2'; // הנתיב הקבוע של ההודעות

/**
 * פונקציה פנימית משותפת שבודקת אם המשתמש רשאי למחוק את הקובץ הספציפי
 */
async function checkEligibility(db, phone, fileName) {
    // 1. אבטחה קריטית: האם שם הקובץ חוקי? (רק מספרים וסיומת wav)
    if (!fileName || !fileName.match(/^\d+\.wav$/)) {
        return { allowed: false, message: "שם קובץ לא חוקי או שאינו קובץ שמע סטנדרטי." };
    }

    // 2. חיפוש הקובץ בטבלת ההעלאות כדי לוודא בעלות
    const uploadRecord = await db.prepare(
        `SELECT upload_time, tzintuk_sent FROM upload_events WHERE phone = ? AND file_name = ?`
    ).bind(phone, fileName).first();

    if (!uploadRecord) {
        return { allowed: false, message: "הודעה זו לא הועלתה על ידך דרך האתר, ולכן אין לך הרשאה למחוק אותה." };
    }

    // 3. בדיקת צינתוק - אם נשלח צינתוק אסור למחוק
    if (uploadRecord.tzintuk_sent === 1) {
        return { allowed: false, message: "לא ניתן למחוק הודעה שכבר נשלח עליה צינתוק למנויים." };
    }

    // 4. האם עברו יותר מ-12 שעות?
    const minutesPassed = getMinutesSinceIsraelDbTime(uploadRecord.upload_time);
    if (minutesPassed > (DELETE_WINDOW_HOURS * 60) || minutesPassed < 0) {
        return { allowed: false, message: `עבר הזמן המותר למחיקה (מעל ${DELETE_WINDOW_HOURS} שעות).` };
    }

    return { allowed: true };
}

/**
 * קריאה 1: בודק אם מותר למחוק (לפני הקפצת האזהרה בדפדפן)
 */
export async function handleCheckDeleteEligibility(request, env) {
    const body = await request.json();
    const userToken = body.userToken;
    const fileName = body.fileName;

    const [identifier, password] = userToken.split(':');
    const user = await env.DB.prepare("SELECT phone FROM users WHERE (phone = ? OR email = ?) AND password = ?").bind(identifier, identifier, password).first();
    
    if (!user) return Response.json({ success: false, message: "אימות נכשל" }, { status: 403 });

    const eligibility = await checkEligibility(env.DB, user.phone, fileName);
    return Response.json({ success: eligibility.allowed, message: eligibility.message });
}

/**
 * קריאה 2: מחיקה בפועל ורישום לוג
 * שים לב שהוספנו את המשתנה userIp לפונקציה
 */
export async function handleDeleteMessage(request, env, userIp) {
    const body = await request.json();
    const userToken = body.userToken;
    const fileName = body.fileName;

    const [identifier, password] = userToken.split(':');
    const user = await env.DB.prepare("SELECT phone FROM users WHERE (phone = ? OR email = ?) AND password = ?").bind(identifier, identifier, password).first();
    
    if (!user) return Response.json({ success: false, message: "אימות נכשל" }, { status: 403 });

    // בדיקה סופית לפני ביצוע
    const eligibility = await checkEligibility(env.DB, user.phone, fileName);
    if (!eligibility.allowed) {
        return Response.json({ success: false, message: eligibility.message });
    }

    // הכל תקין, שולחים פקודת מחיקה לימות המשיח באבטחה מלאה
    const exactFilePath = `${FOLDER_PATH}/${fileName}`;
    const deleteUrl = `https://www.call2all.co.il/ym/api/FileAction?token=${env.YEMOT_TOKEN}&action=delete&what=${encodeURIComponent(exactFilePath)}`;

    try {
        const res = await fetch(deleteUrl);
        const data = await res.json();

        if (data.responseStatus === "OK" && data.success) {
            const currentTimeIsrael = getIsraelTimeForDB();

            // מחיקה מטבלת ההעלאות + כתיבת הלוג לטבלת המחיקות בשעון ישראל
            await env.DB.batch([
                env.DB.prepare(`DELETE FROM upload_events WHERE phone = ? AND file_name = ?`).bind(user.phone, fileName),
                env.DB.prepare(`INSERT INTO delete_logs (phone, ip_address, file_name, deleted_at) VALUES (?, ?, ?, ?)`).bind(user.phone, userIp, fileName, currentTimeIsrael)
            ]);
            
            return Response.json({ success: true, message: "ההודעה נמחקה בהצלחה." });
        } else {
            return Response.json({ success: false, message: "השרת של ימות המשיח סירב למחוק את הקובץ." });
        }
    } catch (err) {
        return Response.json({ success: false, message: "שגיאת רשת בנסיון המחיקה." });
    }
}
