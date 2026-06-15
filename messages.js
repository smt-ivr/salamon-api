// messages.js

// 1. קבלת רשימת הקבצים (מסוננת למספרים בלבד)
export async function handleGetMessages(request, env) {
    const body = await request.json();
    const { userToken, path = 'ivr2:/1/2' } = body; // ברירת מחדל לשלוחה שציינת, ניתן לשנות מהלקוח

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

        // סינון קבצים: רק קבצי שמע ששמם מורכב מספרות בלבד (ללא חלקי שם כמו M1452)
        const messages = (data.files || []).filter(file => {
            if (file.fileType !== 'AUDIO') return false;
            // ביטוי רגולרי: בודק שהשם מתחיל ומסתיים במספרים בלבד לפני הסיומת
            return /^\d+\.(wav|mp3)$/i.test(file.name);
        }).map(file => ({
            name: file.name,
            size: file.size,
            durationStr: file.durationStr,
            mtime: file.mtime,
            path: file.path
        }));

        return Response.json({ success: true, messages });
    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת קריאת התיקייה" }, { status: 500 });
    }
}

// 2. הזרמת הקובץ לנגן (כולל טיפול בשגיאת "קובץ לא קיים")
export async function handleStreamMessage(request, env) {
    const url = new URL(request.url);
    const userToken = url.searchParams.get('userToken');
    const filePath = url.searchParams.get('path'); // לדוגמה ivr2:/1/2/3652.wav

    if (!userToken || !filePath) {
        return new Response("חסרים פרמטרים חסויים", { status: 400 });
    }

    // אימות משתמש גם בהזרמת הקובץ
    const [identifier, password] = userToken.split(':');
    const user = await env.DB.prepare("SELECT 1 FROM users WHERE (phone = ? OR email = ?) AND password = ?").bind(identifier, identifier, password).first();
    if (!user) {
        return new Response("גישה נדחתה: משתמש לא מורשה", { status: 403 });
    }

    // אבטחה נוספת: מניעת הורדת קבצי מערכת גם אם מישהו מנסה לעקוף את הסינון בנתיב
    const fileName = filePath.split('/').pop();
    if (!/^\d+\.(wav|mp3)$/i.test(fileName)) {
        return new Response("שגיאה: ניתן להאזין לקבצי הודעות בלבד ולא לקבצי מערכת", { status: 403 });
    }

    const token = env.YEMOT_TOKEN;
    const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(filePath)}`;

    try {
        const response = await fetch(downloadUrl);
        const contentTypeHeader = response.headers.get('content-type') || '';
        
        // ימות המשיח לפעמים מחזירים שגיאה בטקסט רגיל במקום קובץ (אפילו עם קוד 200)
        // אם ה-Content-Type הוא לא אודיו אלא טקסט, נבדוק את התוכן
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

        return new Response(response.body, {
            headers: {
                'Content-Type': ext,
                'Content-Disposition': `inline; filename="${fileName}"`
            }
        });

    } catch (error) {
        return new Response("שגיאת שרת פנימית בעת משיכת הקובץ: " + error.message, { status: 500 });
    }
}
