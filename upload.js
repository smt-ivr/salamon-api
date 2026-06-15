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
        // שלב 2: בניית קובץ TXT בפורמט זהה להקלטה טלפונית
        // ==========================================
        let txtSuccess = false;
        let txtDetails = null;

        if (data.path) {
            // המרת נתיב מ-WAV ל-TXT
            const txtPath = data.path.replace(/^ivr\//, 'ivr2:/').replace(/\.wav$/, '.txt');
            
            // 2.1 קריאת קובץ הטקסט הקיים שימות המשיח יצרה כדי לחלץ את התאריך וה-DID
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

            // 2.2 שליפת השם והוספת "(דרך האתר)"
            const userName = await getNameFromIni(user.phone, token);
            const displayName = userName ? `${userName} (דרך האתר)` : `משתמש אתר (דרך האתר)`;

            // 2.3 חילוץ נתונים לצורך הרכבת המחרוזת מחדש
            let did = "0733517857"; // ערך ברירת מחדל ל-DID
            let recDate = "";
            
            // חילוץ תאריך ו-DID מתוך הטקסט שימות יצרה אוטומטית (אם קיים)
            if (existingText) {
                const didMatch = existingText.match(/DID-(\d+)/);
                if (didMatch) did = didMatch[1];
                
                const dateMatch = existingText.match(/Date-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})/);
                if (dateMatch) recDate = dateMatch[1];
            }

            // אם מאיזושהי סיבה אין תאריך, ניצור אחד עכשווי באותו פורמט
            if (!recDate) {
                const now = new Date();
                const pad = (n) => n.toString().padStart(2, '0');
                recDate = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
            }

            // חילוץ מספר הקובץ והתיקייה מתוך נתיב ההעלאה שחזר (למשל 'ivr/1/2/3654.wav')
            const pathParts = data.path.split('/');
            const fileName = pathParts.pop().replace('.wav', ''); // מוציא את '3654'
            const folderName = pathParts.pop() || '2'; // מוציא את '2' (התיקייה האחרונה בנתיב)

            // 2.4 בניית המחרוזת המושלמת בדיוק כמו בהקלטה מטלפון (תוך זריקת ה-IP וה-title לחלוטין)
            const finalTxtContents = `Record-CustomerDID-${did}-Phone-${user.phone}-Date-${recDate}-Folder-${folderName}-File-${fileName}-EnterIDType-phone-EnterID-${user.phone}-ValName-${displayName}`;

            // 2.5 העלאת הטקסט המעודכן לימות המשיח
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
            message: "הקובץ הועלה והטקסט עודכן בהצלחה בפורמט טלפוני", 
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
