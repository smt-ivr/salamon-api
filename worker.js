// worker.js

import { 
    handleCheckIdentifier, 
    handleRegister, 
    handleLogin, 
    handleGoogleLogin,   
    handleGetProfile,    
    handleUpdateProfile,
    handleChangePassword,
    handleResetPasswordConfirm,
    handleLogout,         
    authenticateUser,
    handleCheckUnsubscribeToken,
    handleConfirmUnsubscribe,
    handleUnblockEmail
} from './auth.js';

import {
    handleAdminLogin,
    handleAdminGetUsers,
    handleAdminUpdateUser,
    handleAdminGetUserFullProfile,       
    handleAdminDisconnectUserTokens,
    handleAdminCreateUser,
    handleAdminDeleteUser,
    handleAdminGetTables,
    handleAdminExecuteQuery
} from './admin.js';

import { VerificationSystem } from './verification.js';
import { handleGetMessages, handleStreamMessage } from './messages.js';
import { handleUploadMessage } from './upload.js';
import { processTzintukRequest } from './tzintuk.js';
import { handleCheckDeleteEligibility, handleDeleteMessage } from './delete.js';

import { 
    handleGetSystemMessagesForUser, 
    handleAdminListSystemMessages, 
    handleAdminSaveSystemMessage, 
    handleAdminDeleteSystemMessage,
    handleAdminGetAdLogs
} from './systemMessage.js';

import { handleGetListenStats } from './listenStats.js';
import { handlePhoneApiStats } from './phoneApi.js';
import { handleGetSystemStats } from './stats.js';

// ---- ייבוא הצ'אט החדש ----
import {
    handleUserGetChat,
    handleUserSendMessage,
    handleUserMarkRead,
    handleUserDeleteMessage,
    handleAdminGetConversations,
    handleAdminGetChat,
    handleAdminSendMessage,
    handleAdminMarkRead,
    handleAdminDeleteMessage as handleAdminDeleteChatMessage
} from './chat.js';
// -----------------------

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
            // API פתוח לימות המשיח
            // ============================================
            if (pathname.endsWith("/api/phone/stats")) {
                response = await handlePhoneApiStats(request, env);
            }
            
            // ============================================
            // מערכת מודעות ופרסומות 
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
            // מערכת הודעות קוליות
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
            // מערכת אימות ורישום
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
            // צ'אט עם ההנהלה
            // ============================================
            else if (request.method === "POST" && pathname.endsWith("/api/chat/list")) {
                response = await handleUserGetChat(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/chat/send")) {
                response = await handleUserSendMessage(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/chat/read")) {
                response = await handleUserMarkRead(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/chat/delete")) {
                response = await handleUserDeleteMessage(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/chat/conversations")) {
                response = await handleAdminGetConversations(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/chat/list")) {
                response = await handleAdminGetChat(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/chat/send")) {
                response = await handleAdminSendMessage(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/chat/read")) {
                response = await handleAdminMarkRead(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/chat/delete")) {
                response = await handleAdminDeleteChatMessage(request, env);
            }

            // ============================================
            // ניהול מנהל מערכת - חסימות ולוגים 
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
            // נתיבי ניהול משתמשים (User Management) וחסימות מייל
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
            else if (request.method === "POST" && pathname.endsWith("/api/change-password")) {
                response = await handleChangePassword(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/reset-password/confirm")) {
                response = await handleResetPasswordConfirm(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/unsubscribe/check")) {
                response = await handleCheckUnsubscribeToken(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/unsubscribe/confirm")) {
                response = await handleConfirmUnsubscribe(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/unblock-email")) {
                response = await handleUnblockEmail(request, env);
            }
            
            // ============================================
            // ממשק מנהל לניהול משתמשים ו-SQL מסוף
            // ============================================
            else if (request.method === "POST" && pathname.endsWith("/api/admin/login")) {
                response = await handleAdminLogin(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/users")) {
                response = await handleAdminGetUsers(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/user-profile")) {
                response = await handleAdminGetUserFullProfile(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/update-user")) {
                response = await handleAdminUpdateUser(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/user-tokens/delete")) {
                response = await handleAdminDisconnectUserTokens(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/create-user")) {
                response = await handleAdminCreateUser(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/delete-user")) {
                response = await handleAdminDeleteUser(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/sql/tables")) {
                response = await handleAdminGetTables(request, env);
            }
            else if (request.method === "POST" && pathname.endsWith("/api/admin/sql/execute")) {
                response = await handleAdminExecuteQuery(request, env);
            }
            else {
                response = Response.json({ error: "נתיב לא נמצא" }, { status: 404 });
            }

            const isPlainText = response.headers && response.headers.get('Content-Type') === 'text/plain; charset=utf-8';
            let newResponse = isPlainText ? response : new Response(response.body, response);
            
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
