// server.js
// Backend cho Trạm Quan Trắc Thời Tiết IoT (production-ready)
// Nhận dữ liệu từ ESP8266, lưu SQLite, cung cấp API cho dashboard + chatbot Gemini.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const Database = require('better-sqlite3');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.DEVICE_API_KEY || 'demo-key-change-me';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OFFLINE_THRESHOLD_MS = Number(process.env.OFFLINE_THRESHOLD_MS) || 30 * 1000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'; // production: đặt domain dashboard, ví dụ https:// biases.example.com
const DATA_RETENTION_DAYS = Number(process.env.DATA_RETENTION_DAYS) || 30;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // mỗi cảm biến tối đa 1 cảnh báo / 5 phút (chống spam)
const MAX_HISTORY_POINTS = 500; // trần số điểm trả về cho chart (downsampling khi vượt)

if (API_KEY === 'demo-key-change-me') {
  console.warn('[WARN] DEVICE_API_KEY đang dùng giá trị mặc định. Hãy đặt key mạnh trong file .env trước khi production.');
}

// ---------- Google Gemini AI ----------
let genAI = null;
// Thứ tự ưu tiên. Google thu hồi model cũ (404) và
// model có thể tạm quá tải (503) — vì vậy thử lần lượt từ trên xuống.
// Ghi đè được qua biến môi trường GEMINI_MODELS (phân tách bằng dấu phẩy).
// Tên model phải tồn tại thật trên Google AI Studio (xem https://ai.google.dev/models/gemini).
const DEFAULT_GEMINI_MODELS = [
  'gemini-2.5-flash',        // bản ổn định, nhanh, tiếng Việt tốt
  'gemini-2.0-flash',        // dự phòng
  'gemini-1.5-flash',        // dự phòng cũ nhưng còn hỗ trợ
  'gemini-flash-latest',     // fallback cuối (alias của Google)
];
const GEMINI_MODELS = (process.env.GEMINI_MODELS
  ? process.env.GEMINI_MODELS.split(',').map((m) => m.trim()).filter(Boolean)
  : DEFAULT_GEMINI_MODELS);

if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  console.log('Gemini AI đã khởi tạo, thứ tự ưu tiên:', GEMINI_MODELS.join(', '));
} else {
  console.warn('GEMINI_API_KEY chưa cấu hình. Chatbot AI sẽ trả về 503.');
}

