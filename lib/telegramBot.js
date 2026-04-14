/**
 * telegramBot.js — بوت تيليغرام لنظام الدعم
 * ============================================
 * • استقبال رسائل العملاء وتحويلها إلى تذاكر
 * • إشعار الأدمن بكل رسالة جديدة
 * • رد الأدمن على العملاء عبر /reply
 * • أوامر: /start /reply /tickets
 */

'use strict';

const TelegramBot = require('node-telegram-bot-api');
const {
  getUserByTelegramId,
  createTelegramUser,
  getOpenTicketByTelegramId,
  createTicket,
  getTicket,
  saveTicketMessage,
  getOpenTickets,
  getTelegramChatIdByUserId,
} = require('./storage');

// ─── التحقق من المتغيرات البيئية الضرورية ───────────────────────────────────
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN || '8580211349:AAHue6HMQ1khGpUKoXj1GCNCHpDAxbNSBl8';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!ADMIN_CHAT_ID) {
  console.warn('[telegramBot] تحذير: ADMIN_CHAT_ID غير مضبوط — لن تصل إشعارات للأدمن');
}

// ─── تهيئة البوت (polling) ───────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('[telegramBot] البوت يعمل...');

// ─── مساعد: إرسال رسالة آمنة مع معالجة الخطأ ────────────────────────────────
async function safeSend(chatId, text, options = {}) {
  try {
    await bot.sendMessage(chatId, text, options);
  } catch (err) {
    console.error(`[telegramBot] فشل إرسال الرسالة إلى ${chatId}:`, err.message);
  }
}

// ─── مساعد: بناء اسم المستخدم من بيانات Telegram ────────────────────────────
function buildName(from) {
  const parts = [from.first_name, from.last_name].filter(Boolean);
  return parts.join(' ') || from.username || 'زائر';
}

// ════════════════════════════════════════════════════════════════════════════
//  أمر: /start
// ════════════════════════════════════════════════════════════════════════════
bot.onText(/^\/start$/, async (msg) => {
  const chatId = String(msg.chat.id);
  const name   = buildName(msg.from);

  await createTelegramUser(chatId, name);

  await safeSend(
    chatId,
    `👋 مرحباً ${name}!\n\nأنت الآن متصل بنظام دعم العملاء.\n\nأرسل رسالتك مباشرة وسيتواصل معك فريق الدعم في أقرب وقت.`,
    { parse_mode: 'HTML' }
  );
});

// ════════════════════════════════════════════════════════════════════════════
//  أمر: /tickets — للأدمن فقط
// ════════════════════════════════════════════════════════════════════════════
bot.onText(/^\/tickets$/, async (msg) => {
  const chatId = String(msg.chat.id);

  if (chatId !== String(ADMIN_CHAT_ID)) {
    return safeSend(chatId, '⛔ هذا الأمر متاح للمشرف فقط.');
  }

  const tickets = await getOpenTickets();

  if (!tickets || tickets.length === 0) {
    return safeSend(chatId, '✅ لا توجد تذاكر مفتوحة حالياً.');
  }

  const lines = tickets.map((t, i) =>
    `${i + 1}. 🎫 <b>#${t.id}</b>\n   👤 ${t.username}\n   🕐 ${new Date(t.created_at).toLocaleString('ar-SA')}`
  );

  await safeSend(
    chatId,
    `📋 <b>التذاكر المفتوحة (${tickets.length}):</b>\n\n${lines.join('\n\n')}`,
    { parse_mode: 'HTML' }
  );
});

