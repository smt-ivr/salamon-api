import { getNameFromIni } from './yemot.js';
import { getIsraelTimeForDB } from './timeUtils.js'; // הוספנו את ניהול הזמנים שלנו!

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

        // --- שולפים את הזמן המדויק בישראל ---
        const currentTimeIsrael = getIsraelTimeForDB();

        // תיעוד ההעלאה במסד הנתונים עם שעון ישראל כדי שחלון ה-2 דקות לצינתוק יעבוד במדויק
        try {
            await env.DB.prepare(
                `INSERT INTO upload_events (phone, upload_time, tzintuk_sent) VALUES (?, ?, 0)`
            ).bind(user.phone, currentTimeIsrael).run();
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
                // המרה של הפורמט YYYY-MM-DD HH:MM:SS לפורמט של ימות YYYY-MM-DD-HH-MM-SS
                recDate = currentTimeIsrael.replace(/[: ]/g, '-');
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
