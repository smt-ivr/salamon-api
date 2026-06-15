// upload.js
import { getNameFromIni } from './yemot.js';

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

        // בדיקת ההרשאה המיוחדת
        if (!user.can_upload) {
            return Response.json({ error: "אין לחשבון זה הרשאה להעלות הודעות במערכת" }, { status: 403 });
        }

        const token = env.YEMOT_TOKEN;
        const FOLDER_PATH = 'ivr2:/1/2';

        // 1. בניית בקשת Multipart והעלאת קובץ השמע (זהה לחלוטין למה שעבד)
        const yemotFormData = new FormData();
        yemotFormData.append('token', token);
        yemotFormData.append('path', FOLDER_PATH);
        yemotFormData.append('convertAudio', '1');
        yemotFormData.append('autoNumbering', '1');
        yemotFormData.append('file', file);

        const uploadUrl = 'https://www.call2all.co.il/ym/api/UploadFile';
        const yemotResponse = await fetch(uploadUrl, {
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

        // ==========================================
        // שלב 2 החדש: יצירת קובץ ה-TXT המלווה באופן אוטומטי
        // ==========================================
        let txtSuccess = false;
        let txtDetails = null;

        if (data.path) {
            // המרת הנתיב שהתקבל מימות (לדוגמה ivr/1/2/3654.wav) לפורמט טקסט מלא (ivr2:/1/2/3654.txt)
            const txtPath = data.path.replace(/^ivr\//, 'ivr2:/').replace(/\.wav$/, '.txt');
            
            // שליפת שם המשתמש מקובץ ה-INI כדי לעדכן אותו בפנים
            const userName = await getNameFromIni(user.phone, token);
            const displayName = userName || "משתמש אתר";

            // בניית מחרוזת התוכן המדויקת שמציינת שזה הועלה מהאתר, ומכילה את הטלפון והשם
            // הפורמט הזה תואם ב-100% ללוגיקת החילוץ הקיימת ב-messages.js (מפצל לפי Phone- ו-ValName-)
            const txtContents = `WEB-Phone-${user.phone}-ValName-${displayName}`;

            // יצירת בקשת FormData ייעודית עבור פקודת UploadTextFile
            const txtFormData = new FormData();
            txtFormData.append('token', token);
            txtFormData.append('what', txtPath);
            txtFormData.append('contents', txtContents);

            const txtUrl = 'https://www.call2all.co.il/ym/api/UploadTextFile';
            const txtResponse = await fetch(txtUrl, {
                method: 'POST',
                body: txtFormData
            });

            txtDetails = await txtResponse.json();
            if (txtDetails.responseStatus === 'OK') {
                txtSuccess = true;
            }
        }

        // החזרת תשובה משולבת הכוללת את נתוני קובץ האודיו ואישור על יצירת ה-TXT
        return Response.json({ 
            success: true, 
            message: "הקובץ והטקסט המלווה הועלו בהצלחה למערכת הטלפונית", 
            yemotResponse: data,
            txtUploaded: txtSuccess,
            txtDetails: txtDetails
        });

    } catch (error) {
        return Response.json({ 
            error: "שגיאת שרת פנימית בעת ניסיון העלאת הקובץ והטקסט", 
            details: error.message 
        }, { status: 500 });
    }
}
