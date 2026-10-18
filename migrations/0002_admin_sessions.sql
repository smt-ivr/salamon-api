-- 0002_admin_sessions.sql
-- תיעוד בלבד: נוצר אוטומטית ע"י schema.js

CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        remember INTEGER DEFAULT 0,
        created_at TEXT,
        last_used_at TEXT,
        expires_at TEXT,
        ip TEXT,
        user_agent TEXT
    );

CREATE TABLE IF NOT EXISTS admin_login_attempts (
        ip TEXT,
        created_at TEXT
    );

CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_ip ON admin_login_attempts (ip, created_at);
