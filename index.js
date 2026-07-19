// ============================================
// Minecraft Bedrock Player Bot - Microsoft Auth
// ============================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const bedrock = require('bedrock-protocol');

// ---- إعدادات البوت (عدّلها حسب سيرفرك) ----
const SERVER_HOST = process.env.SERVER_HOST || 'play.example.com';
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '19132');
const BOT_USERNAME = process.env.BOT_USERNAME || 'MyPlayerBot';
const MC_VERSION   = process.env.MC_VERSION   || '1.26.33';

// ============================================
// حفظ/استعادة جلسة تسجيل الدخول عبر متغير بيئة
// (لأن قرص Render يُمسح بالكامل بعد كل إعادة نشر)
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

// يُخزَّن هنا بعد أول تسجيل دخول، ويُعرض عبر رابط ويب /cache
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
  console.log('\n✅ تم إنشاء بيانات الجلسة. افتح من متصفح هاتفك رابط خدمتك متبوعاً بـ /cache لنسخها.');
}

restoreSessionFromEnv();

// ============================================
// الشات الذكي (Gemini API)
// ============================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';

const BOT_PERSONA = process.env.BOT_PERSONA ||
  `أنت لاعب عادي بشخصية ${BOT_USERNAME} داخل سيرفر ماين كرافت. تتكلم بالعامية بشكل طبيعي جداً،
مختصر (جملة أو جملتين كحد أقصى)، بدون أي أسلوب رسمي أو روبوتي، بدون تقديم نفسك كـ"مساعد ذكاء اصطناعي"
أبداً. رد بروح مرحة وطبيعية زي أي شخص عادي يلعب ويحكي مع أصحابه.`;

const chatHistory = new Map(); // playerName -> [{role, text}]
const HISTORY_LIMIT = 6;
let lastReplyAt = 0;
const REPLY_COOLDOWN_MS = 4000;

async function askAI(playerName, message) {
  const history = chatHistory.get(playerName) || [];
  const contents = [
    { role: 'user', parts: [{ text: BOT_PERSONA }] },
    { role: 'model', parts: [{ text: 'تمام، فهمت.' }] },
    ...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: `${playerName}: ${message}` }] },
  ];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({ contents }),
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!reply) throw new Error('رد فارغ من الذكاء الاصطناعي');

  const updated = [...history, { role: 'user', text: message }, { role: 'model', text: reply }];
  chatHistory.set(playerName, updated.slice(-HISTORY_LIMIT));

  return reply;
}

// ============================================
// إدارة الاتصال + إعادة الاتصال التلقائي
// ============================================
let client = null;
let reconnectTimer = null;
let hasSpawnedOnce = false; // نطبع رسائل تسجيل الدخول مرة وحدة بس

// ============================================
// فيزياء أساسية: تطبيق الارتداد (Knockback) عند الضرب
// ============================================
let botPosition = null;         // {x, y, z}
let botVelocity = { x: 0, y: 0, z: 0 };
let botYaw = 0, botPitch = 0, botHeadYaw = 0;
let physicsTick = 0n;
let physicsInterval = null;
let physicsErrorLogged = false; // نطبع خطأ الفيزياء مرة وحدة بس حتى ما نغرق السجل

const GRAVITY = 0.08;
const DRAG = 0.98;
const FRICTION = 0.6; // تباطؤ الحركة الأفقية تدريجياً بعد الضربة

