/**
 * server.js — الخادم الرئيسي
 * ===========================
 * • Express + WebSocket
 * • API الدردشة الذكية
 * • نظام التذاكر والدعم المباشر
 * • حماية: sanitization + حد طول الرسالة
 */

'use strict';

const express  = require('express');
const http     = require('http');
const path     = require('path');
const cors     = require('cors');
const { WebSocketServer } = require('ws');

const { analyzeContact, generateChatReply, sanitizeInput } = require('./lib/analyzer');
const {
  loadStore, saveMessage, getConversation,
  createTicket, getTicket, getTicketsByUser,
  updateTicketStatus, saveTicketMessage, getTicketMessages,
  notifyAgent
} = require('./lib/storage');

// ── Telegram Bot ─────────────────────────────────────────────────────────────
require('./lib/telegramBot');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3000;
const store  = loadStore();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── WebSocket ────────────────────────────────────────────────────────────────
function broadcastToSession(sessionId, payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === 1 && client.sessionId === sessionId) {
      client.send(msg);
    }
  });
}

wss.on('connection', (ws, request) => {
  const url = new URL(request.url, 'http://localhost');
  ws.sessionId = url.searchParams.get('sessionId') || 'demo-session';
  ws.send(JSON.stringify({
    type: 'connected',
    sessionId: ws.sessionId,
    text: 'تم الاتصال بنظام التحديثات اللحظية بنجاح.'
  }));
});

