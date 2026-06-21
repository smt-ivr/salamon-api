// email.js

/**
 * פונקציה תשתיתית לשליחת אימייל דרך ה-API הרשמי של Resend
 * @param {Object} params
 * @param {string} params.apiKey - מפתח ה-API של Resend (מגיע מתוך env.RESEND_API_KEY)
 * @param {string} [params.from] - כתובת השולח (ברירת מחדל: מערכת האימות של הדומיין שלך)
 * @param {string|string[]} params.to - כתובת או מערך כתובות של הנמענים
 * @param {string} params.subject - נושא המייל
 * @param {string} params.html - תוכן המייל בפורמט HTML (עבור תצוגה מעוצבת)
 * @param {string} [params.text] - תוכן טקסט פשוט (Fallback למקרה שאין תמיכה ב-HTML)
 */
export async function sendEmail({ apiKey, from, to, subject, html, text }) {
    if (!apiKey) {
        throw new Error("שגיאת שרת: מפתח ה-API של Resend (RESEND_API_KEY) לא הוגדר במשתני הסביבה.");
    }

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            // שימוש בדומיין המאומת שלך smti.uk
            from: from || 'מערכת אימות סלומון <auth@smti.uk>',
            to: Array.isArray(to) ? to : [to],
            subject: subject,
            html: html,
            text: text || undefined
        })
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(`Resend API Error: ${data.message || response.statusText || 'Unknown error'}`);
    }

    return { success: true, id: data.id };
}

/**
 * שליחת קוד אימות חד-פעמי (OTP) בעיצוב נקי, מותאם לעברית (RTL)
 */
export async function sendVerificationEmail(apiKey, toEmail, code) {
    const subject = `קוד אימות: ${code}`;
    
    const html = `
        <div style="direction: rtl; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; text-align: center; color: #1a202c; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
            <h2 style="color: #2b6cb0; margin-bottom: 20px; font-size: 24px;">קוד אימות חד-פעמי</h2>
            <p style="font-size: 16px; margin-bottom: 10px; color: #4a5568;">שלום,</p>
            <p style="font-size: 16px; margin-bottom: 25px; color: #4a5568;">קיבלנו בקשה לקבלת קוד אימות עבור חשבונך במערכת.</p>
            
            <div style="font-size: 36px; font-weight: bold; background-color: #f7fafc; border: 2px dashed #cbd5e0; padding: 12px 30px; display: inline-block; letter-spacing: 4px; margin-bottom: 25px; color: #2d3748; border-radius: 8px;">
                ${code}
            </div>
            
            <p style="font-size: 14px; color: #718096; margin-bottom: 5px;">הקוד יהיה בתוקף ל-10 הדקות הקרובות בלבד.</p>
            <p style="font-size: 14px; color: #a0aec0; margin-top: 0;">אם לא ביקשת קוד זה, ניתן להתעלם מאימייל זה בבטחה.</p>
            
            <hr style="border: 0; border-top: 1px solid #edf2f7; margin: 30px 0;">
            <p style="font-size: 12px; color: #a0aec0; margin: 0;">נשלח באופן אוטומטי על ידי מערכת סלומון &copy; ${new Date().getFullYear()}</p>
        </div>
    `;

    // גרסת טקסט פשוט כגיבוי למקרה הצורך
    const text = `שלום,\n\nקוד האימות החד-פעמי שלך הוא: ${code}\n\nהקוד בתוקף ל-10 דקות הקרובות.\nאם לא ביקשת זאת, פשוט התעלם מהודעה זו.`;

    return sendEmail({
        apiKey,
        to: toEmail,
        subject,
        html,
        text
    });
}

/**
 * פונקציית בונוס: שליחת התראה כללית (למשל: "הסיסמה שונתה בהצלחה")
 */
export async function sendNotificationEmail(apiKey, toEmail, title, messageText) {
    const html = `
        <div style="direction: rtl; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; color: #1a202c;">
            <h2 style="color: #2b6cb0; text-align: center; margin-bottom: 20px; font-size: 22px;">${title}</h2>
            <p style="font-size: 16px; line-height: 1.6; color: #4a5568;">שלום,</p>
            <p style="font-size: 16px; line-height: 1.6; color: #4a5568;">${messageText}</p>
            
            <hr style="border: 0; border-top: 1px solid #edf2f7; margin: 30px 0;">
            <p style="font-size: 12px; color: #a0aec0; text-align: center; margin: 0;">מערכת סלומון &copy; ${new Date().getFullYear()}</p>
        </div>
    `;

    return sendEmail({
        apiKey,
        to: toEmail,
        subject: title,
        html,
        text: messageText
    });
}
