// messages.js

// 1. קבלת רשימת הקבצים (מסוננת למספרים בלבד)
export async function handleGetMessages(request, env) {
    const body = await request.json();
    const { userToken, path = 'ivr2:/1/2' } = body; // ברירת מחדל לשלוחה שציינת

    // אימות משתמש מול המסד
    if (!userToken) return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
    const [identifier, password] = userToken.split(':');
    const user = await env.DB.prepare("SELECT 1 FROM users WHERE (phone = ? OR email = ?) AND password = ?").bind(identifier, identifier, password).first();
    if (!user) return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });

    const token = env.YEMOT_TOKEN;
    const url = `https://www.call2all.co.il/ym/api/GetIVR2Dir?token=${token}&path=${encodeURIComponent(path)}&filesLimit=100`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.responseStatus !== 'OK') {
            return Response.json({ error: "שגיאה בקבלת נתונים מימות המשיח" }, { status: 400 });
        }

        // סינון קבצים: רק קבצי שמע ששמם מורכב מספרות בלבד
        const messages = (data.files || []).filter(file => {
            if (file.fileType !== 'AUDIO') return false;
            // בודק שהשם מתחיל ומסתיים במספרים בלבד לפני הסיומת
            return /^\d+\.(wav|mp3)$/i.test(file.name);
        }).map(file => {
            // תיקון הנתיב: נוודא שהוא מתחיל ב-ivr2:/
            let fullPath = file.path;
            if (!fullPath.startsWith('ivr2:')) {
                fullPath = fullPath.startsWith('/') ? `ivr2:${fullPath}` : `ivr2:/${fullPath}`;
            }

            return {
                name: file.name,
                size: file.size,
                durationStr: file.durationStr,
                mtime: file.mtime,
                path: fullPath
            };
        });

        return Response.json({ success: true, messages });
    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת קריאת התיקייה" }, { status: 500 });
    }
}

// 2. הזרמת הקובץ לנגן (כולל תמיכה מלאה בדילוג - Range Requests)
export async function handleStreamMessage(request, env) {
    const url = new URL(request.url);
    const userToken = url.searchParams.get('userToken');
    let filePath = url.searchParams.get('path'); 

    if (!userToken || !filePath) {
        return new Response("חסרים פרמטרים חסויים", { status: 400 });
    }

    // אימות משתמש גם בהזרמת הקובץ
    const [identifier, password] = userToken.split(':');
    const user = await env.DB.prepare("SELECT 1 FROM users WHERE (phone = ? OR email = ?) AND password = ?").bind(identifier, identifier, password).first();
    if (!user) {
        return new Response("גישה נדחתה: משתמש לא מורשה", { status: 403 });
    }

    // אבטחה נוספת: מניעת הורדת קבצי מערכת גם אם מישהו מנסה לעקוף את הסינון
    const fileName = filePath.split('/').pop();
    if (!/^\d+\.(wav|mp3)$/i.test(fileName)) {
        return new Response("שגיאה: ניתן להאזין לקבצי הודעות בלבד ולא לקבצי מערכת", { status: 403 });
    }

    // וידוא אחרון שהנתיב תקין עבור ימות המשיח
    if (!filePath.startsWith('ivr2:')) {
        filePath = filePath.startsWith('/') ? `ivr2:${filePath}` : `ivr2:/${filePath}`;
    }

    const token = env.YEMOT_TOKEN;
    const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(filePath)}`;

    try {
        // הכנת הבקשה לימות המשיח - אם הדפדפן מבקש לדלג, אנחנו שואבים את הבקשה ומעבירים הלאה
        const fetchOptions = { headers: {} };
        const rangeHeader = request.headers.get('Range');
        if (rangeHeader) {
            fetchOptions.headers['Range'] = rangeHeader;
        }

        const response = await fetch(downloadUrl, fetchOptions);
        const contentTypeHeader = response.headers.get('content-type') || '';
        
        // בדיקת שגיאות מימות המשיח (למקרה של קובץ לא קיים)
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

        const ext = fileName.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';

        // בניית כותרות התשובה עבור הדפדפן
        const responseHeaders = new Headers();
        responseHeaders.set('Content-Type', ext);
        responseHeaders.set('Content-Disposition', `inline; filename="${fileName}"`);
        
        // הכותרת הכי חשובה: אומרת לנגן בדפדפן "אני תומך בדילוגים!"
        responseHeaders.set('Accept-Ranges', 'bytes');

        // אם ימות המשיח החזירו את גודל הקובץ, אנחנו מעבירים אותו לדפדפן כדי שיידע מה אורך הפס
        const contentLength = response.headers.get('Content-Length');
        if (contentLength) responseHeaders.set('Content-Length', contentLength);

        // אם בוצע דילוג, ימות יחזירו Content-Range - נעביר גם אותו
        const contentRange = response.headers.get('Content-Range');
        if (contentRange) responseHeaders.set('Content-Range', contentRange);

        // אם הדפדפן ביקש חיתוך (Range) וימות אישרו, הסטטוס יהיה 206 (Partial Content). אחרת 200 רגיל.
        const status = response.status === 206 ? 206 : 200;

        return new Response(response.body, {
            status: status,
            headers: responseHeaders
        });

    } catch (error) {
        return new Response("שגיאת שרת פנימית בעת משיכת הקובץ: " + error.message, { status: 500 });
    }
}
