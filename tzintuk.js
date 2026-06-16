// tzintuk.js
import { getIsraelTimeForDB, getMinutesSinceIsraelDbTime, getMinutesSinceYemotTime, isWithinBlockedHours } from './timeUtils.js';

// ============================================
// הגדרות מערכת צינתוקים (קלות לשינוי תמיד)
// ============================================
const UPLOAD_WINDOW_MINUTES = 2;       // תוך כמה דקות מהעלאה מותר לשלוח צינתוק?
const TZINTUK_COOLDOWN_MINUTES = 5;    // מרווח חובה מינימלי בין צינתוקים (מניעת ספאם)
const BLOCK_HOURS_START = 0;           // שעת תחילת חסימת לילה (0 = חצות)
const BLOCK_HOURS_END = 7;             // שעת סיום חסימת לילה (7 = 07:00 בבוקר)
const CALLER_ID = "0775282936";        // מספר המחייג
// ============================================

/**
 * בודק מול ה-API של ימות המשיח אם בוצע צינתוק לאחרונה דרך הטלפון
 */
async function checkYemotLogs(phone, token) {
    const url = `https://www.call2all.co.il/ym/api/TzintukimListManagement?token=${token}&action=getLogList&TzintukimList=members`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.responseStatus !== "OK") return false;

        const recentTzintuk = data.events.find(event => {
            if (event.TypeOperation !== "RunTzintuk") return false;
            
            // ניקוי המספר מתווים מיותרים כדי למנוע פספוסים
            const cleanEventPhone = event.Phone.replace(/\D/g, ''); 
            const cleanUserPhone = phone.replace(/\D/g, '');
            if (cleanEventPhone !== cleanUserPhone && !event.Phone.includes(phone)) return false; 
            
            const minutesPassed = getMinutesSinceYemotTime(event.Date, event.Time);
            // בודק אם עברו פחות מ-5 דקות מהצינתוק של ימות
            return minutesPassed < TZINTUK_COOLDOWN_MINUTES && minutesPassed >= 0;
        });

        return !!recentTzintuk; 
    } catch (error) {
        console.error("Failed to check Yemot logs", error);
        return false;
    }
}

export async function processTzintukRequest(env, phone, yemotToken) {
    const db = env.DB;
    const currentTimeForDB = getIsraelTimeForDB();

    // 0. בדיקת שעות פעילות (חסימת לילה)
    if (isWithinBlockedHours(BLOCK_HOURS_START, BLOCK_HOURS_END)) {
        return { 
            success: false, 
            message: `מערכת הצינתוקים מושבתת בלילה.\nלא ניתן לשלוח צינתוקים בין השעות 0${BLOCK_HOURS_START}:00 ל-0${BLOCK_HOURS_END}:00 בבוקר.` 
        };
    }

    // 1. בדיקת הרשאה מתוך טבלת המשתמשים
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
    // (החלפתי את ORDER BY מ-upload_time ל-id כדי להיות חסין לתקלות במיון טקסט)
    const latestUpload = await db.prepare(
        `SELECT id, upload_time, tzintuk_sent FROM upload_events WHERE phone = ? ORDER BY id DESC LIMIT 1`
    ).bind(phone).first();

    if (!latestUpload) {
        return { success: false, message: "לא נמצאה העלאת הודעה. יש להעלות קובץ לפני שליחת צינתוק." };
    }
    if (latestUpload.tzintuk_sent === 1) {
        return { success: false, message: "כבר שלחת צינתוק על ההודעה האחרונה שהעלית." };
    }

    const uploadMinutesPassed = getMinutesSinceIsraelDbTime(latestUpload.upload_time);

    // אם עבר הזמן המוגדר, או שיש חישוב שלילי מוזר
    if (uploadMinutesPassed > UPLOAD_WINDOW_MINUTES || uploadMinutesPassed < 0) {
        return { success: false, message: `עבר הזמן המותר לצינתוק על הודעה זו.` };
    }

    // 3. בדיקת קירור (Cooldown) מול הטבלה הפנימית (למניעת ספאם באתר)
    const lastInternalLog = await db.prepare(
        `SELECT sent_time FROM tzintuk_logs WHERE phone = ? ORDER BY id DESC LIMIT 1`
    ).bind(phone).first();

    if (lastInternalLog) {
        const internalMinutesPassed = getMinutesSinceIsraelDbTime(lastInternalLog.sent_time);
        
        if (internalMinutesPassed < TZINTUK_COOLDOWN_MINUTES && internalMinutesPassed >= 0) {
            // חישוב כמה דקות בדיוק נשארו להמתנה
            const waitTimeMinutes = Math.ceil(TZINTUK_COOLDOWN_MINUTES - internalMinutesPassed);
            return { success: false, message: `לא ניתן לשלוח צינתוק, הפעלת צינתוק לפני זמן קצר, החסימה תשוחרר בעוד-${waitTimeMinutes} דקות.` };
        }
    }

    // בדיקת קירור מול ימות המשיח (אם עשה צינתוק בטלפון)
    const recentlySentInYemot = await checkYemotLogs(phone, yemotToken);
    if (recentlySentInYemot) {
        return { success: false, message: `הפעלת צינתוק דרך הטלפון לפני זמן קצר, החסימה תשוחרר בעוד ${TZINTUK_COOLDOWN_MINUTES} דקות.` };
    }

    // 4. אם הכל תקין, שולחים את הצינתוק לימות המשיח
    const sendUrl = `https://www.call2all.co.il/ym/api/RunTzintuk?token=${yemotToken}&callerId=${CALLER_ID}&TzintukTimeOut=16&phones=tzl:admins&sayInfoOnAnswer=true`;
    
    try {
        const tzintukRes = await fetch(sendUrl);
        const tzintukData = await tzintukRes.json();

        if (tzintukData.responseStatus === "OK") {
            // מעדכנים שהצינתוק נשלח + מתעדים את זמן הצינתוק המדויק בישראל
            await db.batch([
                db.prepare(`UPDATE upload_events SET tzintuk_sent = 1 WHERE id = ?`).bind(latestUpload.id),
                db.prepare(`INSERT INTO tzintuk_logs (phone, sent_time) VALUES (?, ?)`).bind(phone, currentTimeForDB)
            ]);

            return { success: true, message: "הצינתוק נשלח בהצלחה!" };
        } else {
            return { success: false, message: "שגיאה מול ימות המשיח בשליחת הצינתוק.", details: tzintukData };
        }
    } catch (error) {
        console.error("Error sending tzintuk:", error);
        return { success: false, message: "שגיאת רשת פנימית בשליחת הצינתוק." };
    }
}