// ---------- Database ----------
const db = new Database(path.join(__dirname, 'weather.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    temp REAL NOT NULL,
    hum REAL NOT NULL,
    light REAL NOT NULL,
    device_id TEXT DEFAULT 'ESP8266-WX01',
    rssi INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_readings_created_at ON readings(created_at);
  CREATE INDEX IF NOT EXISTS idx_readings_device_time ON readings(device_id, created_at);
`);

// Migrate DB cũ (có cột rain) -> bỏ cột rain, giữ lại temp/hum/light
try {
  const cols = db.prepare('PRAGMA table_info(readings)').all();
  if (cols.some((c) => c.name === 'rain')) {
    db.exec('ALTER TABLE readings DROP COLUMN rain');
    console.log('[migrate] Đã bỏ cột rain khỏi bảng readings (DB cũ vẫn dùng được).');
  }
} catch (e) {
  console.warn('[migrate] Không drop được cột rain:', e.message);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sensor TEXT NOT NULL,
    value REAL NOT NULL,
    expected TEXT,
    reason TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_sensor_time ON alerts(sensor, created_at);
`);

const insertAlert = db.prepare(`
  INSERT INTO alerts (sensor, value, expected, reason, severity)
  VALUES (@sensor, @value, @expected, @reason, @severity)
`);
const lastAlertTime = db.prepare(
  `SELECT created_at FROM alerts WHERE sensor = ? ORDER BY created_at DESC LIMIT 1`
);
const recentReadings = db.prepare(
  'SELECT temp, hum, light FROM readings ORDER BY created_at DESC LIMIT 30'
);

// Giới hạn vật lý hợp lý + độ lệch chuẩn tối thiểu cho từng cảm biến
const SENSORS = {
  temp:  { label: 'Nhiệt độ', unit: '°C',  min: -10, max: 50,   minStd: 0.5 },
  hum:   { label: 'Độ ẩm',    unit: '%',   min: 0,   max: 100,  minStd: 2 },
  light: { label: 'Ánh sáng', unit: ' lux', min: 0,  max: 2000, minStd: 50 },
};

// Ngưỡng tuyệt đối để từ chối bản ghi rác (lỗi cảm biến / client sai), rộng hơn SENSORS
const HARD_LIMITS = {
  temp: { min: -50, max: 85 },
  hum: { min: 0, max: 100 },
  light: { min: 0, max: 150000 },
};

function detectAnomalies(reading) {
  const history = recentReadings.all(); // gọi TRƯỚC khi insert bản ghi mới
  const alerts = [];

  for (const [key, cfg] of Object.entries(SENSORS)) {
    const v = reading[key];

    // 1) Ngoài giới hạn vật lý
    if (v < cfg.min || v > cfg.max) {
      alerts.push({
        sensor: key, value: v,
        expected: `${cfg.min} đến ${cfg.max}${cfg.unit}`,
        reason: `${cfg.label} ngoài khoảng hợp lý`,
        severity: 'high',
      });
      continue;
    }

    // 2) Lệch mạnh so với 30 lần đo gần nhất (z-score)
    if (history.length >= 10) {
      const vals = history.map((h) => h[key]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      const z = Math.abs(v - mean) / Math.max(std, cfg.minStd);
      if (z > 3) {
        alerts.push({
          sensor: key, value: v,
          expected: `${mean.toFixed(1)}${cfg.unit} ± ${(3 * Math.max(std, cfg.minStd)).toFixed(1)}`,
          reason: `${cfg.label} thay đổi đột ngột`,
          severity: 'medium',
        });
      }
    }
  }
  return alerts;
}

function shouldInsertAlert(sensor) {
  const row = lastAlertTime.get(sensor);
  if (!row) return true;
  return Date.now() - new Date(row.created_at).getTime() >= ALERT_COOLDOWN_MS;
}

const insertReading = db.prepare(`
  INSERT INTO readings (temp, hum, light, device_id, rssi)
  VALUES (@temp, @hum, @light, @device_id, @rssi)
`);

const latestReading = db.prepare(`
  SELECT * FROM readings ORDER BY created_at DESC LIMIT 1
`);

const FMT = "'%Y-%m-%dT%H:%M:%fZ'";
const rangeToSql = {
  '1h':  `strftime(${FMT}, 'now', '-1 hour')`,
  '6h':  `strftime(${FMT}, 'now', '-6 hour')`,
  '24h': `strftime(${FMT}, 'now', '-1 day')`,
  '7d':  `strftime(${FMT}, 'now', '-7 day')`,
};

// Lấy mẫu thưa (downsampling) khi dữ liệu quá dày — giữ tương thích field cũ + thêm count
function downsample(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const bucketSize = Math.ceil(rows.length / maxPoints);
  const out = [];
  for (let i = 0; i < rows.length; i += bucketSize) {
    const bucket = rows.slice(i, i + bucketSize);
    const avg = (f) => bucket.reduce((a, r) => a + r[f], 0) / bucket.length;
    const mid = bucket[Math.floor(bucket.length / 2)];
    out.push({
      ...mid,
      temp: +avg('temp').toFixed(2),
      hum: +avg('hum').toFixed(1),
      light: Math.round(avg('light')),
    });
  }
  return out;
}

// Dọn dữ liệu cũ mỗi 6 giờ: xóa readings quá hạn, giới hạn alerts tối đa 1000 bản ghi mới nhất
function retentionCleanup() {
  try {
    const r = db.prepare(`DELETE FROM readings WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`)
      .run(`-${DATA_RETENTION_DAYS} days`);
    db.exec(`DELETE FROM alerts WHERE id NOT IN (SELECT id FROM alerts ORDER BY created_at DESC LIMIT 1000)`);
    if (r.changes > 0) console.log(`[retention] Đã xóa ${r.changes} bản ghi quá ${DATA_RETENTION_DAYS} ngày.`);
  } catch (err) {
    console.error('[retention] Lỗi dọn dữ liệu:', err.message);
  }
}
setInterval(retentionCleanup, 6 * 60 * 60 * 1000);

// ---------- App ----------
const app = express();

// trust proxy: bắt buộc khi chạy sau reverse proxy (Cloudflare, Nginx, Caddy, Render)
// để rate-limit tính đúng theo IP thật của client và để req.secure hoạt động.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);

// Tự chuyển HTTP -> HTTPS khi chạy sau proxy (Cloudflare/Nginx) và production
if (process.env.FORCE_HTTPS === 'true' && process.env.NODE_ENV === 'production') {
  app.use(function (req, res, next) {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  });
}

app.use(helmet({
  contentSecurityPolicy: false, // CSP tắt để Chart.js CDN + inline script hoạt động; bật lại khi build frontend riêng
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true, preload: false }
    : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false,
}));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(cors(CORS_ORIGIN === '*' ? undefined : { origin: CORS_ORIGIN.split(',').map((s) => s.trim()) }));
app.use(express.json({ limit: '16kb' })); // chặn payload quá lớn từ thiết bị lạ
app.use(express.static(path.join(__dirname, '..', 'Frontend'), { maxAge: '1h' }));

// Rate limit: chống spam ghi dữ liệu + chống abuse chatbot
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 }); // ~1 req/2s cho 1 thiết bị là dư
const chatLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const readLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

// Middleware kiểm tra API key cho endpoint ghi dữ liệu (ESP8266 -> server)
function requireDeviceKey(req, res, next) {
  const key = req.header('x-api-key');
  // so sánh hằng-thời-gian đơn giản để tránh timing-attack cơ bản
  if (typeof key !== 'string' || key.length !== API_KEY.length ||
      !require('crypto').timingSafeEqual(Buffer.from(key), Buffer.from(API_KEY))) {
    return res.status(401).json({ error: 'Sai hoặc thiếu x-api-key' });
  }
  next();
}

// ---------- POST /api/sensors  (ESP8266 gửi dữ liệu lên) ----------
app.post('/api/sensors', writeLimiter, requireDeviceKey, (req, res) => {
  const { temp, hum, light, device_id, rssi } = req.body || {};

  if ([temp, hum, light].some((v) => typeof v !== 'number' || Number.isNaN(v) || !Number.isFinite(v))) {
    return res.status(400).json({ error: 'temp, hum, light phải là số hợp lệ' });
  }
  if (temp < HARD_LIMITS.temp.min || temp > HARD_LIMITS.temp.max ||
      hum < HARD_LIMITS.hum.min || hum > HARD_LIMITS.hum.max ||
      light < HARD_LIMITS.light.min || light > HARD_LIMITS.light.max) {
    return res.status(422).json({ error: 'Giá trị ngoài ngưỡng vật lý, có thể cảm biến lỗi. Kiểm tra lại thiết bị.' });
  }
  if (device_id !== undefined && (typeof device_id !== 'string' || device_id.length > 32)) {
    return res.status(400).json({ error: 'device_id tối đa 32 ký tự' });
  }
  if (rssi !== undefined && rssi !== null && (typeof rssi !== 'number' || rssi > 0 || rssi < -120)) {
    return res.status(400).json({ error: 'rssi phải trong khoảng -120..0 dBm' });
  }

  const found = detectAnomalies({ temp, hum, light });
  // Chống spam cảnh báo: mỗi cảm biến tối đa 1 cảnh báo / ALERT_COOLDOWN_MS
  found.filter((a) => shouldInsertAlert(a.sensor)).forEach((a) => insertAlert.run(a));

  insertReading.run({
    temp, hum, light,
    device_id: device_id || 'ESP8266-WX01',
    rssi: typeof rssi === 'number' ? Math.round(rssi) : null,
  });

  res.status(201).json({ ok: true, alerts: found.length });
});

