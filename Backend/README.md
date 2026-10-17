# Backend — Trạm Quan Trắc Thời Tiết IoT

Backend nhận dữ liệu từ ESP8266, lưu vào SQLite (file `weather.db` tự tạo), và
cung cấp API cho dashboard frontend.

## 1. Cài đặt

Cần Node.js 18+ đã cài sẵn trên máy.

```bash
cd backend
npm install
cp .env.example .env
```

Mở `.env` và đổi `DEVICE_API_KEY` thành một chuỗi bí mật của riêng bạn —
đây là "mật khẩu" để ESP8266 được phép gửi dữ liệu lên.

## 2. Chạy server

```bash
npm start
```

Server chạy tại `http://localhost:3000`. Kiểm tra nhanh:

```bash
curl http://localhost:3000/api/health
```

## 3. API cho ESP8266 (gửi dữ liệu lên)

```
POST /api/sensors
Header: x-api-key: <DEVICE_API_KEY trong .env>
Content-Type: application/json

Body mẫu:
{
  "temp": 30.3,
  "hum": 65,
  "light": 540,
  "rain": 0,
  "device_id": "ESP8266-WX01",
  "rssi": -52
}
```

Test nhanh bằng curl (giả lập ESP8266) trước khi có phần cứng thật:

```bash
curl -X POST http://localhost:3000/api/sensors \
  -H "Content-Type: application/json" \
  -H "x-api-key: doi-key-nay-thanh-chuoi-bi-mat-cua-ban" \
  -d '{"temp":30.3,"hum":65,"light":540,"rain":0,"rssi":-52}'
```

## 4. API cho dashboard frontend (đọc dữ liệu)

```
GET /api/sensors/latest
→ { temp, hum, light, rain, device_id, rssi, timestamp, online }
→ 204 No Content nếu chưa có dữ liệu nào

GET /api/sensors/history?range=1h|6h|24h|7d
→ { range, labels, temp[], hum[], light[], rain[] }
```

## 5. Chạy thử toàn bộ hệ thống trên cùng 1 máy (demo nhóm)

1. Chạy backend: `npm start` (port 3000)
2. Mở file dashboard HTML trong trình duyệt — sửa 2 chỗ gọi API cho trỏ về
   `http://localhost:3000/api/sensors/latest` và
   `http://localhost:3000/api/sensors/history?range=...`
3. Dùng lệnh `curl` ở mục 3 để giả lập ESP8266 gửi dữ liệu, xem dashboard
   cập nhật real-time
4. Khi ESP8266 thật đã nạp code, đổi `serverUrl` trong file Arduino thành
   IP của máy đang chạy backend (cùng mạng Wi-Fi), ví dụ:
   `http://192.168.1.23:3000/api/sensors`

## 6. Triển khai lên cloud (tuỳ chọn, để demo từ xa không cần cùng Wi-Fi)

Có thể deploy lên Render.com (free tier):
1. Đẩy thư mục `backend/` lên một GitHub repo
2. Trên Render: New → Web Service → kết nối repo
3. Build command: `npm install`, Start command: `npm start`
4. Thêm biến môi trường `DEVICE_API_KEY` trong phần Environment
5. Render sẽ cấp một domain dạng `https://ten-app.onrender.com` —
   dùng domain này thay cho `localhost:3000` ở cả ESP8266 và frontend

**Lưu ý bảo mật tối thiểu:** không commit file `.env` (đã có trong
`.gitignore` nên tự tạo file này) lên GitHub — nó chứa API key.
