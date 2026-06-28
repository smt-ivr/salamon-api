// messages.js
import { checkPhoneStatus, getNameFromIni } from './yemot.js';
import { authenticateUser } from './auth.js'; 
import { getIsraelTimeForDB } from './timeUtils.js';

// 1. קבלת רשימת הקבצים + שליפת שם המקליט מתוך קובץ ה-TXT (עם תמיכה בטעינת קבצים נוספים)
export async function handleGetMessages(request, env) {
    const body = await request.json();
    // קבלת פרמטר page. אם לא צורף, ערך ברירת המחדל יהיה 1 (הדף הראשון)
    const { userToken, filesLimit = 40, page = 1 } = body; 

    // חישוב הדילוג (offset) על בסיס מספר הדף
    const filesFrom = (page - 1) * filesLimit;

    const FOLDER_PATH = 'ivr2:/1/2'; 

    if (!userToken) return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
    
    // שינוי לאימות חכם תואם טוקנים וסיסמאות
    const user = await authenticateUser(env.DB, userToken);
    if (!user) return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });

    const token = env.YEMOT_TOKEN;
    // שליחת filesLimit ו-filesFrom (שחושב מהדף) ל-URL של ימות המשיח
    const url = `https://www.call2all.co.il/ym/api/GetIVR2Dir?token=${token}&path=${encodeURIComponent(FOLDER_PATH)}&filesLimit=${filesLimit}&filesFrom=${filesFrom}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.responseStatus !== 'OK') {
            return Response.json({ error: "שגיאה בקבלת נתונים מימות המשיח" }, { status: 400 });
        }

        const rawMessages = (data.files || []).filter(file => {
            if (file.fileType !== 'AUDIO') return false;
            return /^\d+\.(wav|mp3)$/i.test(file.name);
        });

        const messages = await Promise.all(rawMessages.map(async (file) => {
            const fileId = file.name.split('.')[0]; 
            const txtUrl = `https://www.call2all.co.il/ym/api/GetTextFile?token=${token}&what=${encodeURIComponent(FOLDER_PATH + '/' + fileId + '.txt')}`;
            
            let recorderName = "";
            let recorderPhone = ""; 
            let fromWebType = false; // false = phone, 'record' = web record, 'file' = web file upload

            try {
                const txtRes = await fetch(txtUrl);
                if (txtRes.ok) {
                    const txtData = await txtRes.json();
                    if (txtData.responseStatus === 'OK' && txtData.contents) {
                        if (txtData.contents.includes('Phone-')) {
                            recorderPhone = txtData.contents.split('Phone-')[1].split('-')[0].trim();
                        }
                        if (txtData.contents.includes('ValName-')) {
                            recorderName = txtData.contents.split('ValName-')[1].trim();
                            
                            // זיהוי מקור ההודעה לפי התגיות
                            if (recorderName.includes('[WEB_FILE]')) {
                                fromWebType = 'file';
                                recorderName = recorderName.replace('[WEB_FILE]', '').trim();
                            } else if (recorderName.includes('[WEB_REC]')) {
                                fromWebType = 'record';
                                recorderName = recorderName.replace('[WEB_REC]', '').trim();
                            } else if (recorderName.includes('[WEB]')) { 
                                fromWebType = 'record'; // תאימות למודל הקודם
                                recorderName = recorderName.replace('[WEB]', '').trim();
                            } else if (recorderName.includes('(דרך האתר)')) { 
                                fromWebType = 'record'; // תאימות למודל הישן ביותר
                                recorderName = recorderName.replace('(דרך האתר)', '').trim();
                            }

                        } else if (recorderPhone) {
                            recorderName = recorderPhone;
                        }
                    }
                }
            } catch (e) {}

            const isOutgoing = !!(user.phone && (recorderPhone === user.phone || file.phone === user.phone));

            return {
                name: file.name, 
                size: file.size,
                durationStr: file.durationStr,
                mtime: file.mtime,
                valName: recorderName || file.phone || "מערכת / לא מזוהה",
                isOutgoing: isOutgoing,
                fromWebType: fromWebType // העברת סוג המקור ללקוח
            };
        }));

        return Response.json({ success: true, messages });
    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת קריאת התיקייה" }, { status: 500 });
    }
}

