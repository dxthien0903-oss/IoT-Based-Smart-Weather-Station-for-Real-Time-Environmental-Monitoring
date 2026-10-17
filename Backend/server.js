// server.js
// Backend cho Trạm Quan Trắc Thời Tiết IoT
// Nhận dữ liệu từ ESP8266, lưu SQLite, cung cấp API cho dashboard frontend.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.DEVICE_API_KEY || 'demo-key-change-me'; // ESP8266 phải gửi đúng key này
const OFFLINE_THRESHOLD_MS = 30 * 1000; // khớp với connectionState.offlineThresholdMs ở frontend

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
// ---------- Health check ----------
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Weather backend đang chạy tại http://localhost:${PORT}`);
  console.log(`API key cho ESP8266 (header x-api-key): ${API_KEY}`);
});
