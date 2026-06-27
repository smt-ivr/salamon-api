// worker.js

import { 
    handleCheckIdentifier, 
    handleRegister, 
    handleLogin, 
    handleGoogleLogin,   
    handleGetProfile,    
    handleUpdateProfile,
    handleResetPasswordConfirm,
    handleLogout,         
    authenticateUser      
} from './auth.js';

import {
    handleAdminLogin,
    handleAdminGetUsers,
    handleAdminUpdateUser
} from './admin.js';

import { VerificationSystem } from './verification.js';
import { handleGetMessages, handleStreamMessage } from './messages.js';
import { handleUploadMessage } from './upload.js';
import { processTzintukRequest } from './tzintuk.js';
import { handleCheckDeleteEligibility, handleDeleteMessage } from './delete.js';

// ייבוא פונקציות מערכת המודעות
import { 
    handleGetSystemMessagesForUser, 
    handleAdminListSystemMessages, 
    handleAdminSaveSystemMessage, 
    handleAdminDeleteSystemMessage,
    handleAdminGetAdLogs
} from './systemMessage.js';

// ייבוא פונקציות ספירת ההאזנות באתר
import { handleGetListenStats } from './listenStats.js';

// ייבוא ממשק API לימות המשיח (קריאת נתוני האזנה טלפונית)
import { handlePhoneApiStats } from './phoneApi.js';

