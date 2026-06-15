// upload.js
import { getNameFromIni } from './yemot.js';

export async function handleUploadMessage(request, env) {
    try {
        // קבלת ה-FormData שנשלח מהדפדפן
        const formData = await request.formData();
        const userToken = formData.get('userToken');
        const file = formData.get('file'); // קובץ האודיו מהמיקרופון/מחשב

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

        // ==========================================
        // 1. העלאת קובץ השמע 
        // ==========================================
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
        // שלב 2: קריאת ה-TXT הקיים, ניקויו והעלאתו מחדש
        // ==========================================
        let txtSuccess = false;
        let txtDetails = null;

        if (data.path) {
            // המרת נתיב מ-WAV ל-TXT (למשל ivr2:/1/2/3654.txt)
            const txtPath = data.path.replace(/^ivr\//, 'ivr2:/').replace(/\.wav$/, '.txt');
            
            // 2.1 קריאת קובץ הטקסט הקיים שימות המשיח יצרה עכשיו (עם התאריך, IP וה-title)
            const getTxtUrl = `https://www.call2all.co.il/ym/api/GetTextFile?token=${token}&what=${encodeURIComponent(txtPath)}`;
            let existingText = "";
            
            try {
                const getTxtRes = await fetch(getTxtUrl);
                if (getTxtRes.ok) {
                    const getTxtData = await getTxtRes.json();
                    if (getTxtData.responseStatus === 'OK' && getTxtData.contents) {
                        existingText = getTxtData.contents;
                    }
                }
            } catch (e) {
                // נתעלם במקרה של שגיאה בקריאה
            }

            // 2.2 הכנת פרטי המשתמש והתוספת "(דרך האתר)"
            const userName = await getNameFromIni(user.phone, token);
            const displayName = userName ? `${userName} (דרך האתר)` : `משתמש אתר (דרך האתר)`;

            // 2.3 בניית הטקסט החדש תוך זריקת שורת ה-title והוספת הפרטים לשורה הראשונה
            let finalTxtContents = "";
            
            if (existingText) {
                // מפצלים לשורות
                const lines = existingText.split('\n');
                
                // לוקחים *רק* את השורה הראשונה (מתעלמים משאר השורות כמו title=)
                // ומוסיפים בסופה את הטלפון והשם עם מינוס מפריד
                finalTxtContents = lines[0].trim() + `-Phone-${user.phone}-ValName-${displayName}`;
            } else {
                // מקרה חירום (אם ה-Get נכשל) ניצור מחרוזת בסיסית תקנית
                finalTxtContents = `API-Date-${new Date().toISOString().split('T')[0]}-Phone-${user.phone}-ValName-${displayName}`;
            }

            // 2.4 העלאת הטקסט המעודכן חזרה לימות המשיח
            const txtFormData = new FormData();
            txtFormData.append('token', token);
            txtFormData.append('what', txtPath);
            txtFormData.append('contents', finalTxtContents);

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

        // החזרת התשובה הסופית ללקוח
        return Response.json({ 
            success: true, 
            message: "הקובץ הועלה והטקסט עודכן בהצלחה", 
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