// ════════════════════════════════════════════════════════════════════════════
//  أمر: /reply TICKET_ID MESSAGE — للأدمن فقط
// ════════════════════════════════════════════════════════════════════════════
bot.onText(/^\/reply\s+(\S+)\s+([\s\S]+)$/, async (msg, match) => {
  const adminChatId = String(msg.chat.id);

  if (adminChatId !== String(ADMIN_CHAT_ID)) {
    return safeSend(adminChatId, '⛔ هذا الأمر متاح للمشرف فقط.');
  }

  const ticketId = match[1].trim();
  const replyText = match[2].trim();

  // ── التحقق من وجود التذكرة ─────────────────────────────────────────────
  const ticket = await getTicket(ticketId);
  if (!ticket) {
    return safeSend(adminChatId, `❌ التذكرة <b>#${ticketId}</b> غير موجودة.`, { parse_mode: 'HTML' });
  }

  // ── جلب chat_id العميل ─────────────────────────────────────────────────
  const userChatId = await getTelegramChatIdByUserId(ticket.user_id);
  if (!userChatId) {
    return safeSend(adminChatId, `⚠️ لم يُعثر على Telegram ID للعميل في التذكرة #${ticketId}.`);
  }

  // ── حفظ الرد في قاعدة البيانات ──────────────────────────────────────────
  await saveTicketMessage(ticketId, 'admin', replyText);

  // ── إرسال الرد للعميل ──────────────────────────────────────────────────
  await safeSend(
    userChatId,
    `📩 <b>رد فريق الدعم على تذكرتك #${ticketId}:</b>\n\n${replyText}`,
    { parse_mode: 'HTML' }
  );

  // ── تأكيد الإرسال للأدمن ──────────────────────────────────────────────
  await safeSend(
    adminChatId,
    `✅ تم إرسال ردك على التذكرة <b>#${ticketId}</b> بنجاح.`,
    { parse_mode: 'HTML' }
  );
});

// ─── تنبيه لاستخدام /reply بدون معاملات صحيحة ──────────────────────────────
bot.onText(/^\/reply$/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (chatId !== String(ADMIN_CHAT_ID)) return;
  await safeSend(chatId, '⚠️ الاستخدام الصحيح:\n<code>/reply TICKET_ID رسالة الرد</code>', { parse_mode: 'HTML' });
});

// ════════════════════════════════════════════════════════════════════════════
//  استقبال رسائل العملاء العادية
// ════════════════════════════════════════════════════════════════════════════
bot.on('message', async (msg) => {
  // تجاهل الأوامر
  if (msg.text && msg.text.startsWith('/')) return;
  // تجاهل رسائل الأدمن
  if (String(msg.chat.id) === String(ADMIN_CHAT_ID)) return;
  // تجاهل الرسائل غير النصية
  if (!msg.text) return;

  const chatId  = String(msg.chat.id);
  const name    = buildName(msg.from);
  const text    = msg.text.trim();

  try {
    // ── إنشاء المستخدم إذا لم يكن موجوداً ──────────────────────────────
    const user = await createTelegramUser(chatId, name);
    if (!user) throw new Error('فشل إنشاء/تحديث المستخدم');

    const userId = String(user.id);

    // ── البحث عن تذكرة مفتوحة أو إنشاء واحدة جديدة ─────────────────────
    let ticket = await getOpenTicketByTelegramId(chatId);

    if (!ticket) {
      ticket = await createTicket(userId, name);
      if (!ticket) throw new Error('فشل إنشاء التذكرة');

      await safeSend(
        chatId,
        `🎫 تم فتح تذكرة دعم جديدة برقم <b>#${ticket.id}</b>.\nسيتواصل معك فريق الدعم قريباً.`,
        { parse_mode: 'HTML' }
      );
    }

    // ── حفظ الرسالة ─────────────────────────────────────────────────────
    await saveTicketMessage(ticket.id, 'user', text);

    // ── إشعار الأدمن ─────────────────────────────────────────────────────
    if (ADMIN_CHAT_ID) {
      await safeSend(
        ADMIN_CHAT_ID,
        `🔔 <b>رسالة جديدة</b>\n🎫 تذكرة: <b>#${ticket.id}</b>\n👤 المستخدم: ${name}\n💬 الرسالة:\n${text}\n\n↩️ للرد: <code>/reply ${ticket.id} ردك هنا</code>`,
        { parse_mode: 'HTML' }
      );
    }

    // ── تأكيد الاستلام للعميل ────────────────────────────────────────────
    await safeSend(
      chatId,
      '✅ تم استلام رسالتك. سيرد عليك أحد موظفي الدعم قريباً.'
    );

  } catch (err) {
    console.error('[telegramBot] خطأ في معالجة الرسالة:', err.message);
    await safeSend(chatId, '⚠️ حدث خطأ أثناء معالجة رسالتك. يرجى المحاولة مرة أخرى.');
  }
});

// ─── معالجة أخطاء البوت العامة ──────────────────────────────────────────────
bot.on('polling_error', (err) => {
  console.error('[telegramBot] polling error:', err.message);
});

bot.on('error', (err) => {
  console.error('[telegramBot] error:', err.message);
});

module.exports = bot;