// ייבוא פונקציית הסטטיסטיקה החדשה
import { handleGetSystemStats } from './stats.js';

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
        const userIp = request.headers.get('cf-connecting-ip') || '0.0.0.0';

        try {
            let response;
            const verifySystem = new VerificationSystem(env.DB, env.YEMOT_TOKEN);

            // ============================================
            // API פתוח לימות המשיח (ללא אימות טוקן)
            // ============================================
            if (pathname.endsWith("/api/phone/stats")) {
                response = await handlePhoneApiStats(request, env);
            }
            
            // ============================================
            // מערכת מודעות ופרסומות משודרגת (System Messages & Ads)
            // ============================================
            else if (request.method === "POST" && pathname.endsWith("/api/system-message")) {
                response = await handleGetSystemMessagesForUser(request, env, userIp);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/system-messages/list")) {
                response = await handleAdminListSystemMessages(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/system-messages/save")) {
                response = await handleAdminSaveSystemMessage(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/system-messages/delete")) {
                response = await handleAdminDeleteSystemMessage(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/system-messages/logs")) {
                response = await handleAdminGetAdLogs(request, env);
            }
            
            // ============================================
            // מערכת הודעות קוליות (Voice Messages System)
            // ============================================
            else if (request.method === "POST" && pathname.endsWith("/api/messages/list")) {
                response = await handleGetMessages(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/messages/upload")) {
                response = await handleUploadMessage(request, env);
            }
            else if (request.method === "GET" && pathname.endsWith("/api/messages/stream")) {
                response = await handleStreamMessage(request, env, ctx);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/messages/tzintuk")) {
                const body = await request.json().catch(() => ({}));
                if (!body.userToken) {
                    response = Response.json({ error: "חסר אימות משתמש" }, { status: 401 });
                } else {
                    const user = await authenticateUser(env.DB, body.userToken);
                    if (!user) {
                        response = Response.json({ error: "הרשאות משתמש לא חוקיות או פג תוקף" }, { status: 403 });
                    } else {
                        const result = await processTzintukRequest(env, user.phone, env.YEMOT_TOKEN);
                        response = Response.json(result, { status: result.success ? 200 : 400 });
                    }
                }
            }
            else if (request.method === "POST" && pathname.endsWith("/api/messages/check-delete")) {
                response = await handleCheckDeleteEligibility(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/messages/delete")) {
                response = await handleDeleteMessage(request, env, userIp); 
            }
            else if (request.method === "POST" && pathname.endsWith("/api/messages/stats")) {
                response = await handleGetListenStats(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/stats/members")) {
                response = await handleGetSystemStats(request, env);
            }

            // ============================================
            // מערכת אימות ורישום - צינתוקים ומיילים
            // ============================================
            else if (request.method === "POST" && pathname.endsWith("/api/verify/send")) {
                const body = await request.json().catch(() => ({}));
                if (body.intent === 'reset') {
                    const identifier = body.identifier || body.phone;
                    if (!identifier) {
                        response = Response.json({ error: "חסר מזהה משתמש (טלפון או אימייל)" }, { status: 400 });
                    } else {
                        const result = await verifySystem.requestPasswordReset(identifier, userIp, env);
                        response = Response.json({ success: result.success, message: result.message, sessionId: result.sessionId, phone: result.phone }, { status: result.success ? 200 : 400 });
                    }
                } else {
                    if (!body.phone) {
                        response = Response.json({ error: "חסר מספר טלפון" }, { status: 400 });
                    } else {
                        const result = await verifySystem.requestVerification(body.phone, userIp, body.intent || 'register');
                        response = Response.json(result, { status: result.success ? 200 : 400 });
                    }
                }
            }
            else if (request.method === "POST" && pathname.endsWith("/api/verify/check")) {
                const body = await request.json().catch(() => ({}));
                if (!body.sessionId || !body.phone || !body.code) {
                    response = Response.json({ error: "חסרים פרטי אימות (sessionId, phone, code)" }, { status: 400 });
                } else {
                    const result = await verifySystem.verifyCode(body.sessionId, body.phone, userIp, body.code);
                    response = Response.json(result, { status: result.success ? 200 : 400 });
                }
            }

            // ============================================
            // ניהול מנהל מערכת - חסימות ולוגים כלליים
            // ============================================
            else if (pathname.includes("/api/verify/admin/")) {
                if (request.method !== "POST") {
                    response = Response.json({ error: "מתודה לא מורשית" }, { status: 405 });
                } else {
                    const body = await request.json().catch(() => ({}));
                    const adminToken = body.adminToken;
                    
                    if (!adminToken || !adminToken.includes(':')) {
                        response = Response.json({ error: "חסר אימות מנהל או פורמט שגוי" }, { status: 401 });
                    } else {
                        const [username, adminPass] = adminToken.split(':');
                        const admin = await env.DB.prepare("SELECT 1 FROM admins WHERE username = ? AND password = ?").bind(username, adminPass).first();
                        
                        if (!admin) {
                            response = Response.json({ error: "הרשאות מנהל לא חוקיות" }, { status: 403 });
                        } else {
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

            // ============================================
            // נתיבי ניהול משתמשים (User Management)
            // ============================================
            else if (request.method === "POST" && pathname.endsWith("/api/check-identifier")) {
                response = await handleCheckIdentifier(request, env);
            } 
            else if (request.method === "POST" && pathname.endsWith("/api/register")) {
                response = await handleRegister(request, env);
            } 
            else if (request.method === "POST" && pathname.endsWith("/api/login")) {
                response = await handleLogin(request, env);
            } 
            else if (request.method === "POST" && pathname.endsWith("/api/login/google")) { 
                response = await handleGoogleLogin(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/user")) { 
                response = await handleGetProfile(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/logout")) { 
                response = await handleLogout(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/update-profile")) {
                response = await handleUpdateProfile(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/reset-password/confirm")) {
                response = await handleResetPasswordConfirm(request, env);
            }
            
            // ============================================
            // ממשק מנהל לניהול משתמשים (Admin User Management)
            // ============================================
            else if (request.method === "POST" && pathname.endsWith("/api/admin/login")) {
                response = await handleAdminLogin(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/users")) {
                response = await handleAdminGetUsers(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/update-user")) {
                response = await handleAdminUpdateUser(request, env);
            }
            else {
                // הצגת עמוד 404 מעוצב עבור גישה מהדפדפן (GET) לעומת שגיאת JSON עבור API
                if (request.method === "GET") {
                    const fallbackHtml = `
                    <!DOCTYPE html>
                    <html lang="he" dir="rtl">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>מערכת ה-API - עכשיו סלומון</title>
                        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
                        <style>
                            body { font-family: 'Segoe UI', system-ui, sans-serif; background-color: #f0f2f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                            .card { background: #fff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); text-align: center; max-width: 400px; width: 90%; }
                            .icon { font-size: 3.5rem; color: #3b82f6; margin-bottom: 20px; }
                            h1 { color: #0f172a; margin: 0 0 10px 0; font-size: 1.5rem; }
                            p { color: #54656f; margin: 0 0 25px 0; line-height: 1.5; }
                            .btn { display: inline-flex; align-items: center; gap: 8px; background: #16a34a; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; transition: 0.2s; }
                            .btn:hover { background: #15803d; transform: translateY(-2px); }
                        </style>
                    </head>
                    <body>
                        <div class="card">
                            <div class="icon"><i class="fa-solid fa-server"></i></div>
                            <h1>שרת התקשורת</h1>
                            <p>הגעתם לנתיב ה-API של מערכת "עכשיו סלומון".<br>נתיב זה מיועד לקבלת נתונים מאחורי הקלעים ואינו מיועד לצפייה ישירה.</p>
                            <a href="https://smti.uk/salamon" class="btn">למעבר לאתר הראשי <i class="fa-solid fa-arrow-left"></i></a>
                        </div>
                    </body>
                    </html>`;
                    
                    response = new Response(fallbackHtml, { 
                        status: 404, 
                        headers: { 'Content-Type': 'text/html; charset=utf-8' } 
                    });
                } else {
                    response = Response.json({ error: "נתיב לא נמצא" }, { status: 404 });
                }
            }

            // הוספת כותרי CORS בצורה בטוחה
            const contentType = response.headers ? response.headers.get('Content-Type') : '';
            const isSpecialFormat = contentType === 'text/plain; charset=utf-8' || contentType === 'text/html; charset=utf-8';
            
            let newResponse = isSpecialFormat ? response : new Response(response.body, response);
            
            for (let [key, value] of Object.entries(corsHeaders)) {
                try { newResponse.headers.set(key, value); } catch(e) {}
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
