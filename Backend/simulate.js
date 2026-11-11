// simulate.js — Giả lập ESP8266 khi chưa có phần cứng.
// Tự đọc DEVICE_API_KEY + PORT từ file .env (không hardcode key).
// Chạy: npm run simulate   (terminal riêng, sau khi npm start)
require('dotenv').config();

const PORT = Number(process.env.PORT) || 3000;
const URL = process.env.SIMULATE_URL || `http://localhost:${PORT}/api/sensors`;
const API_KEY = process.env.DEVICE_API_KEY;

if (!API_KEY || API_KEY === 'demo-key-change-me' || API_KEY === 'doi-key-nay-thanh-chuoi-bi-mat-cua-ban') {
  console.error('[simulate] DEVICE_API_KEY chưa hợp lệ. Hãy tạo file .env (copy từ .env.example) và đặt key mạnh.');
  process.exit(1);
}

let temp = 30, hum = 65, light = 600, count = 0;

const drift = (v, step, min, max) =>
  Math.min(max, Math.max(min, v + (Math.random() - 0.5) * step));

async function send() {
  count++;
  temp  = drift(temp, 0.8, 24, 38);
  hum   = drift(hum, 2, 40, 90);
  light = drift(light, 60, 100, 900);

  let t = temp;
  // cứ 20 lần gửi thì chèn 1 giá trị bất thường để thử cảnh báo
  if (count % 20 === 0) t = 85;

  const body = {
    temp: +t.toFixed(1),
    hum: +hum.toFixed(0),
    light: +light.toFixed(0),
    device_id: 'ESP8266-WX01',
    rssi: -50 - Math.floor(Math.random() * 10),
  };

  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(body),
    });
    console.log(res.status, JSON.stringify(body));
  } catch (e) {
    console.log('Lỗi:', e.message);
  }
}

setInterval(send, 10000);   // 10 giây gửi 1 lần
send();
