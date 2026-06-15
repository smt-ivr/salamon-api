// messages.js

// 1. קבלת רשימת הקבצים + שליפת שם המקליט מתוך קובץ ה-TXT
export async function handleGetMessages(request, env) {
    const body = await request.json();
    const { userToken } = body; 

    const FOLDER_PATH = 'ivr2:/1/2'; 

    if (!userToken) return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
    const [identifier, password] = userToken.split(':');
    
    // שינוי: שולפים את ה-phone מהמסד כדי שיהיה זמין לנו להשוואה בהמשך
    const user = await env.DB.prepare("SELECT phone FROM users WHERE (phone = ? OR email = ?) AND password = ?").bind(identifier, identifier, password).first();
    if (!user) return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });

    const token = env.YEMOT_TOKEN;
    
    // הגבלנו ל-40 כדי לא לחרוג ממגבלת ה-50 בקשות של Cloudflare שעלולה לרסק את השרת
    const url = `https://www.call2all.co.il/ym/api/GetIVR2Dir?token=${token}&path=${encodeURIComponent(FOLDER_PATH)}&filesLimit=40`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.responseStatus !== 'OK') {
            return Response.json({ error: "שגיאה בקבלת נתונים מימות המשיח" }, { status: 400 });
        }

        // סינון קבצים: רק קבצי שמע ששמם מורכב מספרות בלבד
        const rawMessages = (data.files || []).filter(file => {
            if (file.fileType !== 'AUDIO') return false;
            return /^\d+\.(wav|mp3)$/i.test(file.name);
        });

        // מעבר על כל קובץ שמע ושליפת קובץ ה-TXT שלו (במקביל, לחיסכון בזמן)
        const messages = await Promise.all(rawMessages.map(async (file) => {
            const fileId = file.name.split('.')[0]; // שליפת המספר בלבד
            const txtUrl = `https://www.call2all.co.il/ym/api/GetTextFile?token=${token}&what=${encodeURIComponent(FOLDER_PATH + '/' + fileId + '.txt')}`;
            
            let recorderName = "";
            let recorderPhone = ""; // משתנה חדש לשמירת מספר הטלפון של ההודעה מה-TXT

            try {
                const txtRes = await fetch(txtUrl);
                if (txtRes.ok) {
                    const txtData = await txtRes.json();
                    if (txtData.responseStatus === 'OK' && txtData.contents) {
                        
                        // חילוץ מספר הטלפון מתוך הטקסט לצורך בדיקת הבעלות
                        if (txtData.contents.includes('Phone-')) {
                            recorderPhone = txtData.contents.split('Phone-')[1].split('-')[0].trim();
                        }

                        // חילוץ השם מתוך הטקסט (נשאר בדיוק לפי הלוגיקה המקורית שלך)
                        if (txtData.contents.includes('ValName-')) {
                            recorderName = txtData.contents.split('ValName-')[1].trim();
                        } else if (recorderPhone) {
                            // אם אין שם, ניקח את הטלפון כגיבוי
                            recorderName = recorderPhone;
                        }
                    }
                }
            } catch (e) {
                // מתעלמים משגיאות בקובץ הטקסט כדי לא להרוס את השמעת הקובץ עצמו
            }

            // בדיקה האם ההודעה שייכת למשתמש הנוכחי שמבצע את הבקשה
            const isOutgoing = !!(user.phone && (recorderPhone === user.phone || file.phone === user.phone));

            return {
                name: file.name, 
                size: file.size,
                durationStr: file.durationStr,
                mtime: file.mtime,
                valName: recorderName || file.phone || "מערכת / לא מזוהה", // שם המקליט שהוצאנו
                isOutgoing: isOutgoing // הפרמטר החדש שביקשת
            };
        }));

        return Response.json({ success: true, messages });
    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת קריאת התיקייה" }, { status: 500 });
    }
}

// 2. הזרמת הקובץ לנגן (תומך דילוג - Range, מאובטח מפני IDOR)
export async function handleStreamMessage(request, env) {
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

    const [identifier, password] = userToken.split(':');
    const user = await env.DB.prepare("SELECT 1 FROM users WHERE (phone = ? OR email = ?) AND password = ?").bind(identifier, identifier, password).first();
    if (!user) {
        return new Response("גישה נדחתה: משתמש לא מורשה", { status: 403 });
    }

    const token = env.YEMOT_TOKEN;
    const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(filePath)}`;

    try {
        const fetchOptions = { headers: {} };
        const rangeHeader = request.headers.get('Range');
        if (rangeHeader) {
            fetchOptions.headers['Range'] = rangeHeader;
        }

        const response = await fetch(downloadUrl, fetchOptions);
        const contentTypeHeader = response.headers.get('content-type') || '';
        
        if (contentTypeHeader.includes('text') || contentTypeHeader.includes('json')) {
            const text = await response.text();
            if (text.includes("Requested file does not exist")) {
                return new Response("הקובץ המבוקש לא קיים", { status: 404 });
            }
            return new Response("שגיאה ממערכת התקשורת: " + text, { status: 400 });
        }

        if (!response.ok) {
            return new Response("שגיאה במשיכת הקובץ מהשרת החיצוני", { status: response.status });
        }

        const ext = 'audio/wav';
        const responseHeaders = new Headers();
        responseHeaders.set('Content-Type', ext);
        responseHeaders.set('Content-Disposition', `inline; filename="${fileName}"`);
        responseHeaders.set('Accept-Ranges', 'bytes');

        const contentLength = response.headers.get('Content-Length');
        if (contentLength) responseHeaders.set('Content-Length', contentLength);

        const contentRange = response.headers.get('Content-Range');
        if (contentRange) responseHeaders.set('Content-Range', contentRange);

        const status = response.status === 206 ? 206 : 200;

        return new Response(response.body, { status: status, headers: responseHeaders });

    } catch (error) {
        return new Response("שגיאת שרת פנימית בעת משיכת הקובץ", { status: 500 });
    }
}
