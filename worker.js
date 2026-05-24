import { 
    handleCheckPhone, 
    handleRegister, 
    handleLogin, 
    handleUpdateProfile,
    handleAdminLogin,
    handleAdminGetUsers,
    handleAdminUpdateUser
} from './auth.js';

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

        try {
            let response;
            
            // נתיבי משתמשים רגילים
            if (request.method === "POST" && pathname.endsWith("/api/check-phone")) {
                response = await handleCheckPhone(request, env);
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
            // נתיבי ניהול (Admin)
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
                response = Response.json({ error: "נתיב לא נמצא" }, { status: 404 });
            }

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
