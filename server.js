'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const { analyzeContact, generateChatReply, sanitizeInput } = require('./lib/analyzer');
const {
  loadStore,
  saveMessage,
  getConversation,
  createTicket,
  getTicket,
  getTicketsByUser,
  getOpenTicketByUserId,
  updateTicketStatus,
  saveTicketMessage,
  getTicketMessages,
  notifyAgent,
  createOrGetWebUser,
  getUserById,
} = require('./lib/storage');

if (process.env.TELEGRAM_BOT_TOKEN) {
  require('./lib/telegramBot');
} else {
  console.warn('[server] TELEGRAM_BOT_TOKEN غير مضبوط — تم تعطيل بوت تيليغرام');
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
const store = loadStore();

app.use(cors());
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asyncHandler(handler) {
  return async function wrappedHandler(req, res) {
    try {
      await handler(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) {
        console.error(`[${req.method} ${req.originalUrl}]`, err.message);
      }
      res.status(status).json({ error: err.message || 'حدث خطأ غير متوقع.' });
    }
  };
}

function validateMessage(message, maxLen) {
  const cleaned = sanitizeInput(String(message || '').trim(), maxLen || 1000);
  return cleaned || null;
}

function broadcastToSession(sessionId, payload) {
  const body = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client.sessionId === sessionId) {
      client.send(body);
    }
  });
}

wss.on('connection', (ws, request) => {
  const url = new URL(request.url, 'http://localhost');
  const sessionId = sanitizeInput(String(url.searchParams.get('sessionId') || ''), 200);

  ws.sessionId = sessionId || null;
  ws.send(JSON.stringify({
    type: 'connected',
    sessionId: ws.sessionId,
    text: ws.sessionId
      ? 'تم الاتصال بنظام التحديثات اللحظية بنجاح.'
      : 'تم الاتصال، لكن لا توجد جلسة مرتبطة حتى الآن.',
  }));
});

async function requireUserContext(req) {
  const body = req.body || {};
  const query = req.query || {};

  const userId = sanitizeInput(String(body.userId || query.userId || ''), 50);
  const sessionId = sanitizeInput(String(body.sessionId || query.sessionId || req.params.sessionId || ''), 200);

  if (!userId || !sessionId) {
    throw createHttpError(400, 'بيانات المستخدم أو الجلسة غير مكتملة.');
  }

  const user = await getUserById(userId);
  if (!user) {
    throw createHttpError(404, 'المستخدم غير موجود.');
  }

  if (user.sessionId !== sessionId) {
    throw createHttpError(403, 'الجلسة الحالية لا تطابق المستخدم.');
  }

  return { user, sessionId };
}

