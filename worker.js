import { handleCheckPhone, handleRegister, handleLogin } from './auth.js';

export default {
    async fetch(request, env, ctx) {
        // הגדרת CORS כדי לאפשר גישה מדפדפן
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);

        try {
            let response;
            
            if (request.method === "POST" && url.pathname === "/api/check-phone") {
                response = await handleCheckPhone(request, env);
            } 
            else if (request.method === "POST" && url.pathname === "/api/register") {
                response = await handleRegister(request, env);
            } 
            else if (request.method === "POST" && url.pathname === "/api/login") {
                response = await handleLogin(request, env);
            } 
            else {
                response = Response.json({ error: "נתיב לא נמצא" }, { status: 404 });
            }

            // הוספת הדרים של CORS לתשובה
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
