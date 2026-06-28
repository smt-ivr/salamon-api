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

// תבנית בסיס מעוצבת ויוקרתית לאימיילים
const getBaseTemplate = (title, contentHtml, unsubscribeUrl = null) => `
<div style="background-color: #f1f5f9; padding: 40px 15px; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; direction: rtl; text-align: right;">
    <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1); overflow: hidden;">
        
        <!-- Header אקסקלוסיבי כהה -->
        <div style="background-color: #0f172a; padding: 35px 20px; text-align: center; position: relative;">
            <div style="display: inline-block; padding: 5px; background: #ffffff; border-radius: 50%; margin-bottom: 15px; box-shadow: 0 0 20px rgba(59, 130, 246, 0.3);">
                <img src="https://smt-tel-manager.netlify.app/salamon-logo.png" alt="עכשיו סלומון" style="width: 75px; height: 75px; border-radius: 50%; display: block;">
            </div>
            <h2 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 0.5px;">${title}</h2>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px 35px; color: #334155; font-size: 16px; line-height: 1.7;">
            ${contentHtml}
        </div>
        
        <!-- Footer חכם ומעוצב -->
        <div style="background-color: #f8fafc; padding: 30px 35px; border-top: 1px solid #e2e8f0; text-align: center;">
            <img src="https://smt-tel-manager.netlify.app/smt.png" alt="SMT" style="height: 28px; opacity: 0.5; margin-bottom: 20px; display: block; margin-left: auto; margin-right: auto;">
            
            <p style="margin: 0 0 15px 0; font-size: 13.5px; color: #64748b; line-height: 1.5;">
                לתשומת לבך: ניתן לעדכן את העדפות הדיוור ולהפסיק לקבל אימיילים מסוג זה בכל עת דרך הגדרות החשבון באתר.
            </p>
            
            ${unsubscribeUrl ? `
            <div style="background: #ffffff; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 15px; margin-top: 15px;">
                <p style="margin: 0; font-size: 13.5px; color: #64748b;">
                    הודעה זו אינה מוכרת לכם? אם אינכם קשורים למערכת, באפשרותכם
                    <a href="${unsubscribeUrl}" style="color: #ef4444; font-weight: 700; text-decoration: none; display: inline-block; margin-top: 5px;">לחסום את עצמכם לחלוטין מקבלת אימיילים</a>.
                </p>
            </div>
            ` : ''}
        </div>
        
    </div>
    
    <!-- זכויות יוצרים מחוץ לקופסה -->
    <div style="text-align: center; margin-top: 25px; color: #94a3b8; font-size: 13px;">
        © ${new Date().getFullYear()} עכשיו סלומון מבית SMT. כל הזכויות שמורות.
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
    const ipBadge = `<code style="background:#f1f5f9; padding:3px 8px; border-radius:6px; border: 1px solid #cbd5e1; color: #0f172a; font-size: 14px; direction: ltr; display: inline-block;">${ip}</code>`;
    
    const content = `
        <p style="margin: 0 0 15px 0; font-size: 18px;">שלום <strong>${name}</strong>,</p>
        <p style="margin: 0 0 20px 0;">קיבלנו בקשה לאיפוס הסיסמה עבור חשבונך. הפעולה התבקשה מכתובת ה-IP: ${ipBadge}</p>
        <p style="margin: 0 0 20px 0;">להמשך תהליך האיפוס, אנא הזן את קוד האימות הבא במערכת:</p>
        
        <div style="text-align: center; margin: 30px 0;">
            <div style="font-size: 36px; font-weight: 800; background-color: #f8fafc; border: 2px dashed #94a3b8; padding: 15px 35px; display: inline-block; letter-spacing: 8px; color: #0f172a; border-radius: 12px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.02);">
                ${code}
            </div>
        </div>
        
        <p style="font-size: 14px; color: #64748b; margin: 0 0 8px 0; font-weight: 600;"><i style="color: #3b82f6;">⏳</i> הקוד בתוקף ל-10 דקות בלבד.</p>
        <p style="font-size: 14px; color: #94a3b8; margin: 0;">אם לא ביקשת לאפס את הסיסמה, באפשרותך להתעלם מהודעה זו בבטחה.</p>
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

    const ipBadge = `<code style="background:#f1f5f9; padding:3px 8px; border-radius:6px; border: 1px solid #cbd5e1; color: #0f172a; font-size: 14px; direction: ltr; display: inline-block;">${ip}</code>`;
    const warningText = `<div style="margin-top: 25px; font-size: 14px; color: #b91c1c; font-weight: 600; background: #fef2f2; padding: 15px; border-radius: 8px; border: 1px solid #fecaca; text-align: center;">אם פעולה זו לא בוצעה על ידכם, אנא פנו להנהלת המערכת באופן מיידי!</div>`;

    if (alertType === 'google_only') {
        subject = 'התראת אבטחה: הופעלה כניסה באמצעות Google בלבד';
        title = 'עדכון הגדרות אבטחה';
        content = `
            <p style="margin: 0 0 15px 0; font-size: 18px;">שלום <strong>${name}</strong>,</p>
            <p style="margin: 0 0 15px 0;">אנו מעדכנים כי הגדרת האבטחה <strong>"כניסה באמצעות חשבון Google בלבד"</strong> הופעלה בחשבונך.</p>
            <p style="margin: 0 0 20px 0;">מעתה, הגישה למערכת תתאפשר אך ורק באמצעות התחברות מאובטחת דרך חשבון ה-Google שלך, ולא ניתן יהיה להתחבר באמצעות סיסמה.</p>
            
            <div style="background: #f8fafc; padding: 15px 20px; border-radius: 8px; border-right: 4px solid #3b82f6; font-size: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                <strong style="color: #1e293b; display: block; margin-bottom: 5px;">מקור הפעולה:</strong>
                כתובת IP: ${ipBadge}
            </div>
            ${warningText}
        `;
    } else if (alertType === 'password_change') {
        subject = 'התראת אבטחה: סיסמת חשבונך שונתה';
        title = 'שינוי סיסמה';
        const methodText = authMethod === 'google' ? 'חשבון Google' : 'סיסמה';
        content = `
            <p style="margin: 0 0 15px 0; font-size: 18px;">שלום <strong>${name}</strong>,</p>
            <p style="margin: 0 0 15px 0;">אנו מעדכנים כי הסיסמה המשויכת לחשבונך במערכת עכשיו סלומון <strong>שונתה בהצלחה</strong>.</p>
            <p style="margin: 0 0 20px 0;">הפעולה בוצעה לאחר התחברות מאומתת באמצעות <strong>${methodText}</strong>.</p>
            
            <div style="background: #f0fdf4; padding: 15px 20px; border-radius: 8px; border-right: 4px solid #10b981; font-size: 14px; border: 1px solid #bbf7d0; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                <strong style="color: #15803d; display: block; margin-bottom: 5px;">מקור הפעולה:</strong>
                כתובת IP: ${ipBadge}
            </div>
            ${warningText}
        `;
    } else if (alertType === 'password_reset') {
        subject = 'התראת אבטחה: בוצע איפוס לסיסמתך';
        title = 'איפוס סיסמה בוצע';
        content = `
            <p style="margin: 0 0 15px 0; font-size: 18px;">שלום <strong>${name}</strong>,</p>
            <p style="margin: 0 0 15px 0;">אנו מעדכנים כי בוצע <strong>איפוס סיסמה</strong> מלא לחשבונך במערכת.</p>
            <p style="margin: 0 0 20px 0;">הסיסמה החדשה הוגדרה בהצלחה בעקבות תהליך אימות מתקדם דרך האימייל שלך.</p>
            
            <div style="background: #fffbeb; padding: 15px 20px; border-radius: 8px; border-right: 4px solid #f59e0b; font-size: 14px; border: 1px solid #fde68a; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                <strong style="color: #b45309; display: block; margin-bottom: 5px;">מקור הפעולה:</strong>
                כתובת IP: ${ipBadge}
            </div>
            ${warningText}
        `;
    }

    const textFallback = content.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    return await sendEmail(env, to, subject, getBaseTemplate(title, content, unsubscribeUrl), textFallback);
}
