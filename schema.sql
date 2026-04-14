-- ============================================================
-- schema.sql — PostgreSQL Schema
-- Smart Chat Bot — نظام الدردشة والتذاكر
-- ============================================================
-- تشغيل: psql $DATABASE_URL -f schema.sql
-- ملاحظة: يتم إنشاء الجداول تلقائياً عند أول تشغيل للسيرفر
-- ============================================================

-- مستخدمو Telegram
CREATE TABLE IF NOT EXISTS users (
  id               SERIAL PRIMARY KEY,
  telegram_chat_id TEXT UNIQUE,
  name             TEXT NOT NULL DEFAULT 'زائر',
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- رسائل الدردشة العامة
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'user',
  sender_type TEXT NOT NULL DEFAULT 'user',
  content     TEXT NOT NULL,
  meta        TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

-- جدول التذاكر
CREATE TABLE IF NOT EXISTS tickets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL DEFAULT 'زائر',
  status     TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tickets_user   ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

-- رسائل التذاكر
CREATE TABLE IF NOT EXISTS ticket_messages (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL,
  sender     TEXT NOT NULL DEFAULT 'user',
  message    TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id)
);
CREATE INDEX IF NOT EXISTS idx_tmsg_ticket ON ticket_messages(ticket_id);
