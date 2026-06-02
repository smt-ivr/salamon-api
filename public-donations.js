export async function handlePublicDonations(request, env) {
    try {
        // שאילתה למשיכת כל התרומות מהמסד, מסודרות מהתרומה החדשה ביותר לישנה.
        // אנחנו שולפים רק שדות שמותרים להצגה פומבית: 
        // שם, סכום, מטבע, הערה, זמן התרומה ומזהה המתרים.
        const query = `
            SELECT 
                donor_name, 
                amount, 
                currency, 
                comment, 
                created_at,
                solicitor_id
            FROM donations 
            ORDER BY created_at DESC
        `;
        
        const { results } = await env.DB.prepare(query).all();

        // החזרת הנתונים כ-JSON תקני עם כותרות CORS לגישה מהדפדפן
        return new Response(JSON.stringify({
            status: "success",
            data: results
        }), {
            status: 200,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*"
            }
        });
    } catch (error) {
        // במקרה של שגיאה נחזיר הודעה מסודרת
        return new Response(JSON.stringify({
            status: "error",
            message: "שגיאה בשליפת נתוני התרומות",
            error: error.message
        }), {
            status: 500,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*"
            }
        });
    }
}
