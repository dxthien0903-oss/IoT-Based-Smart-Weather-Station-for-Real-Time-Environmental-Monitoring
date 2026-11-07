// server.js
// Backend cho Trạm Quan Trắc Thời Tiết IoT
// Nhận dữ liệu từ ESP8266, lưu SQLite, cung cấp API cho dashboard frontend.
// Tích hợp Google Gemini AI cho chatbot trợ lý thời tiết.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.DEVICE_API_KEY || 'demo-key-change-me'; // ESP8266 phải gửi đúng key này
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OFFLINE_THRESHOLD_MS = 30 * 1000; // khớp với connectionState.offlineThresholdMs ở frontend

// ---------- Google Gemini AI ----------
let genAI = null;
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];

if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  console.log('Gemini AI đã được khởi tạo với danh sách model ưu tiên:', GEMINI_MODELS.join(', '));
} else {
  console.warn('GEMINI_API_KEY chưa được cấu hình. Chatbot AI sẽ không hoạt động.');
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
    rain INTEGER NOT NULL,
    device_id TEXT DEFAULT 'ESP8266-WX01',
    rssi INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_readings_created_at ON readings(created_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sensor TEXT NOT NULL,
    value REAL NOT NULL,
    expected TEXT,
    reason TEXT NOT NULL,
    severity TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

const insertAlert = db.prepare(`
  INSERT INTO alerts (sensor, value, expected, reason, severity)
  VALUES (@sensor, @value, @expected, @reason, @severity)
`);

const recentReadings = db.prepare(
  'SELECT temp, hum, light FROM readings ORDER BY created_at DESC LIMIT 30'
);

// Giới hạn vật lý hợp lý + độ lệch chuẩn tối thiểu cho từng cảm biến
const SENSORS = {
  temp:  { label: 'Nhiệt độ', unit: '°C',  min: -10, max: 50,   minStd: 0.5 },
  hum:   { label: 'Độ ẩm',    unit: '%',   min: 0,   max: 100,  minStd: 2 },
  light: { label: 'Ánh sáng', unit: ' lux', min: 0,  max: 2000, minStd: 50 },
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

// ---------- App ----------
const app = express();
app.use(cors());              // cho phép frontend (khác origin) gọi API
app.use(express.json());      // parse JSON body từ ESP8266
app.use(express.static(path.join(__dirname, '..', 'Frontend')));

// Middleware kiểm tra API key cho endpoint ghi dữ liệu (ESP8266 -> server)
function requireDeviceKey(req, res, next) {
  const key = req.header('x-api-key');
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Sai hoặc thiếu x-api-key' });
  }
  next();
}

// ---------- POST /api/sensors  (ESP8266 gửi dữ liệu lên) ----------
app.post('/api/sensors', requireDeviceKey, (req, res) => {
  const { temp, hum, light, rain, device_id, rssi } = req.body || {};

  if ([temp, hum, light].some((v) => typeof v !== 'number' || Number.isNaN(v))) {
    return res.status(400).json({ error: 'temp, hum, light phải là số' });
  }
  if (rain !== 0 && rain !== 1) {
    return res.status(400).json({ error: 'rain phải là 0 hoặc 1' });
  }

  const found = detectAnomalies({ temp, hum, light });
  found.forEach((a) => insertAlert.run(a));

  insertReading.run({
    temp, hum, light, rain,
    device_id: device_id || 'ESP8266-WX01',
    rssi: typeof rssi === 'number' ? rssi : null,
  });

  res.status(201).json({ ok: true });
});

// ---------- GET /api/sensors/latest ----------
app.get('/api/sensors/latest', (req, res) => {
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
app.get('/api/sensors/history', (req, res) => {
  const range = rangeToSql[req.query.range] ? req.query.range : '1h';
  const sinceExpr = rangeToSql[range];

  const rows = db
    .prepare(`SELECT * FROM readings WHERE created_at >= ${sinceExpr} ORDER BY created_at ASC`)
    .all();

  res.json({
    range,
    labels: rows.map((r) => r.created_at),
    temp: rows.map((r) => r.temp),
    hum: rows.map((r) => r.hum),
    light: rows.map((r) => r.light),
    rain: rows.map((r) => r.rain),
  });
});

   // ---------- GET /api/alerts ----------
   app.get('/api/alerts', (req, res) => {
     const limit = Math.min(Number(req.query.limit) || 20, 100);
     const rows = db
       .prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?')
       .all(limit);
     res.json(rows);
   });
// ---------- POST /api/chat  (Chatbot AI dùng Gemini) ----------
app.post('/api/chat', async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Vui lòng nhập câu hỏi.' });
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
        console.warn(`Model ${modelName} thất bại, đang thử model tiếp theo... (${err.message.slice(0, 80)})`);
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
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Weather backend đang chạy tại http://localhost:${PORT}`);
  console.log(`API key cho ESP8266 (header x-api-key): ${API_KEY}`);
});