// ─── Validation Helper ────────────────────────────────────────────────────────
function validateMessage(message, maxLen) {
  maxLen = maxLen || 1000;
  if (!message || typeof message !== 'string') return null;
  const cleaned = sanitizeInput(message.trim(), maxLen);
  return cleaned.length > 0 ? cleaned : null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  PING
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/demo/ping', function(req, res) {
  res.json({
    ok: true,
    app: process.env.APP_NAME || 'Smart Chat Bot',
    message: 'الخادم يعمل بنجاح',
    timestamp: new Date().toISOString()
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  تحليل نموذج التواصل
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/contact/analyze', function(req, res) {
  try {
    var payload   = req.body || {};
    var sessionId = sanitizeInput(String(payload.sessionId || 'demo-session'), 100);
    var analysis  = analyzeContact(payload, store);

    saveMessage(store, sessionId, {
      role: 'contact-form',
      content: sanitizeInput(payload.message || ''),
      meta: { name: payload.name, email: payload.email, topic: payload.topic }
    });

    saveMessage(store, sessionId, {
      role: 'assistant',
      content: analysis.suggestedReply,
      meta: { intent: analysis.intent, sentiment: analysis.sentiment }
    });

    broadcastToSession(sessionId, {
      type: 'analysis_ready',
      sessionId: sessionId,
      summary: analysis.summary,
      intent: analysis.intent
    });

    res.json(Object.assign({}, analysis, {
      reply: analysis.suggestedReply,
      suggestions: analysis.suggestions
    }));
  } catch (err) {
    console.error('[/api/contact/analyze]', err.message);
    res.status(500).json({ error: 'حدث خطأ أثناء معالجة الطلب.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  إرسال رسالة دردشة
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/chat/send', function(req, res) {
  try {
    var sessionId = sanitizeInput(String((req.body && req.body.sessionId) || 'demo-session'), 100);
    var message   = validateMessage(req.body && req.body.message, 1000);

    if (!message) {
      return res.status(400).json({ error: 'الرسالة فارغة أو غير صالحة.' });
    }

    saveMessage(store, sessionId, { role: 'user', content: message });

    broadcastToSession(sessionId, {
      type: 'assistant_typing',
      sessionId: sessionId,
      text: 'جارٍ تحليل رسالتك والردّ عليها...'
    });

    var result = generateChatReply(sessionId, message, store);

    saveMessage(store, sessionId, {
      role: 'assistant',
      content: result.reply,
      meta: { intent: result.detectedIntent }
    });

    broadcastToSession(sessionId, {
      type: 'assistant_message',
      sessionId: sessionId,
      answer: result.reply
    });

    res.json({
      reply: result.reply,
      answer: result.reply,
      suggestions: result.suggestions,
      detectedIntent: result.detectedIntent
    });
  } catch (err) {
    console.error('[/api/chat/send]', err.message);
    res.status(500).json({ error: 'حدث خطأ أثناء معالجة الرسالة.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  سجل المحادثة
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/chat/history/:sessionId', function(req, res) {
  try {
    var sessionId    = sanitizeInput(req.params.sessionId, 100);
    var conversation = getConversation(store, sessionId);
    res.json({ sessionId: sessionId, totalMessages: conversation.length, messages: conversation });
  } catch (err) {
    res.status(500).json({ error: 'تعذّر جلب السجل.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  إنشاء تذكرة
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/tickets/create', async function(req, res) {
  try {
    var userId   = sanitizeInput(String((req.body && (req.body.userId || req.body.sessionId)) || 'anon'), 100);
    var username = sanitizeInput(String((req.body && req.body.username) || 'زائر'), 100);

    var ticket = createTicket(userId, username);
    if (!ticket) {
      return res.status(500).json({ error: 'فشل إنشاء التذكرة.' });
    }

    await notifyAgent(ticket, 'تم فتح تذكرة جديدة من ' + username);

    res.json({
      success: true,
      ticket: ticket,
      reply: 'تم فتح تذكرة دعم برقم #' + ticket.id + '. سيتواصل معك أحد موظفينا قريباً.',
      suggestions: ['إرسال رسالة', 'وصف المشكلة', 'إرفاق لقطة شاشة']
    });
  } catch (err) {
    console.error('[/api/tickets/create]', err.message);
    res.status(500).json({ error: 'حدث خطأ أثناء إنشاء التذكرة.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  إرسال رسالة إلى تذكرة
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/tickets/:ticketId/message', async function(req, res) {
  try {
    var ticketId = sanitizeInput(req.params.ticketId, 100);
    var message  = validateMessage(req.body && req.body.message, 2000);
    var sender   = sanitizeInput(String((req.body && req.body.sender) || 'user'), 20);

    if (!message) {
      return res.status(400).json({ error: 'الرسالة فارغة.' });
    }

    var ticket = getTicket(ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'التذكرة غير موجودة.' });
    }

    var msgId = saveTicketMessage(ticketId, sender, message);

    if (sender === 'user') {
      await notifyAgent(ticket, message);
    }

    if (sender === 'admin') {
      broadcastToSession(ticket.user_id, {
        type: 'ticket_reply',
        ticketId: ticketId,
        message: message,
        sender: 'admin'
      });
    }

    res.json({
      success: true,
      messageId: msgId,
      reply: sender === 'user' ? 'تم إرسال رسالتك إلى فريق الدعم.' : 'تم إرسال الرد.',
      suggestions: sender === 'user'
        ? ['إضافة تفاصيل', 'إغلاق التذكرة']
        : ['إغلاق التذكرة', 'الانتقال لتذكرة أخرى']
    });
  } catch (err) {
    console.error('[/api/tickets/:id/message]', err.message);
    res.status(500).json({ error: 'حدث خطأ أثناء إرسال الرسالة.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  عرض رسائل تذكرة
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/tickets/:ticketId/messages', function(req, res) {
  try {
    var ticketId = sanitizeInput(req.params.ticketId, 100);
    var ticket   = getTicket(ticketId);
    if (!ticket) return res.status(404).json({ error: 'التذكرة غير موجودة.' });

    var messages = getTicketMessages(ticketId);
    res.json({ ticketId: ticketId, ticket: ticket, messages: messages });
  } catch (err) {
    res.status(500).json({ error: 'تعذّر جلب رسائل التذكرة.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  تذاكر المستخدم
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/tickets/user/:userId', function(req, res) {
  try {
    var userId  = sanitizeInput(req.params.userId, 100);
    var tickets = getTicketsByUser(userId);
    res.json({ userId: userId, tickets: tickets });
  } catch (err) {
    res.status(500).json({ error: 'تعذّر جلب التذاكر.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  تحديث حالة التذكرة
// ══════════════════════════════════════════════════════════════════════════════
app.patch('/api/tickets/:ticketId/status', function(req, res) {
  try {
    var ticketId = sanitizeInput(req.params.ticketId, 100);
    var status   = sanitizeInput(String((req.body && req.body.status) || ''), 20);
    var allowed  = ['open', 'in_progress', 'resolved', 'closed'];

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'الحالة غير صالحة.', allowed: allowed });
    }

    var updated = updateTicketStatus(ticketId, status);
    res.json({ success: updated, ticketId: ticketId, status: status });
  } catch (err) {
    res.status(500).json({ error: 'تعذّر تحديث حالة التذكرة.' });
  }
});

// ─── تشغيل الخادم ─────────────────────────────────────────────────────────────
server.listen(PORT, function() {
  console.log('\n Smart Chat Bot يعمل على: http://localhost:' + PORT);
  console.log('   WebSocket جاهز على نفس المنفذ\n');
});
