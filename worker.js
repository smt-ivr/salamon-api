import { 
    handleCheckIdentifier, 
    handleRegister, 
    handleLogin, 
    handleUpdateProfile
} from './auth.js';

import {
    handleAdminLogin,
    handleAdminGetUsers,
    handleAdminUpdateUser
} from './admin.js';

// ייבוא מערכת האימות החדשה
import { VerificationSystem } from './verification.js';

export default {
    async fetch(request, env, ctx) {
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);
        const pathname = url.pathname.replace(/\/$/, "");
        
        // משיכת כתובת ה-IP של המשתמש (או ברירת מחדל אם לא קיים)
        const userIp = request.headers.get('cf-connecting-ip') || '0.0.0.0';

        try {
            let response;
            
            // אתחול מערכת האימות (משתמשת במסד הנתונים ובטוקן של ימות שכבר מוגדרים ב-env)
            const verifySystem = new VerificationSystem(env.DB, env.YEMOT_TOKEN);
            
            // ==========================================
            // נתיבי מערכת האימות (צינתוקים) - חדש
            // ==========================================
            
            if (request.method === "POST" && pathname.endsWith("/api/verify/send")) {
                const body = await request.json();
                if (!body.phone) {
                    response = Response.json({ error: "חסר מספר טלפון" }, { status: 400 });
                } else {
                    const result = await verifySystem.requestVerification(body.phone, userIp, body.intent || 'register');
                    response = Response.json(result, { status: result.success ? 200 : 400 });
                }
            }
            else if (request.method === "POST" && pathname.endsWith("/api/verify/check")) {
                const body = await request.json();
                if (!body.sessionId || !body.phone || !body.code) {
                    response = Response.json({ error: "חסרים פרטי אימות (sessionId, phone, code)" }, { status: 400 });
                } else {
                    const result = await verifySystem.verifyCode(body.sessionId, body.phone, userIp, body.code);
                    response = Response.json(result, { status: result.success ? 200 : 400 });
                }
            }
            else if (request.method === "POST" && pathname.endsWith("/api/verify/clean")) {
                // נתיב לניקוי לוגים ישנים (מעל 30 יום) - מומלץ להפעיל באמצעות CRON בעתיד
                const result = await verifySystem.cleanOldLogs();
                response = Response.json(result, { status: result.success ? 200 : 500 });
            }

            // ==========================================
            // נתיבי משתמשים רגילים (auth.js) - קיים
            // ==========================================
            else if (request.method === "POST" && pathname.endsWith("/api/check-identifier")) {
                response = await handleCheckIdentifier(request, env);
            } 
            else if (request.method === "POST" && pathname.endsWith("/api/register")) {
                response = await handleRegister(request, env);
            } 
            else if (request.method === "POST" && pathname.endsWith("/api/login")) {
                response = await handleLogin(request, env);
            } 
            else if (request.method === "POST" && pathname.endsWith("/api/update-profile")) {
                response = await handleUpdateProfile(request, env);
            }
            
            // ==========================================
            // נתיבי ניהול (admin.js) - קיים
            // ==========================================
            else if (request.method === "POST" && pathname.endsWith("/api/admin/login")) {
                response = await handleAdminLogin(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/users")) {
                response = await handleAdminGetUsers(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/update-user")) {
                response = await handleAdminUpdateUser(request, env);
            }
            
            // ==========================================
            // נתיב לא נמצא
            // ==========================================
            else {
                response = Response.json({ error: "נתיב לא נמצא" }, { status: 404 });
            }

            // החלת כותרות ה-CORS על כל התשובות
            const newResponse = new Response(response.body, response);
            for (let [key, value] of Object.entries(corsHeaders)) {
                newResponse.headers.set(key, value);
            }
            return newResponse;

        } catch (error) {
            return Response.json({ error: error.message }, { 
                status: 500, 
                headers: corsHeaders 
            });
        }
    }
};
