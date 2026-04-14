/**
 * analyzer.js — محرك التحليل والردود الذكية
 * ===========================================
 * • تحليل النية والمشاعر
 * • فلترة المحتوى غير اللائق (عنصرية / سب / +18)
 * • ردود رسمية ذكية مع اقتراحات
 * • fallback response عند عدم التعرف
 */

'use strict';

const { getConversation } = require('./storage');

// ─── قواميس الكلمات ──────────────────────────────────────────────────────────
const TOXIC_WORDS     = ['غبي','حمار','قذر','تافه','كلب','أحمق','مجنون','stupid','idiot','dumb','fool','moron'];
const NSFW_WORDS      = ['جنس','اباحي','عاري','إباحي','porn','sex','xxx','nude','18+'];
const VIOLENCE_WORDS  = ['قتل','ذبح','تفجير','سلاح','دم','اقتل','kill','bomb','weapon','murder','shoot'];
const RACISM_WORDS    = ['عنصري','عنصرية','نازي','ابادة','racist','racism','nazi','genocide'];
const SPAM_WORDS      = ['ربح سريع','اضغط هنا','crypto pump','casino','مليون دولار','كسب مضمون'];
const SALES_WORDS     = ['سعر','عرض','اشتراك','شراء','خطة','تكلفة','باقة','تسعير'];
const SUPPORT_WORDS   = ['دعم','مشكلة','خلل','لا يعمل','خطأ','bug','error','help','مساعدة','issue'];
const DELIVERY_WORDS  = ['توصيل','شحنة','طلب متأخر','لم يصل','delivery','shipment','تتبع'];
const PARTNERSHIP_WORDS=['شراكة','تعاون','partnership','agency','integration','تكامل'];
const FEEDBACK_WORDS  = ['اقتراح','ملاحظة','تحسين','feedback','رأي','تقييم'];
const PRODUCT_WORDS   = ['منتج','تلفون','شاحن','ساعة','سماعة','قطع غيار','جهاز'];
const URGENT_WORDS    = ['عاجل','حالاً','urgent','asap','فوراً','الآن','ضروري'];
const NEGATIVE_WORDS  = ['مشكلة','خطأ','سيء','غاضب','مستاء','تأخير','لا يعمل','شكوى','راضي'];
const POSITIVE_WORDS  = ['ممتاز','رائع','شكراً','أحسنتم','جميل','مفيد','رضا','سعيد'];
const GREETING_WORDS  = ['مرحبا','السلام','اهلا','هلا','hello','hi','hey','صباح','مساء'];

