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
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];

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
    rain INTEGER NOT NULL CHECK (rain IN (0, 1)),
    device_id TEXT DEFAULT 'ESP8266-WX01',
    rssi INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_readings_created_at ON readings(created_at);
  CREATE INDEX IF NOT EXISTS idx_readings_device_time ON readings(device_id, created_at);
`);

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
  INSERT INTO readings (temp, hum, light, rain, device_id, rssi)
  VALUES (@temp, @hum, @light, @rain, @device_id, @rssi)
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
      rain: bucket.some((r) => r.rain === 1) ? 1 : 0, // mưa: giữ 1 nếu bucket có mưa
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
app.set('trust proxy', 1); // cần khi deploy sau reverse proxy (Render/Nginx) để rate-limit theo IP đúng
app.use(helmet({ contentSecurityPolicy: false })); // CSP tắt để Chart.js CDN + inline script hoạt động; bật lại khi build frontend riêng
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
  const { temp, hum, light, rain, device_id, rssi } = req.body || {};

  if ([temp, hum, light].some((v) => typeof v !== 'number' || Number.isNaN(v) || !Number.isFinite(v))) {
    return res.status(400).json({ error: 'temp, hum, light phải là số hợp lệ' });
  }
  if (rain !== 0 && rain !== 1) {
    return res.status(400).json({ error: 'rain phải là 0 hoặc 1' });
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
    temp, hum, light, rain,
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
    rain: row.rain,
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
    rain: sampled.map((r) => r.rain),
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
    const recentData = db.prepare('SELECT temp, hum, light, rain, created_at FROM readings ORDER BY created_at DESC LIMIT 20').all();

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

    const sensorContext = latest
      ? `Dữ liệu cảm biến MỚI NHẤT (${latest.created_at}):
- Nhiệt độ: ${latest.temp}°C
- Độ ẩm: ${latest.hum}%
- Ánh sáng: ${latest.light} lux
- Mưa: ${latest.rain ? 'Có mưa' : 'Không mưa'}
- Thiết bị: ${latest.device_id}
- RSSI (WiFi): ${latest.rssi} dBm
${stats}`
      : 'Chưa có dữ liệu cảm biến nào.';

    const alertContext = recentAlerts.length > 0
      ? `Cảnh báo bất thường gần đây:\n${recentAlerts.map(a =>
          `- [${a.severity}] ${a.reason}: ${a.value} (kỳ vọng: ${a.expected || 'N/A'}) lúc ${a.created_at}`
        ).join('\n')}`
      : 'Không có cảnh báo bất thường nào gần đây.';

    const systemPrompt = `Bạn là trợ lý AI chuyên về thời tiết và môi trường, được tích hợp trong hệ thống IoT Weather Station (Trạm Quan Trắc Thời Tiết IoT).

Vai trò của bạn:
1. Phân tích và giải thích dữ liệu cảm biến thời gian thực
2. Đưa ra nhận xét, đánh giá về điều kiện thời tiết hiện tại
3. Cảnh báo khi có dữ liệu bất thường
4. Đưa ra lời khuyên về sức khỏe, hoạt động phù hợp với thời tiết
5. Giải thích các khái niệm về thời tiết, IoT cho sinh viên
6. Trả lời câu hỏi liên quan đến đồ án, hệ thống

Quy tắc:
- Trả lời bằng tiếng Việt
- Ngắn gọn, dễ hiểu, thân thiện
- Sử dụng emoji phù hợp
- Dựa trên dữ liệu thực tế từ cảm biến khi có
- Nếu không có dữ liệu, nói rõ là chưa có và vẫn trả lời chung

DỮ LIỆU HỆ THỐNG HIỆN TẠI:
${sensorContext}

${alertContext}`;

    let reply = null;
    let lastError = null;

    // Thử lần lượt các model cho đến khi thành công (tự động fallback nếu model quá tải)
    for (const modelName of GEMINI_MODELS) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent({
          contents: [
            { role: 'user', parts: [{ text: systemPrompt + '\n\nCâu hỏi của người dùng: ' + message.trim() }] }
          ],
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.7,
          },
        });
        reply = result.response.text();
        if (reply) break;
      } catch (err) {
        lastError = err;
        console.warn(`Model ${modelName} thất bại, đang thử model tiếp theo... (${String(err && err.message || err).slice(0, 80)})`);
      }
    }

    if (!reply) {
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

const server = app.listen(PORT, () => {
  console.log(`Weather backend đang chạy tại http://localhost:${PORT}`);
  console.log(`API key cho ESP8266: ${API_KEY === 'demo-key-change-me' ? '(CHƯA ĐỔI — hãy đặt DEVICE_API_KEY!)' : '(đã cấu hình)'}`);
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
