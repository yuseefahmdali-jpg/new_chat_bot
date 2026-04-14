/**
 * storage.js — طبقة قاعدة البيانات (PostgreSQL)
 * ================================================
 * • PostgreSQL عبر node-postgres (pg)
 * • إنشاء تلقائي لجميع الجداول عند التشغيل
 * • دعم كامل لـ: messages, tickets, ticket_messages, users
 * • معالجة شاملة للأخطاء
 */

'use strict';

const { Pool } = require('pg');

// ─── إعداد الاتصال ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[storage] خطأ غير متوقع في connection pool:', err.message);
});

// ─── إنشاء الجداول تلقائياً ─────────────────────────────────────────────────
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id               SERIAL PRIMARY KEY,
        telegram_chat_id TEXT UNIQUE,
        name             TEXT NOT NULL DEFAULT 'زائر',
        created_at       TIMESTAMP NOT NULL DEFAULT NOW()
      );

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

      CREATE TABLE IF NOT EXISTS ticket_messages (
        id         TEXT PRIMARY KEY,
        ticket_id  TEXT NOT NULL,
        sender     TEXT NOT NULL DEFAULT 'user',
        message    TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id)
      );
      CREATE INDEX IF NOT EXISTS idx_tmsg_ticket ON ticket_messages(ticket_id);
    `);

    console.log('[storage] قاعدة البيانات PostgreSQL جاهزة');
  } catch (err) {
    console.error('[storage] فشل إنشاء الجداول:', err.message);
    process.exit(1);
  } finally {
    client.release();
  }
}

initializeDatabase();

// ─── مُوَلِّد معرّفات فريدة ──────────────────────────────────────────────────
function genId(prefix = '') {
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── sanitize ──────────────────────────────────────────────────────────────
function sanitize(value, maxLen = 2000) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim()
    .slice(0, maxLen);
}

// ════════════════════════════════════════════════════════════════════════════
//  STORE — للتوافق مع server.js
// ════════════════════════════════════════════════════════════════════════════
function loadStore() {
  return { conversations: {} };
}

// ════════════════════════════════════════════════════════════════════════════
//  MESSAGES — الدردشة العامة
// ════════════════════════════════════════════════════════════════════════════
async function saveMessage(store, sessionId, message) {
  try {
    const id      = genId('msg-');
    const content = sanitize(String(message.content || ''));
    const role    = sanitize(String(message.role || message.sender_type || 'user'), 30);
    const meta    = message.meta ? JSON.stringify(message.meta) : null;

    await pool.query(
      `INSERT INTO messages (id, session_id, role, sender_type, content, meta)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, String(sessionId).slice(0, 200), role, role, content, meta]
    );
    return id;
  } catch (err) {
    console.error('[storage] saveMessage error:', err.message);
    return null;
  }
}

async function getConversation(store, sessionId) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC`,
      [String(sessionId).slice(0, 200)]
    );
    return rows.map(r => ({
      id:          r.id,
      createdAt:   r.created_at,
      role:        r.role,
      sender_type: r.sender_type,
      content:     r.content,
      meta:        r.meta
        ? (() => { try { return JSON.parse(r.meta); } catch { return null; } })()
        : null,
    }));
  } catch (err) {
    console.error('[storage] getConversation error:', err.message);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  TICKETS
// ════════════════════════════════════════════════════════════════════════════
async function createTicket(userId, username) {
  try {
    const id = genId('TKT-');
    await pool.query(
      `INSERT INTO tickets (id, user_id, username, status) VALUES ($1, $2, $3, 'open')`,
      [id, sanitize(String(userId), 100), sanitize(String(username || 'زائر'), 100)]
    );
    return { id, userId, username, status: 'open', createdAt: new Date().toISOString() };
  } catch (err) {
    console.error('[storage] createTicket error:', err.message);
    return null;
  }
}

async function getTicket(ticketId) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM tickets WHERE id = $1',
      [String(ticketId)]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[storage] getTicket error:', err.message);
    return null;
  }
}

async function getTicketsByUser(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM tickets WHERE user_id = $1 ORDER BY created_at DESC`,
      [String(userId)]
    );
    return rows;
  } catch (err) {
    console.error('[storage] getTicketsByUser error:', err.message);
    return [];
  }
}

async function getOpenTickets() {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM tickets WHERE status = 'open' ORDER BY created_at DESC`
    );
    return rows;
  } catch (err) {
    console.error('[storage] getOpenTickets error:', err.message);
    return [];
  }
}

async function updateTicketStatus(ticketId, status) {
  try {
    await pool.query(
      `UPDATE tickets SET status = $1, updated_at = NOW() WHERE id = $2`,
      [sanitize(status, 20), String(ticketId)]
    );
    return true;
  } catch (err) {
    console.error('[storage] updateTicketStatus error:', err.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  TICKET MESSAGES
// ════════════════════════════════════════════════════════════════════════════
async function saveTicketMessage(ticketId, sender, message) {
  try {
    const id = genId('tmsg-');
    await pool.query(
      `INSERT INTO ticket_messages (id, ticket_id, sender, message) VALUES ($1, $2, $3, $4)`,
      [id, String(ticketId), sanitize(String(sender), 20), sanitize(String(message))]
    );
    return id;
  } catch (err) {
    console.error('[storage] saveTicketMessage error:', err.message);
    return null;
  }
}

async function getTicketMessages(ticketId) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC`,
      [String(ticketId)]
    );
    return rows;
  } catch (err) {
    console.error('[storage] getTicketMessages error:', err.message);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  TELEGRAM USERS
// ════════════════════════════════════════════════════════════════════════════
async function getUserByTelegramId(chatId) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE telegram_chat_id = $1',
      [String(chatId)]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[storage] getUserByTelegramId error:', err.message);
    return null;
  }
}

async function createTelegramUser(chatId, name) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (telegram_chat_id, name)
       VALUES ($1, $2)
       ON CONFLICT (telegram_chat_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [String(chatId), sanitize(String(name || 'زائر'), 100)]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[storage] createTelegramUser error:', err.message);
    return null;
  }
}

async function getOpenTicketByTelegramId(chatId) {
  try {
    const { rows } = await pool.query(
      `SELECT t.* FROM tickets t
       JOIN users u ON t.user_id = u.id::text
       WHERE u.telegram_chat_id = $1 AND t.status = 'open'
       ORDER BY t.created_at DESC
       LIMIT 1`,
      [String(chatId)]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[storage] getOpenTicketByTelegramId error:', err.message);
    return null;
  }
}

async function getTelegramChatIdByUserId(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT telegram_chat_id FROM users WHERE id::text = $1`,
      [String(userId)]
    );
    return rows[0]?.telegram_chat_id || null;
  } catch (err) {
    console.error('[storage] getTelegramChatIdByUserId error:', err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  NOTIFY AGENT — placeholder
// ════════════════════════════════════════════════════════════════════════════
async function notifyAgent(ticket, message) {
  console.log(`[notify] تذكرة #${ticket.id} — "${String(message).slice(0, 60)}"`);
  return { sent: false, reason: 'handled_by_telegram_bot' };
}

// ════════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
  pool,
  loadStore,
  saveMessage,
  getConversation,
  createTicket,
  getTicket,
  getTicketsByUser,
  getOpenTickets,
  updateTicketStatus,
  saveTicketMessage,
  getTicketMessages,
  getUserByTelegramId,
  createTelegramUser,
  getOpenTicketByTelegramId,
  getTelegramChatIdByUserId,
  notifyAgent,
  sanitize,
};
