// emailService.js
import { getIsraelTimeForDB } from './timeUtils.js';

// פונקציית ליבה לשליחת אימייל דרך Resend
export async function sendEmail(env, to, subject, html, text) {
    if (!env.RESEND_API_KEY) {
        console.error("Missing RESEND_API_KEY for email service");
        return false;
    }
    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: 'עכשיו סלומון <salamon@smti.uk>',
                to: [to],
                subject: subject,
                html: html,
                text: text
            })
        });
        return res.ok;
    } catch (e) {
        console.error("Email send failed", e);
        return false;
    }
}

// תבנית בסיס מעוצבת, ממוקדת ורספונסיבית לאימיילים (כולל קישור הסרה)
const getBaseTemplate = (title, contentHtml, unsubscribeUrl = null) => `
<div style="direction: rtl; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; background-color: #f4f7f6; padding: 20px 10px;">
    <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; overflow: hidden; border: 1px solid #e2e8f0;">
        
        <!-- Header -->
        <div style="text-align: center; padding: 20px 15px 15px; border-bottom: 1px solid #f8fafc;">
            <img src="https://smt-tel-manager.netlify.app/salamon-logo.png" alt="עכשיו סלומון" style="width: 70px; height: 70px; border-radius: 50%; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 10px; pointer-events: none; user-select: none; -webkit-user-drag: none;">
            <h2 style="color: #0f172a; margin: 0; font-size: 20px; font-weight: 700;">${title}</h2>
        </div>
        
        <!-- Content -->
        <div style="padding: 20px 25px; color: #334155; font-size: 15px; line-height: 1.5;">
            ${contentHtml}
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 15px 25px; text-align: center; border-top: 1px solid #e2e8f0;">
            <img src="https://smt-tel-manager.netlify.app/smt.png" alt="SMT" style="height: 36px; opacity: 0.8; margin-bottom: 8px; pointer-events: none; user-select: none; -webkit-user-drag: none;">
            <p style="margin: 0; font-size: 12px; color: #94a3b8;">© ${new Date().getFullYear()} עכשיו סלומון מבית SMT. כל הזכויות שמורות.</p>
            ${unsubscribeUrl ? `<p style="margin: 15px 0 0 0; font-size: 12px;"><a href="${unsubscribeUrl}" style="color: #ef4444; text-decoration: underline;">חסום כתובת אימייל זו מקבלת הודעות עתידיות</a></p>` : ''}
        </div>
        
    </div>
</div>`;

// פונקציה לשליחת קוד אימות
export async function sendVerificationCodeEmail(env, to, name, code, ip) {
    // 1. בדיקה מול הרשימה השחורה המיוחדת
    const isBlocked = await env.DB.prepare("SELECT 1 FROM email_blocklist WHERE email = ?").bind(to).first();
    if (isBlocked) return false;

    // 2. יצירת טוקן לחסימה
    const token = crypto.randomUUID();
    const nowStr = getIsraelTimeForDB();
    await env.DB.prepare("INSERT INTO unsubscribe_tokens (token, email, created_at) VALUES (?, ?, ?)").bind(token, to, nowStr).run();
    const unsubscribeUrl = `https://smt-tel-manager.netlify.app/unsubscribe?token=${token}`;

    const subject = 'איפוס סיסמה - קוד אימות מאתר עכשיו סלומון';
    const title = 'בקשה לאיפוס סיסמה';
    const ipBadge = `<code style="background:#f1f5f9; padding:2px 6px; border-radius:4px; border: 1px solid #cbd5e1; color: #0f172a; font-size: 13px; direction: ltr; display: inline-block;">${ip}</code>`;
    
    const content = `
        <p style="margin: 0 0 10px 0;">שלום <strong>${name}</strong>,</p>
        <p style="margin: 0 0 15px 0;">קיבלנו בקשה לאיפוס הסיסמה עבור חשבונך. הפעולה התבקשה מכתובת ה-IP: ${ipBadge}</p>
        <p style="margin: 0 0 15px 0;">להמשך תהליך האיפוס, אנא הזן את קוד האימות הבא:</p>
        
        <div style="text-align: center; margin-bottom: 20px;">
            <div style="font-size: 30px; font-weight: 800; background-color: #f8fafc; border: 2px dashed #cbd5e1; padding: 10px 25px; display: inline-block; letter-spacing: 5px; color: #0f172a; border-radius: 8px;">
                ${code}
            </div>
        </div>
        
        <p style="font-size: 13px; color: #64748b; margin: 0 0 5px 0; font-weight: 600;">הקוד בתוקף ל-10 דקות.</p>
        <p style="font-size: 13px; color: #94a3b8; margin: 0;">אם לא ביקשת לאפס את הסיסמה, פשוט התעלם מהודעה זו.</p>
    `;

    const text = `שלום ${name},\n\nקיבלנו בקשה לאיפוס הסיסמה לחשבונך מכתובת ה-IP: ${ip}.\n\nקוד האימות שלך הוא: ${code}\n\nהקוד בתוקף ל-10 דקות.`;
    return await sendEmail(env, to, subject, getBaseTemplate(title, content, unsubscribeUrl), text);
}

