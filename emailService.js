// emailService.js

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

// תבנית בסיס מעוצבת ורספונסיבית לאימיילים
const getBaseTemplate = (title, contentHtml) => `
<div style="direction: rtl; font-family: 'Segoe UI', Tahoma, Geneva, Arial, sans-serif; background-color: #f1f5f9; padding: 40px 15px; line-height: 1.6;">
    <div style="max-width: 550px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
        
        <!-- Header -->
        <div style="text-align: center; padding: 35px 20px 25px; background-color: #ffffff; border-bottom: 2px solid #f8fafc;">
            <img src="https://smt-tel-manager.netlify.app/salamon-logo.png" alt="עכשיו סלומון" style="width: 85px; height: 85px; border-radius: 50%; box-shadow: 0 4px 15px rgba(0,0,0,0.08); margin-bottom: 15px;">
            <h2 style="color: #0f172a; margin: 0; font-size: 22px; font-weight: 800;">${title}</h2>
        </div>
        
        <!-- Content -->
        <div style="padding: 35px 30px; color: #334155; font-size: 16px;">
            ${contentHtml}
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 25px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
            <p style="margin: 0 0 15px 0; font-size: 14px; color: #64748b; font-weight: 600;">
                אם פעולה זו לא בוצעה על ידכם,<br>
                <span style="color: #ef4444; font-weight: 800;">נא פנו להנהלת המערכת באופן מיידי.</span>
            </p>
            <img src="https://smt-tel-manager.netlify.app/smt.png" alt="SMT" style="height: 24px; opacity: 0.6; margin-bottom: 10px;">
            <p style="margin: 0; font-size: 13px; color: #94a3b8;">© ${new Date().getFullYear()} עכשיו סלומון מבית SMT. כל הזכויות שמורות.</p>
        </div>
        
    </div>
</div>`;

// פונקציה לשליחת קוד אימות (החליפה את הלוגיקה בקובץ verification.js)
export async function sendVerificationCodeEmail(env, to, name, code, ip) {
    const subject = 'איפוס סיסמה - קוד אימות מאתר עכשיו סלומון';
    const title = 'בקשה לאיפוס סיסמה';
    const ipBadge = `<code style="background:#f1f5f9; padding:4px 8px; border-radius:6px; font-family: monospace; border: 1px solid #cbd5e1; color: #0f172a; font-size: 14px;">${ip}</code>`;
    
    const content = `
        <p style="margin-bottom: 15px;">שלום <strong>${name}</strong>,</p>
        <p style="margin-bottom: 20px; line-height: 1.5;">קיבלנו בקשה לאיפוס הסיסמה עבור חשבונך באתר עכשיו סלומון. הפעולה התבקשה מכתובת ה-IP:<br><br>${ipBadge}</p>
        <p style="margin-bottom: 25px;">להמשך תהליך איפוס הסיסמה, אנא הזן את קוד האימות החד-פעמי הבא:</p>
        
        <div style="text-align: center; margin-bottom: 25px;">
            <div style="font-size: 34px; font-weight: 800; background-color: #f8fafc; border: 2px dashed #cbd5e1; padding: 15px 30px; display: inline-block; letter-spacing: 6px; color: #0f172a; border-radius: 12px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.02);">
                ${code}
            </div>
        </div>
        
        <p style="font-size: 14px; color: #64748b; margin-bottom: 5px; font-weight: 600;">הקוד יהיה בתוקף ל-10 הדקות הקרובות בלבד.</p>
        <p style="font-size: 14px; color: #94a3b8; margin-top: 0;">אם לא ביקשת לאפס את הסיסמה שלך – ניתן להתעלם מאימייל זה בבטחה.</p>
    `;

    const text = `שלום ${name},\n\nקיבלנו בקשה לאיפוס הסיסמה לחשבונך מכתובת ה-IP: ${ip}.\n\nקוד האימות שלך הוא: ${code}\n\nהקוד בתוקף ל-10 דקות.`;
    return await sendEmail(env, to, subject, getBaseTemplate(title, content), text);
}

