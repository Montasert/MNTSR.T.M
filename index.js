// ============================================
// Minecraft Bedrock Player Bot - Microsoft Auth
// نسخة مستقرة: بدون حركة فيزيائية (غير ممكنة حالياً
// بسبب علة في بروتوكول 1.26.30 نفسه)، الذكاء الاصطناعي
// يتحكم بالشخصية والقرارات والردود بالكامل.
// ============================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const bedrock = require('bedrock-protocol');

// ---- إعدادات البوت ----
const SERVER_HOST = process.env.SERVER_HOST || 'play.example.com';
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '19132');
const BOT_USERNAME = process.env.BOT_USERNAME || 'MyPlayerBot';
const MC_VERSION   = process.env.MC_VERSION   || '1.26.33';

// ============================================
// حفظ/استعادة جلسة تسجيل الدخول عبر متغير بيئة
// ============================================
const PROFILES_FOLDER = path.join(__dirname, 'auth_cache');

function restoreSessionFromEnv() {
  if (!process.env.MSA_CACHE) return;
  try {
    const files = JSON.parse(Buffer.from(process.env.MSA_CACHE, 'base64').toString('utf-8'));
    fs.mkdirSync(PROFILES_FOLDER, { recursive: true });
    for (const [relPath, base64Content] of Object.entries(files)) {
      const fullPath = path.join(PROFILES_FOLDER, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, Buffer.from(base64Content, 'base64'));
    }
    console.log('✅ تم استعادة جلسة تسجيل الدخول المحفوظة — لا حاجة لتسجيل دخول جديد.');
  } catch (e) {
    console.error('⚠️ تعذّر استعادة جلسة تسجيل الدخول من MSA_CACHE:', e.message);
  }
}

let latestCacheString = null;

function buildSessionCacheString() {
  if (!fs.existsSync(PROFILES_FOLDER)) return;
  const files = {};
  (function walk(dir, base) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else files[rel] = fs.readFileSync(full).toString('base64');
    }
  })(PROFILES_FOLDER, '');
  latestCacheString = Buffer.from(JSON.stringify(files)).toString('base64');
  console.log('\n✅ تم إنشاء بيانات الجلسة. افتح رابط خدمتك متبوعاً بـ /cache لنسخها.');
}

restoreSessionFromEnv();

// ============================================
// الذكاء الاصطناعي (Gemini API) + نظام المزاج
// ============================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

const BOT_PERSONA_BASE = process.env.BOT_PERSONA ||
  `أنت لاعب عادي بشخصية ${BOT_USERNAME} داخل سيرفر ماين كرافت. تتكلم بالعامية بشكل طبيعي جداً،
مختصر (جملة أو جملتين كحد أقصى)، بدون أي أسلوب رسمي أو روبوتي، بدون تقديم نفسك كـ"مساعد ذكاء اصطناعي"
أبداً. رد بروح مرحة وطبيعية زي أي شخص عادي يلعب ويحكي مع أصحابه.`;

let annoyance = 0;
let lastHitAt = 0;
let recentHits = [];
const ANNOYANCE_DECAY_MS = 60000;

function currentMoodDescription() {
  const hour = new Date().getHours();
  let mood = 'هادئ وطبيعي';
  if (annoyance >= 5) mood = 'غاضب جداً وعصبي المزاج، ردودك حادة وقصيرة';
  else if (annoyance >= 2) mood = 'منزعج شوي، متضايق من التنرفز اللي صار';
  else if (hour >= 0 && hour < 6) mood = 'نعسان وكسلان، ردودك بطيئة ومقتضبة كإنك تعبان';
  return mood;
}

function buildPersonaWithMood() {
  return `${BOT_PERSONA_BASE}\n\nحالتك المزاجية الحالية: ${currentMoodDescription()}. خلي ردك يعكس هالمزاج بشكل طبيعي، بدون ما تشرح إنك "بمزاج كذا" — بس تصرف عليه.`;
}

const chatHistory = new Map();
const HISTORY_LIMIT = 6;
let lastReplyAt = 0;
const REPLY_COOLDOWN_MS = 4000;

async function callGemini(contents) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({ contents }),
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, opts);
    if (res.ok) return res.json();

    // 503 (ازدحام مؤقت) و429 (تجاوز الحصة اللحظية) تستحق إعادة محاولة قصيرة
    if ((res.status === 503 || res.status === 429) && attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      continue;
    }
    throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
  }
}

