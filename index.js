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
// (النسخ من صفحة ويب بزر "نسخ" أوثق من تحديد سطر طويل داخل شاشة السجلات)
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
  console.log('مثال: https://<اسم-خدمتك>.onrender.com/cache\n');
}

restoreSessionFromEnv();

console.log('=== بدء تشغيل البوت ===');
console.log('عند ظهور رابط microsoft.com/link مع كود مكوّن من 8 أحرف بالأسفل،');
console.log('افتحه من متصفح هاتفك وأدخل الكود لربط حسابك.\n');

const client = bedrock.createClient({
  host: SERVER_HOST,
  port: SERVER_PORT,
  username: BOT_USERNAME,
  offline: false,        // false = مصادقة مايكروسوفت (يطبع الرابط والكود تلقائياً)
  version: MC_VERSION,
  profilesFolder: PROFILES_FOLDER,
});

client.on('session', () => {
  console.log('✅ تم ربط الحساب وتسجيل الدخول بنجاح.');
  if (!process.env.MSA_CACHE) {
    buildSessionCacheString();
  }
});

client.on('join', () => {
  console.log('🚪 البوت في طور الانضمام للسيرفر...');
});

client.on('spawn', () => {
  console.log('🎮 البوت الآن داخل السيرفر وظاهر في العالم.');
});

client.on('disconnect', (packet) => {
  console.log('❌ تم فصل البوت. السبب:', packet?.reason || 'غير معروف');
});

client.on('kick', (reason) => {
  console.log('⛔ تم طرد البوت من السيرفر:', reason);
});

client.on('error', (err) => {
  console.error('⚠️ خطأ في الاتصال:', err.message);
});

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
