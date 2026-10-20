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

    `CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        remember INTEGER DEFAULT 0,
        created_at TEXT,
        last_used_at TEXT,
        expires_at TEXT,
        ip TEXT,
        user_agent TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS admin_login_attempts (
        ip TEXT,
        created_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_ip ON admin_login_attempts (ip, created_at)`,

    // קישורים חד-פעמיים במיילים ללקוח (נשמר רק hash של הטוקן) + תיעוד פתיחה
    `CREATE TABLE IF NOT EXISTS chat_email_links (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        message_id INTEGER,
        email TEXT,
        created_at TEXT,
        expires_at TEXT,
        sent_ok INTEGER DEFAULT 0,
        used_at TEXT,
        used_ip TEXT,
        used_user_agent TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chat_email_links_phone ON chat_email_links (phone, message_id)`,

    // מערכת הדיוור: דיוורים, נמען-נמען (עם מעקב פתיחה/הקלקה) והקלקות לפי קישור
    `CREATE TABLE IF NOT EXISTS mail_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        preheader TEXT,
        design TEXT,
        audience TEXT,
        links TEXT,
        status TEXT DEFAULT 'draft',
        scheduled_at TEXT,
        started_at TEXT,
        sent_at TEXT,
        total INTEGER DEFAULT 0,
        sent_ok INTEGER DEFAULT 0,
        sent_fail INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS mail_sends (
        id TEXT PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        phone TEXT,
        email TEXT NOT NULL,
        name TEXT,
        status TEXT DEFAULT 'pending',
        error TEXT,
        created_at TEXT,
        sent_at TEXT,
        opened_at TEXT,
        open_count INTEGER DEFAULT 0,
        clicked_at TEXT,
        click_count INTEGER DEFAULT 0,
        last_ip TEXT,
        last_device TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mail_sends_campaign ON mail_sends (campaign_id, status)`,
    `CREATE TABLE IF NOT EXISTS mail_clicks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        send_id TEXT,
        campaign_id INTEGER,
        link_index INTEGER,
        clicked_at TEXT,
        ip TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mail_clicks_campaign ON mail_clicks (campaign_id)`,

    // קמפיינים: הקלקות וסגירות, וערכות עיצוב שמורות
    `CREATE TABLE IF NOT EXISTS system_message_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        phone TEXT,
        event TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ip TEXT,
        device TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sm_events_msg ON system_message_events (message_id, event)`,
    `CREATE INDEX IF NOT EXISTS idx_sm_logs_msg ON system_message_logs (message_id, phone)`,
    `CREATE TABLE IF NOT EXISTS ad_designs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        bg_color TEXT,
        text_color TEXT,
        design TEXT,
        created_at TEXT,
        updated_at TEXT
    )`,

    // העדפות אישיות של הגרסה החדשה (מסונכרנות בין מכשירים)
    `CREATE TABLE IF NOT EXISTS user_prefs (
        phone TEXT PRIMARY KEY,
        prefs TEXT,
        updated_at TEXT,
        last_v2_at TEXT,
        v2_opens INTEGER DEFAULT 0
    )`,

    // הודעות קוליות: מי ראה את ההודעה ברשימה באתר
    `CREATE TABLE IF NOT EXISTS message_views (
        file_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        first_seen_at TEXT,
        last_seen_at TEXT,
        view_count INTEGER DEFAULT 1,
        PRIMARY KEY (file_id, phone)
    )`,
];

// עמודות שנוספות לטבלאות קיימות. SQLite לא תומך ב-IF NOT EXISTS על עמודות, לכן כל אחת נבדקת בנפרד.
const COLUMNS = [
    ['chat_messages', 'reply_to', 'INTEGER'],
    ['chat_messages', 'edited_at', 'TEXT'],
    // מצב הלשונית של הלקוח: active / hidden / offline
    ['user_presence', 'page_state', 'TEXT'],
    ['user_presence', 'page_state_at', 'TEXT'],
    // מחיקה רכה בצ'אט: עותק שרק המנהל רואה, לשחזור
    ['chat_messages', 'deleted_text', 'TEXT'],
    ['chat_messages', 'deleted_at', 'TEXT'],
    // קבצים מצורפים בצ'אט (נשמרים ב-R2, הטוקן משמש לקישור ההורדה)
    ['chat_messages', 'file_key', 'TEXT'],
    ['chat_messages', 'file_name', 'TEXT'],
    ['chat_messages', 'file_type', 'TEXT'],
    ['chat_messages', 'file_size', 'INTEGER'],
    ['chat_messages', 'file_token', 'TEXT'],
    // מגבלות שהמנהל קבע לקובץ ששלח: מספר צפיות, תוקף, ומעקב צפיות
    ['chat_messages', 'file_max_views', 'INTEGER'],
    ['chat_messages', 'file_views', 'INTEGER DEFAULT 0'],
    ['chat_messages', 'file_expires_at', 'TEXT'],
    ['chat_messages', 'file_last_viewed_at', 'TEXT'],
    // האזנות באתר: כמה פעמים ומתי לאחרונה (השורה נוצרת בהאזנה הראשונה)
    ['message_listens', 'listen_count', 'INTEGER DEFAULT 1'],
    ['message_listens', 'last_listened_at', 'TEXT'],
    // קמפיינים מתקדמים
    ['system_messages', 'placement', 'TEXT'],
    ['system_messages', 'starts_at', 'TEXT'],
    ['system_messages', 'is_paused', 'INTEGER DEFAULT 0'],
    ['system_messages', 'audience', 'TEXT'],
    ['system_messages', 'cta_label', 'TEXT'],
    ['system_messages', 'cta_url', 'TEXT'],
    ['system_messages', 'design', 'TEXT'],
    ['system_message_logs', 'device', 'TEXT'],
];

let ready = null;

export function ensureSchema(env) {
    if (!ready) {
        ready = (async () => {
            await env.DB.batch(STATEMENTS.map(sql => env.DB.prepare(sql)));
            for (const [table, column, type] of COLUMNS) {
                const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
                const cols = info.results || [];
                if (cols.length && !cols.some(c => c.name === column)) {
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
    // פרטיות מול הלקוחות
    admin_show_presence: '1',
    admin_show_typing: '1',
    admin_show_read_receipts: '1',
    // מצב הנוכחות שהמרכז השליטה מדווח (online / away / offline)
    admin_presence_state: '',
    admin_presence_at: '',
    // חשבון האתר היחיד שמורשה להיכנס למרכז השליטה כמנהל-על
    super_admin_phone: '',
};

// הגדרות שהמנהל יכול לערוך ממסך ההגדרות
export const EDITABLE_SETTINGS = ['notify_admin_enabled', 'notify_idle_minutes', 'notify_cooldown_minutes',
    'admin_show_presence', 'admin_show_typing', 'admin_show_read_receipts'];

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
