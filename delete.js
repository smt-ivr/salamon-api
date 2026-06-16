// delete.js
import { getMinutesSinceIsraelDbTime, getIsraelTimeForDB } from './timeUtils.js';

const DELETE_WINDOW_HOURS = 12; // מותר למחוק רק עד 12 שעות מההעלאה
const FOLDER_PATH = 'ivr2:/1/2'; // הנתיב הקבוע של ההודעות

/**
 * פונקציה פנימית מפורטת שבודקת את כל התנאים
 */
async function checkEligibility(db, phone, fileName) {
    // 1. אבטחה קריטית: האם שם הקובץ חוקי? (רק מספרים וסיומת wav)
    if (!fileName || !fileName.match(/^\d+\.wav$/)) {
        return { allowed: false, message: "שם קובץ לא חוקי. ניתן למחוק קבצי שמע מסוג מספרי בלבד." };
    }

    // 2. חיפוש הקובץ בטבלת ההעלאות הכללית (כדי לדעת מי העלה ומאיפה)
    const anyUpload = await db.prepare(
        `SELECT phone FROM upload_events WHERE file_name = ?`
    ).bind(fileName).first();

    // אם הקובץ בכלל לא קיים בטבלה - הוקלט בטלפון או לפני עדכון המערכת
    if (!anyUpload) {
        return { 
            allowed: false, 
            message: "לא ניתן למחוק. ההודעה הוקלטה דרך הטלפון או לפני שדרוג המערכת." 
        };
    }

    // 3. אם הקובץ קיים בטבלה - בודקים האם הטלפון הנוכחי הוא זה שהעלה אותו
    if (anyUpload.phone !== phone) {
        return { 
            allowed: false, 
            message: "פעולה חסומה! אינך מורשה למחוק הודעה שהועלתה על ידי משתמש אחר." 
        };
    }

    // 4. שליפת נתוני הצינתוק והזמן למשתמש הנוכחי
    const uploadRecord = await db.prepare(
        `SELECT upload_time, tzintuk_sent FROM upload_events WHERE phone = ? AND file_name = ?`
    ).bind(phone, fileName).first();

    // בדיקת צינתוק - אם נשלח צינתוק אסור למחוק
    if (uploadRecord.tzintuk_sent === 1) {
        return { allowed: false, message: " לא ניתן למחוק הודעה שנשלחה עליה צינתוק" };
    }

    // בדיקה האם עברו יותר מ-12 שעות?
    const minutesPassed = getMinutesSinceIsraelDbTime(uploadRecord.upload_time);
    if (minutesPassed > (DELETE_WINDOW_HOURS * 60) || minutesPassed < 0) {
        return { allowed: false, message: `עבר הזמן המותר למחיקה עצמאית (עד ${DELETE_WINDOW_HOURS} שעות ממועד ההעלאה).` };
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
    
    if (!user) return Response.json({ success: false, message: "אימות נכשל, התחבר מחדש." }, { status: 403 });

    const eligibility = await checkEligibility(env.DB, user.phone, fileName);
    return Response.json({ success: eligibility.allowed, message: eligibility.message });
}

/**
 * קריאה 2: מחיקה בפועל ורישום לוג
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

    // ==========================================
    // שלב 1: מחיקה בימות המשיח
    // ==========================================
    const exactFilePath = `${FOLDER_PATH}/${fileName}`;
    const deleteUrl = `https://www.call2all.co.il/ym/api/FileAction?token=${env.YEMOT_TOKEN}&action=delete&what=${encodeURIComponent(exactFilePath)}`;
    let yemotDeleted = false;

    try {
        const res = await fetch(deleteUrl);
        const data = await res.json();

        if (data.responseStatus === "OK" && data.success) {
            yemotDeleted = true;
        } else {
            return Response.json({ success: false, message: "השרת של ימות המשיח סירב למחוק את הקובץ. ייתכן שהוא כבר נמחק." });
        }
    } catch (err) {
        return Response.json({ success: false, message: "שגיאת רשת בנסיון ההתחברות לשרתי ימות המשיח." });
    }

    // ==========================================
    // שלב 2: עדכון מסד הנתונים ורישום לוג מחיקות
    // ==========================================
    if (yemotDeleted) {
        try {
            const currentTimeIsrael = getIsraelTimeForDB();
            // הגנה למקרה שה-IP לא מוגדר
            const safeIp = userIp || '0.0.0.0';

            // מחיקה מטבלת ההעלאות + כתיבת הלוג
            await env.DB.batch([
                env.DB.prepare(`DELETE FROM upload_events WHERE phone = ? AND file_name = ?`).bind(user.phone, fileName),
                env.DB.prepare(`INSERT INTO delete_logs (phone, ip_address, file_name, deleted_at) VALUES (?, ?, ?, ?)`).bind(user.phone, safeIp, fileName, currentTimeIsrael)
            ]);
            
            return Response.json({ success: true, message: "ההודעה נמחקה בהצלחה." });
        } catch (dbErr) {
            console.error("DB Log Error: ", dbErr);
            // הקובץ נמחק בימות, אז אנחנו מחזירים הצלחה, אבל מוסיפים את השגיאה של מסד הנתונים כדי שתוכל לדעת בדיוק למה זה נכשל
            return Response.json({ 
                success: true, 
                message: `ההודעה נמחקה, אך אירעה שגיאת SQL ברישום הלוג: ${dbErr.message}` 
            });
        }
    }
}
