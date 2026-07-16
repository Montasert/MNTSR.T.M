// ============================================
// Minecraft Bedrock Player Bot - Microsoft Auth
// ============================================
const http = require('http');
const bedrock = require('bedrock-protocol');

// ---- إعدادات البوت (عدّلها حسب سيرفرك) ----
const SERVER_HOST = process.env.SERVER_HOST || 'play.example.com';
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '19132');
const BOT_USERNAME = process.env.BOT_USERNAME || 'MyPlayerBot';
const MC_VERSION   = process.env.MC_VERSION   || '1.26.33';

console.log('=== بدء تشغيل البوت ===');
console.log('عند ظهور رابط microsoft.com/link مع كود مكوّن من 8 أحرف بالأسفل،');
console.log('افتحه من متصفح هاتفك وأدخل الكود لربط حسابك.\n');

const client = bedrock.createClient({
  host: SERVER_HOST,
  port: SERVER_PORT,
  username: BOT_USERNAME,
  offline: false,        // false = مصادقة مايكروسوفت (يطبع الرابط والكود تلقائياً)
  version: MC_VERSION,
});

client.on('session', () => {
  console.log('✅ تم ربط الحساب وتسجيل الدخول بنجاح.');
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
// سيرفر HTTP بسيط جداً — فقط لإبقاء الاستضافة
// المجانية (مثل Render) مستيقظة عبر خدمة بينغ
// خارجية مثل UptimeRobot. لا يؤثر على أداء البوت.
// ============================================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('البوت يعمل الآن ✅');
}).listen(PORT, () => {
  console.log(`🌐 سيرفر الحفاظ على الاتصال يعمل على المنفذ ${PORT}`);
});
