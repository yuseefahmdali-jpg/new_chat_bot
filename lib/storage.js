'use strict';

const { Pool } = require('pg');
const crypto = require('crypto');

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

function genId(prefix = '') {
  if (crypto.randomUUID) {
    return `${prefix}${crypto.randomUUID()}`;
  }
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitize(value, maxLen = 2000) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim()
    .slice(0, maxLen);
}

function parseMeta(meta) {
  if (!meta) return null;
  if (typeof meta === 'object') return meta;
  try {
    return JSON.parse(meta);
  } catch {
    return null;
  }
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    name: row.name || 'زائر',
    email: row.email || '',
    deviceKey: row.device_key || null,
    sessionId: row.session_id || null,
    telegramChatId: row.telegram_chat_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

let databaseReadyPromise = null;

async function initializeDatabase() {
  if (databaseReadyPromise) return databaseReadyPromise;

  databaseReadyPromise = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id               SERIAL PRIMARY KEY,
          telegram_chat_id TEXT UNIQUE,
          device_key       TEXT UNIQUE,
          session_id       TEXT UNIQUE,
          name             TEXT NOT NULL DEFAULT 'زائر',
          email            TEXT,
          created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at       TIMESTAMP NOT NULL DEFAULT NOW(),
          last_seen_at     TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS messages (
          id          TEXT PRIMARY KEY,
          user_id     INTEGER,
          session_id  TEXT NOT NULL,
          role        TEXT NOT NULL DEFAULT 'user',
          sender_type TEXT NOT NULL DEFAULT 'user',
          content     TEXT NOT NULL,
          meta        JSONB,
          created_at  TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS tickets (
          id         TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL,
          session_id TEXT,
          username   TEXT NOT NULL DEFAULT 'زائر',
          status     TEXT NOT NULL DEFAULT 'open',
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS ticket_messages (
          id         TEXT PRIMARY KEY,
          ticket_id  TEXT NOT NULL,
          sender     TEXT NOT NULL DEFAULT 'user',
          message    TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS device_key TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS session_id TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
        ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP NOT NULL DEFAULT NOW();

        ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id INTEGER;

        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS session_id TEXT;
      `);

      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_chat_id ON users(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_device_key ON users(device_key) WHERE device_key IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_session_id ON users(session_id) WHERE session_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
        CREATE INDEX IF NOT EXISTS idx_messages_user_session ON messages(user_id, session_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_session ON tickets(session_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
        CREATE INDEX IF NOT EXISTS idx_tmsg_ticket ON ticket_messages(ticket_id);
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'fk_messages_user'
          ) THEN
            ALTER TABLE messages
              ADD CONSTRAINT fk_messages_user
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
          END IF;
        EXCEPTION WHEN duplicate_object THEN
          NULL;
        END $$;
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_messages_ticket'
          ) THEN
            ALTER TABLE ticket_messages
              ADD CONSTRAINT fk_ticket_messages_ticket
              FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
          END IF;
        EXCEPTION WHEN duplicate_object THEN
          NULL;
        END $$;
      `);

      await client.query(`
        UPDATE users
        SET session_id = COALESCE(session_id, CONCAT('legacy-session-', id)),
            updated_at = NOW(),
            last_seen_at = NOW()
        WHERE device_key IS NOT NULL AND (session_id IS NULL OR session_id = '');
      `);

      await client.query('COMMIT');
      console.log('[storage] قاعدة البيانات PostgreSQL جاهزة');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[storage] فشل إنشاء/ترقية الجداول:', err.message);
      throw err;
    } finally {
      client.release();
    }
  })();

  return databaseReadyPromise;
}

async function ensureDatabaseReady() {
  return initializeDatabase();
}

initializeDatabase().catch((err) => {
  console.error('[storage] database init fatal:', err.message);
  process.exit(1);
});

function loadStore() {
  return { conversations: {} };
}

async function getUserById(userId) {
  await ensureDatabaseReady();
  const numericId = Number(userId);
  if (!Number.isInteger(numericId)) return null;

  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [numericId]);
  return mapUser(rows[0] || null);
}

async function getUserByDeviceKey(deviceKey) {
  await ensureDatabaseReady();
  const cleanKey = sanitize(String(deviceKey || ''), 200);
  if (!cleanKey) return null;

  const { rows } = await pool.query('SELECT * FROM users WHERE device_key = $1 LIMIT 1', [cleanKey]);
  return mapUser(rows[0] || null);
}

async function getUserBySessionId(sessionId) {
  await ensureDatabaseReady();
  const cleanSessionId = sanitize(String(sessionId || ''), 200);
  if (!cleanSessionId) return null;

  const { rows } = await pool.query('SELECT * FROM users WHERE session_id = $1 LIMIT 1', [cleanSessionId]);
  return mapUser(rows[0] || null);
}

