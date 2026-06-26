// phoneApi.js

export async function handlePhoneApiStats(request, env) {
    try {
        const url = new URL(request.url);
        
        // ימות המשיח יכולים לשלוח את הנתונים ב-GET או ב-POST
        // ננסה קודם למשוך מפרמטר URL
        let what = url.searchParams.get('what');

        // אם לא נמצא ב-URL והבקשה היא POST, ננסה לחלץ מהגוף
        if (!what && request.method === 'POST') {
            const contentType = request.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const body = await request.json().catch(() => ({}));
                what = body.what;
            } else if (contentType.includes('application/x-www-form-urlencoded')) {
                const formData = await request.formData().catch(() => new FormData());
                what = formData.get('what');
            }
        }

        // אם בכל זאת לא התקבל פרמטר what
        if (!what) {
            return new Response("id_list_message=t-שגיאה, לא התקבל נתיב קובץ.&", { 
                headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
            });
        }

        // חילוץ מזהה ההודעה (המספר בלבד) מתוך הנתיב
        // עובד גם על ivr2:/2/1/3620.wav וגם על נתיבים דומים
        const match = what.match(/\/(\d+)\.[a-zA-Z0-9]+$/);
        let fileId = match ? match[1] : null;

        // מקרה גיבוי: אם הנתיב נשלח בלי סיומת (רק מספר בסוף)
        if (!fileId) {
             const fallbackMatch = what.match(/(\d+)$/);
             fileId = fallbackMatch ? fallbackMatch[1] : null;
        }

        if (!fileId) {
            return new Response("id_list_message=t-שגיאה, מזהה קובץ לא חוקי.&", { 
                headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
            });
        }

        // שליפת כמות השמיעות דרך האתר בלבד מתוך מסד הנתונים
        const dbStats = await env.DB.prepare(
            `SELECT COUNT(*) as web_listens FROM message_listens WHERE file_id = ?`
        ).bind(fileId).first();
        
        const webListens = dbStats ? dbStats.web_listens : 0;

        // בניית התשובה בפורמט הנדרש עבור שלוחת API בימות המשיח
        const yemotResponse = `id_list_message=t-סך הכל צפיות דרך האתר.n-${webListens}&`;

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
