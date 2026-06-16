// tzintuk.js

// משתנים הניתנים לשינוי בקלות (הוגדר לפי בקשתך)
const UPLOAD_WINDOW_MINUTES = 2; // זכות שליחת צינתוק עד 2 דקות מהעלאה
const TZINTUK_COOLDOWN_MINUTES = 5; // חסימת צינתוקים תכופים (מרווח של 5 דקות)

/**
 * פונקציית עזר להמרת התאריך של ימות המשיח לזמן מילישניות (כדי להשוות זמנים)
 */
function parseYemotTime(dateStr, timeStr) {
    const [day, month, year] = dateStr.split('/');
    const [hour, minute, second] = timeStr.split(':');
    // יוצר אובייקט זמן - שים לב שזה מתבסס על כך שהזמן מקומי
    return new Date(year, month - 1, day, hour, minute, second).getTime();
}

/**
 * פונקציית עזר לקבלת הזמן הנוכחי בישראל (כדי לא להיות תלויים באזור הזמן של השרת)
 */
function getNowIsraelMs() {
    const nowStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" });
    return new Date(nowStr).getTime();
}

/**
 * 1. בדיקה בלוגים של ימות המשיח אם נשלח צינתוק לאחרונה
 */
async function checkYemotLogs(phone, token) {
    const url = `https://www.call2all.co.il/ym/api/TzintukimListManagement?token=${token}&action=getLogList&TzintukimList=members`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.responseStatus !== "OK") {
            console.error("Yemot API error fetching logs:", data);
            return false; // במקרה של שגיאה נאפשר (או שתחליט לחסום)
        }

        const nowMs = getNowIsraelMs();
        const cooldownMs = TZINTUK_COOLDOWN_MINUTES * 60 * 1000;

        // חיפוש בלוג: האם יש פעולת RunTzintuk שבוצעה על ידי המספר הזה בחלון הזמן?
        const recentTzintuk = data.events.find(event => {
            if (event.TypeOperation !== "RunTzintuk") return false;
            // אם במערכת של ימות הטלפון נרשם לפעמים בלי אפס או עם קידומת, כדאי לוודא התאמה מלאה
            if (event.Phone !== phone) return false; 
            
            const eventTimeMs = parseYemotTime(event.Date, event.Time);
            return (nowMs - eventTimeMs) < cooldownMs;
        });

        return !!recentTzintuk; // יחזיר true אם עשה צינתוק לאחרונה, אחרת false
    } catch (error) {
        console.error("Failed to check Yemot logs", error);
        return false;
    }
}

/**
 * 2. הפונקציה המרכזית: בדיקת כל התנאים ושליחת הצינתוק
 */
export async function processTzintukRequest(env, phone, yemotToken) {
    const db = env.DB; // החיבור למסד הנתונים D1 שלך

    // --- בדיקה 1: הרשאות משתמש (האם חסום?) ---
    const userPermission = await db.prepare(
        `SELECT is_blocked, blocked_until FROM tzintuk_permissions WHERE phone = ?`
    ).bind(phone).first();

    if (userPermission) {
        if (userPermission.is_blocked === 1) {
            return { success: false, message: "המשתמש חסום לצמיתות משליחת צינתוקים." };
        }
        if (userPermission.blocked_until && new Date(userPermission.blocked_until) > new Date()) {
            return { success: false, message: "המשתמש חסום זמנית משליחת צינתוקים." };
        }
    }

    // --- בדיקה 2: האם העלה קובץ ב-2 דקות האחרונות והאם כבר שלח? ---
    const latestUpload = await db.prepare(
        `SELECT id, upload_time, tzintuk_sent FROM upload_events 
         WHERE phone = ? ORDER BY upload_time DESC LIMIT 1`
    ).bind(phone).first();

    if (!latestUpload) {
        return { success: false, message: "לא נמצאה העלאת קובץ למשתמש זה." };
    }

    if (latestUpload.tzintuk_sent === 1) {
        return { success: false, message: "כבר נשלח צינתוק עבור הודעה זו." };
    }

    const uploadTimeMs = new Date(`${latestUpload.upload_time}Z`).getTime();
    const nowMs = Date.now();
    const timeSinceUploadMinutes = (nowMs - uploadTimeMs) / (1000 * 60);

    if (timeSinceUploadMinutes > UPLOAD_WINDOW_MINUTES) {
        return { success: false, message: `עבר הזמן המותר לשליחת צינתוק. חלפו ${timeSinceUploadMinutes.toFixed(1)} דקות (המקסימום הוא ${UPLOAD_WINDOW_MINUTES}).` };
    }

    // --- בדיקה 3: קירור (Cooldown) - האם שלח ב-5 דקות האחרונות? ---
    
    // בדיקה פנימית בטבלה שלנו (כדי לחסוך קריאות API אם שלח דרך האתר לאחרונה)
    const lastInternalLog = await db.prepare(
        `SELECT sent_time FROM tzintuk_logs WHERE phone = ? ORDER BY sent_time DESC LIMIT 1`
    ).bind(phone).first();

    if (lastInternalLog) {
        const lastSentMs = new Date(`${lastInternalLog.sent_time}Z`).getTime();
        if ((nowMs - lastSentMs) < (TZINTUK_COOLDOWN_MINUTES * 60 * 1000)) {
            return { success: false, message: `יש להמתין ${TZINTUK_COOLDOWN_MINUTES} דקות בין צינתוק לצינתוק.` };
        }
    }

    // בדיקה מול הלוגים של ימות המשיח (במידה ושלח דרך הטלפון)
    const recentlySentInYemot = await checkYemotLogs(phone, yemotToken);
    if (recentlySentInYemot) {
        return { success: false, message: `הפעלת צינתוק דרך הטלפון לאחרונה. יש להמתין ${TZINTUK_COOLDOWN_MINUTES} דקות.` };
    }

    // --- הכל תקין! שולחים את הצינתוק ---
    const sendUrl = `https://www.call2all.co.il/ym/api/RunTzintuk?token=${yemotToken}&callerId=0775282936&TzintukTimeOut=16&phones=tzl:members&sayInfoOnAnswer=true`;
    
    try {
        const tzintukRes = await fetch(sendUrl);
        const tzintukData = await tzintukRes.json();

        if (tzintukData.responseStatus === "OK") {
            // מעדכנים בטבלה שהצינתוק נשלח עבור העלאה זו
            await db.prepare(
                `UPDATE upload_events SET tzintuk_sent = 1 WHERE id = ?`
            ).bind(latestUpload.id).run();

            // רושמים בלוג הפנימי את הצינתוק
            await db.prepare(
                `INSERT INTO tzintuk_logs (phone) VALUES (?)`
            ).bind(phone).run();

            return { success: true, message: "הצינתוק נשלח בהצלחה!", details: tzintukData };
        } else {
            return { success: false, message: "שגיאה בשליחת הצינתוק דרך ימות המשיח.", details: tzintukData };
        }
    } catch (error) {
        console.error("Error sending tzintuk:", error);
        return { success: false, message: "שגיאת רשת פנימית בעת נסיון השליחה." };
    }
}
