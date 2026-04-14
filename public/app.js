'use strict';

var DEVICE_KEY_STORAGE = 'chatbot_device_key';
var USER_ID_STORAGE = 'chatbot_user_id';
var SESSION_ID_STORAGE = 'chatbot_session_id';
var USER_NAME_STORAGE = 'chatbot_user_name';
var USER_EMAIL_STORAGE = 'chatbot_user_email';

var identity = {
  deviceKey: null,
  userId: null,
  sessionId: null,
  isNewUser: false,
};

var activeTicketId = null;
var isTicketMode = false;
var socket = null;
var reconnectTimer = null;
var initPromise = null;

var analysisOutput = document.getElementById('analysisOutput');
var analysisResult = document.getElementById('analysisResult');
var historyOutput = document.getElementById('historyOutput');
var wsLog = document.getElementById('wsLog');
var chatMessages = document.getElementById('chatMessages');
var pingStatus = document.getElementById('pingStatus');
var chatSuggestions = document.getElementById('chatSuggestions');
var ticketInfo = document.getElementById('ticketInfo');
var ticketIdDisplay = document.getElementById('ticketIdDisplay');
var chatInput = document.getElementById('chatInput');
var nameInput = document.getElementById('name');
var emailInput = document.getElementById('email');

function createClientId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function getWelcomeBubble() {
  return chatMessages.querySelector('.welcome-bubble');
}

function resetChatView() {
  var welcomeBubble = getWelcomeBubble();
  chatMessages.innerHTML = '';
  if (welcomeBubble) {
    chatMessages.appendChild(welcomeBubble);
  }
}

