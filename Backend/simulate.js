const URL = "http://localhost:3000/api/sensors";
const API_KEY = "tonlien007";   // phải khớp DEVICE_API_KEY trong .env

let temp = 30, hum = 65, light = 600, count = 0;

const drift = (v, step, min, max) =>
  Math.min(max, Math.max(min, v + (Math.random() - 0.5) * step));

async function send() {
  count++;
  temp  = drift(temp, 0.8, 24, 38);
  hum   = drift(hum, 2, 40, 90);
  light = drift(light, 60, 100, 900);

  let t = temp;
  // cứ 20 lần gửi thì chèn 1 giá trị bất thường để thử cảnh báo AI
  if (count % 20 === 0) t = 85;

  const body = {
    temp: +t.toFixed(1),
    hum: +hum.toFixed(0),
    light: +light.toFixed(0),
    rain: Math.random() < 0.1 ? 1 : 0,
    rssi: -50 - Math.floor(Math.random() * 10),
  };

  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify(body),
    });
    console.log(res.status, JSON.stringify(body));
  } catch (e) {
    console.log("Lỗi:", e.message);
  }
}

setInterval(send, 10000);   // 10 giây gửi 1 lần
send();