// messages.js

// 1. קבלת רשימת הקבצים (הנתיב עכשיו מאובטח ומוגדר בשרת בלבד)
export async function handleGetMessages(request, env) {
    const body = await request.json();
    const { userToken } = body; 

    // התיקייה קבועה בשרת - אף משתמש לא יכול לשנות אותה מבחוץ!
    const FOLDER_PATH = 'ivr2:/1/2'; 

    if (!userToken) return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
    const [identifier, password] = userToken.split(':');
    const user = await env.DB.prepare("SELECT 1 FROM users WHERE (phone = ? OR email = ?) AND password = ?").bind(identifier, identifier, password).first();
    if (!user) return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });

    const token = env.YEMOT_TOKEN;
    const url = `https://www.call2all.co.il/ym/api/GetIVR2Dir?token=${token}&path=${encodeURIComponent(FOLDER_PATH)}&filesLimit=100`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.responseStatus !== 'OK') {
            return Response.json({ error: "שגיאה בקבלת נתונים מימות המשיח" }, { status: 400 });
        }

        // סינון קבצים: רק קבצי שמע ששמם מורכב מספרות בלבד
        const messages = (data.files || []).filter(file => {
            if (file.fileType !== 'AUDIO') return false;
            return /^\d+\.(wav|mp3)$/i.test(file.name);
        }).map(file => {
            // שולחים ללקוח רק את הנתונים הנקיים, בלי נתיבים בכלל!
            return {
                name: file.name, // לדוגמה 3653.wav
                size: file.size,
                durationStr: file.durationStr,
                mtime: file.mtime
            };
        });

        return Response.json({ success: true, messages });
    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת קריאת התיקייה" }, { status: 500 });
    }
}

// 2. הזרמת הקובץ לנגן (מקבל רק מזהה קובץ במקום נתיב מלא)
export async function handleStreamMessage(request, env) {
    const url = new URL(request.url);
    const userToken = url.searchParams.get('userToken');
    const fileId = url.searchParams.get('fileId'); // מקבל רק את המספר, למשל 3653

    if (!userToken || !fileId) {
        return new Response("חסרים פרמטרים חסויים", { status: 400 });
    }

    // אבטחה חמורה: נוודא שקיבלנו *אך ורק* מספרים! (חוסם ניסיונות פריצה כמו ../../)
    if (!/^\d+$/.test(fileId)) {
        return new Response("שגיאה: מזהה קובץ לא חוקי. מותרים מספרים בלבד.", { status: 403 });
    }

    // השרת מרכיב את הנתיב המלא לבד! הלקוח לא יודע מאיפה זה נמשך.
    const filePath = `ivr2:/1/2/${fileId}.wav`;
    const fileName = `${fileId}.wav`;

    // אימות משתמש גם בהזרמת הקובץ
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
