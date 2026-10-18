-- 0001_chat_activity_name_locks.sql
-- תיעוד בלבד: הטבלאות נוצרות אוטומטית ע"י schema.js בהפעלה הראשונה של ה-Worker.
-- ניתן גם להריץ ידנית: wrangler d1 execute salamon --remote --file migrations/0001_chat_activity_name_locks.sql

CREATE TABLE IF NOT EXISTS user_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT,
        action TEXT NOT NULL,
        details TEXT,
        ip TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_user_activity_phone ON user_activity (phone, created_at);

CREATE INDEX IF NOT EXISTS idx_user_activity_created ON user_activity (created_at);

CREATE TABLE IF NOT EXISTS user_presence (
        phone TEXT PRIMARY KEY,
        last_seen_at TEXT,
        last_ip TEXT,
        last_user_agent TEXT,
        last_login_at TEXT,
        last_login_method TEXT
    );

CREATE TABLE IF NOT EXISTS chat_threads (
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
    );

CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT
    );

CREATE TABLE IF NOT EXISTS name_locks (
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
    );

CREATE INDEX IF NOT EXISTS idx_chat_messages_phone_id ON chat_messages (user_phone, id);

-- עמודה חדשה לציטוט הודעות (להריץ פעם אחת בלבד)
ALTER TABLE chat_messages ADD COLUMN reply_to INTEGER;
ALTER TABLE chat_messages ADD COLUMN edited_at TEXT;
