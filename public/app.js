/**
 * app.js — منطق الواجهة الأمامية
 * =================================
 * • دردشة ذكية مع اقتراحات
 * • نظام التذاكر والدعم المباشر
 * • WebSocket للتحديثات اللحظية
 * • تكامل مع جميع API endpoints
 */

'use strict';

// ─── المتغيرات العامة ─────────────────────────────────────────────────────────
var sessionId      = 'session-' + Date.now();
var activeTicketId = null;
var isTicketMode   = false;

// ─── عناصر DOM ────────────────────────────────────────────────────────────────
var analysisOutput   = document.getElementById('analysisOutput');
var analysisResult   = document.getElementById('analysisResult');
var historyOutput    = document.getElementById('historyOutput');
var wsLog            = document.getElementById('wsLog');
var chatMessages     = document.getElementById('chatMessages');
var pingStatus       = document.getElementById('pingStatus');
var chatSuggestions  = document.getElementById('chatSuggestions');
var ticketInfo       = document.getElementById('ticketInfo');
var ticketIdDisplay  = document.getElementById('ticketIdDisplay');
var chatInput        = document.getElementById('chatInput');

// ══════════════════════════════════════════════════════════════════════════════
//  WebSocket
// ══════════════════════════════════════════════════════════════════════════════
var wsUrl = location.origin.replace('http', 'ws') + '?sessionId=' + sessionId;
var socket;

function connectWebSocket() {
  socket = new WebSocket(wsUrl);

  socket.addEventListener('open', function() {
    wsLog.textContent = '✅ متصل بنظام التحديثات اللحظية';
    wsLog.className = 'mini-log connected';
  });

  socket.addEventListener('close', function() {
    wsLog.textContent = '🔴 انقطع الاتصال — إعادة المحاولة...';
    wsLog.className = 'mini-log disconnected';
    setTimeout(connectWebSocket, 3000);
  });

  socket.addEventListener('message', function(event) {
    try {
      var payload = JSON.parse(event.data);

      if (payload.type === 'assistant_typing') {
        wsLog.textContent = '⌨️ ' + payload.text;
      } else if (payload.type === 'assistant_message') {
        wsLog.textContent = '✉️ وصل رد جديد';
      } else if (payload.type === 'analysis_ready') {
        wsLog.textContent = '📊 التحليل جاهز — النية: ' + payload.intent;
      } else if (payload.type === 'connected') {
        wsLog.textContent = '✅ ' + payload.text;
      } else if (payload.type === 'ticket_reply') {
        // رد الموظف على التذكرة
        addBubble('admin', '👤 موظف الدعم: ' + payload.message, false);
        wsLog.textContent = '📩 وصل رد من موظف الدعم على تذكرة #' + payload.ticketId;
      }
    } catch (e) {
      // ignore parse errors
    }
  });
}

connectWebSocket();