// ---------- GET /api/sensors/latest ----------
app.get('/api/sensors/latest', readLimiter, (req, res) => {
  const row = latestReading.get();
  if (!row) {
    return res.status(204).end(); // chưa có dữ liệu nào — frontend giữ trạng thái "Đang chờ"
  }

  const ageMs = Date.now() - new Date(row.created_at).getTime();
  res.json({
    temp: row.temp,
    hum: row.hum,
    light: row.light,
    device_id: row.device_id,
    rssi: row.rssi,
    timestamp: row.created_at,
    online: ageMs < OFFLINE_THRESHOLD_MS,
  });
});

// ---------- GET /api/sensors/history?range=1h|6h|24h|7d ----------
app.get('/api/sensors/history', readLimiter, (req, res) => {
  const range = rangeToSql[req.query.range] ? req.query.range : '1h';
  const sinceExpr = rangeToSql[range];

  const rows = db
    .prepare(`SELECT * FROM readings WHERE created_at >= ${sinceExpr} ORDER BY created_at ASC`)
    .all();

  const sampled = downsample(rows, MAX_HISTORY_POINTS);

  res.json({
    range,
    count: rows.length,
    downsampled: sampled.length !== rows.length,
    labels: sampled.map((r) => r.created_at),
    temp: sampled.map((r) => r.temp),
    hum: sampled.map((r) => r.hum),
    light: sampled.map((r) => r.light),
  });
});

   // ---------- GET /api/alerts ----------
   app.get('/api/alerts', readLimiter, (req, res) => {
     const limit = Math.min(Number(req.query.limit) || 20, 100);
     const rows = db
       .prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?')
       .all(limit);
     res.json(rows);
   });