async function askAI(playerName, message) {
  const history = chatHistory.get(playerName) || [];
  const contents = [
    { role: 'user', parts: [{ text: buildPersonaWithMood() }] },
    { role: 'model', parts: [{ text: 'تمام، فهمت.' }] },
    ...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: `${playerName}: ${message}` }] },
  ];

  const data = await callGemini(contents);
  const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!reply) throw new Error('رد فارغ من الذكاء الاصطناعي');

  const updated = [...history, { role: 'user', text: message }, { role: 'model', text: reply }];
  chatHistory.set(playerName, updated.slice(-HISTORY_LIMIT));
  return reply;
}

const LIGHT_HIT_REPLIES = ['ايش هالضربة؟ 😅', 'هاها طيب طيب', 'وقف بضربني 😂', 'ليش هيك 😆'];
const SERIOUS_HIT_REPLIES = ['وقف!! ليش عم تضربني!!', 'خلص بجد؟؟ 😠', 'طيب طيب هدّي، عم تعصبني', 'استوقف قبل ما تندم'];
const DEATH_REPLIES = ['قتلتني 😤 برجع بس ما بنساها', 'يووه ميت 💀 خلص كسبت المرة هاي', 'قتلتني بس بس، بجيك تاني 😅'];

function registerHit() {
  const now = Date.now();
  if (now - lastHitAt > ANNOYANCE_DECAY_MS) { annoyance = 0; recentHits = []; }
  lastHitAt = now;
  recentHits = recentHits.filter(t => now - t < 5000);
  recentHits.push(now);
  const isSerious = recentHits.length >= 3;
  annoyance = Math.min(annoyance + (isSerious ? 2 : 1), 8);
  return isSerious;
}

