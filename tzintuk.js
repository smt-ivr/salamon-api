// tzintuk.js

const UPLOAD_WINDOW_MINUTES = 2; // זכות שליחה עד 2 דקות
const TZINTUK_COOLDOWN_MINUTES = 5; // חסימת ספאם פנימית (5 דקות)

// ממיר תאריך של ימות המשיח למילישניות לפי שעון ישראל
function parseYemotTimeToMs(dateStr, timeStr) {
    const [day, month, year] = dateStr.split('/');
    const [hour, minute, second] = timeStr.split(':');
    const dateString = `${year}-${month}-${day}T${hour}:${minute}:${second}+02:00`; 
    return new Date(dateString).getTime();
}

async function checkYemotLogs(phone, token) {
    const url = `https://www.call2all.co.il/ym/api/TzintukimListManagement?token=${token}&action=getLogList&TzintukimList=members`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.responseStatus !== "OK") return false;

        const nowMs = Date.now();
        const cooldownMs = TZINTUK_COOLDOWN_MINUTES * 60 * 1000;

        const recentTzintuk = data.events.find(event => {
            if (event.TypeOperation !== "RunTzintuk") return false;
            // הוספת מנקה פשוט למספר במקרה וימות מחזירים פורמט קצת שונה
            const cleanEventPhone = event.Phone.replace(/\D/g, ''); 
            const cleanUserPhone = phone.replace(/\D/g, '');
            if (cleanEventPhone !== cleanUserPhone && !event.Phone.includes(phone)) return false; 
            
            const eventTimeMs = parseYemotTimeToMs(event.Date, event.Time);
            return (nowMs - eventTimeMs) < cooldownMs;
        });

        return !!recentTzintuk; 
    } catch (error) {
        console.error("Yemot log error:", error);
        return false;
    }
}

export async function processTzintukRequest(env, phone, yemotToken) {
    const db = env.DB;
    const nowMs = Date.now(); // זמן יוניברסלי לבדיקות

    // 1. בדיקת חסימות (צמיתות / זמנית)
    const userPermission = await db.prepare(
        `SELECT is_blocked, blocked_until FROM tzintuk_permissions WHERE phone = ?`
    ).bind(phone).first();

    if (userPermission) {
        if (userPermission.is_blocked === 1) {
            return { success: false, message: "המספר שלך חסום משליחת צינתוקים דרך האתר." };
        }
        if (userPermission.blocked_until) {
            const blockTimeMs = new Date(userPermission.blocked_until + 'Z').getTime();
            if (blockTimeMs > nowMs) {
                return { success: false, message: "המספר שלך חסום זמנית משליחת צינתוקים." };
            }
        }
    }

    // 2. בדיקה האם הועלה קובץ ב-2 דקות האחרונות
    const latestUpload = await db.prepare(
        `SELECT id, upload_time, tzintuk_sent FROM upload_events WHERE phone = ? ORDER BY upload_time DESC LIMIT 1`
    ).bind(phone).first();

    if (!latestUpload) {
        return { success: false, message: "לא נמצאה העלאת הודעה. יש להעלות הודעה כדי לשלוח צינתוק." };
    }
    if (latestUpload.tzintuk_sent === 1) {
        return { success: false, message: "כבר נשלח צינתוק על ההודעה האחרונה שהעלית." };
    }

    const uploadTimeMs = new Date(latestUpload.upload_time + 'Z').getTime();
    const timeSinceUploadMinutes = (nowMs - uploadTimeMs) / (1000 * 60);

    if (timeSinceUploadMinutes > UPLOAD_WINDOW_MINUTES) {
        return { success: false, message: `עבר הזמן המותר לצינתוק. חלפו יותר מ-${UPLOAD_WINDOW_MINUTES} דקות מההעלאה.` };
    }

    // 3. מניעת ספאם (5 דקות) מול הטבלה ומול ימות המשיח
    const lastInternalLog = await db.prepare(
        `SELECT sent_time FROM tzintuk_logs WHERE phone = ? ORDER BY sent_time DESC LIMIT 1`
    ).bind(phone).first();

    if (lastInternalLog) {
        const lastSentMs = new Date(lastInternalLog.sent_time + 'Z').getTime();
        if ((nowMs - lastSentMs) < (TZINTUK_COOLDOWN_MINUTES * 60 * 1000)) {
            return { success: false, message: `אנא המתן. ניתן לשלוח צינתוק רק כל ${TZINTUK_COOLDOWN_MINUTES} דקות.` };
        }
    }

    const recentlySentInYemot = await checkYemotLogs(phone, yemotToken);
    if (recentlySentInYemot) {
        return { success: false, message: `הפעלת צינתוק דרך הטלפון לאחרונה. אנא המתן ${TZINTUK_COOLDOWN_MINUTES} דקות.` };
    }

    // 4. שליחת הצינתוק בפועל
    const callerId = "0775282936"; // המזהה שביקשת
    const sendUrl = `https://www.call2all.co.il/ym/api/RunTzintuk?token=${yemotToken}&callerId=${callerId}&TzintukTimeOut=16&phones=tzl:members&sayInfoOnAnswer=true`;
    
    try {
        const tzintukRes = await fetch(sendUrl);
        const tzintukData = await tzintukRes.json();

        if (tzintukData.responseStatus === "OK") {
            // עדכון שהצינתוק בוצע + הוספת לוג פנימי
            await db.batch([
                db.prepare(`UPDATE upload_events SET tzintuk_sent = 1 WHERE id = ?`).bind(latestUpload.id),
                db.prepare(`INSERT INTO tzintuk_logs (phone, sent_time) VALUES (?, CURRENT_TIMESTAMP)`).bind(phone)
            ]);

            return { success: true, message: "הצינתוק נשלח למנויים בהצלחה!" };
        } else {
            return { success: false, message: "שגיאה בשרת ימות המשיח בעת שליחת הצינתוק.", details: tzintukData };
        }
    } catch (error) {
        return { success: false, message: "שגיאת תקשורת פנימית בעת ניסיון הצינתוק." };
    }
}
