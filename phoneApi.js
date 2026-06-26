// phoneApi.js

export async function handlePhoneApiStats(request, env) {
    try {
        const url = new URL(request.url);
        
        // שליפת הפרמטרים מה-URL (במקרה שימות המשיח שולחים ב-GET)
        let what = url.searchParams.get('what');
        let playStop = url.searchParams.get('PlayStop');

        // אם לא נמצא ב-URL והבקשה היא POST, נמשוך מתוך גוף הבקשה
        if (request.method === 'POST') {
            const contentType = request.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const body = await request.json().catch(() => ({}));
                if (!what) what = body.what;
                if (!playStop) playStop = body.PlayStop;
            } else if (contentType.includes('application/x-www-form-urlencoded')) {
                const formData = await request.formData().catch(() => new FormData());
                if (!what) what = formData.get('what');
                if (!playStop) playStop = formData.get('PlayStop');
            }
        }

        // אם בכל זאת לא התקבל פרמטר what, נחזיר שגיאה שתושמע בטלפון
        if (!what) {
            return new Response("id_list_message=t-שגיאה, לא התקבל נתיב קובץ.&", { 
                headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
            });
        }

        // ==========================================
        // פירוק הנתיב לחלקים עבור go_to_folder_and_play
        // ==========================================
        
        // 1. הסרת הקידומת ivr2: (או IVR2:) מהנתיב
        let cleanPath = what.replace(/^ivr2:/i, '');
        
        // וידוא שהנתיב מתחיל בלוכסן (לדוגמה: /2/1/3620.wav)
        if (!cleanPath.startsWith('/')) {
            cleanPath = '/' + cleanPath;
        }

        // מציאת המיקום של הלוכסן האחרון המפריד בין התיקייה לקובץ
        const lastSlashIndex = cleanPath.lastIndexOf('/');
        
        // 2. חילוץ נתיב התיקייה (לדוגמה: /2/1)
        const folderPath = cleanPath.substring(0, lastSlashIndex);
        
        // 3. חילוץ שם הקובץ המלא (לדוגמה: 3620.wav)
        const fullFileName = cleanPath.substring(lastSlashIndex + 1);
        
        // 4. חילוץ מזהה הקובץ ללא סיומת (לדוגמה: 3620)
        const fileId = fullFileName.split('.')[0];

        if (!fileId) {
            return new Response("id_list_message=t-שגיאה, מזהה קובץ לא חוקי.&", { 
                headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
            });
        }

        // ==========================================
        // שליפת הנתונים ממסד הנתונים של האתר
        // ==========================================
        const dbStats = await env.DB.prepare(
            `SELECT COUNT(*) as web_listens FROM message_listens WHERE file_id = ?`
        ).bind(fileId).first();
        
        const webListens = dbStats ? dbStats.web_listens : 0;

        // ==========================================
        // בניית התשובה לימות המשיח
        // ==========================================
        
        // שלב א': הודעת הסטטיסטיקה
        let yemotResponse = `id_list_message=t-סך הכל צפיות דרך האתר.n-${webListens}&`;

        // שלב ב': אם התקבל פרמטר PlayStop, נוסיף פקודת מעבר וחזרה למיקום המדויק
        if (playStop) {
            // התוצאה: go_to_folder_and_play=/2/1,3620,6545&
            yemotResponse += `go_to_folder_and_play=${folderPath},${fileId},${playStop}&`;
        }

        return new Response(yemotResponse, { 
            status: 200,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });

    } catch (error) {
        console.error("Phone API Error:", error);
        return new Response("id_list_message=t-שגיאת שרת פנימית.&", { 
            status: 500,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }
}