function pickReply(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function sendChat(client, text) {
  try {
    client.queue('text', {
      needs_translation: false,
      category: 1,
      type: 'chat',
      source_name: BOT_USERNAME,
      message: text,
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false,
    });
  } catch (e) {
    console.error('⚠️ خطأ بإرسال رسالة شات:', e.message);
  }
}

// ============================================
// إدارة الاتصال + إعادة الاتصال التلقائي
// ============================================
let client = null;
let reconnectTimer = null;
let hasSpawnedOnce = false;

function scheduleReconnect(delayMs, reasonText) {
  if (reconnectTimer) return;
  console.log(`🔁 إعادة محاولة الاتصال خلال ${Math.round(delayMs / 1000)} ثانية بسبب: ${reasonText}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBot();
  }, delayMs);
}

function connectBot() {
  console.log('=== محاولة الاتصال بالسيرفر ===');

  client = bedrock.createClient({
    host: SERVER_HOST,
    port: SERVER_PORT,
    username: BOT_USERNAME,
    offline: false,
    version: MC_VERSION,
    profilesFolder: PROFILES_FOLDER,
  });

  client.on('session', () => {
    console.log('✅ تم ربط الحساب وتسجيل الدخول بنجاح.');
    if (!process.env.MSA_CACHE) buildSessionCacheString();
  });

  client.on('join', () => {
    console.log('🚪 البوت في طور الانضمام للسيرفر...');
  });

  let runtimeEntityId = null;
  let isDead = false;

  client.on('start_game', (packet) => {
    runtimeEntityId = packet.runtime_entity_id;
    console.log('📍 تم حفظ معرّف الكيان:', String(runtimeEntityId));

    // نمط مؤكد من مجتمع bedrock-protocol لحل مشكلة "الخلود/العالق"
    try {
      client.queue('serverbound_loading_screen', { type: 1 });
      client.queue('serverbound_loading_screen', { type: 2 });
      client.queue('interact', {
        action_id: 'mouse_over_entity',
        target_entity_id: 0n,
        position: { x: 0, y: 0, z: 0 },
      });
      client.queue('set_local_player_as_initialized', {
        runtime_entity_id: String(runtimeEntityId),
      });
      console.log('✅ تم تطبيق تسلسل الاندماج الكامل بالعالم.');
    } catch (e) {
      console.error('⚠️ خطأ بتسلسل الاندماج:', e.message);
    }
  });

  client.on('set_entity_motion', (packet) => {
    if (runtimeEntityId === null) return;
    const myId = String(runtimeEntityId);
    const entry = packet.entries?.find(e => String(e.runtime_entity_id) === myId);
    if (!entry?.velocity) return;

    const isSerious = registerHit();
    console.log(`💥 البوت انضرب (${isSerious ? 'هجوم جدي' : 'ضربة خفيفة'}) — مستوى الانزعاج: ${annoyance}`);

    if (!isSerious || !GEMINI_API_KEY) {
      sendChat(client, pickReply(isSerious ? SERIOUS_HIT_REPLIES : LIGHT_HIT_REPLIES));
    }
  });

  client.on('update_attributes', (packet) => {
    if (runtimeEntityId === null) return;
    if (String(packet.runtime_entity_id) !== String(runtimeEntityId)) return;

    const healthAttr = packet.attributes?.find(a => a.name === 'minecraft:health');
    if (!healthAttr) return;

    if (healthAttr.value <= 0 && !isDead) {
      isDead = true;
      console.log('☠️ البوت مات.');
      sendChat(client, pickReply(DEATH_REPLIES));
    } else if (healthAttr.value > 0 && isDead) {
      isDead = false;
      console.log('❤️ البوت رجع حي (respawn).');
    }
  });

  client.on('spawn', () => {
    console.log('🎮 البوت الآن داخل السيرفر وظاهر في العالم.');
    hasSpawnedOnce = true;
  });

  client.on('disconnect', (packet) => {
    const reason = packet?.reason || 'غير معروف';
    console.log('❌ تم فصل البوت. السبب:', reason);
    const delay = reason === 'server_id_conflict' ? 20000 : 10000;
    scheduleReconnect(delay, reason);
  });

  client.on('kick', (reason) => {
    console.log('⛔ تم طرد البوت من السيرفر:', reason);
  });

  client.on('error', (err) => {
    console.error('⚠️ خطأ في الاتصال:', err.message);
  });

  client.on('text', async (packet) => {
    if (packet.type !== 'chat') return;
    if (packet.source_name === BOT_USERNAME) return;
    if (!GEMINI_API_KEY) return;

    const mentioned = packet.message?.toLowerCase().includes(BOT_USERNAME.toLowerCase());
    if (!mentioned) return;

    const now = Date.now();
    if (now - lastReplyAt < REPLY_COOLDOWN_MS) return;
    lastReplyAt = now;

    try {
      const reply = await askAI(packet.source_name, packet.message);
      sendChat(client, reply);
    } catch (e) {
      console.error('⚠️ خطأ في الشات الذكي:', e.message);
    }
  });
}

console.log('=== بدء تشغيل البوت ===');
console.log('عند ظهور رابط microsoft.com/link مع كود مكوّن من 8 أحرف بالأسفل،');
console.log('افتحه من متصفح هاتفك وأدخل الكود لربط حسابك.\n');

connectBot();

// ============================================
// سيرفر HTTP: يبقي Render مستيقظاً + صفحة /cache
// ============================================
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  if (req.url === '/cache') {
    if (!latestCacheString) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('لا توجد بيانات جلسة جاهزة بعد. سجّل الدخول أولاً، ثم أعد تحميل هذه الصفحة.');
      return;
    }
    const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>نسخ بيانات الجلسة</title>
<style>
  body { font-family: sans-serif; padding: 16px; background:#111; color:#eee; }
  textarea { width: 100%; height: 55vh; box-sizing: border-box; font-family: monospace;
             font-size: 12px; padding: 8px; direction: ltr; }
  button { width: 100%; padding: 14px; font-size: 16px; margin-top: 10px; }
  p { line-height: 1.6; }
</style></head>
<body>
  <p>1) اضغط الزر لنسخ النص كاملاً.<br>
     2) الصقه في متغير بيئة باسم <b>MSA_CACHE</b> في Render.</p>
  <textarea id="c" readonly>${latestCacheString}</textarea>
  <button onclick="navigator.clipboard.writeText(document.getElementById('c').value).then(()=>alert('تم النسخ ✅'))">
    نسخ النص كاملاً
  </button>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('البوت يعمل الآن ✅');
}).listen(PORT, () => {
  console.log(`🌐 سيرفر الحفاظ على الاتصال يعمل على المنفذ ${PORT}`);
});