// ══════════════════════════════════════════════════════════════════════════════
//  دوال الدردشة
// ══════════════════════════════════════════════════════════════════════════════
function addBubble(role, text, addCopy) {
  addCopy = addCopy !== false && role === 'assistant';

  var div = document.createElement('div');
  div.className = 'bubble ' + role;

  var content = document.createElement('div');
  content.className = 'bubble-content';
  content.textContent = text;
  div.appendChild(content);

  if (addCopy) {
    var copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 نسخ';
    copyBtn.className = 'btn btn-sm secondary copy-btn';
    copyBtn.onclick = function() {
      navigator.clipboard.writeText(text)
        .then(function() {
          copyBtn.textContent = '✅ تم النسخ';
          setTimeout(function() { copyBtn.textContent = '📋 نسخ'; }, 2000);
        })
        .catch(function() { alert('فشل نسخ النص'); });
    };
    div.appendChild(copyBtn);
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showSuggestions(suggestions) {
  chatSuggestions.innerHTML = '';
  if (!suggestions || !suggestions.length) return;

  suggestions.forEach(function(s) {
    var btn = document.createElement('button');
    btn.className = 'suggestion-chip';
    btn.textContent = s;
    btn.onclick = function() {
      chatInput.value = s;
      document.getElementById('chatForm').dispatchEvent(new Event('submit'));
    };
    chatSuggestions.appendChild(btn);
  });
}

function addTypingIndicator() {
  var div = document.createElement('div');
  div.className = 'bubble assistant typing-bubble';
  div.id = 'typingIndicator';
  div.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeTypingIndicator() {
  var el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

// ══════════════════════════════════════════════════════════════════════════════
//  API Helpers
// ══════════════════════════════════════════════════════════════════════════════
async function callApi(url, options) {
  options = options || {};
  var response = await fetch(url, Object.assign({
    headers: { 'Content-Type': 'application/json' }
  }, options));

  if (!response.ok) {
    var errData = await response.json().catch(function() { return {}; });
    throw new Error(errData.error || 'HTTP ' + response.status);
  }
  return response.json();
}

// ══════════════════════════════════════════════════════════════════════════════
//  PING
// ══════════════════════════════════════════════════════════════════════════════
document.getElementById('pingBtn').addEventListener('click', async function() {
  pingStatus.textContent = '⏳ جارٍ الاختبار...';
  try {
    var data = await callApi('/api/demo/ping');
    pingStatus.textContent = '✅ ' + data.message;
    pingStatus.style.background = 'rgba(0,200,100,0.2)';
  } catch (err) {
    pingStatus.textContent = '❌ فشل الاتصال';
    pingStatus.style.background = 'rgba(255,0,0,0.15)';
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  تحليل نموذج التواصل
// ══════════════════════════════════════════════════════════════════════════════
document.getElementById('contactForm').addEventListener('submit', async function(event) {
  event.preventDefault();

  var submitBtn = event.target.querySelector('button[type="submit"]');
  submitBtn.textContent = '⏳ جارٍ التحليل...';
  submitBtn.disabled = true;

  var payload = {
    sessionId: sessionId,
    name:    document.getElementById('name').value,
    email:   document.getElementById('email').value,
    topic:   document.getElementById('topic').value,
    message: document.getElementById('message').value
  };

  try {
    var result = await callApi('/api/contact/analyze', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    // عرض النتائج البصرية
    analysisResult.classList.remove('hidden');
    document.getElementById('resIntent').textContent     = result.intent || '—';
    document.getElementById('resIntent').className       = 'badge intent-' + (result.intent || 'general');
    document.getElementById('resSentiment').textContent  = result.sentiment || '—';
    document.getElementById('resSentiment').className    = 'badge sentiment-' + (result.sentiment || 'neutral');
    document.getElementById('resSummary').textContent    = result.summary || '—';
    document.getElementById('resReply').textContent      = result.suggestedReply || result.reply || '—';
    document.getElementById('resEscalate').textContent   = result.shouldEscalate ? '⚠️ يحتاج تصعيد' : '✅ لا يحتاج';
    document.getElementById('resEscalate').className     = 'badge ' + (result.shouldEscalate ? 'badge-warn' : 'badge-ok');

    // الاقتراحات
    var sugDiv = document.getElementById('resSuggestions');
    sugDiv.innerHTML = '';
    if (result.suggestions && result.suggestions.length) {
      result.suggestions.forEach(function(s) {
        var chip = document.createElement('span');
        chip.className = 'suggestion-chip small';
        chip.textContent = s;
        sugDiv.appendChild(chip);
      });
    }

    // JSON خام
    analysisOutput.textContent = JSON.stringify(result, null, 2);

    addBubble('assistant', '📊 تم التحليل. النية: ' + result.intent + ' — ' + (result.suggestedReply || result.reply || ''));

  } catch (err) {
    analysisOutput.textContent = '❌ خطأ: ' + err.message;
  } finally {
    submitBtn.textContent = '🔍 تحليل الرسالة';
    submitBtn.disabled = false;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  إرسال رسالة دردشة
// ══════════════════════════════════════════════════════════════════════════════
document.getElementById('chatForm').addEventListener('submit', async function(event) {
  event.preventDefault();

  var message = chatInput.value.trim();
  if (!message) return;

  chatInput.value = '';
  chatSuggestions.innerHTML = '';
  addBubble('user', message, false);

  // فحص "تواصل مع الدعم"
  if (message === 'تواصل مع الدعم' || message.includes('تذكرة') || message.includes('دعم مباشر')) {
    if (!isTicketMode) {
      await openSupportTicket();
      return;
    }
  }

  addTypingIndicator();

  try {
    var endpoint, body;

    if (isTicketMode && activeTicketId) {
      // إرسال رسالة ضمن التذكرة
      endpoint = '/api/tickets/' + activeTicketId + '/message';
      body = JSON.stringify({ ticketId: activeTicketId, sender: 'user', message: message });
    } else {
      // دردشة عادية
      endpoint = '/api/chat/send';
      body = JSON.stringify({ sessionId: sessionId, message: message });
    }

    var result = await callApi(endpoint, { method: 'POST', body: body });

    removeTypingIndicator();

    var replyText = result.reply || result.answer || 'تم استلام رسالتك.';
    addBubble('assistant', replyText);

    if (result.suggestions && result.suggestions.length) {
      showSuggestions(result.suggestions);
    }

  } catch (err) {
    removeTypingIndicator();
    addBubble('assistant', '❌ تعذّر إرسال الرسالة: ' + err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  فتح تذكرة دعم
// ══════════════════════════════════════════════════════════════════════════════
async function openSupportTicket() {
  addTypingIndicator();
  try {
    var result = await callApi('/api/tickets/create', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: sessionId,
        userId: sessionId,
        username: document.getElementById('name').value || 'زائر'
      })
    });

    removeTypingIndicator();

    activeTicketId = result.ticket.id;
    isTicketMode   = true;

    ticketIdDisplay.textContent = activeTicketId;
    ticketInfo.classList.remove('hidden');

    addBubble('assistant', '🎫 ' + result.reply);
    addBubble('assistant', '📌 رقم تذكرتك: ' + activeTicketId + '\nيمكنك الآن إرسال رسائلك مباشرةً وسيردّ عليك موظف الدعم.');

    if (result.suggestions) showSuggestions(result.suggestions);

    wsLog.textContent = '🎫 وضع الدعم المباشر — تذكرة #' + activeTicketId;

  } catch (err) {
    removeTypingIndicator();
    addBubble('assistant', '❌ تعذّر إنشاء تذكرة الدعم: ' + err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  إغلاق التذكرة
// ══════════════════════════════════════════════════════════════════════════════
document.getElementById('closeTicketBtn').addEventListener('click', async function() {
  if (!activeTicketId) return;

  try {
    await callApi('/api/tickets/' + activeTicketId + '/status', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'closed' })
    });

    addBubble('assistant', '✅ تم إغلاق تذكرة الدعم #' + activeTicketId + '. شكراً لتواصلك معنا!');
    activeTicketId = null;
    isTicketMode   = false;
    ticketInfo.classList.add('hidden');
    wsLog.textContent = '✅ تم إغلاق التذكرة — العودة للدردشة الذكية';
    showSuggestions(['ابدأ محادثة جديدة', 'مساعدة', 'تواصل مع الدعم']);

  } catch (err) {
    addBubble('assistant', '❌ تعذّر إغلاق التذكرة: ' + err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  اقتراحات الترحيب
// ══════════════════════════════════════════════════════════════════════════════
document.getElementById('welcomeSuggestions').addEventListener('click', function(e) {
  var chip = e.target.closest('.suggestion-chip');
  if (!chip) return;
  var msg = chip.getAttribute('data-msg');
  if (msg) {
    chatInput.value = msg;
    document.getElementById('chatForm').dispatchEvent(new Event('submit'));
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  سجل المحادثة
// ══════════════════════════════════════════════════════════════════════════════
document.getElementById('historyBtn').addEventListener('click', async function() {
  this.textContent = '⏳ جارٍ الجلب...';
  try {
    var history = await callApi('/api/chat/history/' + sessionId);
    historyOutput.textContent = JSON.stringify(history, null, 2);
  } catch (err) {
    historyOutput.textContent = '❌ تعذّر جلب السجل: ' + err.message;
  } finally {
    this.textContent = '📜 عرض السجل';
  }
});

document.getElementById('clearHistoryBtn').addEventListener('click', function() {
  // إعادة التعيين المحلي فقط
  var welcomeBubble = chatMessages.querySelector('.welcome-bubble');
  chatMessages.innerHTML = '';
  if (welcomeBubble) chatMessages.appendChild(welcomeBubble);
  chatSuggestions.innerHTML = '';
  activeTicketId = null;
  isTicketMode = false;
  ticketInfo.classList.add('hidden');
  sessionId = 'session-' + Date.now();
  wsLog.textContent = '🔄 بدأت محادثة جديدة';
});
