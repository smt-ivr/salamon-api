export class VerificationSystem {
    // מקבל את מסד הנתונים ואת הטוקן של ימות המשיח (שנמשך מה-env של הפרויקט)
    constructor(db, yemotToken) {
        this.db = db;
        this.yemotToken = yemotToken; 
    }

    // --- פונקציות עזר פנימיות ---

    // כתיבת לוג למסד הנתונים
    async logAction(level, phone, ip, action, details) {
        await this.db.prepare(
            `INSERT INTO verification_logs (level, phone, ip_address, action, details) VALUES (?, ?, ?, ?, ?)`
        ).bind(level, phone || null, ip || null, action, details).run();
    }

    // המרת שניות לטקסט קריא בעברית (לתצוגה למשתמש)
    formatTimeRemaining(seconds) {
        if (seconds < 60) return `${seconds} שניות`;
        const minutes = Math.floor(seconds / 60);
        const remSeconds = seconds % 60;
        if (minutes < 60) {
            return remSeconds > 0 ? `${minutes} דקות ו-${remSeconds} שניות` : `${minutes} דקות`;
        }
        const hours = Math.floor(minutes / 60);
        const remMinutes = minutes % 60;
        return remMinutes > 0 ? `${hours} שעות ו-${remMinutes} דקות` : `${hours} שעות`;
    }

    // חישוב זמן צינון לפי כמות ניסיונות (בדקות) כפי שביקשת
    getCooldownMinutes(attempts) {
        if (attempts === 0) return 0;
        if (attempts === 1) return 2;
        if (attempts === 2) return 10;
        if (attempts === 3) return 20;
        if (attempts === 4) return 30;
        if (attempts === 5) return 40;
        return 60; // מניסיון 6 ומעלה - שעה הפסקה
    }

    // --- פונקציות מרכזיות ---

    // 1. שליחת בקשת אימות (צינתוק)
    async requestVerification(phone, ip, intent = 'register') {
        if (!this.yemotToken) {
            return { success: false, message: "שגיאת שרת: חסר טוקן התחברות לימות המשיח." };
        }

        const now = new Date();
        
        // א. בדיקת חסימות (מנהל/אוטומטי) ל-IP או לטלפון
        const blockCheck = await this.db.prepare(
            `SELECT * FROM verification_blocks 
             WHERE (block_type = 'phone' AND block_value = ?) OR (block_type = 'ip' AND block_value = ?)
             AND (blocked_until IS NULL OR blocked_until > CURRENT_TIMESTAMP)`
        ).bind(phone, ip).first();

        if (blockCheck) {
            let msg = `הגישה נחסמה. סיבה: ${blockCheck.reason || 'ללא סיבה'}.`;
            if (blockCheck.blocked_until) {
                const timeLeft = Math.floor((new Date(blockCheck.blocked_until + 'Z') - now) / 1000);
                msg += ` החסימה תשתחרר בעוד ${this.formatTimeRemaining(timeLeft)}.`;
            } else {
                msg += " החסימה הינה לצמיתות.";
            }
            await this.logAction('BLOCKED', phone, ip, 'SEND_REQUEST', `נחסם עקב רשימה שחורה. מזהה חסימה: ${blockCheck.id}`);
            return { success: false, message: msg };
        }

        // ב. בדיקת היסטוריית ניסיונות (Rate Limiting)
        const recentSession = await this.db.prepare(
            `SELECT * FROM verification_sessions 
             WHERE phone = ? AND created_at > datetime('now', '-1 day')
             ORDER BY created_at DESC LIMIT 1`
        ).bind(phone).first();

        let attemptsCount = 1;

        if (recentSession) {
            // מתאפס רק אם האימות הצליח, אחרת ממשיכים לספור ולהעניש
            if (recentSession.status !== 'verified' && recentSession.status !== 'used') {
                attemptsCount = recentSession.attempts_count + 1;
                const lastAttemptTime = new Date(recentSession.created_at + 'Z');
                const cooldownMinutes = this.getCooldownMinutes(recentSession.attempts_count);
                const nextAllowedTime = new Date(lastAttemptTime.getTime() + cooldownMinutes * 60000);

                if (now < nextAllowedTime) {
                    const timeLeft = Math.floor((nextAllowedTime - now) / 1000);
                    const errorMsg = `נשלחו יותר מדי בקשות. זהו ניסיון מספר ${recentSession.attempts_count}. אנא נסו שוב בעוד ${this.formatTimeRemaining(timeLeft)}.`;
                    await this.logAction('WARN', phone, ip, 'SEND_REQUEST', `הגבלת קצב הופעלה. ניסיון ${attemptsCount}`);
                    return { success: false, message: errorMsg };
                }
            }
        }

        // ג. קריאה ל-API של ימות המשיח
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
            const codeExpiresAt = new Date(now.getTime() + 10 * 60000); // 10 דקות תוקף לקוד הצינתוק

            // ד. שמירה במסד הנתונים
            await this.db.prepare(
                `INSERT INTO verification_sessions (id, phone, ip_address, verify_code, intent, attempts_count, code_expires_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(sessionId, phone, ip, verifyCode, intent, attemptsCount, codeExpiresAt.toISOString()).run();

            await this.logAction('INFO', phone, ip, 'SEND_REQUEST', `צינתוק נשלח בהצלחה. ניסיון ${attemptsCount}`);

            return { 
                success: true, 
                message: `צינתוק אימות נשלח למספר ${phone}. אנא הזינו את 4 הספרות האחרונות מהמספר המצנתק.`,
                sessionId: sessionId // מוחזר ללקוח כדי שישלח אותו בשלב השני
            };

        } catch (error) {
            await this.logAction('ERROR', phone, ip, 'SYSTEM', error.message);
            return { success: false, message: "שגיאת מערכת פנימית בעת ניסיון שליחת הצינתוק." };
        }
    }

    // 2. אימות הקוד שהוזן ויצירת טוקן מאובטח
    async verifyCode(sessionId, phone, ip, code) {
        const session = await this.db.prepare(
            `SELECT * FROM verification_sessions WHERE id = ? AND phone = ? AND status = 'pending'`
        ).bind(sessionId, phone).first();

        if (!session) {
            await this.logAction('WARN', phone, ip, 'VERIFY_CODE', 'סשן לא נמצא או שכבר אינו פעיל');
            return { success: false, message: "בקשת האימות לא נמצאה, פג תוקפה או שכבר אומתה." };
        }

        const now = new Date();
        const expiryTime = new Date(session.code_expires_at + 'Z');

        if (now > expiryTime) {
            await this.db.prepare(`UPDATE verification_sessions SET status = 'expired' WHERE id = ?`).bind(sessionId).run();
            return { success: false, message: "זמן הזנת הקוד פג (עברו יותר מ-10 דקות). אנא בקשו צינתוק מחדש." };
        }

        if (session.verify_attempts >= 3) {
            await this.db.prepare(`UPDATE verification_sessions SET status = 'expired' WHERE id = ?`).bind(sessionId).run();
            await this.logAction('BLOCKED', phone, ip, 'VERIFY_CODE', 'יותר מדי ניסיונות קוד שגויים');
            return { success: false, message: "הוזן קוד שגוי יותר מדי פעמים. הבקשה בוטלה." };
        }

        if (session.verify_code !== code) {
            const newAttempts = session.verify_attempts + 1;
            await this.db.prepare(`UPDATE verification_sessions SET verify_attempts = ? WHERE id = ?`)
                .bind(newAttempts, sessionId).run();
            return { success: false, message: `קוד שגוי. נותרו לך עוד ${3 - newAttempts} ניסיונות.` };
        }

        // --- האימות הצליח! יצירת טוקן ---
        const authToken = crypto.randomUUID();
        let tokenExpiresAt = null;

        if (session.intent === 'register' || session.intent === 'reset') {
            tokenExpiresAt = new Date(now.getTime() + 15 * 60000).toISOString(); // 15 דקות
        } else if (session.intent === 'login') {
            // מחיקת טוקנים קודמים של כניסה למספר הזה, ככה שיש רק סשן פעיל אחד
            await this.db.prepare(
                `UPDATE verification_sessions SET status = 'expired' WHERE phone = ? AND intent = 'login' AND status = 'verified'`
            ).bind(phone).run();
        }

        await this.db.prepare(
            `UPDATE verification_sessions SET status = 'verified', auth_token = ?, token_expires_at = ?, ip_address = ? WHERE id = ?`
        ).bind(authToken, tokenExpiresAt, ip, sessionId).run();

        await this.logAction('INFO', phone, ip, 'VERIFY_SUCCESS', `אימות הצליח, הונפק טוקן (סוג: ${session.intent})`);

        return {
            success: true,
            message: "הטלפון אומת בהצלחה!",
            token: authToken,
            intent: session.intent
        };
    }

    // 3. ניקוי לוגים מעל 30 יום (כפי שביקשת, לא נוגע במה שבתוך ה-30 יום)
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