app.get('/api/demo/ping', function demoPing(req, res) {
  res.json({
    ok: true,
    app: process.env.APP_NAME || 'Smart Chat Bot',
    message: 'الخادم يعمل بنجاح',
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/session/init', asyncHandler(async function initSession(req, res) {
  const body = req.body || {};
  const deviceKey = sanitizeInput(String(body.deviceKey || ''), 200);
  const name = sanitizeInput(String(body.name || 'زائر'), 100) || 'زائر';
  const email = sanitizeInput(String(body.email || ''), 200);

  if (!deviceKey) {
    throw createHttpError(400, 'deviceKey مطلوب لتهيئة المستخدم.');
  }

  const result = await createOrGetWebUser({
    deviceKey,
    name,
    email,
    sessionId: sanitizeInput(String(body.sessionId || ''), 200),
  });

  res.cookie('chatbotSessionId', result.user.sessionId, {
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 365,
  });

  res.json({
    success: true,
    isNewUser: result.isNewUser,
    sessionId: result.user.sessionId,
    user: result.user,
    message: result.isNewUser
      ? 'تم إنشاء مستخدم جديد وجلسة جديدة.'
      : 'تم استرجاع المستخدم والجلسة السابقة بنجاح.',
  });
}));

app.post('/api/contact/analyze', asyncHandler(async function contactAnalyze(req, res) {
  const context = await requireUserContext(req);
  const payload = req.body || {};
  const analysis = analyzeContact(payload, store);

  await saveMessage({
    userId: context.user.id,
    sessionId: context.sessionId,
    role: 'contact-form',
    senderType: 'user',
    content: sanitizeInput(String(payload.message || ''), 2000),
    meta: {
      name: sanitizeInput(String(payload.name || ''), 100),
      email: sanitizeInput(String(payload.email || ''), 200),
      topic: sanitizeInput(String(payload.topic || ''), 200),
    },
  });

  await saveMessage({
    userId: context.user.id,
    sessionId: context.sessionId,
    role: 'assistant',
    senderType: 'assistant',
    content: analysis.suggestedReply,
    meta: { intent: analysis.intent, sentiment: analysis.sentiment, source: 'contact-analyze' },
  });

  broadcastToSession(context.sessionId, {
    type: 'analysis_ready',
    sessionId: context.sessionId,
    summary: analysis.summary,
    intent: analysis.intent,
  });

  res.json(Object.assign({}, analysis, {
    reply: analysis.suggestedReply,
    sessionId: context.sessionId,
    userId: context.user.id,
  }));
}));

app.post('/api/chat/send', asyncHandler(async function chatSend(req, res) {
  const context = await requireUserContext(req);
  const message = validateMessage(req.body && req.body.message, 1000);

  if (!message) {
    throw createHttpError(400, 'الرسالة فارغة أو غير صالحة.');
  }

  await saveMessage({
    userId: context.user.id,
    sessionId: context.sessionId,
    role: 'user',
    senderType: 'user',
    content: message,
  });

  broadcastToSession(context.sessionId, {
    type: 'assistant_typing',
    sessionId: context.sessionId,
    text: 'جارٍ تحليل رسالتك والردّ عليها...',
  });

  const result = await generateChatReply(context.sessionId, message, store, { userId: context.user.id });

  await saveMessage({
    userId: context.user.id,
    sessionId: context.sessionId,
    role: 'assistant',
    senderType: 'assistant',
    content: result.reply,
    meta: { intent: result.detectedIntent, source: 'chat-reply' },
  });

  broadcastToSession(context.sessionId, {
    type: 'assistant_message',
    sessionId: context.sessionId,
    answer: result.reply,
  });

  res.json({
    reply: result.reply,
    answer: result.reply,
    suggestions: result.suggestions,
    detectedIntent: result.detectedIntent,
    sessionId: context.sessionId,
    userId: context.user.id,
  });
}));

app.get(['/api/chat/history', '/api/chat/history/:sessionId'], asyncHandler(async function chatHistory(req, res) {
  const context = await requireUserContext(req);
  const conversation = await getConversation({
    userId: context.user.id,
    sessionId: context.sessionId,
  });

  res.json({
    userId: context.user.id,
    sessionId: context.sessionId,
    totalMessages: conversation.length,
    messages: conversation,
  });
}));

app.post('/api/tickets/create', asyncHandler(async function ticketsCreate(req, res) {
  const context = await requireUserContext(req);
  const username = sanitizeInput(String((req.body && req.body.username) || context.user.name || 'زائر'), 100) || 'زائر';

  let ticket = await getOpenTicketByUserId(context.user.id);
  let created = false;

  await saveMessage({
    userId: context.user.id,
    sessionId: context.sessionId,
    role: 'user',
    senderType: 'user',
    content: 'تواصل مع الدعم',
    meta: { source: 'ticket-open-request' },
  });

  if (!ticket) {
    ticket = await createTicket(context.user.id, username, context.sessionId);
    created = true;

    await saveMessage({
      userId: context.user.id,
      sessionId: context.sessionId,
      role: 'assistant',
      senderType: 'assistant',
      content: `🎫 تم فتح تذكرة دعم جديدة برقم #${ticket.id}. يمكنك الآن متابعة المشكلة ضمن نفس المحادثة.`,
      meta: { ticketId: ticket.id, source: 'ticket-create' },
    });

    await notifyAgent(ticket, 'تم فتح تذكرة جديدة من ' + username);
  }

  res.json({
    success: true,
    created,
    ticket,
    reply: created
      ? 'تم فتح تذكرة دعم جديدة بنجاح.'
      : 'لديك بالفعل تذكرة دعم مفتوحة وتم استرجاعها.',
    suggestions: ['إرسال رسالة', 'وصف المشكلة', 'إرفاق لقطة شاشة'],
  });
}));

app.post('/api/tickets/:ticketId/message', asyncHandler(async function ticketMessage(req, res) {
  const context = await requireUserContext(req);
  const ticketId = sanitizeInput(req.params.ticketId, 100);
  const message = validateMessage(req.body && req.body.message, 2000);
  const sender = sanitizeInput(String((req.body && req.body.sender) || 'user'), 20) || 'user';

  if (!message) {
    throw createHttpError(400, 'الرسالة فارغة.');
  }

  const ticket = await getTicket(ticketId);
  if (!ticket) {
    throw createHttpError(404, 'التذكرة غير موجودة.');
  }

  if (String(ticket.user_id) !== String(context.user.id)) {
    throw createHttpError(403, 'غير مسموح لك بالوصول إلى هذه التذكرة.');
  }

  const messageId = await saveTicketMessage(ticketId, sender, message, {
    userId: context.user.id,
    sessionId: context.sessionId,
    mirrorToMessages: true,
    meta: { ticketId, sender },
  });

  if (sender === 'user') {
    await notifyAgent(ticket, message);
  }

  if (sender === 'admin') {
    broadcastToSession(ticket.session_id || context.sessionId, {
      type: 'ticket_reply',
      ticketId,
      message,
      sender: 'admin',
    });
  }

  res.json({
    success: true,
    messageId,
    reply: sender === 'user' ? 'تم إرسال رسالتك إلى فريق الدعم.' : 'تم إرسال الرد.',
    suggestions: sender === 'user'
      ? ['إضافة تفاصيل', 'إغلاق التذكرة']
      : ['إغلاق التذكرة', 'الانتقال لتذكرة أخرى'],
  });
}));

app.get('/api/tickets/:ticketId/messages', asyncHandler(async function ticketMessages(req, res) {
  const context = await requireUserContext(req);
  const ticketId = sanitizeInput(req.params.ticketId, 100);
  const ticket = await getTicket(ticketId);

  if (!ticket) {
    throw createHttpError(404, 'التذكرة غير موجودة.');
  }

  if (String(ticket.user_id) !== String(context.user.id)) {
    throw createHttpError(403, 'غير مسموح لك بعرض هذه التذكرة.');
  }

  const messages = await getTicketMessages(ticketId);
  res.json({ ticketId, ticket, messages });
}));

app.get('/api/tickets/user/:userId', asyncHandler(async function ticketsByUser(req, res) {
  const context = await requireUserContext({
    body: { userId: req.params.userId, sessionId: req.query.sessionId },
    query: req.query,
    params: req.params,
  });

  const tickets = await getTicketsByUser(context.user.id);
  res.json({ userId: context.user.id, sessionId: context.sessionId, tickets });
}));

app.patch('/api/tickets/:ticketId/status', asyncHandler(async function updateStatus(req, res) {
  const context = await requireUserContext(req);
  const ticketId = sanitizeInput(req.params.ticketId, 100);
  const status = sanitizeInput(String((req.body && req.body.status) || ''), 20);
  const allowed = ['open', 'in_progress', 'resolved', 'closed'];

  if (!allowed.includes(status)) {
    throw createHttpError(400, 'الحالة غير صالحة.');
  }

  const ticket = await getTicket(ticketId);
  if (!ticket) {
    throw createHttpError(404, 'التذكرة غير موجودة.');
  }

  if (String(ticket.user_id) !== String(context.user.id)) {
    throw createHttpError(403, 'غير مسموح لك بتعديل هذه التذكرة.');
  }

  await updateTicketStatus(ticketId, status);

  if (status === 'closed') {
    await saveMessage({
      userId: context.user.id,
      sessionId: context.sessionId,
      role: 'assistant',
      senderType: 'assistant',
      content: `✅ تم إغلاق تذكرة الدعم #${ticketId}.`,
      meta: { ticketId, source: 'ticket-close' },
    });
  }

  res.json({ success: true, ticketId, status });
}));

server.listen(PORT, function onListen() {
  console.log('\n Smart Chat Bot يعمل على: http://localhost:' + PORT);
  console.log('   WebSocket جاهز على نفس المنفذ\n');
});
