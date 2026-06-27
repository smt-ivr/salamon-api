// verification.js
import { checkPhoneStatus, getNameFromIni } from './yemot.js';
import { getIsraelTimeForDB, getFutureIsraelTimeForDB, getMinutesSinceIsraelDbTime, isPastIsraelTime } from './timeUtils.js';

export class VerificationSystem {
    constructor(db, yemotToken) {
        this.db = db;
        this.yemotToken = yemotToken; 
    }

    // כתיבת לוג למערכת המעקב בשעון ישראל בלבד
    async logAction(level, phone, ip, action, details) {
        const nowIsraelStr = getIsraelTimeForDB();
        await this.db.prepare(
            `INSERT INTO verification_logs (level, phone, ip_address, action, details, timestamp) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(level, phone || null, ip || null, action, details, nowIsraelStr).run();
    }

    // פונקציית עזר להמרת זמן
    formatTimeRemaining(seconds) {
        if (seconds <= 0) return 'זמן קצר';
        if (seconds < 60) return `${seconds} שניות`;
        const minutes = Math.floor(seconds / 60);
        const remSeconds = seconds % 60;
        if (minutes < 60) return remSeconds > 0 ? `${minutes} דקות ו-${remSeconds} שניות` : `${minutes} דקות`;
        const hours = Math.floor(minutes / 60);
        const remMinutes = minutes % 60;
        if (hours < 24) return remMinutes > 0 ? `${hours} שעות ו-${remMinutes} דקות` : `${hours} שעות`;
        
        const days = Math.floor(hours / 24);
        const remHours = hours % 24;
        return remHours > 0 ? `${days} ימים ו-${remHours} שעות` : `${days} ימים`;
    }

    // פונקציית זמני המתנה וצינון
    getCooldownMinutes(attempts) {
        if (attempts === 0) return 0;
        if (attempts === 1) return 2;
        if (attempts === 2) return 4;
        if (attempts === 3) return 6;
        if (attempts === 4) return 15;
        if (attempts === 5) return 20;
        if (attempts === 6) return 30;
        if (attempts === 7) return 50;
        return 60;
    }

    // 1. שליחת בקשת אימות (צינתוק טלפוני להרשמה/כניסה)
    async requestVerification(phone, ip, intent = 'register') {
        if (!this.yemotToken) {
            return { success: false, message: "שגיאת שרת: חסר טוקן התחברות לימות המשיח." };
        }

        const nowIsraelStr = getIsraelTimeForDB();

        // --- שלב 1: בדיקת ימות המשיח ---
        const phoneStatus = await checkPhoneStatus(phone, this.yemotToken);
        if (!phoneStatus.exists) {
            await this.logAction('BLOCKED', phone, ip, 'SEND_REJECTED', 'המספר אינו מורשה במערכת ימות המשיח');
            return { success: false, message: "המספר אינו מורשה לקבל צינתוקים. עליכם לאשר קבלת צינתוקים במערכת הטלפונית." };
        }

        // --- שלב 2: בדיקת רישום במסד הנתונים שלנו ---
        const existingUser = await this.db.prepare("SELECT 1 FROM users WHERE phone = ?").bind(phone).first();
        
        if (intent === 'register' && existingUser) {
            await this.logAction('WARN', phone, ip, 'SEND_REJECTED', 'ניסיון צינתוק להרשמה למספר שכבר רשום');
            return { success: false, message: "המספר הזה כבר רשום במערכת. אנא התחברו במקום להירשם." };
        }
        
        if ((intent === 'login' || intent === 'reset') && !existingUser) {
            await this.logAction('WARN', phone, ip, 'SEND_REJECTED', 'ניסיון כניסה/איפוס למספר שאינו רשום');
            return { success: false, message: "המספר הזה אינו רשום במערכת. עליכם להירשם תחילה." };
        }

        // --- שלב 3: בדיקת חסימות (מנהל/אוטומטי) ---
        const blockCheck = await this.db.prepare(
            `SELECT * FROM verification_blocks 
             WHERE (block_type = 'phone' AND block_value = ?) OR (block_type = 'ip' AND block_value = ?)
             AND (blocked_until IS NULL OR blocked_until > ?)`
        ).bind(phone, ip, nowIsraelStr).first();

        if (blockCheck) {
            let msg = `הפעולה נחסמה על ידי ההנהלה. סיבה: ${blockCheck.reason || 'ללא סיבה'}.`;
            if (blockCheck.blocked_until) {
                // הזמן במסד הוא בעתיד - מחשבים כמה שניות נותרו (הופכים לתוצאה חיובית)
                const timeLeftSecs = Math.floor(-getMinutesSinceIsraelDbTime(blockCheck.blocked_until) * 60);
                msg += ` החסימה תשתחרר בעוד ${this.formatTimeRemaining(timeLeftSecs)}.`;
            } else {
                msg += " החסימה הינה לצמיתות.";
            }
            await this.logAction('BLOCKED', phone, ip, 'SEND_REQUEST', `נחסם עקב רשימה שחורה`);
            return { success: false, message: msg };
        }

        // --- שלב 4: בדיקת היסטוריית ניסיונות (Rate Limiting) ---
        const yesterdayStr = getFutureIsraelTimeForDB(-24 * 60);
        const recentSession = await this.db.prepare(
            `SELECT * FROM verification_sessions 
             WHERE phone = ? AND created_at > ?
             ORDER BY created_at DESC LIMIT 1`
        ).bind(phone, yesterdayStr).first();

        let attemptsCount = 1;

        if (recentSession) {
            if (recentSession.status !== 'verified' && recentSession.status !== 'used') {
                attemptsCount = recentSession.attempts_count + 1;
                const cooldownMinutes = this.getCooldownMinutes(recentSession.attempts_count);
                const minutesPassed = getMinutesSinceIsraelDbTime(recentSession.created_at);

                if (minutesPassed < cooldownMinutes) {
                    const timeLeftSecs = Math.floor((cooldownMinutes - minutesPassed) * 60);
                    const errorMsg = `נשלחו יותר מדי בקשות. זהו ניסיון מספר ${recentSession.attempts_count}. אנא נסו שוב בעוד ${this.formatTimeRemaining(timeLeftSecs)}.`;
                    await this.logAction('WARN', phone, ip, 'RATE_LIMIT', `הגבלת קצב הופעלה. ניסיון ${attemptsCount}`);
                    return { success: false, message: errorMsg };
                }
            }
        }

        // --- שלב 5: קריאה ל-API ושמירה ---
        try {
            const yemotUrl = `https://www.call2all.co.il/ym/api/RunTzintuk?token=${this.yemotToken}&callerId=RAND&TzintukTimeOut=16&phones=${phone}`;
            const yemotResponse = await fetch(yemotUrl);
            const yemotData = await yemotResponse.json();

            if (yemotData.responseStatus !== "OK") {
                await this.logAction('ERROR', phone, ip, 'YEMOT_API', `שגיאה מימות: ${JSON.stringify(yemotData)}`);
                return { success: false, message: "אירעה שגיאה בשליחת הצינתוק אל המספר." };
            }

            const verifyCode = yemotData.verifyCode;
            const sessionId = crypto.randomUUID();
            const codeExpiresAtStr = getFutureIsraelTimeForDB(10); // 10 דקות תוקף בשעון ישראל

            await this.db.prepare(
                `INSERT INTO verification_sessions (id, phone, ip_address, verify_code, intent, attempts_count, code_expires_at, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(sessionId, phone, ip, verifyCode, intent, attemptsCount, codeExpiresAtStr, nowIsraelStr).run();

            await this.logAction('INFO', phone, ip, 'SEND_REQUEST', `צינתוק נשלח בהצלחה. ניסיון ${attemptsCount}`);

            return { 
                success: true, 
                message: `צינתוק אימות נשלח למספר ${phone}. אנא הזינו את 4 הספרות האחרונות מהמספר המצנתק.`,
                sessionId: sessionId
            };

        } catch (error) {
            await this.logAction('ERROR', phone, ip, 'SYSTEM', error.message);
            return { success: false, message: "שגיאת מערכת פנימית בעת ניסיון שליחת הצינתוק." };
        }
    }

    // --- בקשת איפוס סיסמה ושליחת קוד אימות במייל דרך Resend ---
    async requestPasswordReset(identifier, ip, env) {
        if (!env.RESEND_API_KEY) {
            return { success: false, message: "שגיאת שרת: חסר מפתח אימות למערכת האימיילים (RESEND_API_KEY)." };
        }

        const nowIsraelStr = getIsraelTimeForDB();

        // חיפוש המשתמש - שולף גם את ההגדרה לקבלת אימיילים
        const user = await this.db.prepare(
            "SELECT phone, email, receive_emails FROM users WHERE phone = ? OR email = ?"
        ).bind(identifier, identifier).first();

        if (!user) {
            return { success: false, message: "לא נמצא משתמש רשום עם פרטים אלו במערכת." };
        }
        if (!user.email) {
            return { success: false, message: "לא מוגדרת כתובת אימייל מעודכנת לחשבון זה. אנא פנה למנהל המערכת." };
        }
        if (user.receive_emails === 0) {
            return { success: false, message: "חשבונך הוגדר שלא לקבל הודעות אימייל מהמערכת. לא ניתן לשלוח קוד איפוס לאימייל שלך. אנא פנה למנהל או היעזר בצינתוק." };
        }

        // בדיקת חסימות כלליות
        const blockCheck = await this.db.prepare(
            `SELECT * FROM verification_blocks 
             WHERE (block_type = 'phone' AND block_value = ?) OR (block_type = 'ip' AND block_value = ?)
             AND (blocked_until IS NULL OR blocked_until > ?)`
        ).bind(user.phone, ip, nowIsraelStr).first();

        if (blockCheck) {
            let msg = `הפעולה נחסמה על ידי ההנהלה. סיבה: ${blockCheck.reason || 'ללא סיבה'}.`;
            if (blockCheck.blocked_until) {
                const timeLeftSecs = Math.floor(-getMinutesSinceIsraelDbTime(blockCheck.blocked_until) * 60);
                msg += ` החסימה תשתחרר בעוד ${this.formatTimeRemaining(timeLeftSecs)}.`;
            } else {
                msg += " החסימה הינה לצמיתות.";
            }
            await this.logAction('BLOCKED', user.phone, ip, 'RESET_REJECTED', `ניסיון איפוס נחסם עקב רשימה שחורה`);
            return { success: false, message: msg };
        }

        // הגבלת קצב (Rate Limiting)
        const yesterdayStr = getFutureIsraelTimeForDB(-24 * 60);
        const recentSession = await this.db.prepare(
            `SELECT * FROM verification_sessions 
             WHERE phone = ? AND intent = 'reset' AND created_at > ?
             ORDER BY created_at DESC LIMIT 1`
        ).bind(user.phone, yesterdayStr).first();

        let attemptsCount = 1;
        if (recentSession) {
            if (recentSession.status !== 'verified' && recentSession.status !== 'used') {
                attemptsCount = recentSession.attempts_count + 1;
                const cooldownMinutes = this.getCooldownMinutes(recentSession.attempts_count);
                const minutesPassed = getMinutesSinceIsraelDbTime(recentSession.created_at);

                if (minutesPassed < cooldownMinutes) {
                    const timeLeftSecs = Math.floor((cooldownMinutes - minutesPassed) * 60);
                    return { success: false, message: `נשלחו יותר מדי בקשות איפוס. אנא נסו שוב בעוד ${this.formatTimeRemaining(timeLeftSecs)}.` };
                }
            }
        }

        // שליפת שם המשתמש העדכני מימות המשיח
        const userName = await getNameFromIni(user.phone, this.yemotToken);
        const displayName = userName || "משתמש מערכת";

        // יצירת קוד אימות רנדומלי בן 6 ספרות וסשן חדש
        const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
        const sessionId = crypto.randomUUID();
        const codeExpiresAtStr = getFutureIsraelTimeForDB(10); // 10 דקות תוקף

        try {
            // שמירת הסשן במסד הנתונים
            await this.db.prepare(
                `INSERT INTO verification_sessions (id, phone, ip_address, verify_code, intent, attempts_count, code_expires_at, created_at) 
                 VALUES (?, ?, ?, ?, 'reset', ?, ?, ?)`
            ).bind(sessionId, user.phone, ip, verifyCode, attemptsCount, codeExpiresAtStr, nowIsraelStr).run();

            // בניית המייל המעוצב בעברית (RTL)
            const emailHtml = `
                <div style="direction: rtl; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; text-align: center; color: #1a202c; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                    <h2 style="color: #2b6cb0; margin-bottom: 20px; font-size: 24px;">בקשה לאיפוס סיסמה</h2>
                    <p style="font-size: 16px; margin-bottom: 10px; color: #4a5568; text-align: right;">שלום <strong>${displayName}</strong>,</p>
                    <p style="font-size: 16px; margin-bottom: 20px; color: #4a5568; text-align: right; line-height: 1.5;">קיבלנו בקשה לאיפוס הסיסמה עבור חשבונך באתר עכשיו סלומון מהכתובת: <code style="background:#f1f5f9; padding:3px 6px; border-radius:4px; font-family: monospace;">${ip}</code>.</p>
                    <p style="font-size: 16px; margin-bottom: 25px; color: #4a5568; text-align: right;">להמשך תהליך איפוס הסיסמה, אנא הזן את קוד האימות החד-פעמי הבא:</p>
                    
                    <div style="font-size: 32px; font-weight: bold; background-color: #f7fafc; border: 2px dashed #cbd5e0; padding: 12px 30px; display: inline-block; letter-spacing: 4px; margin-bottom: 25px; color: #2d3748; border-radius: 8px;">
                        ${verifyCode}
                    </div>
                    
                    <p style="font-size: 14px; color: #718096; margin-bottom: 5px;">הקוד יהיה בתוקף ל-10 הדקות הקרובות בלבד.</p>
                    <p style="font-size: 13px; color: #a0aec0; margin-top: 0;">אם לא ביקשת לאפס את הסיסמה שלך – ניתן להתעלם מאימייל זה.</p>
                    
                    <hr style="border: 0; border-top: 1px solid #edf2f7; margin: 30px 0;">
                    <p style="font-size: 12px; color: #a0aec0; margin: 0;">נשלח באופן אוטומטי על ידי S.M.T מאתר עכשיו סלומון &copy; ${new Date().getFullYear()}</p>
                </div>
            `;

            const emailText = `שלום ${displayName},\n\nקיבלנו בקשה לאיפוס הסיסמה לחשבונך מכתובת ה-IP: ${ip}.\n\nקוד האימות שלך הוא: ${verifyCode}\n\nהקוד בתוקף ל-10 דקות.\nאם לא ביקשת זאת, פשוט התעלם מהודעה זו.`;

            // שליחה ישירה ל-API של Resend
            const resendResponse = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: 'עכשיו סלומון <salamon@smti.uk>',
                    to: [user.email],
                    subject: 'איפוס סיסמה - מאתר עכשיו סלומון',
                    html: emailHtml,
                    text: emailText
                })
            });

            if (!resendResponse.ok) {
                const errData = await resendResponse.json();
                throw new Error(`Resend API Error: ${JSON.stringify(errData)}`);
            }

            await this.logAction('INFO', user.phone, ip, 'RESET_CODE_SENT', `קוד איפוס נשלח בהצלחה למייל`);

            return { 
                success: true, 
                message: "קוד אימות לאיפוס הסיסמה נשלח לכתובת האימייל המעודכנת בחשבונך.",
                sessionId: sessionId,
                phone: user.phone // מחזירים את הטלפון כדי שהקליינט יוכל להשתמש בו ב-verify/check
            };

        } catch (error) {
            await this.logAction('ERROR', user.phone, ip, 'RESET_SYSTEM_ERROR', error.message);
            return { success: false, message: "שגיאה פנימית בשליחת קוד האימות למייל." };
        }
    }

    // 2. אימות הקוד (מתאים גם לצינתוק וגם לאימייל!)
    async verifyCode(sessionId, phone, ip, code) {
        const session = await this.db.prepare(
            `SELECT * FROM verification_sessions WHERE id = ? AND phone = ? AND status = 'pending'`
        ).bind(sessionId, phone).first();

        if (!session) {
            return { success: false, message: "בקשת האימות לא נמצאה, פג תוקפה או שכבר אומתה." };
        }

        if (isPastIsraelTime(session.code_expires_at)) {
            await this.db.prepare(`UPDATE verification_sessions SET status = 'expired' WHERE id = ?`).bind(sessionId).run();
            return { success: false, message: "זמן הזנת הקוד פג (עברו יותר מ-10 דקות). אנא בקשו קוד מחדש." };
        }

        if (session.verify_code !== code) {
            const newAttempts = session.verify_attempts + 1;
            
            if (newAttempts >= 5) {
                await this.db.prepare(`UPDATE verification_sessions SET status = 'expired', verify_attempts = ? WHERE id = ?`).bind(newAttempts, sessionId).run();
                await this.logAction('BLOCKED', phone, ip, 'VERIFY_CODE', '5 ניסיונות שגויים - הבקשה נמחקה');
                return { success: false, message: "קוד שגוי. נותרו 0 ניסיונות והבקשה נמחקה." };
            } else {
                await this.db.prepare(`UPDATE verification_sessions SET verify_attempts = ? WHERE id = ?`).bind(newAttempts, sessionId).run();
                return { success: false, message: `קוד שגוי. נותרו לך עוד ${5 - newAttempts} ניסיונות.` };
            }
        }

        // --- האימות הצליח ---
        const authToken = crypto.randomUUID();
        const nowIsraelStr = getIsraelTimeForDB();
        let tokenExpiresAtStr = null;

        if (session.intent === 'register' || session.intent === 'reset') {
            tokenExpiresAtStr = getFutureIsraelTimeForDB(15);
        } else if (session.intent === 'login') {
            await this.db.prepare(
                `UPDATE verification_sessions SET status = 'expired' WHERE phone = ? AND intent = 'login' AND status = 'verified'`
            ).bind(phone).run();
        }

        await this.db.prepare(
            `UPDATE verification_sessions SET status = 'verified', auth_token = ?, token_expires_at = ?, ip_address = ?, updated_at = ? WHERE id = ?`
        ).bind(authToken, tokenExpiresAtStr, ip, nowIsraelStr, sessionId).run();

        await this.logAction('INFO', phone, ip, 'VERIFY_SUCCESS', `אימות הצליח (סוג: ${session.intent})`);

        return {
            success: true,
            message: "הקוד אומת בהצלחה!",
            token: authToken,
            intent: session.intent
        };
    }

    // --- פעולות ניהול ---
    async getLogs(limit = 100, offset = 0) {
        try {
            const { results } = await this.db.prepare(
                `SELECT * FROM verification_logs ORDER BY timestamp DESC LIMIT ? OFFSET ?`
            ).bind(limit, offset).all();
            return { success: true, logs: results };
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async getBlocks() {
        try {
            const { results } = await this.db.prepare(
                `SELECT * FROM verification_blocks ORDER BY created_at DESC`
            ).all();
            return { success: true, blocks: results };
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    async blockTarget(type, value, reason, durationValue, durationUnit, ip) {
        let blockedUntil = null;
        if (durationValue && durationUnit) {
            let durationMinutes = 0;
            if (durationUnit === 'seconds') durationMinutes = durationValue / 60;
            else if (durationUnit === 'minutes') durationMinutes = durationValue;
            else if (durationUnit === 'hours') durationMinutes = durationValue * 60;
            else if (durationUnit === 'days') durationMinutes = durationValue * 24 * 60;
            else if (durationUnit === 'months') durationMinutes = durationValue * 30 * 24 * 60;
            
            blockedUntil = getFutureIsraelTimeForDB(durationMinutes);
        }

        const nowIsraelStr = getIsraelTimeForDB();
        const existing = await this.db.prepare(
            `SELECT id FROM verification_blocks WHERE block_type = ? AND block_value = ?`
        ).bind(type, value).first();
        
        if (existing) {
            await this.db.prepare(
                `UPDATE verification_blocks SET reason = ?, blocked_until = ? WHERE id = ?`
            ).bind(reason, blockedUntil, existing.id).run();
            return { success: true, message: `החסימה עבור ${value} עודכנה בהצלחה במערכת.` };
        } else {
            await this.db.prepare(
                `INSERT INTO verification_blocks (block_type, block_value, reason, blocked_until, created_at) VALUES (?, ?, ?, ?, ?)`
            ).bind(type, value, reason, blockedUntil, nowIsraelStr).run();
            return { success: true, message: `החסימה עבור ${value} נוצרה בהצלחה במערכת.` };
        }
    }

    async unblockTarget(target, ip) {
        const result = await this.db.prepare(
            `DELETE FROM verification_blocks WHERE id = ? OR block_value = ?`
        ).bind(target, String(target)).run();
        
        if (result.meta && result.meta.changes > 0) {
            return { success: true, message: "החסימה הוסרה בהצלחה ממערכת הניהול." };
        } else {
            return { success: false, error: "לא נמצאה חסימה התואמת לערך זה." };
        }
    }

    async cleanOldLogs() {
        try {
            const cutOffDateStr = getFutureIsraelTimeForDB(-30 * 24 * 60); // לפני 30 ימים בשעון ישראל
            await this.db.prepare(
                `DELETE FROM verification_logs WHERE timestamp < ?`
            ).bind(cutOffDateStr).run();
            return { success: true, message: "נוקו לוגים היסטוריים בהצלחה." };
        } catch (e) {
            return { success: false, message: e.message };
        }
    }
}
