import { handleCampaignInfo, handleSolicitorsList, handleDonationInfo } from './campaign.js';
import { handleWebhookRequest } from './webhook.js';
import { handleRegister, handleLogin, handleDashboard, handleUpdateTarget } from './solicitor.js';
import { handleYemotStatus, handleYemotDonate } from './yemot.js'; // הייבוא החדש של ימות המשיח
import { handlePublicDonations } from './public-donations.js';

function corsResponse(response) {
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    newHeaders.set('Access-Control-Allow-Headers', 'Content-Type');
    return new Response(response.body, { status: response.status, headers: newHeaders });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === 'OPTIONS') {
            return corsResponse(new Response(null, { status: 204 }));
        }

        try {
            let response;

            // נתיבים חדשים לקמפיין ולתרומות
            if (path === '/campaign/api/info' && request.method === 'GET') {
                response = await handleCampaignInfo(env);
            }
            else if (path === '/campaign/api/solicitors' && request.method === 'GET') {
                response = await handleSolicitorsList(env);
            }
            else if (path === '/campaign/api/donation-info' && request.method === 'GET') {
                response = await handleDonationInfo(env);
            }
            // נתיב וובהוק נשאר כרגיל
            else if (path === '/campaign/api/webhook' && request.method === 'POST') {
                response = await handleWebhookRequest(request, env);
            }
            // נתיבי מתרימים
            else if (path === '/campaign/api/solicitor/register' && request.method === 'POST') {
                response = await handleRegister(request, env);
            }
            else if (path === '/campaign/api/solicitor/login' && request.method === 'POST') {
                response = await handleLogin(request, env);
            }
            else if (path === '/campaign/api/solicitor/dashboard' && request.method === 'GET') {
                response = await handleDashboard(request, env);
            }
            else if (path === '/campaign/api/solicitor/update' && request.method === 'POST') {
                response = await handleUpdateTarget(request, env);
            }
            // --- נתיבים חדשים עבור ימות המשיח ---
            else if (path === '/campaign/api/yemot/status' && request.method === 'GET') {
                response = await handleYemotStatus(request, env);
            }
            else if (path === '/campaign/api/yemot/donate' && request.method === 'GET') {
                response = await handleYemotDonate(request, env);
            }
            // --- נתיב תרומות פומביות ---
            else if (path === '/campaign/api/donations-public' && request.method === 'GET') {
                response = await handlePublicDonations(request, env);
            }
            else {
                response = new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
            }

            return corsResponse(response);

        } catch (error) {
            console.error("=== קריסת שרת נתפסה בראוטר הראשי ===");
            console.error("נתיב שניסה לגשת:", path);
            console.error("הודעת שגיאה:", error.message);
            console.error("פירוט (Stack):", error.stack);

            return corsResponse(new Response(JSON.stringify({ 
                status: 'error', 
                message: 'שגיאת שרת פנימית',
                details: error.message
            }), { 
                status: 500,
                headers: { 'Content-Type': 'application/json' } 
            }));
        }
    }
};
