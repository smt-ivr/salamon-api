import { checkPhoneStatus } from './yemot.js';

export class VerificationSystem {
    constructor(db, yemotToken) {
        this.db = db;
        this.yemotToken = yemotToken; 
    }

    // כתיבת לוג למערכת המעקב
    async logAction(level, phone, ip, action, details) {
        await this.db.prepare(
            `INSERT INTO verification_logs (level, phone, ip_address, action, details) VALUES (?, ?, ?, ?, ?)`
        ).bind(level, phone || null, ip || null, action, details).run();
    }

    // פונקציית עזר להמרת זמן (תומכת כעת גם בימים)
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

    // 1. שליחת בקשת אימות
    async requestVerification(phone, ip, intent = 'register') {
        if (!this.yemotToken) {
            return { success: false, message: "שגיאת שרת: חסר טוקן התחברות לימות המשיח." };
        }

        const now = new Date();

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
             AND (blocked_until IS NULL OR blocked_until > CURRENT_TIMESTAMP)`
        ).bind(phone, ip).first();

        if (blockCheck) {
            let msg = `הפעולה נחסמה על ידי ההנהלה. סיבה: ${blockCheck.reason || 'ללא סיבה'}.`;
            if (blockCheck.blocked_until) {
                // תיקון באג ה-NaN: הוספת T לפני חישוב אזור הזמן Z
                const safeDateStr = blockCheck.blocked_until.replace(' ', 'T') + 'Z';
                const timeLeft = Math.floor((new Date(safeDateStr) - now) / 1000);
                msg += ` החסימה תשתחרר בעוד ${this.formatTimeRemaining(timeLeft)}.`;
            } else {
                msg += " החסימה הינה לצמיתות.";
            }
            await this.logAction('BLOCKED', phone, ip, 'SEND_REQUEST', `נחסם עקב רשימה שחורה`);
            return { success: false, message: msg };
        }

        // --- שלב 4: בדיקת היסטוריית ניסיונות (Rate Limiting) ---
        const recentSession = await this.db.prepare(
            `SELECT * FROM verification_sessions 
             WHERE phone = ? AND created_at > datetime('now', '-1 day')
             ORDER BY created_at DESC LIMIT 1`
        ).bind(phone).first();

        let attemptsCount = 1;

        if (recentSession) {
            if (recentSession.status !== 'verified' && recentSession.status !== 'used') {
                attemptsCount = recentSession.attempts_count + 1;
                // תיקון תאימות תאריך עבור sqlite
                const safeLastAttempt = recentSession.created_at.replace(' ', 'T') + 'Z';
                const lastAttemptTime = new Date(safeLastAttempt);
                const cooldownMinutes = this.getCooldownMinutes(recentSession.attempts_count);
                const nextAllowedTime = new Date(lastAttemptTime.getTime() + cooldownMinutes * 60000);

                if (now < nextAllowedTime) {
                    const timeLeft = Math.floor((nextAllowedTime - now) / 1000);
                    const errorMsg = `נשלחו יותר מדי בקשות. זהו ניסיון מספר ${recentSession.attempts_count}. אנא נסו שוב בעוד ${this.formatTimeRemaining(timeLeft)}.`;
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
            const codeExpiresAt = new Date(now.getTime() + 10 * 60000); // 10 דקות תוקף

            await this.db.prepare(
                `INSERT INTO verification_sessions (id, phone, ip_address, verify_code, intent, attempts_count, code_expires_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(sessionId, phone, ip, verifyCode, intent, attemptsCount, codeExpiresAt.toISOString().replace('T', ' ').substring(0, 19)).run();

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

    // 2. אימות הקוד
    async verifyCode(sessionId, phone, ip, code) {
        const session = await this.db.prepare(
            `SELECT * FROM verification_sessions WHERE id = ? AND phone = ? AND status = 'pending'`
        ).bind(sessionId, phone).first();

        if (!session) {
            return { success: false, message: "בקשת האימות לא נמצאה, פג תוקפה או שכבר אומתה." };
        }

        const now = new Date();
        const safeExpiry = session.code_expires_at.replace(' ', 'T') + 'Z';
        const expiryTime = new Date(safeExpiry);

        if (now > expiryTime) {
            await this.db.prepare(`UPDATE verification_sessions SET status = 'expired' WHERE id = ?`).bind(sessionId).run();
            return { success: false, message: "זמן הזנת הקוד פג (עברו יותר מ-10 דקות). אנא בקשו צינתוק מחדש." };
        }

        if (session.verify_code !== code) {
            const newAttempts = session.verify_attempts + 1;
            
            // עד 5 ניסיונות
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
        let tokenExpiresAt = null;

        if (session.intent === 'register' || session.intent === 'reset') {
            const tokenTime = new Date(now.getTime() + 15 * 60000);
            tokenExpiresAt = tokenTime.toISOString().replace('T', ' ').substring(0, 19);
        } else if (session.intent === 'login') {
            await this.db.prepare(
                `UPDATE verification_sessions SET status = 'expired' WHERE phone = ? AND intent = 'login' AND status = 'verified'`
            ).bind(phone).run();
        }

        await this.db.prepare(
            `UPDATE verification_sessions SET status = 'verified', auth_token = ?, token_expires_at = ?, ip_address = ? WHERE id = ?`
        ).bind(authToken, tokenExpiresAt, ip, sessionId).run();

        await this.logAction('INFO', phone, ip, 'VERIFY_SUCCESS', `אימות הצליח (סוג: ${session.intent})`);

        return {
            success: true,
            message: "הטלפון אומת בהצלחה!",
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
            const now = new Date();
            let ms = 0;
            // חישוב המרה לפי היחידה הנבחרת
            if (durationUnit === 'seconds') ms = durationValue * 1000;
            else if (durationUnit === 'minutes') ms = durationValue * 60000;
            else if (durationUnit === 'hours') ms = durationValue * 3600000;
            else if (durationUnit === 'days') ms = durationValue * 86400000;
            else if (durationUnit === 'months') ms = durationValue * 30 * 86400000; // חודש = 30 ימים
            
            const futureDate = new Date(now.getTime() + ms);
            blockedUntil = futureDate.toISOString().replace('T', ' ').substring(0, 19);
        }

        // בדיקה האם כבר קיימת חסימה למספר/כתובת הזה (במקום לשכפל - נעדכן)
        const existing = await this.db.prepare(
            `SELECT id FROM verification_blocks WHERE block_type = ? AND block_value = ?`
        ).bind(type, value).first();
        
        if (existing) {
            await this.db.prepare(
                `UPDATE verification_blocks SET reason = ?, blocked_until = ? WHERE id = ?`
            ).bind(reason, blockedUntil, existing.id).run();
            await this.logAction('INFO', value, ip, 'ADMIN_BLOCK_UPDATE', `חסימה קיימת עברה עדכון (זמן: ${durationValue || 'צמיתות'} ${durationUnit || ''})`);
            return { success: true, message: `החסימה עבור ${value} עודכנה בהצלחה במערכת.` };
        } else {
            await this.db.prepare(
                `INSERT INTO verification_blocks (block_type, block_value, reason, blocked_until) VALUES (?, ?, ?, ?)`
            ).bind(type, value, reason, blockedUntil).run();
            await this.logAction('INFO', value, ip, 'ADMIN_BLOCK_CREATE', `חסימה חדשה נוצרה`);
            return { success: true, message: `החסימה עבור ${value} נוצרה בהצלחה במערכת.` };
        }
    }

    async unblockTarget(target, ip) {
        // יכול לקבל או ID מספר של שורה, או טקסט שזה למעשה ה-IP / טלפון בעצמו.
        const result = await this.db.prepare(
            `DELETE FROM verification_blocks WHERE id = ? OR block_value = ?`
        ).bind(target, String(target)).run();
        
        if (result.meta && result.meta.changes > 0) {
            await this.logAction('INFO', String(target), ip, 'ADMIN_UNBLOCK', `חסימה הוסרה`);
            return { success: true, message: "החסימה הוסרה בהצלחה ממערכת הניהול." };
        } else {
            return { success: false, error: "לא נמצאה חסימה התואמת לערך זה (ניתן להזין ID, טלפון או IP)." };
        }
    }

    async cleanOldLogs() {
        try {
            const result = await this.db.prepare(
                `DELETE FROM verification_logs WHERE timestamp < datetime('now', '-30 days')`
            ).run();
            return { success: true, message: "נוקו לוגים היסטוריים." };
        } catch (e) {
            return { success: false, message: e.message };
        }
    }
}
