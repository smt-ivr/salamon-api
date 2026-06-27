// stats.js
import { authenticateUser } from './auth.js';

export async function handleGetSystemStats(request, env) {
    try {
        const body = await request.json().catch(() => ({}));
        const { userToken } = body;

        // אימות משתמש בסיסי כדי למנוע גישה לא מורשית
        if (!userToken) return Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
        
        const user = await authenticateUser(env.DB, userToken);
        if (!user) return Response.json({ error: "הרשאות משתמש לא חוקיות" }, { status: 403 });

        const token = env.YEMOT_TOKEN;
        const url = `https://www.call2all.co.il/ym/api/TzintukimListManagement?token=${token}&action=getlists`;
        
        const response = await fetch(url);
        const data = await response.json();

        if (data.responseStatus !== 'OK') {
            return Response.json({ error: "שגיאה בקבלת נתונים מימות המשיח" }, { status: 400 });
        }

        // חיפוש הרשימה הספציפית
        const membersList = (data.lists || []).find(list => list.listName === 'members');
        
        if (!membersList) {
            return Response.json({ success: true, stats: { total: 0, active: 0, blocked: 0 } });
        }

        return Response.json({ 
            success: true, 
            stats: {
                total: membersList.subscribers,
                active: membersList.active,
                blocked: membersList.blocked
            }
        });
    } catch (error) {
        return Response.json({ error: "שגיאת שרת פנימית", details: error.message }, { status: 500 });
    }
}
