// upload.js
import { getNameFromIni } from './yemot.js';

// פונקציית עזר פנימית לקבלת תאריך ושעה מדויקים בישראל עבור קובץ ה-TXT
function getIsraelDateStringForTxt() {
    const options = { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(new Date());
    const d = {};
    parts.forEach(({ type, value }) => { d[type] = value; });
    return `${d.year}-${d.month}-${d.day}-${d.hour}-${d.minute}-${d.second}`;
}

export async function handleUploadMessage(request, env) {
    try {
        const formData = await request.formData();
        const userToken = formData.get('userToken');
        const file = formData.get('file'); 

        if (!userToken) {
            return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
        }
        if (!file) {
            return Response.json({ error: "חסר קובץ שמע להעלאה" }, { status: 400 });
        }

        const [identifier, password] = userToken.split(':');
        const user = await env.DB.prepare(
            "SELECT phone, can_upload, can_record FROM users WHERE (phone = ? OR email = ?) AND password = ?"
        ).bind(identifier, identifier, password).first();

        if (!user) {
            return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });
        }

        let uploadType = formData.get('uploadType');
        if (!uploadType) {
            uploadType = file.name.startsWith('recording.') ? 'record' : 'file';
        }

        if (uploadType === 'file' && !user.can_upload) {
            return Response.json({ error: "אין לחשבון זה הרשאה להעלות קבצים מוכנים מהמכשיר" }, { status: 403 });
        }
        if (uploadType === 'record' && user.can_record === 0) {
            return Response.json({ error: "הרשאת ההקלטה שלך נחסמה על ידי המנהל" }, { status: 403 });
        }

        const token = env.YEMOT_TOKEN;
        const FOLDER_PATH = 'ivr2:/1/2';

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
            return Response.json({ error: "שגיאה בהעלאת הקובץ מצד ימות המשיח", yemotDetails: data }, { status: 400 });
        }

        // --- הוספה: תיעוד ההעלאה במסד הנתונים כדי לאפשר צינתוק ב-2 דקות הקרובות ---
        try {
            await env.DB.prepare(
                `INSERT INTO upload_events (phone, upload_time, tzintuk_sent) VALUES (?, CURRENT_TIMESTAMP, 0)`
            ).bind(user.phone).run();
        } catch (e) {
            console.error("שגיאה ברישום ההעלאה בטבלה:", e);
        }

        let txtSuccess = false;
        let txtDetails = null;

        if (data.path) {
            const txtPath = data.path.replace(/^ivr\//, 'ivr2:/').replace(/\.wav$/, '.txt');
            
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
            } catch (e) {}

            const userName = await getNameFromIni(user.phone, token);
            const displayName = userName ? `${userName} (דרך האתר)` : `משתמש אתר (דרך האתר)`;

            let did = "0733517857"; 
            let recDate = "";
            
            if (existingText) {
                const didMatch = existingText.match(/DID-(\d+)/);
                if (didMatch) did = didMatch[1];
                
                const dateMatch = existingText.match(/Date-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})/);
                if (dateMatch) recDate = dateMatch[1];
            }

            if (!recDate) {
                // שימוש בשעון ישראל מדויק לימות המשיח!
                recDate = getIsraelDateStringForTxt();
            }

            const pathParts = data.path.split('/');
            const fileName = pathParts.pop().replace('.wav', ''); 
            const folderName = pathParts.pop() || '2'; 

            const finalTxtContents = `Record-CustomerDID-${did}-Phone-${user.phone}-Date-${recDate}-Folder-${folderName}-File-${fileName}-EnterIDType-phone-EnterID-${user.phone}-ValName-${displayName}`;

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

        return Response.json({ 
            success: true, 
            message: "הקובץ הועלה והטקסט עודכן בהצלחה", 
            yemotResponse: data,
            txtUploaded: txtSuccess,
            txtDetails: txtDetails
        });

    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בעת ניסיון העלאת הקובץ", details: error.message }, { status: 500 });
    }
}
