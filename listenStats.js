// listenStats.js

// פונקציה לשליפת נתוני צפיות/האזנות מקוצרת מקובץ
export async function handleGetListenStats(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        const { fileId } = body;

        if (!fileId) return Response.json({ error: "חסר מזהה קובץ" }, { status: 400 });

        // 1. שליפת כמות השמיעות דרך האתר (מתוך מסד הנתונים שלנו)
        const dbStats = await env.DB.prepare(
            `SELECT COUNT(*) as web_listens FROM message_listens WHERE file_id = ?`
        ).bind(fileId.toString()).first();
        
        const webListens = dbStats ? dbStats.web_listens : 0;

        // 2. שליפת כמות השמיעות דרך הטלפון (ימות המשיח)
        let phoneListens = 0;
        const yemotToken = env.YEMOT_TOKEN;
        const yemotUrl = `https://www.call2all.co.il/ym/api/GetTextFile?token=${yemotToken}&what=ivr2:Log/Listening/1/2/${encodeURIComponent(fileId)}.ini`;

        try {
            const yemotRes = await fetch(yemotUrl);
            if (yemotRes.ok) {
                const yemotData = await yemotRes.json();
                if (yemotData.responseStatus === 'OK' && yemotData.contents) {
                    // חיפוש הערך ListenAmount=X מתוך התוכן
                    const match = yemotData.contents.match(/ListenAmount=(\d+)/);
                    if (match && match[1]) {
                        phoneListens = parseInt(match[1], 10);
                    }
                }
            }
        } catch (yemotError) {
            console.error("שגיאה בשליפת נתוני האזנות מימות המשיח:", yemotError);
            // במקרה של שגיאה מול ימות המשיח נחזיר 0 שמיעות טלפון ולא נקריס את התשובה
        }

        const totalListens = webListens + phoneListens;

        return Response.json({ 
            success: true, 
            stats: {
                webListens: webListens,
                phoneListens: phoneListens,
                totalListens: totalListens
            }
        });
    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית בשליפת נתוני ההאזנות.", details: error.message }, { status: 500 });
    }
}
