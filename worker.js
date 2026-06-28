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
    handleCheckUnsubscribeToken, // חדש
    handleConfirmUnsubscribe,    // חדש
    handleUnblockEmail           // חדש
} from './auth.js';

import {
    handleAdminLogin,
    handleAdminGetUsers,
    handleAdminUpdateUser,
    handleAdminGetUserFullProfile,       
    handleAdminDisconnectUserTokens,
    handleAdminCreateUser,
    handleAdminDeleteUser
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
            
            // ... (שאר הקוד הקיים - System Messages, Voice Messages System וכו')
            // הערה: יש להשאיר את כל הקוד הקיים עד לבלוק של "נתיבי ניהול משתמשים"
            // אני מציג רק את התוספות לבלוק ניהול המשתמשים:

            // ============================================
            // נתיבי ניהול משתמשים וחסימות מייל
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
            // >>> התוספות החדשות לניהול החסימה מול צד הלקוח <<<
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
            // ממשק מנהל לניהול משתמשים (Admin User Management)
            // ============================================
            // ... (שאר קוד מנהל המערכת הקיים)