// ---------- POST /api/chat  (Chatbot AI dùng Gemini) ----------
app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Vui lòng nhập câu hỏi.' });
  }
  if (message.trim().length > 2000) {
    return res.status(413).json({ error: 'Câu hỏi quá dài (tối đa 2000 ký tự).' });
  }

  if (!genAI) {
    return res.status(503).json({ error: 'AI chưa được cấu hình. Vui lòng thêm GEMINI_API_KEY vào file .env' });
  }

  try {
    // Lấy dữ liệu cảm biến mới nhất để cung cấp ngữ cảnh cho AI
    const latest = latestReading.get();
    const recentAlerts = db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 5').all();
    const recentData = db.prepare('SELECT temp, hum, light, created_at FROM readings ORDER BY created_at DESC LIMIT 20').all();
    const hourRows = db.prepare(
      `SELECT temp, hum, light FROM readings WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') ORDER BY created_at ASC`
    ).all();

    const calcStats = (rows) => {
      if (!rows.length) return null;
      const t = rows.map((r) => r.temp), h = rows.map((r) => r.hum), l = rows.map((r) => r.light);
      const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      return {
        n: rows.length,
        tMax: Math.max(...t), tMin: Math.min(...t), tAvg: avg(t),
        hMax: Math.max(...h), hMin: Math.min(...h), hAvg: avg(h),
        lMax: Math.max(...l), lMin: Math.min(...l), lAvg: avg(l),
      };
    };
    const hourStats = calcStats(hourRows);

    // Trả lời trực tiếp cho câu hỏi thống kê / tính năng — không gọi Gemini để tránh bịa số.
    const q = message.trim().toLowerCase();
    const askMax = /cao nhất|max|lớn nhất/.test(q);
    const askMin = /thấp nhất|min|nhỏ nhất/.test(q);
    const askAvg = /trung bình|average|tb /.test(q);
    const askHour = /1\s*(tiếng|giờ|h\b)|giờ qua|tiếng qua/.test(q);
    if ((askMax || askMin || askAvg) && latest) {
      const s = hourStats || calcStats(recentData);
      if (s) {
        const scope = hourStats ? `trong 1 giờ qua (${s.n} mẫu)` : `trong ${s.n} lần đo gần nhất`;
        let ans = '';
        if (askMax && /nhiệt|temp|nóng/.test(q)) ans = `Nhiệt độ cao nhất ${scope} là ${s.tMax.toFixed(1)}°C. Hiện tại ${latest.temp}°C, ẩm ${latest.hum}%, sáng ${latest.light} lux.`;
        else if (askMin && /nhiệt|temp|lạnh/.test(q)) ans = `Nhiệt độ thấp nhất ${scope} là ${s.tMin.toFixed(1)}°C. Hiện tại ${latest.temp}°C, ẩm ${latest.hum}%, sáng ${latest.light} lux.`;
        else if (askMax && /ẩm|hum/.test(q)) ans = `Độ ẩm cao nhất ${scope} là ${Math.round(s.hMax)}%. Hiện tại ${latest.temp}°C, ẩm ${latest.hum}%, sáng ${latest.light} lux.`;
        else if (askMin && /ẩm|hum/.test(q)) ans = `Độ ẩm thấp nhất ${scope} là ${Math.round(s.hMin)}%. Hiện tại ${latest.temp}°C, ẩm ${latest.hum}%, sáng ${latest.light} lux.`;
        else if (askMax && /sáng|light|lux|đèn/.test(q)) ans = `Ánh sáng mạnh nhất ${scope} là ${Math.round(s.lMax)} lux. Hiện tại ${latest.temp}°C, ẩm ${latest.hum}%, sáng ${latest.light} lux.`;
        else if (askMin && /sáng|light|lux|đèn/.test(q)) ans = `Ánh sáng yếu nhất ${scope} là ${Math.round(s.lMin)} lux. Hiện tại ${latest.temp}°C, ẩm ${latest.hum}%, sáng ${latest.light} lux.`;
        else if (askAvg) ans = `Trung bình ${scope}: ${s.tAvg.toFixed(1)}°C, ẩm ${Math.round(s.hAvg)}%, sáng ${Math.round(s.lAvg)} lux. Hiện tại ${latest.temp}°C, ẩm ${latest.hum}%, sáng ${latest.light} lux.`;
        else ans = `Trong 1 giờ qua: nhiệt ${s.tMin.toFixed(1)} đến ${s.tMax.toFixed(1)}°C, ẩm ${Math.round(s.hMin)} đến ${Math.round(s.hMax)}%, sáng ${Math.round(s.lMin)} đến ${Math.round(s.lMax)} lux. Hiện tại ${latest.temp}°C, ẩm ${latest.hum}%, sáng ${latest.light} lux.`;
        if (ans) return res.json({ reply: ans });
      }
    }
    if (/làm (được |đc )?gì|có thể làm|chức năng|giúp (được |đc )?gì|tính năng/.test(q)) {
      const cur = latest ? ` Hiện tại trạm đo được ${latest.temp}°C, ẩm ${latest.hum}%, sáng ${latest.light} lux.` : '';
      return res.json({
        reply: `Mình có thể giúp bạn 4 việc.${cur} Bạn hỏi mình: 1) Thời tiết hiện tại thế nào. 2) Nhiệt độ, độ ẩm cao nhất, thấp nhất, trung bình 1 giờ qua. 3) Có cảnh báo bất thường nào không. 4) Tư vấn sức khỏe theo thời tiết, ví dụ trời nóng có nên ra ngoài không.`,
      });
    }
    // Chào hỏi đơn giản — trả lời ngay, không gọi Gemini cho đỡ tốn quota.
    if (/^(hi|hello|hey|yo|alo|chào|xìn chào|xin chào)\b/.test(q) || q.length <= 3) {
      const cur = latest ? ` Trạm đang đo ${latest.temp}°C, ẩm ${latest.hum}%, sáng ${latest.light} lux.` : '';
      return res.json({ reply: `Chào bạn.${cur} Bạn muốn hỏi thời tiết hiện tại, max min 1 giờ qua, cảnh báo hay tư vấn sức khỏe?` });
    }
    // Hỏi cảnh báo — trả trực tiếp từ bảng alerts, không qua Gemini.
    if (/cảnh báo|bất thường|alert/.test(q)) {
      if (!recentAlerts.length) {
        const cur = latest ? ` Hiện tại ${latest.temp}°C, ẩm ${latest.hum}%, sáng ${latest.light} lux, mọi thứ trong ngưỡng.` : '';
        return res.json({ reply: `Không có cảnh báo bất thường nào gần đây.${cur}` });
      }
      const lines = recentAlerts.slice(0, 3).map((a) => `${a.reason} ${a.value} (lúc ${a.created_at})`).join('. ');
      return res.json({ reply: `Có ${recentAlerts.length} cảnh báo gần đây. Gần nhất: ${lines}. Bạn mở mục Cảnh báo trên dashboard để xem chi tiết nhé.` });
    }
    // Hỏi tư vấn sức khỏe / nên làm gì — trả theo ngưỡng, khỏi gọi Gemini.
    if (/sức khỏe|nên|mặc|uống|ra ngoài|tập|phơi|học/.test(q)) {
      if (latest) {
        let adv = '';
        if (latest.temp >= 33) adv = 'Trời nóng, bạn hạn chế ra ngoài giờ nắng gắt, uống đủ nước nhé.';
        else if (latest.temp >= 30) adv = 'Trời hơi nóng, đội mũ khi ra ngoài và uống nước đều nhé.';
        else if (latest.temp < 21) adv = 'Trời hơi lạnh, bạn mặc thêm áo ấm nhé.';
        else if (latest.hum > 80) adv = 'Độ ẩm cao, phòng dễ ẩm mốc, bạn giữ nhà thoáng nhé.';
        else if (latest.light < 150) adv = 'Trời tối, bạn bật đèn đủ sáng nếu học bài nhé.';
        else adv = 'Thời tiết dễ chịu, hợp đi lại và tập thể dục nhẹ.';
        return res.json({ reply: `Hiện tại ${latest.temp}°C, ẩm ${latest.hum}%, sáng ${latest.light} lux. ${adv}` });
      }
    }
    // Hỏi chung "hôm nay / hiện tại" mà có số liệu 1 giờ — để Gemini trả lời tự nhiên
    // (không trả cứng ở đây để tránh lặp 1 câu). Chỉ giữ nhánh cứng cho max/min/tb ở trên.

    // Tính toán thống kê nhanh
    let stats = '';
    if (recentData.length > 0) {
      const temps = recentData.map(r => r.temp);
      const hums = recentData.map(r => r.hum);
      const lights = recentData.map(r => r.light);
      stats = `
Thống kê 20 lần đo gần nhất:
- Nhiệt độ: min ${Math.min(...temps).toFixed(1)}°C, max ${Math.max(...temps).toFixed(1)}°C, trung bình ${(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1)}°C
- Độ ẩm: min ${Math.min(...hums).toFixed(0)}%, max ${Math.max(...hums).toFixed(0)}%, trung bình ${(hums.reduce((a, b) => a + b, 0) / hums.length).toFixed(0)}%
- Ánh sáng: min ${Math.min(...lights).toFixed(0)} lux, max ${Math.max(...lights).toFixed(0)} lux, trung bình ${(lights.reduce((a, b) => a + b, 0) / lights.length).toFixed(0)} lux`;
    }
    if (hourStats) {
      stats += `
Thống kê 1 giờ qua (${hourStats.n} mẫu) — DÙNG SỐ NÀY khi hỏi max/min/trung bình 1 giờ:
- Nhiệt độ: min ${hourStats.tMin.toFixed(1)}°C, max ${hourStats.tMax.toFixed(1)}°C, trung bình ${hourStats.tAvg.toFixed(1)}°C
- Độ ẩm: min ${Math.round(hourStats.hMin)}%, max ${Math.round(hourStats.hMax)}%, trung bình ${Math.round(hourStats.hAvg)}%
- Ánh sáng: min ${Math.round(hourStats.lMin)} lux, max ${Math.round(hourStats.lMax)} lux, trung bình ${Math.round(hourStats.lAvg)} lux`;
    }

    const sensorContext = latest
      ? `Dữ liệu cảm biến MỚI NHẤT (${latest.created_at}):
- Nhiệt độ: ${latest.temp}°C
- Độ ẩm: ${latest.hum}%
- Ánh sáng: ${latest.light} lux
- Thiết bị: ${latest.device_id} | RSSI: ${latest.rssi} dBm
${stats}
LƯU Ý HỆ THỐNG: chỉ có 3 cảm biến trên (nhiệt độ DHT11, độ ẩm DHT11, ánh sáng CDS). KHÔNG có cảm biến mưa, KHÔNG có gió, KHÔNG có áp suất.`
      : 'Chưa có dữ liệu cảm biến nào từ ESP8266.';

    const alertContext = recentAlerts.length > 0
      ? `Cảnh báo bất thường gần đây:\n${recentAlerts.map(a =>
          `- [${a.severity}] ${a.reason}: ${a.value} (kỳ vọng: ${a.expected || 'N/A'}) lúc ${a.created_at}`
        ).join('\n')}`
      : 'Không có cảnh báo bất thường nào gần đây.';

    const projectKnowledge = `KIẾN THỨC ĐỒ ÁN (dùng khi hỏi ngoài số liệu):
- Phần cứng: ESP8266 NodeMCU, DHT11 đo nhiệt độ + độ ẩm ở chân D4, quang trở CDS ở chân A0, còi buzzer ở D5, LED_OK ở D8, LED_ALARM ở D6, ngưỡng tối CDS < 350, báo động khi temp > 35 độ hoặc trời tối, gửi mỗi 10 giây.
- Phần mềm: Node.js + Express file Backend/server.js, SQLite file Backend/weather.db 2 bảng readings và alerts, API POST /api/sensors (cần header x-api-key), GET /api/sensors/latest, GET /api/sensors/history?range=1h|6h|24h|7d, GET /api/alerts, POST /api/chat, GET /api/health. Frontend HTML JS thuần + Chart.js, dashboard.js gọi API mỗi 10 giây, ngưỡng offline OFFLINE_THRESHOLD_MS 15 giây.
- Khi hỏi đấu dây, code, WiFi, lỗi POST -1, EADDRINUSE, tunnel Cloudflare: giải thích theo đúng kiến thức này, ngắn gọn từng bước.`;

    const systemPrompt = `Bạn là trợ lý AI của đồ án IoT Weather Station (ESP8266 + DHT11 + CDS quang trở).
Bạn chat trực tiếp với sinh viên bằng tiếng Việt, thân thiện, tự nhiên như ChatGPT.

2 CHẾ ĐỘ TRẢ LỜI:
1) Hỏi SỐ LIỆU (thời tiết hiện tại, hôm nay, max min trung bình, cảnh báo): DÙNG SỐ THẬT bên dưới, không bịa. Hỏi max/min/trung bình 1 giờ thì dùng mục "Thống kê 1 giờ qua". Hỏi thời tiết hiện tại thì nêu đủ 3 số mới nhất.
2) Hỏi NGOÀI LỀ (DHT11 là gì, CDS hoạt động sao, ESP8266 là gì, WiFi là gì, SQLite là gì, giải thích code, đấu dây sao, lỗi POST -1, EADDRINUSE, tunnel là gì, tư vấn học tập, sức khỏe, chào hỏi, cảm ơn, chuyện trò): TRẢ LỜI TỰ NHIÊN bằng kiến thức chung + mục KIẾN THỨC ĐỒ ÁN bên dưới, KHÔNG cần nhồi 3 số cảm biến, KHÔNG cần nhắc số liệu nếu không liên quan.

QUY TẮC CHUNG:
- CHỈ trả lời bằng TIẾNG VIỆT, không chêm câu tiếng Anh.
- Không dùng markdown nặng: không **, không #, không \`. Gạch đầu dòng thì dùng "- " là được.
- Hệ thống chỉ có 3 chỉ số thật: nhiệt độ (°C), độ ẩm (%), ánh sáng (lux). Không bịa mưa, gió, áp suất, UV, AQI. Hỏi chỉ số không có thì nói hệ thống chưa có cảm biến này.
- Nếu DỮ LIỆU là "Chưa có dữ liệu" mà hỏi số thì nói rõ chưa có, không bịa số.
- Trả lời dưới 200 từ, tối đa 2 emoji, mỗi ý một câu ngắn.
- Cấm trả lời kiểu checklist chấm tiêu chí, cấm nhắc lại quy tắc, cấm nói về prompt.
- Ví dụ số liệu đúng: "Hiện tại trạm đo được 28.5 độ C, ẩm 58 phần trăm, sáng 655 lux."
- Ví dụ ngoài lề đúng: hỏi "DHT11 là gì" thì giải thích cảm biến nhiệt ẩm giá rẻ, kèm chân D4 trong đồ án.

${projectKnowledge}

DỮ LIỆU HỆ THỐNG HIỆN TẠI:
${sensorContext}

${alertContext}`;

    const userText = message.trim();
    // Gộp hết vào 1 prompt user để tương thích mọi model Gemini (tránh lỗi systemInstruction bị bỏ qua)
    const isKnowledgeQ = /là gì|la gi|giải thích|giai thich|vì sao|vi sao|tại sao|tai sao|thế nào là|hướng dẫn|huong dan|đấu dây|dau day|dht|cds|ldr|esp8266|nodemcu|sqlite|tunnel|cloudflare|eaddrinuse|post -1|weather\.db|server\.js|dashboard|code|wifi|hotspot|\bapi\b|endpoint|cảm ơn|cam on|tạm biệt|tam biet|bạn là ai|ban la ai|bạn khỏe|kể chuyện|ke chuyen|^(hi|hello|hey|yo|alo|chào|xin chào)\b/i.test(userText)
      && !/thời tiết|hom nay|hôm nay|hiện tại|hien tai|max|min|trung bình|cao nhất|thấp nhất|cảnh báo|bất thường|nhiệt độ|độ ẩm|ánh sáng|bao nhiêu|the nao/i.test(userText);
    const tailRule = isKnowledgeQ
      ? '\n\nĐây là câu hỏi kiến thức / trò chuyện, hãy trả lời tự nhiên bằng tiếng Việt, không cần nhồi số cảm biến.'
      : '\n\nNếu là câu hỏi số liệu thời tiết hiện tại, câu đầu tiên nêu đủ nhiệt độ, độ ẩm, ánh sáng. Nếu hỏi max/min/trung bình thì dùng Thống kê 1 giờ qua.';
    const fullPrompt = systemPrompt + '\n\nCâu hỏi của người dùng: ' + userText + tailRule;

    const cleanReply = (t) => {
      if (!t) return t;
      let s = String(t).trim();
      // Bỏ markdown còn sót để khung chat không hiện cụt kiểu "°C):**"
      s = s.replace(/\*\*(.*?)\*\*/g, '$1');
      s = s.replace(/__([^_]+)__/g, '$1');
      s = s.replace(/^#{1,6}\s+/gm, '');
      s = s.replace(/`/g, '');
      // "* text" đầu dòng của AI -> chuyển thành "- " cho đồng nhất
      s = s.replace(/^\*\s+/gm, '- ');
      s = s.replace(/\n{3,}/g, '\n\n');
      return s.trim();
    };

    const isBadReply = (t) => {
      if (!t || t.trim().length < 15) return true;
      const s = t.trim();
      const low = s.toLowerCase();
      // AI đang tự chấm điểm thay vì trả lời -> coi là lỗi, thử model khác / fallback
      if (low.includes('words)?') || low.includes('? yes') || low.includes('friendly') && low.includes('yes')) return true;
      if (/short\s*\(.*180/.test(low)) return true;
      // Lẫn tiếng Anh kiểu "Is 28.5" -> coi là lỗi, thử model khác
      if (/(^|\n)\s*\*\s*is\s+\d/i.test(s) || /(^|\s)is\s+\d+\s*°?c/i.test(s)) return true;
      // Câu bị cắt cụt (kết thúc bằng dấu lửng) -> lỗi, thử model khác
      if (/[,:;(\-–—*]\s*$/.test(s)) return true;
      // Chỉ ép đủ 3 số khi hỏi số liệu thời tiết; câu kiến thức / trò chuyện được miễn.
      if (isKnowledgeQ) return false;
      if (s.length < 40 && /\d+\s*°C/.test(s) && (!s.includes('%') || !s.toLowerCase().includes('lux'))) return true;
      // Hỏi thời tiết mà thiếu 1 trong 3 số -> lỗi, thử model khác
      if (/thời tiết|nhiệt độ|nóng|lạnh|ẩm|ánh sáng|hôm nay|hiện tại|max|min|trung bình|cao nhất|thấp nhất/i.test(userText)) {
        if (!s.includes('°C') || !s.includes('%') || !s.toLowerCase().includes('lux')) return true;
      }
      return false;
    };

    const buildLocalFallback = (customQ) => {
      if (!latest) return 'Hiện chưa có dữ liệu từ ESP8266. Bạn kiểm tra lại thiết bị rồi hỏi lại giúp mình nhé.';
      const t = `Hiện tại trạm đo được ${latest.temp}°C, ẩm ${latest.hum}%, sáng ${latest.light} lux (lúc ${latest.created_at}).`;
      const adv = latest.temp > 31 ? ' Trời hơi nóng, bạn uống đủ nước nhé. ☀️'
        : latest.temp < 21 ? ' Trời hơi lạnh, bạn mặc ấm nhé. 🧥'
        : latest.hum > 80 ? ' Độ ẩm cao, hạn chế phơi đồ ngoài trời nhé. 💧'
        : latest.light < 150 ? ' Trời đang tối, bật đèn nếu học bài nhé. 💡'
        : ' Điều kiện khá dễ chịu để học tập và đi lại. 😊';
      return t + adv;
    };

    // Trả lời kiến thức đồ án NGOẠI TUYẾN — dùng khi Gemini chết (404/503/timeout)
    // để hỏi ngoài lề vẫn khôn, không rớt về 1 câu số liệu.
    const buildKnowledgeFallback = () => {
      if (/dht11|dht ?11/.test(q)) return 'DHT11 là cảm biến nhiệt độ + độ ẩm giá rẻ, dùng 1 dây dữ liệu. Trong đồ án này DHT11 đấu vào chân D4 của NodeMCU, đọc mỗi 10 giây bằng dht.readTemperature và dht.readHumidity. Dải đo khoảng 0 đến 50 độ, ẩm 20 đến 90 phần trăm.';
      if (/cds|quang trở|quang tro|ldr|ánh sáng.*(hoạt|nguyên|đo)/.test(q)) return 'CDS hay quang trở LDR là điện trở thay đổi theo ánh sáng, sáng mạnh thì trở nhỏ. Trong đồ án CDS đấu vào chân A0, ESP đọc analogRead 0 đến 1023 rồi map sang 0 đến 1200 lux. Ngưỡng trời tối là CDS dưới 350, lúc đó còi ở D5 kêu và LED báo ở D6 sáng.';
      if (/esp8266|nodemcu|esp /.test(q)) return 'ESP8266 NodeMCU là vi điều khiển có WiFi 2.4GHz, chạy chế độ STA để bắt WiFi nhà hoặc hotspot. Trong đồ án nó đọc DHT11 ở D4 và CDS ở A0, rồi POST JSON lên server mỗi 10 giây kèm header x-api-key.';
      if (/wifi|kết nối|ket noi|sta|hotspot/.test(q)) return 'ESP nối WiFi bằng WiFi.mode STA rồi WiFi.begin tên và mật khẩu trong secrets.h, chỉ vào được 2.4GHz. Mất mạng thì hàm connectWiFi gọi lại, chưa nối thì chưa gửi. Bạn nên dùng tên không dấu, để ESP cách điện thoại 1 đến 2m khi test hotspot.';
      if (/sqlite|database|dữ liệu.*(lưu|đâu)|luu o dau|weather.db|bảng|bang /.test(q)) return 'Dữ liệu lưu trong file Backend/weather.db dạng SQLite, mở bằng better-sqlite3. Có 2 bảng readings chứa temp hum light device_id rssi created_at và alerts chứa sensor value expected reason severity. Server tạo bảng bằng CREATE TABLE IF NOT EXISTS trong server.js, dọn readings quá 30 ngày mỗi 6 tiếng.';
      if (/đấu dây|dau day|chân|chan |sơ đồ|so do|mạch|mach /.test(q)) return 'Cách đấu chuẩn đồ án: DHT11 vào D4, CDS vào A0, còi buzzer vào D5, LED_OK vào D8, LED_ALARM vào D6. Nhớ dời LED_ALARM khỏi chân RX sang D6 để khỏi xung đột Serial. Cấp nguồn 3V3 GND đủ dòng cho WiFi.';
      if (/post -1|post.*-1|-1 là gì/.test(q)) return 'POST -1 nghĩa là ESP chưa mở được kết nối HTTPS tới server, chưa liên quan API key. Hay gặp khi bắt hotspot yếu, tunnel Cloudflare đã đổi link, hoặc TLS hết RAM. Bạn kiểm tra link trong tunnel-url.txt có khớp secrets.h không, thử mở /api/health bằng 4G, rồi mới nạp lại.';
      if (/eaddrinuse|3000.*dùng|address in use|port /.test(q)) return 'Lỗi EADDRINUSE là do bạn chạy 2 lần node server.js nên kẹt cổng 3000. Chỉ giữ 1 cửa sổ backend, tìm PID bằng Get-NetTCPConnection rồi Stop-Process, sau đó chạy lại node server.js trong thư mục Backend.';
      if (/tunnel|cloudflare|trycloudflare|link.*https|public /.test(q)) return 'Tunnel Cloudflare dùng start-tunnel.ps1 để forward localhost 3000 ra link https ngẫu nhiên. Link đổi mỗi lần chạy lại, nên phải copy link mới trong tunnel-url.txt vào secrets.h rồi nạp lại ESP. Mở web public xong nhớ Ctrl F5 để hết cache.';
      if (/\bapi\b|endpoint|\/api\//.test(q)) return 'Backend có 5 API chính trong server.js: POST /api/sensors cần x-api-key để ESP đẩy số, GET /api/sensors/latest lấy số mới nhất, GET /api/sensors/history lấy biểu đồ, GET /api/alerts lấy cảnh báo, POST /api/chat hỏi AI, GET /api/health kiểm tra sống.';
      if (/server\.js|backend.*(làm|giải)/.test(q)) return 'File Backend/server.js chạy Express, việc chính là nhận POST /api/sensors, kiểm tra x-api-key và ngưỡng HARD_LIMITS, phát hiện lệch bằng detectAnomalies, INSERT vào SQLite weather.db, rồi mở GET latest history alerts chat cho web dashboard.js gọi mỗi 10 giây.';
      if (/cảm ơn|cam on|thank/.test(q)) return 'Không có gì, chúc bạn demo suôn sẻ nhé. Bạn cần hỏi số liệu, đấu dây hay giải thích code thì cứ hỏi tiếp.';
      if (/tạm biệt|tam biet|bye/.test(q)) return 'Tạm biệt bạn, cần gì về trạm thời tiết thì quay lại hỏi mình nhé.';
      if (/bạn.*(khỏe|khoe)|ban la ai|bạn là ai|tên gì/.test(q)) return 'Mình là trợ lý AI của đồ án trạm thời tiết ESP8266, mình theo dõi nhiệt độ độ ẩm ánh sáng và giải thích code giúp bạn. Trạm hiện vẫn chạy bình thường.';
      if (/thơ|tho |hát|hat |kể chuyện|ke chuyen|đố |do vui/.test(q)) return 'Mình chuyên về trạm thời tiết nên kể chuyện không hay lắm, nhưng mình có thể giải thích DHT11, CDS, ESP8266, WiFi, SQLite hay tư vấn sức khỏe theo thời tiết cho bạn.';
      return 'Mình hiểu rồi. Về đồ án này mình có thể giải thích DHT11 ở D4, CDS ở A0, còi ở D5, backend server.js, SQLite weather.db, API latest history alerts, lỗi POST -1 hay EADDRINUSE. Bạn muốn mình giải thích phần nào kỹ hơn?';
    };

    let reply = null;
    let lastError = null;
    // Timeout mỗi model để chat không treo hàng phút khi Gemini chậm.
    // Ghi đè qua GEMINI_TIMEOUT_MS (mặc định 15 giây).
    const MODEL_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 15000;
    const withTimeout = (promise, ms, label) => Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('Timeout ' + label + ' sau ' + ms + 'ms'), { status: 504 })), ms)
      ),
    ]);

    // Thử lần lượt các model cho đến khi thành công (tự động fallback nếu model quá tải)
    for (const modelName of GEMINI_MODELS) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await withTimeout(
          model.generateContent({
            contents: [
              { role: 'user', parts: [{ text: fullPrompt }] }
            ],
            generationConfig: {
              maxOutputTokens: isKnowledgeQ ? 600 : 400,
              temperature: isKnowledgeQ ? 0.7 : 0.2,
            },
          }),
          MODEL_TIMEOUT_MS,
          modelName
        );
        const text = cleanReply(result.response.text() || '');
        if (!text) continue;
        if (isBadReply(text)) {
          console.warn(`Model ${modelName} trả lời checklist, bỏ qua: ${text.slice(0, 120)}`);
          lastError = new Error('AI checklist reply: ' + text.slice(0, 120));
          continue; // thử model tiếp theo
        }
        reply = text;
        break;
      } catch (err) {
        lastError = err;
        const status = err && (err.status || err.statusCode);
        const detail = String((err && err.message) || err).slice(0, 120);
        // 404 = model bị thu hồi -> thử model khác ngay
        // 429/503 = quá tải/hết quota -> thử model khác, có thể thành công
        console.warn(`Model ${modelName} thất bại [${status || '?'}]: ${detail}`);
      }
    }

    if (!reply) {
      // Gemini chết (404/503/timeout) -> câu kiến thức trả từ kho ngoại tuyến cho khôn,
      // câu số liệu trả từ DB để không bao giờ treo ở "đang nhập...".
      if (isKnowledgeQ) {
        if (lastError) console.warn('Dùng knowledge-fallback:', String((lastError && lastError.message) || lastError).slice(0, 150));
        return res.json({ reply: buildKnowledgeFallback() });
      }
      if (latest) {
        if (lastError) {
          const msg = String((lastError && lastError.message) || lastError).slice(0, 150);
          console.warn('Dùng fallback nội bộ do AI lỗi:', msg);
        }
        return res.json({ reply: buildLocalFallback() });
      }
      // Phân loại lỗi để trả đúng mã và thông báo hữu ích
      const status = lastError && (lastError.status || lastError.statusCode);
      if (status === 404) {
        return res.status(503).json({
          error: 'Các model AI đã cấu hình không còn khả dụng. Hãy cập nhật GEMINI_MODELS trong file .env.',
        });
      }
      if (status === 429) {
        return res.status(429).json({ error: 'Đã vượt giới hạn gọi AI (quota). Vui lòng thử lại sau.' });
      }
      if (status === 400 && /api key/i.test(String((lastError && lastError.message) || ''))) {
        return res.status(503).json({ error: 'GEMINI_API_KEY không hợp lệ. Hãy kiểm tra lại key trong file .env.' });
      }
      throw lastError || new Error('Không nhận được phản hồi từ AI');
    }

    res.json({ reply });
  } catch (err) {
    console.error('Gemini API error:', err);
    res.status(500).json({ error: 'Lỗi khi gọi AI. Vui lòng thử lại sau.' });
  }
});

// ---------- Health check ----------
app.get('/api/health', (req, res) => {
  let dbOk = true;
  try {
    db.prepare('SELECT 1').get();
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    version: '1.1.0',
  });
});

// 404 cho API không tồn tại (trước static fallback)
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint không tồn tại' }));

// Error handler tập trung — không bao giờ lộ stack ra client ở production
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload quá lớn' });
  }
  res.status(500).json({ error: 'Lỗi server nội bộ' });
});

// ---------- Khởi động HTTP hoặc HTTPS ----------
// HTTPS trực tiếp: đặt SSL_KEY_PATH + SSL_CERT_PATH (chứng chỉ PEM).
// Nếu không có, server chạy HTTP và phía trước nên có reverse proxy (Caddy/Nginx/Cloudflare).
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
const USE_HTTPS = Boolean(SSL_KEY_PATH && SSL_CERT_PATH &&
  require('fs').existsSync(SSL_KEY_PATH) && require('fs').existsSync(SSL_CERT_PATH));

let server;
if (USE_HTTPS) {
  const https = require('https');
  server = https.createServer({
    key: require('fs').readFileSync(SSL_KEY_PATH),
    cert: require('fs').readFileSync(SSL_CERT_PATH),
  }, app);
  server.listen(PORT); // BẮT BUỘC: createServer chỉ tạo server, phải listen mới nhận kết nối
  console.log('🔒 Chế độ HTTPS trực tiếp (chứng chỉ: ' + SSL_CERT_PATH + ')');
} else {
  server = app.listen(PORT);
  if (process.env.NODE_ENV === 'production') {
    console.log('⚠️  Đang chạy HTTP ở production. Đặt SSL_KEY_PATH + SSL_CERT_PATH,');
    console.log('   hoặc đặt reverse proxy (Caddy/Nginx/Cloudflare) trước để có HTTPS.');
  }
}

server.on('listening', () => {
  const scheme = USE_HTTPS ? 'https' : 'http';
  console.log(`🌐 ${scheme}://localhost:${PORT}`);
  console.log(`🔑 API key cho ESP8266: ${API_KEY === 'demo-key-change-me' ? '(CHƯA ĐỔI — hãy đặt DEVICE_API_KEY!)' : '(đã cấu hình)'}`);
  if (CORS_ORIGIN === '*' && process.env.NODE_ENV === 'production') {
    console.warn('⚠️  CORS_ORIGIN đang là "*". Production nên giới hạn theo domain dashboard.');
  }
});

function shutdown(signal) {
  console.log(`\nNhận ${signal}, đang tắt server...`);
  server.close(() => {
    db.close();
    console.log('Đã đóng HTTP server + SQLite. Tạm biệt!');
    process.exit(0);
  });
  // Ép tắt sau 10s nếu còn kết nối treo
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