// פונקציה לשליחת התראות אבטחה שונות
export async function sendSecurityAlert(env, to, name, alertType, ip, authMethod) {
    let title = '';
    let content = '';
    let subject = '';

    const ipBadge = `<code style="background:#f1f5f9; padding:4px 8px; border-radius:6px; font-family: monospace; border: 1px solid #cbd5e1; color: #0f172a; font-size: 14px;">${ip}</code>`;

    if (alertType === 'google_only') {
        subject = 'התראת אבטחה: הופעלה כניסה באמצעות Google בלבד';
        title = 'עדכון הגדרות אבטחה';
        content = `
            <p style="margin-bottom: 15px;">שלום <strong>${name}</strong>,</p>
            <p style="margin-bottom: 15px;">הגדרת האבטחה <strong>"כניסה באמצעות חשבון Google בלבד"</strong> הופעלה כעת בחשבונך בהצלחה.</p>
            <p style="margin-bottom: 20px;">מעתה לא ניתן יהיה להתחבר לחשבונך באמצעות סיסמה רגילה, אלא אך ורק דרך חשבון ה-Google שלך, מה שמעלה משמעותית את רמת האבטחה.</p>
            <div style="background: #f8fafc; padding: 15px 20px; border-radius: 8px; border-right: 4px solid #3b82f6; font-size: 14px;">
                <strong style="color: #1e293b; display: block; margin-bottom: 8px;">כתובת IP מבצע הפעולה:</strong>
                ${ipBadge}
            </div>
        `;
    } else if (alertType === 'password_change') {
        subject = 'התראת אבטחה: סיסמת חשבונך שונתה';
        title = 'שינוי סיסמה';
        const methodText = authMethod === 'google' ? 'חשבון Google' : 'סיסמה';
        content = `
            <p style="margin-bottom: 15px;">שלום <strong>${name}</strong>,</p>
            <p style="margin-bottom: 15px;">אנו מעדכנים אותך כי הסיסמה המשויכת לחשבונך במערכת <strong>שונתה בהצלחה</strong> לפני זמן קצר.</p>
            <p style="margin-bottom: 20px;">הפעולה בוצעה מתוך אזור ההגדרות, לאחר שהתחברת למערכת באמצעות התחברות עם <strong>${methodText}</strong>.</p>
            <div style="background: #f0fdf4; padding: 15px 20px; border-radius: 8px; border-right: 4px solid #10b981; font-size: 14px; border: 1px solid #bbf7d0;">
                <strong style="color: #15803d; display: block; margin-bottom: 8px;">כתובת IP מבצע הפעולה:</strong>
                ${ipBadge}
            </div>
        `;
    } else if (alertType === 'password_reset') {
        subject = 'התראת אבטחה: בוצע איפוס לסיסמתך';
        title = 'איפוס סיסמה בוצע';
        content = `
            <p style="margin-bottom: 15px;">שלום <strong>${name}</strong>,</p>
            <p style="margin-bottom: 15px;">אנו מעדכנים אותך כי בוצע <strong>איפוס סיסמה</strong> מלא לחשבונך במערכת.</p>
            <p style="margin-bottom: 20px;">הסיסמה החדשה עודכנה דרך תהליך "שכחתי סיסמה", תוך שימוש בקוד אימות מאובטח שנשלח לכתובת האימייל שלך.</p>
            <div style="background: #fffbeb; padding: 15px 20px; border-radius: 8px; border-right: 4px solid #f59e0b; font-size: 14px; border: 1px solid #fde68a;">
                <strong style="color: #b45309; display: block; margin-bottom: 8px;">כתובת IP מבצע הפעולה:</strong>
                ${ipBadge}
            </div>
        `;
    }

    const textFallback = content.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    return await sendEmail(env, to, subject, getBaseTemplate(title, content), textFallback);
}
