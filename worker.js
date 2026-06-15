// worker.js

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

// ייבוא מודול ההודעות החדש שיצרנו
import { handleGetMessages, handleStreamMessage } from './messages.js';

// ייבוא מודול העלאת קבצים החדש (קובץ נפרד)
import { handleUploadMessage } from './upload.js';

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
            // נתיבי מערכת שמע הודעות (חדש + העלאה)
            // ==========================================
            if (request.method === "POST" && pathname.endsWith("/api/messages/list")) {
                response = await handleGetMessages(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/messages/upload")) {
                response = await handleUploadMessage(request, env);
            }
            else if (request.method === "GET" && pathname.endsWith("/api/messages/stream")) {
                response = await handleStreamMessage(request, env);
            }

            // ==========================================
            // נתיבי מערכת האימות (צינתוקים) - משתמש רגיל
            // ==========================================
            else if (request.method === "POST" && pathname.endsWith("/api/verify/send")) {
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

            // ==========================================
            // נתיבי מערכת אימות - ניהול בלבד (Admin)
            // ==========================================
            else if (pathname.includes("/api/verify/admin/")) {
                if (request.method !== "POST") {
                    response = Response.json({ error: "מתודה לא מורשית" }, { status: 405 });
                } else {
                    const body = await request.json();
                    const adminToken = body.adminToken;
                    
                    if (!adminToken) {
                        response = Response.json({ error: "חסר אימות מנהל" }, { status: 401 });
                    } else {
                        const [username, adminPass] = adminToken.split(':');
                        const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, adminPass).first();
                        
                        if (!admin) {
                            response = Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });
                        } else {
                            // אימות מנהל עבר בהצלחה - ביצוע הפעולה המבוקשת
                            if (pathname.endsWith("/api/verify/admin/logs")) {
                                const limit = body.limit || 100;
                                const offset = body.offset || 0;
                                response = Response.json(await verifySystem.getLogs(limit, offset));
                            }
                            else if (pathname.endsWith("/api/verify/admin/blocks")) {
                                response = Response.json(await verifySystem.getBlocks());
                            }
                            else if (pathname.endsWith("/api/verify/admin/block")) {
                                response = Response.json(await verifySystem.blockTarget(body.type, body.value, body.reason, body.durationValue, body.durationUnit, userIp));
                            }
                            else if (pathname.endsWith("/api/verify/admin/unblock")) {
                                response = Response.json(await verifySystem.unblockTarget(body.target, userIp));
                            }
                            else if (pathname.endsWith("/api/verify/admin/clean")) {
                                response = Response.json(await verifySystem.cleanOldLogs());
                            } else {
                                response = Response.json({ error: "נתיב ניהול לא נמצא" }, { status: 404 });
                            }
                        }
                    }
                }
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

            // החלת כותרות ה-CORS על כל התשובות (תומך גם ב-Response רגילים כמו ב-Stream)
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
