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

const insertReading = db.prepare(`
  INSERT INTO readings (temp, hum, light, rain, device_id, rssi)
  VALUES (@temp, @hum, @light, @rain, @device_id, @rssi)
`);

const latestReading = db.prepare(`
  SELECT * FROM readings ORDER BY created_at DESC LIMIT 1
`);

const rangeToSql = {
  '1h':  "datetime('now', '-1 hour')",
  '6h':  "datetime('now', '-6 hour')",
  '24h': "datetime('now', '-1 day')",
  '7d':  "datetime('now', '-7 day')",
};

// ---------- App ----------
const app = express();
app.use(cors());              // cho phép frontend (khác origin) gọi API
app.use(express.json());      // parse JSON body từ ESP8266

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

  const ageMs = Date.now() - new Date(row.created_at + 'Z'.replace('ZZ', 'Z')).getTime();
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

// ---------- Health check ----------
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Weather backend đang chạy tại http://localhost:${PORT}`);
  console.log(`API key cho ESP8266 (header x-api-key): ${API_KEY}`);
});