function addBubble(role, text, addCopy) {
  addCopy = addCopy !== false && role === 'assistant';

  var bubble = document.createElement('div');
  bubble.className = 'bubble ' + role;

  var content = document.createElement('div');
  content.className = 'bubble-content';
  content.textContent = text;
  bubble.appendChild(content);

  if (addCopy) {
    var copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 نسخ';
    copyBtn.className = 'btn btn-sm secondary copy-btn';
    copyBtn.onclick = function onCopy() {
      navigator.clipboard.writeText(text)
        .then(function success() {
          copyBtn.textContent = '✅ تم النسخ';
          setTimeout(function restore() {
            copyBtn.textContent = '📋 نسخ';
          }, 2000);
        })
        .catch(function fail() {
          alert('فشل نسخ النص');
        });
    };
    bubble.appendChild(copyBtn);
  }

  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showSuggestions(suggestions) {
  chatSuggestions.innerHTML = '';
  if (!suggestions || !suggestions.length) return;

  suggestions.forEach(function eachSuggestion(item) {
    var btn = document.createElement('button');
    btn.className = 'suggestion-chip';
    btn.textContent = item;
    btn.onclick = function onSuggestionClick() {
      chatInput.value = item;
      document.getElementById('chatForm').dispatchEvent(new Event('submit'));
    };
    chatSuggestions.appendChild(btn);
  });
}

function addTypingIndicator() {
  removeTypingIndicator();
  var bubble = document.createElement('div');
  bubble.className = 'bubble assistant typing-bubble';
  bubble.id = 'typingIndicator';
  bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeTypingIndicator() {
  var node = document.getElementById('typingIndicator');
  if (node) node.remove();
}

async function callApi(url, options) {
  options = options || {};
  var response = await fetch(url, Object.assign({
    headers: { 'Content-Type': 'application/json' },
  }, options));

  if (!response.ok) {
    var errorData = await response.json().catch(function fallback() { return {}; });
    throw new Error(errorData.error || ('HTTP ' + response.status));
  }

  return response.json();
}

function readStoredIdentity() {
  return {
    deviceKey: localStorage.getItem(DEVICE_KEY_STORAGE),
    userId: localStorage.getItem(USER_ID_STORAGE),
    sessionId: localStorage.getItem(SESSION_ID_STORAGE),
    name: localStorage.getItem(USER_NAME_STORAGE) || '',
    email: localStorage.getItem(USER_EMAIL_STORAGE) || '',
  };
}

function persistIdentity(sessionData, profile) {
  identity.deviceKey = sessionData.user.deviceKey || identity.deviceKey;
  identity.userId = sessionData.user.id;
  identity.sessionId = sessionData.sessionId;
  identity.isNewUser = Boolean(sessionData.isNewUser);

  localStorage.setItem(DEVICE_KEY_STORAGE, identity.deviceKey);
  localStorage.setItem(USER_ID_STORAGE, identity.userId);
  localStorage.setItem(SESSION_ID_STORAGE, identity.sessionId);

  if (profile && profile.name) localStorage.setItem(USER_NAME_STORAGE, profile.name);
  if (profile && profile.email) localStorage.setItem(USER_EMAIL_STORAGE, profile.email);
}

function getProfileFromInputs() {
  return {
    name: (nameInput.value || '').trim(),
    email: (emailInput.value || '').trim(),
  };
}

async function initSession(forceRefresh, profile) {
  if (initPromise && !forceRefresh) return initPromise;

  initPromise = (async function runInit() {
    var stored = readStoredIdentity();
    var deviceKey = stored.deviceKey || createClientId('device');
    var nextProfile = profile || getProfileFromInputs();

    if (nextProfile.name) localStorage.setItem(USER_NAME_STORAGE, nextProfile.name);
    if (nextProfile.email) localStorage.setItem(USER_EMAIL_STORAGE, nextProfile.email);

    var result = await callApi('/api/session/init', {
      method: 'POST',
      body: JSON.stringify({
        deviceKey: deviceKey,
        sessionId: stored.sessionId || '',
        name: nextProfile.name || stored.name || 'زائر',
        email: nextProfile.email || stored.email || '',
      }),
    });

    identity.deviceKey = deviceKey;
    persistIdentity(result, {
      name: nextProfile.name || stored.name || result.user.name || '',
      email: nextProfile.email || stored.email || result.user.email || '',
    });

    connectWebSocket();
    return result;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

function connectWebSocket() {
  if (!identity.sessionId) return;

  if (socket) {
    socket.onclose = null;
    try { socket.close(); } catch (e) { }
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  var wsUrl = location.origin.replace('http', 'ws') + '?sessionId=' + encodeURIComponent(identity.sessionId);
  socket = new WebSocket(wsUrl);

  socket.addEventListener('open', function onOpen() {
    wsLog.textContent = '✅ متصل — تم ربط نفس جلسة المستخدم الحالية';
    wsLog.className = 'mini-log connected';
  });

  socket.addEventListener('close', function onClose() {
    wsLog.textContent = '🔴 انقطع الاتصال — إعادة المحاولة...';
    wsLog.className = 'mini-log disconnected';
    reconnectTimer = setTimeout(function reconnect() {
      connectWebSocket();
    }, 3000);
  });

  socket.addEventListener('message', function onMessage(event) {
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
        addBubble('admin', '👤 موظف الدعم: ' + payload.message, false);
        wsLog.textContent = '📩 وصل رد من موظف الدعم على تذكرة #' + payload.ticketId;
      }
    } catch (err) {
      console.warn('فشل قراءة رسالة websocket', err);
    }
  });
}

function normalizeHistoryMessage(message) {
  if (message.sender_type === 'admin') {
    return { role: 'admin', text: '👤 موظف الدعم: ' + message.content, addCopy: false };
  }

  if (message.role === 'assistant') {
    return { role: 'assistant', text: message.content, addCopy: true };
  }

  if (message.role === 'contact-form') {
    return { role: 'user', text: '📝 نموذج تواصل: ' + message.content, addCopy: false };
  }

  return { role: 'user', text: message.content, addCopy: false };
}

async function loadHistory(renderBubbles) {
  await initSession(false);

  var history = await callApi('/api/chat/history?userId=' + encodeURIComponent(identity.userId) + '&sessionId=' + encodeURIComponent(identity.sessionId));
  historyOutput.textContent = JSON.stringify(history, null, 2);

  if (renderBubbles) {
    resetChatView();
    history.messages.forEach(function eachMessage(message) {
      var formatted = normalizeHistoryMessage(message);
      addBubble(formatted.role, formatted.text, formatted.addCopy);
    });
  }

  return history;
}

async function restoreOpenTicket() {
  await initSession(false);
  var result = await callApi('/api/tickets/user/' + encodeURIComponent(identity.userId) + '?sessionId=' + encodeURIComponent(identity.sessionId));
  var openTicket = (result.tickets || []).find(function findOpen(ticket) {
    return ticket.status === 'open';
  });

  if (openTicket) {
    activeTicketId = openTicket.id;
    isTicketMode = true;
    ticketIdDisplay.textContent = activeTicketId;
    ticketInfo.classList.remove('hidden');
  } else {
    activeTicketId = null;
    isTicketMode = false;
    ticketInfo.classList.add('hidden');
  }
}

nameInput.value = localStorage.getItem(USER_NAME_STORAGE) || '';
emailInput.value = localStorage.getItem(USER_EMAIL_STORAGE) || '';

nameInput.addEventListener('change', function onNameChange() {
  var value = nameInput.value.trim();
  if (value) localStorage.setItem(USER_NAME_STORAGE, value);
});

emailInput.addEventListener('change', function onEmailChange() {
  var value = emailInput.value.trim();
  if (value) localStorage.setItem(USER_EMAIL_STORAGE, value);
});

document.getElementById('pingBtn').addEventListener('click', async function onPing() {
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

document.getElementById('contactForm').addEventListener('submit', async function onAnalyzeSubmit(event) {
  event.preventDefault();

  var submitBtn = event.target.querySelector('button[type="submit"]');
  submitBtn.textContent = '⏳ جارٍ التحليل...';
  submitBtn.disabled = true;

  try {
    await initSession(true, getProfileFromInputs());

    var payload = {
      userId: identity.userId,
      sessionId: identity.sessionId,
      name: nameInput.value,
      email: emailInput.value,
      topic: document.getElementById('topic').value,
      message: document.getElementById('message').value,
    };

    var result = await callApi('/api/contact/analyze', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    analysisResult.classList.remove('hidden');
    document.getElementById('resIntent').textContent = result.intent || '—';
    document.getElementById('resIntent').className = 'badge intent-' + (result.intent || 'general');
    document.getElementById('resSentiment').textContent = result.sentiment || '—';
    document.getElementById('resSentiment').className = 'badge sentiment-' + (result.sentiment || 'neutral');
    document.getElementById('resSummary').textContent = result.summary || '—';
    document.getElementById('resReply').textContent = result.suggestedReply || result.reply || '—';
    document.getElementById('resEscalate').textContent = result.shouldEscalate ? '⚠️ يحتاج تصعيد' : '✅ لا يحتاج';
    document.getElementById('resEscalate').className = 'badge ' + (result.shouldEscalate ? 'badge-warn' : 'badge-ok');

    var sugDiv = document.getElementById('resSuggestions');
    sugDiv.innerHTML = '';
    if (result.suggestions && result.suggestions.length) {
      result.suggestions.forEach(function eachSuggestion(item) {
        var chip = document.createElement('span');
        chip.className = 'suggestion-chip small';
        chip.textContent = item;
        sugDiv.appendChild(chip);
      });
    }

    analysisOutput.textContent = JSON.stringify(result, null, 2);
    addBubble('assistant', '📊 تم التحليل. النية: ' + result.intent + ' — ' + (result.suggestedReply || result.reply || ''));
    await loadHistory(false);
  } catch (err) {
    analysisOutput.textContent = '❌ خطأ: ' + err.message;
  } finally {
    submitBtn.textContent = '🔍 تحليل الرسالة';
    submitBtn.disabled = false;
  }
});

document.getElementById('chatForm').addEventListener('submit', async function onChatSubmit(event) {
  event.preventDefault();

  var message = chatInput.value.trim();
  if (!message) return;

  await initSession(false, getProfileFromInputs());

  chatInput.value = '';
  chatSuggestions.innerHTML = '';
  addBubble('user', message, false);

  if (message === 'تواصل مع الدعم' || message.indexOf('تذكرة') !== -1 || message.indexOf('دعم مباشر') !== -1) {
    if (!isTicketMode) {
      await openSupportTicket();
      return;
    }
  }

  addTypingIndicator();

  try {
    var endpoint;
    var body;

    if (isTicketMode && activeTicketId) {
      endpoint = '/api/tickets/' + encodeURIComponent(activeTicketId) + '/message';
      body = JSON.stringify({
        ticketId: activeTicketId,
        userId: identity.userId,
        sessionId: identity.sessionId,
        sender: 'user',
        message: message,
      });
    } else {
      endpoint = '/api/chat/send';
      body = JSON.stringify({
        userId: identity.userId,
        sessionId: identity.sessionId,
        message: message,
      });
    }

    var result = await callApi(endpoint, { method: 'POST', body: body });
    removeTypingIndicator();

    var replyText = result.reply || result.answer || 'تم استلام رسالتك.';
    addBubble('assistant', replyText);
    if (result.suggestions && result.suggestions.length) {
      showSuggestions(result.suggestions);
    }

    await loadHistory(false);
  } catch (err) {
    removeTypingIndicator();
    addBubble('assistant', '❌ تعذّر إرسال الرسالة: ' + err.message);
  }
});

async function openSupportTicket() {
  addTypingIndicator();
  try {
    await initSession(false, getProfileFromInputs());
    var result = await callApi('/api/tickets/create', {
      method: 'POST',
      body: JSON.stringify({
        userId: identity.userId,
        sessionId: identity.sessionId,
        username: nameInput.value || 'زائر',
      }),
    });

    removeTypingIndicator();

    activeTicketId = result.ticket.id;
    isTicketMode = true;
    ticketIdDisplay.textContent = activeTicketId;
    ticketInfo.classList.remove('hidden');

    addBubble('assistant', '🎫 ' + result.reply);
    addBubble('assistant', '📌 رقم تذكرتك: ' + activeTicketId + '\nيمكنك الآن إرسال رسائلك مباشرةً وسيردّ عليك موظف الدعم.');

    if (result.suggestions) showSuggestions(result.suggestions);
    wsLog.textContent = '🎫 وضع الدعم المباشر — تذكرة #' + activeTicketId;
    await loadHistory(false);
  } catch (err) {
    removeTypingIndicator();
    addBubble('assistant', '❌ تعذّر إنشاء تذكرة الدعم: ' + err.message);
  }
}

document.getElementById('closeTicketBtn').addEventListener('click', async function onCloseTicket() {
  if (!activeTicketId) return;

  try {
    await callApi('/api/tickets/' + encodeURIComponent(activeTicketId) + '/status', {
      method: 'PATCH',
      body: JSON.stringify({
        userId: identity.userId,
        sessionId: identity.sessionId,
        status: 'closed',
      }),
    });

    addBubble('assistant', '✅ تم إغلاق تذكرة الدعم #' + activeTicketId + '. شكراً لتواصلك معنا!');
    activeTicketId = null;
    isTicketMode = false;
    ticketInfo.classList.add('hidden');
    wsLog.textContent = '✅ تم إغلاق التذكرة — العودة للدردشة الذكية';
    showSuggestions(['ابدأ محادثة جديدة', 'مساعدة', 'تواصل مع الدعم']);
    await loadHistory(false);
  } catch (err) {
    addBubble('assistant', '❌ تعذّر إغلاق التذكرة: ' + err.message);
  }
});

document.getElementById('welcomeSuggestions').addEventListener('click', function onWelcomeSuggestion(event) {
  var chip = event.target.closest('.suggestion-chip');
  if (!chip) return;
  var message = chip.getAttribute('data-msg');
  if (message) {
    chatInput.value = message;
    document.getElementById('chatForm').dispatchEvent(new Event('submit'));
  }
});

document.getElementById('historyBtn').addEventListener('click', async function onHistoryClick() {
  this.textContent = '⏳ جارٍ الجلب...';
  try {
    await loadHistory(true);
  } catch (err) {
    historyOutput.textContent = '❌ تعذّر جلب السجل: ' + err.message;
  } finally {
    this.textContent = '📜 عرض السجل';
  }
});

document.getElementById('clearHistoryBtn').addEventListener('click', async function onClearView() {
  resetChatView();
  chatSuggestions.innerHTML = '';
  historyOutput.textContent = 'ℹ️ تم تنظيف العرض المحلي فقط بدون حذف أي رسالة من قاعدة البيانات.';
  await restoreOpenTicket().catch(function noop() {});
  wsLog.textContent = '↻ تم تحديث العرض المحلي — يمكنك دائماً استرجاع نفس المحادثة.';
});

(async function bootstrap() {
  try {
    var session = await initSession(false, getProfileFromInputs());
    await restoreOpenTicket();
    var history = await loadHistory(true);

    if (session.isNewUser && history.totalMessages === 0) {
      wsLog.textContent = '🆕 تم إنشاء مستخدم جديد وجلسة جديدة لهذا الجهاز';
      addBubble('assistant', '👋 أهلاً بك! تم تجهيز حسابك لأول مرة على هذا الجهاز. كل رسائلك القادمة سيتم حفظها تلقائياً.');
    } else {
      wsLog.textContent = '♻️ تم استرجاع المستخدم القديم وسجل المحادثة السابق';
    }
  } catch (err) {
    wsLog.textContent = '❌ تعذّر تهيئة الجلسة: ' + err.message;
    wsLog.className = 'mini-log disconnected';
  }
})();