// ─── دوال مساعدة ─────────────────────────────────────────────────────────────
function normalize(text = '') {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function containsAny(text, words) {
  return words.some(w => text.includes(w));
}

// ─── فحص الفلترة (المحتوى المحظور) ──────────────────────────────────────────
function checkForbidden(text) {
  if (containsAny(text, TOXIC_WORDS))    return 'toxic';
  if (containsAny(text, RACISM_WORDS))   return 'racism';
  if (containsAny(text, NSFW_WORDS))     return 'nsfw';
  if (containsAny(text, VIOLENCE_WORDS)) return 'violence';
  return null;
}

// ─── تحديد النية ─────────────────────────────────────────────────────────────
function detectIntent(text) {
  if (containsAny(text, GREETING_WORDS))     return 'greeting';
  if (containsAny(text, SPAM_WORDS))         return 'spam';
  if (containsAny(text, DELIVERY_WORDS))     return 'delivery';
  if (containsAny(text, SUPPORT_WORDS))      return 'support';
  if (containsAny(text, SALES_WORDS))        return 'sales';
  if (containsAny(text, PARTNERSHIP_WORDS))  return 'partnership';
  if (containsAny(text, FEEDBACK_WORDS))     return 'feedback';
  if (containsAny(text, PRODUCT_WORDS))      return 'product';
  return 'general';
}

// ─── تحليل المشاعر ───────────────────────────────────────────────────────────
function detectSentiment(text) {
  const neg = containsAny(text, NEGATIVE_WORDS);
  const pos = containsAny(text, POSITIVE_WORDS);
  if (pos && !neg) return 'positive';
  if (neg && !pos) return 'negative';
  return 'neutral';
}

// ─── استخراج الكيانات ─────────────────────────────────────────────────────────
function extractEntities(rawText = '') {
  const text = String(rawText);
  return {
    emails:   [...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(m => m[0]),
    phones:   [...text.matchAll(/(?:\+?\d[\d\s-]{7,}\d)/g)].map(m => m[0].trim()),
    urls:     [...text.matchAll(/https?:\/\/[^\s]+/g)].map(m => m[0]),
    orderIds: [...text.matchAll(/#?[A-Z]{0,3}\d{4,}/g)].map(m => m[0]),
    dates:    [...text.matchAll(/\b(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/g)].map(m => m[0]),
    company:  (text.match(/(?:شركة|مؤسسة|منصة)\s+([^\n,.]+)/) || [])[1]?.trim() || null,
    person:   (text.match(/(?:اسمي|أنا)\s+([^\n,.]+)/)        || [])[1]?.trim() || null
  };
}

// ─── ملخص النص ────────────────────────────────────────────────────────────────
function summarize(text) {
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'لا توجد رسالة لتحليلها.';
  const sentences = cleaned.split(/[.!؟\n]/).map(s => s.trim()).filter(Boolean);
  const summary   = sentences.slice(0, 2).join(' — ');
  return summary.length > 160 ? summary.slice(0, 157) + '...' : summary;
}

// ─── هل يجب التصعيد؟ ─────────────────────────────────────────────────────────
function shouldEscalate(intent, sentiment, text) {
  return (
    intent === 'support' ||
    intent === 'delivery' ||
    sentiment === 'negative' ||
    containsAny(text, URGENT_WORDS) ||
    containsAny(text, ['تأخير','فاتورة','شكوى'])
  );
}

// ════════════════════════════════════════════════════════════════════════════════
//  الردود والاقتراحات حسب النية
// ════════════════════════════════════════════════════════════════════════════════
const INTENT_REPLY = {
  greeting:    'مرحباً بك! يسعدنا تواصلك معنا. كيف يمكنني مساعدتك اليوم؟',
  support:     'تلقّينا طلب الدعم الفني الخاص بك. سنقوم بمراجعة المشكلة وتزويدك بخطوات واضحة للحل في أقرب وقت ممكن.',
  sales:       'يسعدنا تزويدك بكامل التفاصيل المتعلقة بأسعارنا وباقاتنا. يمكنني توجيهك للخطة الأنسب بحسب احتياجاتك.',
  delivery:    'نأسف لأي تأخير في وصول طلبك. سنقوم بمتابعة حالة الشحنة فوراً وإبلاغك بآخر التحديثات.',
  partnership: 'نرحب بفكرة التعاون والتكامل. يسعدنا مناقشة التفاصيل وترتيب الخطوات المناسبة لبناء شراكة ناجحة.',
  feedback:    'نقدّر ملاحظتك بشدة. سيتم توجيهها مباشرةً للفريق المختص لمراجعتها والعمل على تحسين خدمتنا.',
  product:     'يمكنني تزويدك بكافة المعلومات المتعلقة بالمنتج. هل لديك استفسار محدد تودّ الاستفسار عنه؟',
  spam:        'نعتذر، لا يمكننا متابعة هذا النوع من الرسائل وفق سياسات الاستخدام المعتمدة لدينا.',
  general:     'تلقّينا رسالتك وسنبادر بالرد عليك في أقرب وقت. هل يمكنك تزويدنا بمزيد من التفاصيل لنتمكن من خدمتك بشكل أفضل؟'
};

const INTENT_SUGGESTIONS = {
  greeting:    ['ما هي خدماتكم؟', 'أريد دعم فني', 'استفسار عن الأسعار', 'تواصل مع الدعم'],
  support:     ['وصف المشكلة بالتفصيل', 'إرسال لقطة شاشة', 'فتح تذكرة دعم', 'التحدث مع موظف'],
  sales:       ['عرض الباقات المتاحة', 'طلب عرض سعر', 'جدولة مكالمة', 'تواصل مع المبيعات'],
  delivery:    ['تتبع الشحنة', 'الإبلاغ عن مشكلة', 'فتح تذكرة دعم', 'التحدث مع موظف'],
  partnership: ['إرسال ملف الشراكة', 'جدولة اجتماع', 'الاطلاع على الشروط', 'التواصل المباشر'],
  feedback:    ['إرسال الاقتراح رسمياً', 'تقييم الخدمة', 'تواصل مع الإدارة'],
  product:     ['مزيد من التفاصيل', 'عرض المواصفات', 'مقارنة المنتجات', 'طلب عينة'],
  spam:        ['العودة للقائمة الرئيسية', 'تواصل رسمي', 'مساعدة'],
  general:     ['ابدأ', 'مساعدة', 'تواصل مع الدعم', 'الأسئلة الشائعة']
};

const FORBIDDEN_SUGGESTIONS = [
  'العودة للمحادثة الطبيعية',
  'فتح تذكرة دعم',
  'التحدث مع موظف'
];

// ─── تحليل نموذج التواصل (API: /api/contact/analyze) ─────────────────────────
function analyzeContact(payload, store) {
  const name    = sanitizeInput(payload.name    || '');
  const email   = sanitizeInput(payload.email   || '');
  const message = sanitizeInput(payload.message || '', 2000);
  const topic   = sanitizeInput(payload.topic   || '');
  const text    = normalize(`${topic} ${message}`);

  const forbidden = checkForbidden(text);
  if (forbidden) {
    return {
      name, email, topic,
      intent: `blocked:${forbidden}`,
      sentiment: 'blocked',
      summary: 'رسالة محظورة',
      moderation: { isSafe: false, flags: [forbidden] },
      entities: extractEntities(''),
      suggestedReply: 'نعتذر، لا يمكننا المساعدة في هذا النوع من الطلبات لأن سياساتنا لا تسمح بذلك.',
      suggestions: FORBIDDEN_SUGGESTIONS,
      smartHints: ['يُنصح بمراجعة سياسة الاستخدام والتواصل بطريقة لائقة.'],
      shouldEscalate: false,
      confidence: 1.0,
      rewrittenMessage: null,
      seo: null
    };
  }

  const intent    = detectIntent(text);
  const sentiment = detectSentiment(text);
  const entities  = extractEntities(`${name}\n${email}\n${topic}\n${message}`);
  const summary   = summarize(message);
  const greeting  = name ? `مرحباً ${name}،` : 'مرحباً،';
  const empathy   = sentiment === 'negative' ? ' نعتذر عن أي إزعاج ونقدّر توضيحك.' : '';

  const entityNote = [
    entities.orderIds.length ? `رقم الطلب: ${entities.orderIds[0]}.` : '',
    entities.emails.length   ? `البريد المذكور: ${entities.emails[0]}.` : ''
  ].filter(Boolean).join(' ');

  const suggestedReply = `${greeting}${empathy} ${INTENT_REPLY[intent] || INTENT_REPLY.general} ${entityNote}`.trim();

  return {
    name, email, topic, summary, intent, sentiment,
    moderation: { isSafe: true, flags: [] },
    entities,
    suggestedReply,
    suggestions: INTENT_SUGGESTIONS[intent] || INTENT_SUGGESTIONS.general,
    smartHints: buildSmartHints(intent, sentiment, entities),
    rewrittenMessage: buildPoliteRewrite(name, message, intent),
    seo: buildSeoSuggestions(message),
    shouldEscalate: shouldEscalate(intent, sentiment, text),
    confidence: intent === 'general' ? 0.65 : 0.91
  };
}

// ─── بناء الرد المهذّب ────────────────────────────────────────────────────────
function buildPoliteRewrite(name, text, intent) {
  const intro = name ? `مرحباً، أنا ${name}. ` : 'مرحباً، ';
  const byIntent = {
    greeting:    'أودّ التواصل معكم.',
    support:     'أواجه مشكلة تقنية وأحتاج إلى دعم فني.',
    sales:       'أرغب بمعرفة الأسعار والباقات المتاحة.',
    delivery:    'أواجه مشكلة في وصول طلبي وأحتاج للمتابعة.',
    partnership: 'أرغب بمناقشة فرصة تعاون أو تكامل.',
    feedback:    'أودّ مشاركة ملاحظة لتحسين الخدمة.',
    product:     'أرغب بالاستفسار عن تفاصيل منتج معين.',
    spam:        'رسالة غير مناسبة.',
    general:     'أرغب بالتواصل والاستفسار.'
  };
  return `${intro}${byIntent[intent] || byIntent.general} التفاصيل: ${text.trim()}`;
}

// ─── تلميحات ذكية ─────────────────────────────────────────────────────────────
function buildSmartHints(intent, sentiment, entities) {
  const hints = [];
  if (intent === 'support')    hints.push('اطلب من العميل تفاصيل الخطأ والخطوات التي أدت إليه.');
  if (intent === 'delivery')   hints.push('تحقق من رقم التتبع وأبلغ العميل بالوقت المتوقع للوصول.');
  if (intent === 'sales')      hints.push('اقترح جدولة مكالمة تعريفية أو إرسال ملف الأسعار.');
  if (intent === 'feedback')   hints.push('اشكر العميل ووضّح كيف ستستفيد من ملاحظته.');
  if (intent === 'partnership') hints.push('اطلب ملف تعريفي أو اقترح اجتماع أوّلي.');
  if (sentiment === 'negative') hints.push('ابدأ الرد بتعاطف واعتذار مهني قصير قبل الحل.');
  if (entities.orderIds.length) hints.push(`تم رصد رقم طلب: ${entities.orderIds[0]} — تحقق منه في النظام.`);
  if (!hints.length)            hints.push('استخدم رداً مختصراً ثم أضف سؤال متابعة واضح.');
  return hints;
}

// ─── اقتراحات SEO ─────────────────────────────────────────────────────────────
function buildSeoSuggestions(text) {
  const keywords = normalize(text)
    .split(/[^a-zA-Z\u0600-\u06FF0-9]+/)
    .filter(x => x.length > 3)
    .slice(0, 6);
  return {
    titleIdea: `حل سريع لـ ${keywords[0] || 'استفسار العميل'} | دليل مبسّط`,
    metaDescription: 'ملخص قصير يشرح المشكلة أو الطلب ويقترح استجابة عملية.',
    faqIdeas: [
      'ما الخطوة الأولى بعد إرسال الرسالة؟',
      'كيف يتم تصنيف الطلبات تلقائياً؟',
      'متى يجب تحويل الطلب إلى الدعم البشري؟'
    ],
    targetKeywords: keywords
  };
}

// ─── sanitize مبسط ────────────────────────────────────────────────────────────
function sanitizeInput(value, maxLen = 500) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]+>/g, '').trim().slice(0, maxLen);
}

// ════════════════════════════════════════════════════════════════════════════════
//  الدردشة الذكية — generateChatReply
// ════════════════════════════════════════════════════════════════════════════════

function textToKeywordSet(text = '') {
  return new Set(
    normalize(text).split(/[^a-zA-Z\u0600-\u06FF0-9]+/).filter(w => w.length > 2)
  );
}

function scoreSimilarity(a, b) {
  const setA = textToKeywordSet(a);
  const setB = textToKeywordSet(b);
  let overlap = 0;
  setA.forEach(w => { if (setB.has(w)) overlap++; });
  return overlap;
}

function retrieveMemories(sessionId, message, store) {
  try {
    const conversation = getConversation(store, sessionId);
    return conversation
      .filter(item => ['user', 'contact-form'].includes(item.role))
      .map(item => ({ content: item.content, score: scoreSimilarity(item.content, message) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  } catch {
    return [];
  }
}

// ─── ردود الدردشة الذكية حسب النية ──────────────────────────────────────────
const CHAT_REPLY = {
  greeting:    'مرحباً بك! أنا هنا لمساعدتك. كيف يمكنني خدمتك اليوم؟',
  support:     'يبدو أنك تواجه مشكلة تقنية. دعنا نحلّها معاً — هل يمكنك توصيف المشكلة بدقة أكبر؟ متى بدأت؟ وما الخطوات التي أفضت إليها؟',
  sales:       'يسعدنا تزويدك بكامل تفاصيل الأسعار والباقات. ما حجم المشروع الذي تعمل عليه حتى أتمكن من اقتراح الخيار الأنسب؟',
  delivery:    'نأسف لهذا التأخير. يرجى مشاركة رقم الطلب أو رقم الشحنة لنتمكن من متابعة حالتها فوراً.',
  partnership: 'فكرة الشراكة مثيرة للاهتمام! هل يمكنك توضيح طبيعة العمل وما الذي تسعى لتحقيقه من هذا التعاون؟',
  feedback:    'ملاحظتك قيّمة جداً لنا. هل يمكنك إعطاءنا مزيداً من التفاصيل حتى نتمكن من ترجمتها إلى تحسين فعلي؟',
  product:     'يسعدنا تزويدك بكافة المعلومات. عن أي منتج تستفسر بالتحديد؟',
  spam:        'هذه الرسالة لا تتوافق مع سياسات التواصل المعتمدة لدينا. إن كان لديك استفسار حقيقي، يسعدنا خدمتك.',
  general:     'شكراً لتواصلك! لكي أتمكن من مساعدتك بشكل أدق، هل يمكنك توضيح طبيعة الاستفسار أو المشكلة؟'
};

function generateChatReply(sessionId, rawMessage, store) {
  // حد أقصى للرسالة
  const message    = sanitizeInput(String(rawMessage || ''), 1000);
  const normalized = normalize(message);

  // فحص المحتوى المحظور أولاً
  const forbidden = checkForbidden(normalized);
  if (forbidden) {
    return {
      reply: 'نعتذر، لا يمكننا المساعدة في هذا النوع من الطلبات لأن سياساتنا لا تسمح بذلك.',
      answer: 'نعتذر، لا يمكننا المساعدة في هذا النوع من الطلبات لأن سياساتنا لا تسمح بذلك.',
      suggestions: FORBIDDEN_SUGGESTIONS,
      detectedIntent: `blocked:${forbidden}`,
      memoriesUsed: [],
      historyCount: 0
    };
  }

  const detectedIntent = detectIntent(normalized);
  const memories       = retrieveMemories(sessionId, message, store);

  // بناء الرد
  let coreReply = CHAT_REPLY[detectedIntent] || CHAT_REPLY.general;

  // إضافة سياق الذاكرة إن وجدت
  if (memories.length > 0) {
    const memoryNote = `(استناداً لتواصلنا السابق: "${memories[0].content.slice(0, 60).trim()}...") `;
    coreReply = memoryNote + coreReply;
  }

  const suggestions = INTENT_SUGGESTIONS[detectedIntent] || INTENT_SUGGESTIONS.general;

  return {
    reply: coreReply,
    answer: coreReply,           // للتوافق مع server.js القديم
    suggestions,
    detectedIntent,
    memoriesUsed: memories,
    historyCount: memories.length
  };
}

// ════════════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ════════════════════════════════════════════════════════════════════════════════
module.exports = {
  analyzeContact,
  generateChatReply,
  detectIntent,
  checkForbidden,
  sanitizeInput
};
