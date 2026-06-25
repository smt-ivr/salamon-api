// delete.js
import { getMinutesSinceIsraelDbTime, getIsraelTimeForDB } from './timeUtils.js';
import { authenticateUser } from './auth.js';

const DELETE_WINDOW_HOURS = 12; 
const FOLDER_PATH = 'ivr2:/1/2'; 

async function checkEligibility(db, phone, fileName) {
    if (!fileName || !fileName.match(/^\d+\.wav$/)) {
        return { allowed: false, message: "שם קובץ לא חוקי. ניתן למחוק קבצי שמע מסוג מספרי בלבד." };
    }

    const anyUpload = await db.prepare(
        `SELECT phone FROM upload_events WHERE file_name = ?`
    ).bind(fileName).first();

    if (!anyUpload) {
        return { 
            allowed: false, 
            message: "לא ניתן למחוק. ההודעה הוקלטה דרך הטלפון או לפני שדרוג המערכת." 
        };
    }

    if (anyUpload.phone !== phone) {
        return { 
            allowed: false, 
            message: "פעולה חסומה! אינך מורשה למחוק הודעה שהועלתה על ידי משתמש אחר." 
        };
    }

    const uploadRecord = await db.prepare(
        `SELECT upload_time, tzintuk_sent FROM upload_events WHERE phone = ? AND file_name = ?`
    ).bind(phone, fileName).first();

    if (uploadRecord.tzintuk_sent === 1) {
        return { allowed: false, message: " לא ניתן למחוק הודעה שנשלחה עליה צינתוק" };
    }

    const minutesPassed = getMinutesSinceIsraelDbTime(uploadRecord.upload_time);
    if (minutesPassed > (DELETE_WINDOW_HOURS * 60) || minutesPassed < 0) {
        return { allowed: false, message: `לא ניתן למחוק הודעה שהוקלטה לפני יותר מ ${DELETE_WINDOW_HOURS} שעות.` };
    }

    return { allowed: true };
}

export async function handleCheckDeleteEligibility(request, env) {
    const body = await request.json();
    const userToken = body.userToken;
    const fileName = body.fileName;

    // שינוי לאימות חכם תואם טוקנים וסיסמאות
    const user = await authenticateUser(env.DB, userToken);
    if (!user) return Response.json({ success: false, message: "אימות נכשל, התחבר מחדש." }, { status: 403 });

    const eligibility = await checkEligibility(env.DB, user.phone, fileName);
    return Response.json({ success: eligibility.allowed, message: eligibility.message });
}

export async function handleDeleteMessage(request, env, userIp) {
    const body = await request.json();
    const userToken = body.userToken;
    const fileName = body.fileName;

    // שינוי לאימות חכם תואם טוקנים וסיסמאות
    const user = await authenticateUser(env.DB, userToken);
    if (!user) return Response.json({ success: false, message: "אימות נכשל" }, { status: 403 });

    const eligibility = await checkEligibility(env.DB, user.phone, fileName);
    if (!eligibility.allowed) {
        return Response.json({ success: false, message: eligibility.message });
    }

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

    if (yemotDeleted) {
        try {
            const currentTimeIsrael = getIsraelTimeForDB();
            const safeIp = userIp || '0.0.0.0';

            await env.DB.batch([
                env.DB.prepare(`DELETE FROM upload_events WHERE phone = ? AND file_name = ?`).bind(user.phone, fileName),
                env.DB.prepare(`INSERT INTO delete_logs (phone, ip_address, file_name, deleted_at) VALUES (?, ?, ?, ?)`).bind(user.phone, safeIp, fileName, currentTimeIsrael)
            ]);
            
            return Response.json({ success: true, message: "ההודעה נמחקה בהצלחה." });
        } catch (dbErr) {
            console.error("DB Log Error: ", dbErr);
            return Response.json({ 
                success: true, 
                message: `ההודעה נמחקה, אך אירעה שגיאת SQL ברישום הלוג: ${dbErr.message}` 
            });
        }
    }
}
