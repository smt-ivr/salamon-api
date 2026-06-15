// upload.js

export async function handleUploadMessage(request, env) {
    try {
        // קבלת ה-FormData שנשלח מהדפדפן
        const formData = await request.formData();
        const userToken = formData.get('userToken');
        const file = formData.get('file'); // קובץ האודיו מהמיקרופון

        if (!userToken) {
            return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
        }
        if (!file) {
            return Response.json({ error: "חסר קובץ שמע להעלאה" }, { status: 400 });
        }

        // פירוק הטוקן ואימות המשתמש
        const [identifier, password] = userToken.split(':');
        const user = await env.DB.prepare(
            "SELECT phone, can_upload FROM users WHERE (phone = ? OR email = ?) AND password = ?"
        ).bind(identifier, identifier, password).first();

        if (!user) {
            return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });
        }

        // בדיקת ההרשאה המיוחדת שביקשת
        if (!user.can_upload) {
            return Response.json({ error: "אין לחשבון זה הרשאה להעלות הודעות במערכת" }, { status: 403 });
        }

        const token = env.YEMOT_TOKEN;
        const FOLDER_PATH = 'ivr2:/1/2';

        // בניית בקשת Multipart חדשה עבור ימות המשיח בדיוק לפי הדרישות שלך
        const yemotFormData = new FormData();
        yemotFormData.append('token', token);
        yemotFormData.append('path', FOLDER_PATH);
        yemotFormData.append('convertAudio', '1');
        yemotFormData.append('autoNumbering', '1');
        yemotFormData.append('file', file);

        // פנייה ב-HTTP POST אל השרתים של ימות המשיח
        const url = 'https://www.call2all.co.il/ym/api/UploadFile';
        const yemotResponse = await fetch(url, {
            method: 'POST',
            body: yemotFormData
        });

        const data = await yemotResponse.json();

        if (data.responseStatus !== 'OK') {
            return Response.json({ 
                error: "שגיאה בהעלאת הקובץ מצד ימות המשיח", 
                yemotDetails: data 
            }, { status: 400 });
        }

        // החזרת תשובה חיובית עם הפרטים שנתקבלו מימות (כמו שם הקובץ שנוצר אוטומטית)
        return Response.json({ 
            success: true, 
            message: "הקובץ הועלה בהצלחה למערכת הטלפונית", 
            yemotResponse: data 
        });

    } catch (error) {
        return Response.json({ 
            error: "שגיאת שרת פנימית בעת ניסיון העלאת הקובץ", 
            details: error.message 
        }, { status: 500 });
    }
}