async function createOrGetWebUser(payload = {}) {
  await ensureDatabaseReady();

  const deviceKey = sanitize(String(payload.deviceKey || ''), 200);
  const name = sanitize(String(payload.name || 'زائر'), 100) || 'زائر';
  const email = sanitize(String(payload.email || ''), 200) || null;
  const requestedSessionId = sanitize(String(payload.sessionId || ''), 200);

  if (!deviceKey) {
    throw new Error('device_key_required');
  }

  const existing = await getUserByDeviceKey(deviceKey);
  if (existing) {
    const stableSessionId = existing.sessionId || requestedSessionId || genId('sess-');
    const { rows } = await pool.query(
      `UPDATE users
       SET name = CASE WHEN $2 <> '' THEN $2 ELSE name END,
           email = COALESCE($3, email),
           session_id = COALESCE(NULLIF(session_id, ''), $4),
           updated_at = NOW(),
           last_seen_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [Number(existing.id), name, email, stableSessionId]
    );

    return {
      user: mapUser(rows[0]),
      isNewUser: false,
    };
  }

  const sessionId = requestedSessionId || genId('sess-');
  const { rows } = await pool.query(
    `INSERT INTO users (device_key, session_id, name, email, updated_at, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING *`,
    [deviceKey, sessionId, name, email]
  );

  return {
    user: mapUser(rows[0]),
    isNewUser: true,
  };
}

async function touchUser(userId) {
  await ensureDatabaseReady();
  const numericId = Number(userId);
  if (!Number.isInteger(numericId)) return null;

  const { rows } = await pool.query(
    `UPDATE users
     SET updated_at = NOW(), last_seen_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [numericId]
  );

  return mapUser(rows[0] || null);
}

async function saveMessage(arg1, arg2, arg3) {
  await ensureDatabaseReady();

  let payload = null;
  if (typeof arg3 !== 'undefined') {
    payload = Object.assign({}, arg3 || {}, { sessionId: arg2 });
  } else {
    payload = arg1 || {};
  }

  const id = genId('msg-');
  const userId = payload.userId ? Number(payload.userId) : null;
  const sessionId = sanitize(String(payload.sessionId || ''), 200);
  const role = sanitize(String(payload.role || payload.sender_type || 'user'), 30) || 'user';
  const senderType = sanitize(String(payload.senderType || payload.sender_type || role), 30) || role;
  const content = sanitize(String(payload.content || ''), 5000);
  const meta = payload.meta ? JSON.stringify(payload.meta) : null;

  if (!sessionId || !content) {
    return null;
  }

  await pool.query(
    `INSERT INTO messages (id, user_id, session_id, role, sender_type, content, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [id, Number.isInteger(userId) ? userId : null, sessionId, role, senderType, content, meta]
  );

  return id;
}

async function getConversation(arg1, arg2) {
  await ensureDatabaseReady();

  let filters = {};
  if (typeof arg2 !== 'undefined') {
    filters = { sessionId: arg2 };
  } else if (typeof arg1 === 'string') {
    filters = { sessionId: arg1 };
  } else {
    filters = arg1 || {};
  }

  const userId = filters.userId ? Number(filters.userId) : null;
  const sessionId = sanitize(String(filters.sessionId || ''), 200);

  const where = [];
  const values = [];

  if (Number.isInteger(userId)) {
    values.push(userId);
    where.push(`user_id = $${values.length}`);
  }

  if (sessionId) {
    values.push(sessionId);
    where.push(`session_id = $${values.length}`);
  }

  if (!where.length) return [];

  const { rows } = await pool.query(
    `SELECT *
     FROM messages
     WHERE ${where.join(' AND ')}
     ORDER BY created_at ASC, id ASC`,
    values
  );

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id != null ? String(row.user_id) : null,
    sessionId: row.session_id,
    createdAt: row.created_at,
    role: row.role,
    sender_type: row.sender_type,
    content: row.content,
    meta: parseMeta(row.meta),
  }));
}

async function createTicket(userId, username, sessionId = null) {
  await ensureDatabaseReady();
  const id = genId('TKT-');
  const cleanUserId = sanitize(String(userId || ''), 100);
  const cleanSessionId = sanitize(String(sessionId || ''), 200) || null;
  const cleanUsername = sanitize(String(username || 'زائر'), 100) || 'زائر';

  await pool.query(
    `INSERT INTO tickets (id, user_id, session_id, username, status)
     VALUES ($1, $2, $3, $4, 'open')`,
    [id, cleanUserId, cleanSessionId, cleanUsername]
  );

  return {
    id,
    user_id: cleanUserId,
    session_id: cleanSessionId,
    username: cleanUsername,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
}

async function getTicket(ticketId) {
  await ensureDatabaseReady();
  const { rows } = await pool.query('SELECT * FROM tickets WHERE id = $1 LIMIT 1', [String(ticketId)]);
  return rows[0] || null;
}

async function getTicketsByUser(userId) {
  await ensureDatabaseReady();
  const { rows } = await pool.query(
    `SELECT * FROM tickets WHERE user_id = $1 ORDER BY created_at DESC`,
    [String(userId)]
  );
  return rows;
}

async function getOpenTicketByUserId(userId) {
  await ensureDatabaseReady();
  const { rows } = await pool.query(
    `SELECT *
     FROM tickets
     WHERE user_id = $1 AND status = 'open'
     ORDER BY created_at DESC
     LIMIT 1`,
    [String(userId)]
  );
  return rows[0] || null;
}

async function getOpenTickets() {
  await ensureDatabaseReady();
  const { rows } = await pool.query(
    `SELECT * FROM tickets WHERE status = 'open' ORDER BY created_at DESC`
  );
  return rows;
}

async function updateTicketStatus(ticketId, status) {
  await ensureDatabaseReady();
  await pool.query(
    `UPDATE tickets SET status = $1, updated_at = NOW() WHERE id = $2`,
    [sanitize(String(status), 20), String(ticketId)]
  );
  return true;
}

async function saveTicketMessage(ticketId, sender, message, options = {}) {
  await ensureDatabaseReady();
  const id = genId('tmsg-');
  const cleanTicketId = String(ticketId);
  const cleanSender = sanitize(String(sender), 20) || 'user';
  const cleanMessage = sanitize(String(message), 5000);

  await pool.query(
    `INSERT INTO ticket_messages (id, ticket_id, sender, message)
     VALUES ($1, $2, $3, $4)`,
    [id, cleanTicketId, cleanSender, cleanMessage]
  );

  if (options && options.mirrorToMessages && options.userId && options.sessionId && cleanMessage) {
    await saveMessage({
      userId: options.userId,
      sessionId: options.sessionId,
      role: cleanSender === 'admin' ? 'assistant' : 'user',
      senderType: cleanSender,
      content: cleanMessage,
      meta: Object.assign({}, options.meta || {}, {
        ticketId: cleanTicketId,
        channel: 'ticket',
      }),
    });
  }

  return id;
}

async function getTicketMessages(ticketId) {
  await ensureDatabaseReady();
  const { rows } = await pool.query(
    `SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [String(ticketId)]
  );
  return rows;
}

async function getUserByTelegramId(chatId) {
  await ensureDatabaseReady();
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE telegram_chat_id = $1 LIMIT 1',
    [String(chatId)]
  );
  return mapUser(rows[0] || null);
}

async function createTelegramUser(chatId, name) {
  await ensureDatabaseReady();
  const cleanChatId = String(chatId);
  const cleanName = sanitize(String(name || 'زائر'), 100) || 'زائر';

  const { rows } = await pool.query(
    `INSERT INTO users (telegram_chat_id, name, updated_at, last_seen_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (telegram_chat_id)
     DO UPDATE SET
       name = EXCLUDED.name,
       updated_at = NOW(),
       last_seen_at = NOW()
     RETURNING *`,
    [cleanChatId, cleanName]
  );

  return mapUser(rows[0] || null);
}

async function getOpenTicketByTelegramId(chatId) {
  await ensureDatabaseReady();
  const { rows } = await pool.query(
    `SELECT t.*
     FROM tickets t
     JOIN users u ON t.user_id = u.id::text
     WHERE u.telegram_chat_id = $1 AND t.status = 'open'
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [String(chatId)]
  );
  return rows[0] || null;
}

async function getTelegramChatIdByUserId(userId) {
  await ensureDatabaseReady();
  const { rows } = await pool.query(
    `SELECT telegram_chat_id FROM users WHERE id::text = $1 LIMIT 1`,
    [String(userId)]
  );
  return rows[0] ? rows[0].telegram_chat_id : null;
}

async function notifyAgent(ticket, message) {
  console.log(`[notify] تذكرة #${ticket.id} — "${String(message).slice(0, 60)}"`);
  return { sent: false, reason: 'handled_by_telegram_bot' };
}

module.exports = {
  pool,
  loadStore,
  ensureDatabaseReady,
  saveMessage,
  getConversation,
  getUserById,
  getUserByDeviceKey,
  getUserBySessionId,
  createOrGetWebUser,
  touchUser,
  createTicket,
  getTicket,
  getTicketsByUser,
  getOpenTicketByUserId,
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