// 2. הזרמת הקובץ לנגן והוספת מונה האזנות ברקע
export async function handleStreamMessage(request, env, ctx) {
    const url = new URL(request.url);
    const userToken = url.searchParams.get('userToken');
    const fileId = url.searchParams.get('fileId'); 

    if (!userToken || !fileId) {
        return new Response("חסרים פרמטרים חסויים", { status: 400 });
    }

    if (!/^\d+$/.test(fileId)) {
        return new Response("שגיאה: מזהה קובץ לא חוקי. מותרים מספרים בלבד.", { status: 403 });
    }

    const filePath = `ivr2:/1/2/${fileId}.wav`;
    const fileName = `${fileId}.wav`;

    // שינוי לאימות חכם תואם טוקנים וסיסמאות
    const user = await authenticateUser(env.DB, userToken);
    if (!user) {
        return new Response("גישה נדחתה: משתמש לא מורשה", { status: 403 });
    }

    // =====================================================================
    // רישום האזנה ברקע (מקבילי) - לא מעכב את תחילת ניגון השמע
    // =====================================================================
    const nowIsraelStr = getIsraelTimeForDB();
    const logPromise = env.DB.prepare(
        `INSERT OR IGNORE INTO message_listens (file_id, phone, listened_at) VALUES (?, ?, ?)`
    ).bind(fileId.toString(), user.phone, nowIsraelStr).run().catch(err => console.error("DB Log Error:", err));
    
    if (ctx && ctx.waitUntil) {
        ctx.waitUntil(logPromise);
    }
    // =====================================================================

    const token = env.YEMOT_TOKEN;
    const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(filePath)}`;

    try {
        const response = await fetch(downloadUrl);
        const contentTypeHeader = response.headers.get('content-type') || '';
        
        if (contentTypeHeader.includes('text') || contentTypeHeader.includes('json')) {
            const text = await response.text();
            if (text.includes("Requested file does not exist")) {
                return new Response("הקובץ המבוקש לא קיים", { status: 404 });
            }
            return new Response("שגיאה ממערכת התקשורת: " + text, { status: 400 });
        }

        if (!response.ok || !response.body) {
            return new Response("שגיאה במשיכת הקובץ מהשרת החיצוני", { status: response.status });
        }

        const totalLength = parseInt(response.headers.get('Content-Length') || '0', 10);
        const rangeHeader = request.headers.get('Range');
        
        let start = 0;
        let end = totalLength - 1;
        let isRangeRequest = false;

        if (rangeHeader && totalLength > 0) {
            const parts = rangeHeader.replace(/bytes=/, "").split("-");
            start = parseInt(parts[0], 10);
            if (parts[1]) {
                end = parseInt(parts[1], 10);
            }
            isRangeRequest = true;

            if (start >= totalLength || end >= totalLength || start > end) {
                return new Response("Requested Range Not Satisfiable", {
                    status: 416,
                    headers: { "Content-Range": `bytes */${totalLength}` }
                });
            }
        }

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const reader = response.body.getReader();

        (async () => {
            let bytesRead = 0;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunkStart = bytesRead;
                    const chunkEnd = bytesRead + value.length - 1;
                    bytesRead += value.length;

                    if (chunkEnd >= start && chunkStart <= end) {
                        const sliceStart = Math.max(0, start - chunkStart);
                        const sliceEnd = Math.min(value.length, end - chunkStart + 1);
                        await writer.write(value.subarray(sliceStart, sliceEnd));
                    }

                    if (bytesRead > end) {
                        await reader.cancel(); 
                        break;
                    }
                }
            } catch (err) {
                console.error("Streaming pump error:", err);
            } finally {
                await writer.close();
            }
        })();

        const responseHeaders = new Headers();
        responseHeaders.set('Content-Type', 'audio/wav');
        responseHeaders.set('Content-Disposition', `inline; filename="${fileName}"`);
        responseHeaders.set('Accept-Ranges', 'bytes');

        if (isRangeRequest) {
            responseHeaders.set('Content-Range', `bytes ${start}-${end}/${totalLength}`);
            responseHeaders.set('Content-Length', (end - start + 1).toString());
            return new Response(readable, { status: 206, headers: responseHeaders });
        } else {
            if (totalLength > 0) responseHeaders.set('Content-Length', totalLength.toString());
            return new Response(readable, { status: 200, headers: responseHeaders });
        }

    } catch (error) {
        console.error(error);
        return new Response("שגיאת שרת פנימית בעת עיבוד הקובץ", { status: 500 });
    }
}
