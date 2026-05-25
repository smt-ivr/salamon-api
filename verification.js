import { checkPhoneStatus } from './yemot.js';

export class VerificationSystem {
    constructor(db, yemotToken) {
        this.db = db;
        this.yemotToken = yemotToken; 
    }

    // כתיבת לוג
    async logAction(level, phone, ip, action, details) {
        await this.db.prepare(
            `INSERT INTO verification_logs (level, phone, ip_address, action, details) VALUES (?, ?, ?, ?, ?)`
        ).bind(level, phone || null, ip || null, action, details).run();
    }

    formatTimeRemaining(seconds) {
        if (seconds < 60) return `${seconds} שניות`;
        const minutes = Math.floor(seconds / 60);
        const remSeconds = seconds % 60;
        if (minutes < 60) return remSeconds > 0 ? `${minutes} דקות ו-${remSeconds} שניות` : `${minutes} דקות`;
        const hours = Math.floor(minutes / 60);
        const remMinutes = minutes % 60;
        return remMinutes > 0 ? `${hours} שעות ו-${remMinutes} דקות` : `${hours} שעות`;
    }

    getCooldownMinutes(attempts) {
        if (attempts === 0) return 0;
        if (attempts === 1) return 2;
        if (attempts === 2) return 10;
        if (attempts === 3) return 20;
        if (attempts === 4) return 30;
        if (attempts === 5) return 40;
        return 60;
    }