function startPhysicsLoop() {
  stopPhysicsLoop();
  physicsInterval = setInterval(() => {
    if (!botPosition || !client) return;

    // جاذبية بسيطة + مقاومة هواء
    botVelocity.y -= GRAVITY;
    botVelocity.y *= DRAG;

    // تحديث الموقع فعلياً
    botPosition.x += botVelocity.x;
    botPosition.y += botVelocity.y;
    botPosition.z += botVelocity.z;

    // احتكاك أفقي: يبطّئ الارتداد تدريجياً بدل ما يستمر للأبد
    botVelocity.x *= FRICTION;
    botVelocity.z *= FRICTION;

    physicsTick += 1n;

    try {
      client.queue('player_auth_input', {
        pitch: botPitch,
        yaw: botYaw,
        position: botPosition,
        move_vector: { x: 0, z: 0 },
        head_yaw: botHeadYaw,
        input_data: [],
        input_mode: 'mouse',
        play_mode: 'normal',
        interaction_model: 'touch',
        tick: physicsTick,
        delta: { x: botVelocity.x, y: botVelocity.y, z: botVelocity.z },
      });
    } catch (e) {
      if (!physicsErrorLogged) {
        console.error('⚠️ خطأ بإرسال حزمة الحركة (player_auth_input):', e.message);
        physicsErrorLogged = true;
      }
    }
  }, 50); // 20 مرة بالثانية تقريباً
}

function stopPhysicsLoop() {
  if (physicsInterval) clearInterval(physicsInterval);
  physicsInterval = null;
}

function scheduleReconnect(delayMs, reasonText) {
  if (reconnectTimer) return; // في محاولة إعادة اتصال مجدولة أصلاً
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

  client.on('play_status', (packet) => {
    if (packet.status === 'player_spawn') {
      // بدون هذه الحزمة، السيرفر يعتبر البوت لسا بشاشة التحميل
      // حتى لو ظهر داخل العالم — وهذا سبب بقاءه "عالق" وما يندمج فعلياً.
      client.write('serverbound_loading_screen', { type: 2 });
      console.log('✅ تم تأكيد إنهاء شاشة التحميل (serverbound_loading_screen).');
    }
  });

  client.on('start_game', (packet) => {
    // نلتقط موقع البوت الأولي حتى نقدر نحسب حركته بعدين
    if (packet.player_position) {
      botPosition = { ...packet.player_position };
    }
    if (typeof packet.rotation?.x === 'number') botPitch = packet.rotation.x;
    if (typeof packet.rotation?.y === 'number') botYaw = packet.rotation.y;
  });

  client.on('set_entity_motion', (packet) => {
    if (!botPosition) return;
    const myId = String(client.entityId);
    const entry = packet.entries?.find(e => String(e.runtime_entity_id) === myId);
    if (entry?.velocity) {
      // نضيف قوة الدفع اللي أرسلها السيرفر — هاي فعلياً الارتداد الحقيقي
      botVelocity.x += entry.velocity.x;
      botVelocity.y += entry.velocity.y;
      botVelocity.z += entry.velocity.z;
      console.log('💥 البوت انضرب — تطبيق ارتداد طبيعي للخلف.');
    }
  });

  client.on('spawn', () => {
    console.log('🎮 البوت الآن داخل السيرفر وظاهر في العالم.');
    hasSpawnedOnce = true;
    // بدون هذه الحزمة، السيرفر يبقي البوت بحالة "تحميل" دائمة
    // من ناحية باقي اللاعبين حتى لو ظهر داخل العالم من ناحيته هو.
    try {
      client.queue('set_local_player_as_initialized', {
        runtime_entity_id: client.entityId,
      });
      console.log('✅ تم تأكيد اندماج البوت بالعالم (set_local_player_as_initialized).');
      startPhysicsLoop();
    } catch (e) {
      console.error('⚠️ تعذّر إرسال تأكيد الاندماج:', e.message);
    }
  });

  client.on('disconnect', (packet) => {
    stopPhysicsLoop();
    const reason = packet?.reason || 'غير معروف';
    console.log('❌ تم فصل البوت. السبب:', reason);
    // تعارض مؤقت بسبب إعادة نشر: ننتظر أطول شوي حتى تنغلق الجلسة القديمة تماماً
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
      client.queue('text', {
        type: 'chat',
        needs_translation: false,
        source_name: BOT_USERNAME,
        xuid: '',
        platform_chat_id: '',
        filtered_message: '',
        message: reply,
      });
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
// سيرفر HTTP: يبقي Render مستيقظاً عبر UptimeRobot،
// ويعرض صفحة /cache لنسخ بيانات الجلسة بأمان وسهولة.
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
