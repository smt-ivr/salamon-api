// tzintuk.js
import { getIsraelTimeForDB, getNowMs, parseYemotTimeMs, parseDBTimeToMs } from './timeUtils.js';

const UPLOAD_WINDOW_MINUTES = 2; // למשתמש יש 2 דקות מהעלאה לבקש צינתוק
const TZINTUK_COOLDOWN_MINUTES = 5; // חסימת צינתוקים (המתנה של 5 דקות)

/**
 * בודקת מול ה-API של ימות המשיח אם בוצע צינתוק לאחרונה דרך הטלפון
 */
async function checkYemotLogs(phone, token) {
    const url = `https://www.call2all.co.il/ym/api/TzintukimListManagement?token=${token}&action=getLogList&TzintukimList=members`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.responseStatus !== "OK") {
            console.error("Yemot API error fetching logs");
            return false; 
        }

        const nowMs = getNowMs();
        const cooldownMs = TZINTUK_COOLDOWN_MINUTES * 60 * 1000;

        const recentTzintuk = data.events.find(event => {
            if (event.TypeOperation !== "RunTzintuk") return false;
            
            // ניקוי המספר מתווים מיותרים כדי למנוע פספוסים בהשוואה
            const cleanEventPhone = event.Phone.replace(/\D/g, ''); 
            const cleanUserPhone = phone.replace(/\D/g, '');
            if (cleanEventPhone !== cleanUserPhone && !event.Phone.includes(phone)) return false; 
            
            const eventTimeMs = parseYemotTimeMs(event.Date, event.Time);
            // בדיקה אם עברו פחות מ-5 דקות
            return (nowMs - eventTimeMs) < cooldownMs;
        });

        return !!recentTzintuk; 
    } catch (error) {
        console.error("Failed to check Yemot logs", error);
        return false;
    }
}

/**
 * הפונקציה המרכזית לשליחת הצינתוק לאחר כל הבדיקות
 */
export async function processTzintukRequest(env, phone, yemotToken) {
    const db = env.DB;
    const nowMs = getNowMs();
    const currentTimeForDB = getIsraelTimeForDB();

    // 1. בדיקת הרשאה מתוך טבלת המשתמשים הראשית (הכי נקי ופשוט!)
    const user = await db.prepare(
        `SELECT can_tzintuk FROM users WHERE phone = ?`
    ).bind(phone).first();

    if (!user) {
         return { success: false, message: "המשתמש לא נמצא במערכת." };
    }
    if (user.can_tzintuk === 0) {
         return { success: false, message: "ההרשאה שלך לשליחת צינתוקים נחסמה על ידי מנהל המערכת." };
    }

    // 2. בדיקה האם המשתמש העלה קובץ ב-2 הדקות האחרונות
    const latestUpload = await db.prepare(
        `SELECT id, upload_time, tzintuk_sent FROM upload_events WHERE phone = ? ORDER BY upload_time DESC LIMIT 1`
    ).bind(phone).first();

    if (!latestUpload) {
        return { success: false, message: "לא נמצאה העלאת הודעה. יש להעלות קובץ לפני שליחת צינתוק." };
    }

    if (latestUpload.tzintuk_sent === 1) {
        return { success: false, message: "כבר שלחת צינתוק על ההודעה האחרונה שהעלית." };
    }

    const uploadTimeMs = parseDBTimeToMs(latestUpload.upload_time);
    const timeSinceUploadMinutes = (nowMs - uploadTimeMs) / (1000 * 60);

    if (timeSinceUploadMinutes > UPLOAD_WINDOW_MINUTES) {
        return { success: false, message: `עבר הזמן המותר לצינתוק. חלפו יותר מ-${UPLOAD_WINDOW_MINUTES} דקות מאז ההעלאה.` };
    }

    // 3. בדיקת קירור (Cooldown) מול הטבלה הפנימית ומול הלוגים של ימות
    const lastInternalLog = await db.prepare(
        `SELECT sent_time FROM tzintuk_logs WHERE phone = ? ORDER BY sent_time DESC LIMIT 1`
    ).bind(phone).first();

    if (lastInternalLog) {
        const lastSentMs = parseDBTimeToMs(lastInternalLog.sent_time);
        if ((nowMs - lastSentMs) < (TZINTUK_COOLDOWN_MINUTES * 60 * 1000)) {
            return { success: false, message: `אנא המתן. ניתן לשלוח צינתוק רק פעם ב-${TZINTUK_COOLDOWN_MINUTES} דקות.` };
        }
    }

    const recentlySentInYemot = await checkYemotLogs(phone, yemotToken);
    if (recentlySentInYemot) {
        return { success: false, message: `הפעלת צינתוק דרך הטלפון לאחרונה. אנא המתן ${TZINTUK_COOLDOWN_MINUTES} דקות.` };
    }

    // 4. אם הכל תקין, שולחים את הצינתוק לימות המשיח
    const callerId = "0775282936";
    const sendUrl = `https://www.call2all.co.il/ym/api/RunTzintuk?token=${yemotToken}&callerId=${callerId}&TzintukTimeOut=16&phones=tzl:members&sayInfoOnAnswer=true`;
    
    try {
        const tzintukRes = await fetch(sendUrl);
        const tzintukData = await tzintukRes.json();

        if (tzintukData.responseStatus === "OK") {
            // מעדכנים שהצינתוק נשלח על ההעלאה הזו + מתעדים את זמן הצינתוק עם שעון ישראל
            await db.batch([
                db.prepare(`UPDATE upload_events SET tzintuk_sent = 1 WHERE id = ?`).bind(latestUpload.id),
                db.prepare(`INSERT INTO tzintuk_logs (phone, sent_time) VALUES (?, ?)`).bind(phone, currentTimeForDB)
            ]);

            return { success: true, message: "הצינתוק נשלח למנויים בהצלחה!" };
        } else {
            return { success: false, message: "שגיאה מול שרתי ימות המשיח.", details: tzintukData };
        }
    } catch (error) {
        console.error("Error sending tzintuk:", error);
        return { success: false, message: "שגיאת רשת פנימית בשליחת הצינתוק." };
    }
}