    // 1. שליחת בקשת אימות (כולל לוגיקה עסקית מלאה)
    async requestVerification(phone, ip, intent = 'register') {
        if (!this.yemotToken) {
            return { success: false, message: "שגיאת שרת: חסר טוקן התחברות לימות המשיח." };
        }

        const now = new Date();

        // --- שלב 1: לוגיקה עסקית (חסימה לפי מטרת הפעולה) ---
        
        // א. בדיקה האם המשתמש כבר רשום במערכת שלנו
        const existingUser = await this.db.prepare("SELECT 1 FROM users WHERE phone = ?").bind(phone).first();
        
        if (intent === 'register' && existingUser) {
            await this.logAction('WARN', phone, ip, 'SEND_REJECTED', 'ניסיון צינתוק להרשמה למספר שכבר קיים');
            return { success: false, message: "מספר הטלפון הזה כבר רשום במערכת. אנא התחברו או בצעו איפוס סיסמה." };
        }
        
        if ((intent === 'login' || intent === 'reset') && !existingUser) {
            await this.logAction('WARN', phone, ip, 'SEND_REJECTED', `ניסיון צינתוק ל${intent} למספר שאינו רשום`);
            return { success: false, message: "המספר אינו רשום במערכת. עליכם לבצע הרשמה קודם." };
        }

        // ב. בדיקה בימות המשיח האם המספר מורשה ברשימת הצינתוקים
        const phoneStatus = await checkPhoneStatus(phone, this.yemotToken);
        if (!phoneStatus.exists) {
            await this.logAction('BLOCKED', phone, ip, 'SEND_REJECTED', 'המספר אינו מורשה במערכת ימות המשיח');
            return { success: false, message: "המספר אינו מורשה לקבל צינתוקים. עליכם לאשר קבלת צינתוקים במערכת הטלפונית." };
        }

        // --- שלב 2: מנגנוני הגנה נגד ספאם וחסימות ---

        const blockCheck = await this.db.prepare(
            `SELECT * FROM verification_blocks 
             WHERE (block_type = 'phone' AND block_value = ?) OR (block_type = 'ip' AND block_value = ?)
             AND (blocked_until IS NULL OR blocked_until > CURRENT_TIMESTAMP)`
        ).bind(phone, ip).first();

        if (blockCheck) {
            let msg = `הפעולה נחסמה על ידי ההנהלה. סיבה: ${blockCheck.reason || 'ללא סיבה'}.`;
            if (blockCheck.blocked_until) {
                const timeLeft = Math.floor((new Date(blockCheck.blocked_until + 'Z') - now) / 1000);
                msg += ` החסימה תשתחרר בעוד ${this.formatTimeRemaining(timeLeft)}.`;
            } else {
                msg += " החסימה הינה לצמיתות.";
            }
            await this.logAction('BLOCKED', phone, ip, 'SEND_REQUEST', `נחסם - מזהה: ${blockCheck.id}`);
            return { success: false, message: msg };
        }

        const recentSession = await this.db.prepare(
            `SELECT * FROM verification_sessions 
             WHERE phone = ? AND created_at > datetime('now', '-1 day')
             ORDER BY created_at DESC LIMIT 1`
        ).bind(phone).first();

        let attemptsCount = 1;
        if (recentSession && recentSession.status !== 'verified' && recentSession.status !== 'used') {
            attemptsCount = recentSession.attempts_count + 1;
            const lastAttemptTime = new Date(recentSession.created_at + 'Z');
            const cooldownMinutes = this.getCooldownMinutes(recentSession.attempts_count);
            const nextAllowedTime = new Date(lastAttemptTime.getTime() + cooldownMinutes * 60000);

            if (now < nextAllowedTime) {
                const timeLeft = Math.floor((nextAllowedTime - now) / 1000);
                const errorMsg = `נשלחו יותר מדי בקשות. נסו שוב בעוד ${this.formatTimeRemaining(timeLeft)}.`;
                await this.logAction('WARN', phone, ip, 'RATE_LIMIT', `הגבלת קצב. ניסיון ${attemptsCount}`);
                return { success: false, message: errorMsg };
            }
        }

        // --- שלב 3: שליחה לימות ושמירה ---
        try {
            const yemotUrl = `https://www.call2all.co.il/ym/api/RunTzintuk?token=${this.yemotToken}&callerId=RAND&TzintukTimeOut=16&phones=${phone}`;
            const yemotResponse = await fetch(yemotUrl);
            const yemotData = await yemotResponse.json();

            if (yemotData.responseStatus !== "OK") {
                await this.logAction('ERROR', phone, ip, 'YEMOT_API', `שגיאה מימות: ${JSON.stringify(yemotData)}`);
                return { success: false, message: "אירעה שגיאה בשליחת הצינתוק." };
            }

            const verifyCode = yemotData.verifyCode;
            const sessionId = crypto.randomUUID();
            const codeExpiresAt = new Date(now.getTime() + 10 * 60000); 

            await this.db.prepare(
                `INSERT INTO verification_sessions (id, phone, ip_address, verify_code, intent, attempts_count, code_expires_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(sessionId, phone, ip, verifyCode, intent, attemptsCount, codeExpiresAt.toISOString()).run();

            await this.logAction('INFO', phone, ip, 'SEND_REQUEST', `צינתוק נשלח בהצלחה. סוג: ${intent}`);
            return { 
                success: true, 
                message: `צינתוק אימות נשלח למספר ${phone}. אנא הזינו את 4 הספרות האחרונות מהמספר המצנתק.`,
                sessionId: sessionId
            };

        } catch (error) {
            await this.logAction('ERROR', phone, ip, 'SYSTEM', error.message);
            return { success: false, message: "שגיאת מערכת בעת שליחת הצינתוק." };
        }
    }

    // 2. אימות קוד
    async verifyCode(sessionId, phone, ip, code) {
        const session = await this.db.prepare(
            `SELECT * FROM verification_sessions WHERE id = ? AND phone = ? AND status = 'pending'`
        ).bind(sessionId, phone).first();

        if (!session) return { success: false, message: "בקשת האימות לא נמצאה או פג תוקפה." };

        const now = new Date();
        if (now > new Date(session.code_expires_at + 'Z')) {
            await this.db.prepare(`UPDATE verification_sessions SET status = 'expired' WHERE id = ?`).bind(sessionId).run();
            return { success: false, message: "זמן הזנת הקוד פג (10 דקות). בקשו מחדש." };
        }

        if (session.verify_attempts >= 3) {
            await this.db.prepare(`UPDATE verification_sessions SET status = 'expired' WHERE id = ?`).bind(sessionId).run();
            return { success: false, message: "הוזן קוד שגוי יותר מדי פעמים. הבקשה בוטלה." };
        }

        if (session.verify_code !== code) {
            const newAttempts = session.verify_attempts + 1;
            await this.db.prepare(`UPDATE verification_sessions SET verify_attempts = ? WHERE id = ?`).bind(newAttempts, sessionId).run();
            return { success: false, message: `קוד שגוי. נותרו לך עוד ${3 - newAttempts} ניסיונות.` };
        }

        const authToken = crypto.randomUUID();
        let tokenExpiresAt = null;

        if (session.intent === 'register' || session.intent === 'reset') {
            tokenExpiresAt = new Date(now.getTime() + 15 * 60000).toISOString();
        } else if (session.intent === 'login') {
            await this.db.prepare(`UPDATE verification_sessions SET status = 'expired' WHERE phone = ? AND intent = 'login' AND status = 'verified'`).bind(phone).run();
        }

        await this.db.prepare(
            `UPDATE verification_sessions SET status = 'verified', auth_token = ?, token_expires_at = ?, ip_address = ? WHERE id = ?`
        ).bind(authToken, tokenExpiresAt, ip, sessionId).run();

        await this.logAction('INFO', phone, ip, 'VERIFY_SUCCESS', `אימות עבר. טוקן הונפק עבור: ${session.intent}`);
        return { success: true, message: "הטלפון אומת בהצלחה!", token: authToken, intent: session.intent };
    }

    // --- פעולות הנהלה (ADMIN) ---

    async getLogs() {
        const { results } = await this.db.prepare(`SELECT * FROM verification_logs ORDER BY timestamp DESC LIMIT 100`).all();
        return { success: true, logs: results };
    }

    async getBlocks() {
        const { results } = await this.db.prepare(`SELECT * FROM verification_blocks ORDER BY created_at DESC`).all();
        return { success: true, blocks: results };
    }

    async blockTarget(type, value, reason, durationMinutes, adminIp) {
        const now = new Date();
        let blockedUntil = null;
        if (durationMinutes && durationMinutes > 0) {
            blockedUntil = new Date(now.getTime() + durationMinutes * 60000).toISOString();
        }
        await this.db.prepare(
            `INSERT INTO verification_blocks (block_type, block_value, reason, blocked_until) VALUES (?, ?, ?, ?)`
        ).bind(type, value, reason, blockedUntil).run();
        
        await this.logAction('WARN', null, adminIp, 'ADMIN_BLOCK', `הוספה חסימה ל-${type}: ${value}`);
        return { success: true, message: "החסימה נוצרה בהצלחה." };
    }

    async unblockTarget(id, adminIp) {
        await this.db.prepare(`DELETE FROM verification_blocks WHERE id = ?`).bind(id).run();
        await this.logAction('INFO', null, adminIp, 'ADMIN_UNBLOCK', `הוסרה חסימה מספר: ${id}`);
        return { success: true, message: "החסימה הוסרה." };
    }

    async cleanOldLogs() {
        await this.db.prepare(`DELETE FROM verification_logs WHERE timestamp < datetime('now', '-30 days')`).run();
        return { success: true, message: "נוקו לוגים היסטוריים." };
    }
}
