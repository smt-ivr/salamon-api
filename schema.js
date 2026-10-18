// schema.js
// יצירת הטבלאות של מערכות הצ'אט, המעקב ונעילות השמות.
// רץ פעם אחת לכל מופע של ה-Worker, כך שאין צורך להריץ מיגרציות ידנית.

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS user_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT,
        action TEXT NOT NULL,
        details TEXT,
        ip TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_user_activity_phone ON user_activity (phone, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_user_activity_created ON user_activity (created_at)`,

    `CREATE TABLE IF NOT EXISTS user_presence (
        phone TEXT PRIMARY KEY,
        last_seen_at TEXT,
        last_ip TEXT,
        last_user_agent TEXT,
        last_login_at TEXT,
        last_login_method TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS chat_threads (
        user_phone TEXT PRIMARY KEY,
        user_typing_at TEXT,
        admin_typing_at TEXT,
        pinned INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        note TEXT DEFAULT '',
        admin_notified_at TEXT,
        user_notified_at TEXT,
        user_seen_at TEXT,
        updated_at TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS name_locks (
        phone TEXT PRIMARY KEY,
        locked_name TEXT,
        mode TEXT NOT NULL DEFAULT 'staff',
        starts_at TEXT,
        expires_at TEXT,
        reason TEXT DEFAULT '',
        created_at TEXT,
        updated_at TEXT,
        last_enforced_at TEXT,
        enforce_count INTEGER DEFAULT 0
    )`,

    `CREATE INDEX IF NOT EXISTS idx_chat_messages_phone_id ON chat_messages (user_phone, id)`,
];

// עמודות שנוספות לטבלאות קיימות. SQLite לא תומך ב-IF NOT EXISTS על עמודות, לכן כל אחת נבדקת בנפרד.
const COLUMNS = [
    ['chat_messages', 'reply_to', 'INTEGER'],
    ['chat_messages', 'edited_at', 'TEXT'],
];

let ready = null;

export function ensureSchema(env) {
    if (!ready) {
        ready = (async () => {
            await env.DB.batch(STATEMENTS.map(sql => env.DB.prepare(sql)));
            for (const [table, column, type] of COLUMNS) {
                const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
                if (!(info.results || []).some(c => c.name === column)) {
                    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
                }
            }
        })().catch(err => {
            ready = null; // ניסיון חוזר בבקשה הבאה
            throw err;
        });
    }
    return ready;
}

// ---------- הגדרות מערכת (key/value) ----------

export const SETTING_DEFAULTS = {
    notify_admin_enabled: '1',
    notify_admin_email: '',
    notify_idle_minutes: '5',
    notify_cooldown_minutes: '30',
    customer_email_mode: 'auto',
    customer_offline_minutes: '3',
    admin_last_active_at: '',
};

export async function getSettings(env) {
    const { results } = await env.DB.prepare("SELECT key, value FROM app_settings").all();
    const out = { ...SETTING_DEFAULTS };
    for (const row of results || []) out[row.key] = row.value ?? '';
    return out;
}

export async function setSettings(env, values, now) {
    const entries = Object.entries(values);
    if (!entries.length) return;
    await env.DB.batch(entries.map(([key, value]) =>
        env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
            .bind(key, String(value ?? ''), now)
    ));
}