// פונקציה לשליחת התראות אבטחה שונות
export async function sendSecurityAlert(env, to, name, alertType, ip, authMethod) {
    // 1. בדיקה מול הרשימה השחורה המיוחדת
    const isBlocked = await env.DB.prepare("SELECT 1 FROM email_blocklist WHERE email = ?").bind(to).first();
    if (isBlocked) return false;

    // 2. יצירת טוקן לחסימה
    const token = crypto.randomUUID();
    const nowStr = getIsraelTimeForDB();
    await env.DB.prepare("INSERT INTO unsubscribe_tokens (token, email, created_at) VALUES (?, ?, ?)").bind(token, to, nowStr).run();
    const unsubscribeUrl = `https://smt-tel-manager.netlify.app/unsubscribe?token=${token}`;

    let title = '';
    let content = '';
    let subject = '';

    const ipBadge = `<code style="background:#f1f5f9; padding:2px 6px; border-radius:4px; border: 1px solid #cbd5e1; color: #0f172a; font-size: 13px; direction: ltr; display: inline-block;">${ip}</code>`;
    const warningText = `<p style="margin: 15px 0 0 0; font-size: 13.5px; color: #ef4444; font-weight: 700; background: #fef2f2; padding: 10px; border-radius: 6px; border: 1px solid #fecaca; text-align: center;">אם פעולה זו לא בוצעה על ידכם, נא פנו להנהלת המערכת באופן מיידי.</p>`;

    if (alertType === 'google_only') {
        subject = 'התראת אבטחה: הופעלה כניסה באמצעות Google בלבד';
        title = 'עדכון הגדרות אבטחה';
        content = `
            <p style="margin: 0 0 10px 0;">שלום <strong>${name}</strong>,</p>
            <p style="margin: 0 0 10px 0;">הגדרת האבטחה <strong>"כניסה באמצעות חשבון Google בלבד"</strong> הופעלה בחשבונך.</p>
            <p style="margin: 0 0 15px 0;">מעתה ניתן להתחבר אך ורק דרך חשבון ה-Google שלך.</p>
            <div style="background: #f8fafc; padding: 10px 15px; border-radius: 6px; border-right: 4px solid #3b82f6; font-size: 13px;">
                <strong style="color: #1e293b;">כתובת IP מבצע הפעולה:</strong> ${ipBadge}
            </div>
            ${warningText}
        `;
    } else if (alertType === 'password_change') {
        subject = 'התראת אבטחה: סיסמת חשבונך שונתה';
        title = 'שינוי סיסמה';
        const methodText = authMethod === 'google' ? 'חשבון Google' : 'סיסמה';
        content = `
            <p style="margin: 0 0 10px 0;">שלום <strong>${name}</strong>,</p>
            <p style="margin: 0 0 10px 0;">אנו מעדכנים כי הסיסמה המשויכת לחשבונך במערכת <strong>שונתה בהצלחה</strong>.</p>
            <p style="margin: 0 0 15px 0;">הפעולה בוצעה לאחר התחברות באמצעות <strong>${methodText}</strong>.</p>
            <div style="background: #f0fdf4; padding: 10px 15px; border-radius: 6px; border-right: 4px solid #10b981; font-size: 13px; border: 1px solid #bbf7d0;">
                <strong style="color: #15803d;">כתובת IP מבצע הפעולה:</strong> ${ipBadge}
            </div>
            ${warningText}
        `;
    } else if (alertType === 'password_reset') {
        subject = 'התראת אבטחה: בוצע איפוס לסיסמתך';
        title = 'איפוס סיסמה בוצע';
        content = `
            <p style="margin: 0 0 10px 0;">שלום <strong>${name}</strong>,</p>
            <p style="margin: 0 0 10px 0;">אנו מעדכנים כי בוצע <strong>איפוס סיסמה</strong> לחשבונך במערכת.</p>
            <p style="margin: 0 0 15px 0;">הסיסמה החדשה עודכנה דרך תהליך אימות באימייל.</p>
            <div style="background: #fffbeb; padding: 10px 15px; border-radius: 6px; border-right: 4px solid #f59e0b; font-size: 13px; border: 1px solid #fde68a;">
                <strong style="color: #b45309;">כתובת IP מבצע הפעולה:</strong> ${ipBadge}
            </div>
            ${warningText}
        `;
    }

    const textFallback = content.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    return await sendEmail(env, to, subject, getBaseTemplate(title, content, unsubscribeUrl), textFallback);
}
