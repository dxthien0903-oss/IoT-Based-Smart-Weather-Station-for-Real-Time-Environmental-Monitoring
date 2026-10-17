# Trạm Quan Trắc Thời Tiết IoT

**IoT-Based Smart Weather Station for Real-Time Environmental Monitoring**

Hệ thống trạm thời tiết giá rẻ dùng ESP8266: đo nhiệt độ, độ ẩm, cường độ ánh
sáng và mưa, gửi dữ liệu qua Wi-Fi lên máy chủ, lưu trữ, hiển thị trên dashboard
web theo thời gian thực và tự động phát hiện số đo bất thường.

**Từ khóa:** IoT, Weather Station, ESP8266, Environmental Monitoring, Sensor,
Wi-Fi, Anomaly Detection

## Mục lục
1. [Giới thiệu](#1-giới-thiệu)
2. [Kiến trúc hệ thống](#2-kiến-trúc-hệ-thống)
3. [Cấu trúc thư mục](#3-cấu-trúc-thư-mục)
4. [Yêu cầu](#4-yêu-cầu)
5. [Bắt đầu nhanh](#5-bắt-đầu-nhanh)
6. [Backend](#6-backend)
7. [Frontend (Dashboard)](#7-frontend-dashboard)
8. [Phần cứng và code ESP8266](#8-phần-cứng-và-code-esp8266)
9. [Chạy thử khi chưa có phần cứng](#9-chạy-thử-khi-chưa-có-phần-cứng)
10. [Phát hiện bất thường](#10-phát-hiện-bất-thường)
11. [Xử lý sự cố](#11-xử-lý-sự-cố)
12. [Triển khai lên cloud (tùy chọn)](#12-triển-khai-lên-cloud-tùy-chọn)
13. [Bảo mật](#13-bảo-mật)
14. [Hạn chế đã biết và hướng phát triển](#14-hạn-chế-đã-biết-và-hướng-phát-triển)
15. [Nhóm thực hiện](#15-nhóm-thực-hiện)

---

## 1. Giới thiệu

Điều kiện thời tiết và môi trường (nhiệt độ, độ ẩm, ánh sáng, mưa) ảnh hưởng đến
sinh hoạt, nông nghiệp và nhiều ứng dụng khác. Các trạm quan trắc truyền thống
thường đắt tiền và khó truy cập dữ liệu thời gian thực tại chỗ. Dự án này xây
dựng một trạm đo chi phí thấp dựa trên IoT.

**Mục tiêu:**
- Xây dựng thiết bị giám sát thời tiết IoT chi phí thấp.
- Thu thập dữ liệu môi trường theo thời gian thực.
- Lưu trữ và trực quan hóa dữ liệu trên dashboard web.
- Phát hiện số đo bất thường.
- Đánh giá hiệu năng và độ tin cậy của hệ thống.

**Tính năng chính:**
- Đo nhiệt độ, độ ẩm (DHT22), ánh sáng (LDR) và trạng thái mưa (cảm biến mưa).
- Gửi dữ liệu qua Wi-Fi tới backend bằng HTTP, xác thực bằng API key.
- Lưu trữ bằng SQLite, có lịch sử theo 1 giờ, 6 giờ, 24 giờ, 7 ngày.
- Dashboard: thẻ chỉ số, xu hướng, biểu đồ lịch sử, so sánh hai chỉ số.
- Cảnh báo bất thường được lưu lại, hiển thị kèm thời gian, giá trị, mức độ.
- Hiển thị trạng thái kết nối thiết bị (Đã kết nối / Mất kết nối).

## 2. Kiến trúc hệ thống

```
┌──────────────────┐   HTTP POST (JSON)   ┌─────────────────────────┐
│ ESP8266          │ ───────────────────> │ Backend (Node.js)       │
│ DHT22, LDR, mưa  │   x-api-key          │ Express + SQLite        │
└──────────────────┘                      │ - lưu bản ghi           │
                                          │ - phát hiện bất thường  │
                                          └────────────┬────────────┘
                                                       │ HTTP GET (JSON)
                                          ┌────────────▼────────────┐
                                          │ Dashboard (trình duyệt) │
                                          │ HTML + Chart.js         │
                                          └─────────────────────────┘
```

Luồng hoạt động: cảm biến đo định kỳ, ESP8266 đọc và gửi lên backend; backend
kiểm tra bất thường, lưu vào database; dashboard hỏi backend mỗi 10 giây để cập
nhật số liệu, biểu đồ và cảnh báo.

## 3. Cấu trúc thư mục

```
IoT-Based-Smart-Weather-Station-for-Real-Time-Environmental-Monitoring/
├── README.md                      Tài liệu này
├── Frontend/
│   └── index.html                 Dashboard (HTML + CSS + JS)
└── Backend/
    ├── server.js                  Server Express + SQLite
    ├── simulate.js                Giả lập ESP8266 khi chưa có phần cứng
    ├── esp8266_weather_station/   Code Arduino cho ESP8266 (file .ino)
    ├── package.json
    ├── .env                       Cấu hình bí mật (KHÔNG đưa lên GitHub)
    ├── .env.example               Mẫu cấu hình
    └── weather.db*                Database SQLite, tự tạo khi chạy lần đầu
```

## 4. Yêu cầu

| Thành phần | Yêu cầu |
|---|---|
| Máy chạy backend | Node.js 18 trở lên (kiểm tra bằng `node -v`) |
| Trình duyệt | Chrome, Edge, Firefox bản mới; cần Internet lần đầu để tải Chart.js từ CDN |
| Nạp code ESP8266 | Arduino IDE, hỗ trợ board ESP8266, cáp USB có truyền dữ liệu |
| Mạng | Wi-Fi **2.4 GHz** dùng chung cho máy chạy backend và ESP8266 |

## 5. Bắt đầu nhanh

Cách nhanh nhất để thấy hệ thống chạy (không cần phần cứng):

```bash
cd Backend
npm install
```

Tạo file cấu hình:

| Hệ điều hành | Lệnh |
|---|---|
| Windows (cmd / PowerShell) | `copy .env.example .env` |
| macOS / Linux | `cp .env.example .env` |

Mở `.env`, đặt `DEVICE_API_KEY` thành chuỗi bí mật của bạn, rồi:

```bash
# Terminal 1: chạy server
npm start

# Terminal 2: giả lập thiết bị gửi dữ liệu
node simulate.js
```

Mở trình duyệt vào `http://localhost:3000`. Sau vài giây dashboard hiển thị số
liệu, và khoảng 3 phút 20 giây sau xuất hiện cảnh báo bất thường đầu tiên.

## 6. Backend

Backend nhận dữ liệu từ ESP8266, lưu vào SQLite (file `weather.db` tự tạo),
phát hiện bất thường và cung cấp API cho dashboard. Server cũng phục vụ luôn
thư mục `Frontend`.

### 6.1. Cấu hình `.env`

```
DEVICE_API_KEY=chuoi-bi-mat-cua-ban
PORT=3000
```

- `DEVICE_API_KEY`: "mật khẩu" cho thiết bị gửi dữ liệu. Phải **giống hệt**
  `deviceApiKey` trong file `.ino` và `API_KEY` trong `simulate.js`.
- `PORT`: cổng chạy server (mặc định 3000).

### 6.2. Chạy server

```bash
npm start
```

Nếu báo không có script `start`, dùng `node server.js`. Thành công khi thấy dòng
`Weather backend đang chạy tại http://localhost:3000`. Kiểm tra nhanh:
`http://localhost:3000/api/health` trả về `{"ok":true,...}`.

> Mỗi lần sửa `server.js` phải dừng server (Ctrl+C) rồi chạy lại.

### 6.3. API ghi dữ liệu (ESP8266 gửi lên)

```
POST /api/sensors
Header:  x-api-key: <DEVICE_API_KEY>
         Content-Type: application/json
```

Body mẫu:

```json
{
  "temp": 30.3,
  "hum": 65,
  "light": 540,
  "rain": 0,
  "device_id": "ESP8266-WX01",
  "rssi": -52
}
```

| Trường | Kiểu | Bắt buộc | Ghi chú |
|---|---|---|---|
| `temp` | số | có | Nhiệt độ (°C) |
| `hum` | số | có | Độ ẩm (%) |
| `light` | số | có | Ánh sáng (lux) |
| `rain` | 0 hoặc 1 | có | 1 = phát hiện mưa, 0 = khô. Cảm biến chỉ cho trạng thái, không đo mm |
| `device_id` | chuỗi | không | Mặc định `ESP8266-WX01` |
| `rssi` | số | không | Cường độ Wi-Fi (dBm) |

| Mã phản hồi | Ý nghĩa |
|---|---|
| `201` | Đã lưu thành công |
| `400` | Dữ liệu sai định dạng (thiếu trường, không phải số, `rain` khác 0/1) |
| `401` | Sai hoặc thiếu `x-api-key` |

Thử bằng curl:

**Windows (cmd):**
```cmd
curl -X POST http://localhost:3000/api/sensors -H "Content-Type: application/json" -H "x-api-key: KEY_CUA_BAN" -d "{\"temp\":30.3,\"hum\":65,\"light\":540,\"rain\":0,\"rssi\":-52}"
```

**macOS / Linux:**
```bash
curl -X POST http://localhost:3000/api/sensors \
  -H "Content-Type: application/json" \
  -H "x-api-key: KEY_CUA_BAN" \
  -d '{"temp":30.3,"hum":65,"light":540,"rain":0,"rssi":-52}'
```

### 6.4. API đọc dữ liệu (dashboard dùng)

Các endpoint đọc không cần API key. Server đã bật CORS.

**`GET /api/sensors/latest`**: bản ghi mới nhất.

```json
{
  "temp": 30.3, "hum": 65, "light": 540, "rain": 0,
  "device_id": "ESP8266-WX01", "rssi": -52,
  "timestamp": "2026-10-17T07:30:15.123Z",
  "online": true
}
```

- `timestamp` là giờ **UTC** (ISO 8601, có chữ `Z`).
- `online` là `true` nếu bản ghi mới nhất không quá 30 giây tuổi.
- Trả về `204 No Content` nếu chưa có dữ liệu.

**`GET /api/sensors/history?range=1h|6h|24h|7d`**: lịch sử, cũ đến mới,
`range` mặc định `1h`.

```json
{
  "range": "1h",
  "labels": ["2026-10-17T07:00:05.000Z", "..."],
  "temp": [30.1, "..."],
  "hum": [65, "..."],
  "light": [540, "..."],
  "rain": [0, "..."]
}
```

**`GET /api/alerts?limit=20`**: cảnh báo bất thường, mới nhất trước (`limit`
mặc định 20, tối đa 100). Cảnh báo được **lưu vĩnh viễn**.

```json
[
  {
    "id": 1,
    "sensor": "temp",
    "value": 85,
    "expected": "-10 đến 50°C",
    "reason": "Nhiệt độ ngoài khoảng hợp lý",
    "severity": "high",
    "created_at": "2026-10-17T07:31:00.000Z"
  }
]
```

**`GET /api/health`**: kiểm tra server còn sống.

### 6.5. Cơ sở dữ liệu

SQLite, file `Backend/weather.db` (kèm `weather.db-wal`, `weather.db-shm`). Hai bảng:

| Bảng | Nội dung |
|---|---|
| `readings` | Mỗi lần đo: `temp`, `hum`, `light`, `rain`, `device_id`, `rssi`, `created_at` (UTC) |
| `alerts` | Mỗi cảnh báo: `sensor`, `value`, `expected`, `reason`, `severity`, `created_at` (UTC) |

Muốn xóa toàn bộ dữ liệu thử: dừng server, xóa ba file `weather.db*`, chạy lại
server (database được tạo lại).

## 7. Frontend (Dashboard)

Dashboard một trang, chỉ gồm `Frontend/index.html` (HTML + CSS + JavaScript
thuần, biểu đồ dùng Chart.js qua CDN). Không cần build.

### 7.1. Cách mở

**Khuyến nghị:** chạy backend rồi mở `http://localhost:3000`. Muốn xem trên
điện thoại: kết nối cùng Wi-Fi và mở `http://<IP-máy-chạy-backend>:3000` (lấy IP
bằng `ipconfig`).

**Cách khác:** mở trực tiếp file `index.html` (`file:///...`). Khi đó dashboard
tự gọi `http://localhost:3000`, chỉ hoạt động trên chính máy chạy backend. Nên
dùng tab trình duyệt thường, không dùng chế độ giả lập thiết bị của DevTools
(sẽ có cảnh báo `Unsafe attempt to load URL`, không ảnh hưởng chức năng).

### 7.2. Cấu hình (trong thẻ `<script>` của `index.html`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `API_BASE` | `location.origin` (hoặc `http://localhost:3000` khi mở bằng `file://`) | Địa chỉ backend |
| `connectionState.offlineThresholdMs` | `30000` | Quá bao nhiêu ms không có dữ liệu thì báo "Mất kết nối". Nên khớp `OFFLINE_THRESHOLD_MS` trong `server.js` |
| `setInterval(..., 10000)` | 10 giây | Chu kỳ tự làm mới |
| `MAX_HISTORY_POINTS` | `72` | Số điểm tối đa cho biểu đồ nhỏ trong thẻ |

### 7.3. Giao diện

- **Trạng thái kết nối:** "Đã kết nối" (xanh) khi dữ liệu không quá 30 giây tuổi,
  "Mất kết nối" khi quá hạn, "Lỗi kết nối server" khi gọi API thất bại.
- **4 thẻ chỉ số:** giá trị hiện tại, xu hướng so với lần đo trước, khoảng
  min-max của 12 lần đo gần nhất, nhận xét ngắn, biểu đồ nhỏ, badge trạng thái
  (Đang chờ / Bình thường / Bất thường).
- **Thẻ Mưa:** Có mưa / Khô ráo (không có đơn vị mm).
- **Biểu đồ lịch sử:** chọn chỉ số, chọn khoảng thời gian, bật so sánh với chỉ
  số khác (hai trục Y).
- **Cảnh báo bất thường:** danh sách lấy từ backend, kèm thời gian, cảm biến,
  giá trị, giá trị kỳ vọng, mức độ. Badge thẻ báo "Bất thường" nếu cảm biến đó có
  cảnh báo trong 60 giây gần nhất; banner chỉ hiện với cảnh báo dưới 20 giây.
- **Nút "Làm mới dữ liệu":** tải lại ngay, không chờ chu kỳ 10 giây.

Mỗi chu kỳ dashboard gọi: `GET /api/sensors/latest`, `GET /api/sensors/history`
(riêng khoảng 7 ngày chỉ tải khi bấm nút) và `GET /api/alerts`.

## 8. Phần cứng và code ESP8266

### 8.1. Linh kiện

| Linh kiện | Vai trò |
|---|---|
| ESP8266 NodeMCU | Vi điều khiển có Wi-Fi |
| DHT22 | Nhiệt độ và độ ẩm |
| LDR (quang trở) | Cường độ ánh sáng |
| Cảm biến mưa | Phát hiện mưa (có/không) |
| Cáp USB (có truyền dữ liệu) | Cấp nguồn và nạp code |

### 8.2. Sơ đồ nối chân

> Điền theo file `.ino` của nhóm.

| Cảm biến | Chân cảm biến | Chân NodeMCU |
|---|---|---|
| DHT22 | VCC / DATA / GND | `<3V3>` / `<chân>` / `<GND>` |
| LDR | `<cách nối, ví dụ cầu phân áp>` | `<A0 hoặc chân khác>` |
| Cảm biến mưa | VCC / DO (hoặc AO) / GND | `<3V3>` / `<chân>` / `<GND>` |

Lưu ý: ESP8266 chỉ có **một chân analog (A0)**. Nếu cả LDR và cảm biến mưa đều
là tín hiệu analog thì không thể đọc đồng thời trên một chân; thường dùng A0 cho
LDR và chân số (DO) của cảm biến mưa để lấy giá trị 0/1.

### 8.3. Cấu hình code

Mở `Backend/esp8266_weather_station/esp8266_weather_station.ino` bằng Arduino
IDE và sửa phần cấu hình ở đầu file:

```cpp
const char* ssid         = "TEN_WIFI";
const char* password     = "MAT_KHAU_WIFI";
const char* serverUrl    = "http://192.168.x.x:3000/api/sensors";
const char* deviceApiKey = "GIA_TRI_DEVICE_API_KEY";
const char* deviceId     = "ESP8266-WX01";
```

Yêu cầu bắt buộc:
- `serverUrl`: dùng **IPv4 của máy chạy backend** (xem bằng `ipconfig`), không
  dùng `localhost`.
- ESP8266 và máy chạy backend **cùng mạng Wi-Fi**, băng tần **2.4 GHz**.
- Dùng `http://` khi chạy trong mạng LAN.
- `deviceApiKey` phải giống `DEVICE_API_KEY` trong `.env`.
- Nếu Windows Firewall chặn, cho phép **Node.js** qua firewall (mạng Private).
- IP của máy có thể đổi sau khi khởi động lại máy hoặc router; nếu thiết bị
  đột nhiên không gửi được, kiểm tra lại IP.

### 8.4. Nạp code

1. Cắm ESP8266 vào máy bằng cáp USB (loại có truyền dữ liệu).
2. **Tools → Board:** NodeMCU 1.0 (ESP-12E Module).
3. **Tools → Port:** chọn cổng COM của thiết bị (nếu không thấy, cài driver
   CH340 hoặc CP2102 tùy chip).
4. Nếu báo thiếu thư viện (ví dụ cho DHT22 hoặc JSON), cài trong **Sketch →
   Include Library → Manage Libraries** theo các dòng `#include` của file `.ino`.
5. Bấm **Upload**, rồi mở **Serial Monitor** ở **115200 baud** để xem kết quả.

Mã phản hồi trên Serial Monitor: **201** thành công, **401** sai API key,
**-1** không kết nối được server.

## 9. Chạy thử khi chưa có phần cứng

`Backend/simulate.js` đóng vai ESP8266: cứ 10 giây gửi một bản ghi, và cứ 20 lần
gửi (khoảng 3 phút 20 giây) chèn một nhiệt độ bất thường (85 °C) để thử cảnh báo.

1. Mở `simulate.js`, kiểm tra `API_KEY` khớp `DEVICE_API_KEY` trong `.env`.
2. Terminal 1: `npm start`.
3. Terminal 2: `node simulate.js`. Mỗi dòng in ra có dạng `201 {"temp":30.4,...}`.
4. Mở `http://localhost:3000` và quan sát.

Dừng giả lập bằng **Ctrl+C**.

> Khi báo cáo, ghi rõ dữ liệu là **mô phỏng** nếu chưa dùng cảm biến thật.

## 10. Phát hiện bất thường

Mỗi lần nhận dữ liệu, backend kiểm tra `temp`, `hum`, `light` theo hai lớp
**thống kê** (không phải mô hình học máy):

**Lớp 1: giới hạn vật lý** (mức `high`)

| Cảm biến | Khoảng hợp lý |
|---|---|
| Nhiệt độ | -10 đến 50 °C |
| Độ ẩm | 0 đến 100 % |
| Ánh sáng | 0 đến 2000 lux |

**Lớp 2: thay đổi đột ngột** (mức `medium`): so với 30 lần đo gần nhất bằng
z-score; lệch quá **3 độ lệch chuẩn** thì ghi cảnh báo. Lớp này chỉ hoạt động khi
đã có từ **10 bản ghi**. Độ lệch chuẩn tối thiểu (0.5 °C, 2 %, 50 lux) giúp tránh
báo nhầm khi dữ liệu quá ổn định.

Các ngưỡng nằm trong object `SENSORS` ở `Backend/server.js`, có thể chỉnh cho
phù hợp với nơi lắp đặt. Cảm biến mưa chưa được kiểm tra bất thường.

## 11. Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `fetch failed` / `Failed to connect` | Server chưa chạy | Chạy `npm start` |
| Mã `401` | API key không khớp | So lại `.env`, `simulate.js`, file `.ino` |
| Mã `400` | Thiếu trường hoặc sai kiểu | Xem bảng ở mục 6.3 |
| Mã `-1` trên Serial Monitor | ESP8266 không tới được server | Kiểm tra IP, cùng mạng Wi-Fi, firewall |
| Điện thoại không vào được `http://IP:3000` | Firewall hoặc Wi-Fi chặn thiết bị giao tiếp với nhau | Cho phép Node.js qua firewall, hoặc dùng điểm phát Wi-Fi từ điện thoại |
| Dashboard hiện "Lỗi kết nối server" | Backend chưa chạy hoặc sai `API_BASE` | Chạy backend, mở F12 → Console xem lỗi |
| Thẻ hiện `--`, trạng thái "Đang chờ" | Backend chưa có dữ liệu | Chạy `node simulate.js` hoặc bật ESP8266 |
| "Mất kết nối" dù đã gửi dữ liệu | Dữ liệu cũ hơn 30 giây | Kiểm tra thiết bị hoặc `simulate.js` còn chạy không |
| Danh sách cảnh báo luôn rỗng | Chưa có số đo bất thường, hoặc chưa khởi động lại server sau khi sửa code | Gửi thử `temp` = 85, khởi động lại server |
| Biểu đồ trống | Chưa có dữ liệu trong khoảng đã chọn | Chọn khoảng dài hơn hoặc gửi thêm dữ liệu |
| `SqliteError: no such table` | Code tạo bảng đặt sai thứ tự | Đảm bảo bảng `readings` được tạo trước các câu lệnh dùng nó |
| Không thấy cổng COM khi nạp code | Thiếu driver hoặc cáp chỉ sạc | Cài driver CH340/CP2102, thử cáp khác |

## 12. Triển khai lên cloud (tùy chọn)

Có thể deploy lên dịch vụ như Render để demo từ xa mà không cần cùng Wi-Fi:

1. Đẩy thư mục dự án lên GitHub (không kèm `.env` và `weather.db*`).
2. Tạo Web Service, kết nối repo; thư mục gốc của dịch vụ là `Backend`.
3. Build command: `npm install`. Start command: `npm start`.
4. Thêm biến môi trường `DEVICE_API_KEY` trong phần Environment.
5. Dùng domain được cấp thay cho `localhost:3000` ở ESP8266 (dashboard tự dùng
   cùng domain).

Lưu ý:
- Ổ đĩa gói miễn phí thường **không lưu lâu dài**: file SQLite có thể bị xóa khi
  dịch vụ khởi động lại hoặc deploy lại. Muốn giữ dữ liệu cần gắn ổ đĩa bền
  vững hoặc dùng database bên ngoài.
- Gói miễn phí có thể tạm ngủ khi không có truy cập, khiến dashboard báo mất
  kết nối trong lúc dịch vụ thức dậy.
- Domain cloud dùng **HTTPS**; ESP8266 cần `WiFiClientSecure` (ví dụ
  `setInsecure()` khi demo) thay cho `WiFiClient`.
- Tính năng và giới hạn của gói miễn phí có thể thay đổi, hãy xem tài liệu của
  nhà cung cấp.

## 13. Bảo mật

- **Không commit `.env`** (chứa API key). Kiểm tra `.gitignore` đã có `.env` và
  `weather.db*`.
- **Không commit file `.ino` chứa mật khẩu Wi-Fi và API key thật.** `.gitignore`
  mặc định không bảo vệ file này. Trước khi đẩy lên GitHub, đổi về giá trị giả
  như `"TEN_WIFI"`, `"MAT_KHAU_WIFI"`.
- Đổi `DEVICE_API_KEY` khỏi giá trị mặc định `demo-key-change-me`.
- Nếu lỡ để lộ key hoặc mật khẩu, đổi ngay.
- Các endpoint đọc (`/api/sensors/*`, `/api/alerts`) **không yêu cầu xác thực**:
  phù hợp demo trong mạng nội bộ, nhưng nên thêm xác thực nếu mở công khai.

## 14. Hạn chế đã biết và hướng phát triển

**Hạn chế:**
- Phát hiện bất thường dựa trên **thống kê**, chưa phải học máy; chưa kiểm tra
  cảm biến mưa.
- Nếu giá trị bất thường kéo dài, mỗi bản ghi sinh thêm một cảnh báo (chưa gộp
  hoặc giới hạn tần suất).
- Số đo bất thường vẫn nằm trong 30 bản ghi dùng làm mốc so sánh, có thể làm
  tăng độ lệch chuẩn và giảm độ nhạy ngay sau đó.
- Chưa có cơ chế dọn dữ liệu cũ: database lớn dần theo thời gian.
- Khoảng 7 ngày trả về toàn bộ bản ghi nên có thể chậm khi dữ liệu lớn.
- Dashboard làm mới bằng cách hỏi định kỳ (polling), chưa dùng WebSocket.
- Cảm biến mưa chỉ cho trạng thái có/không, không đo lượng mưa (mm).
- Độ chính xác của hệ thống phụ thuộc chất lượng cảm biến và lượng dữ liệu thu
  thập.

**Hướng phát triển:** thêm cảm biến (áp suất, gió, bụi), dự báo thời tiết, mô
hình học máy cho phát hiện bất thường, gộp và giới hạn cảnh báo, thông báo qua
email hoặc Telegram, lấy mẫu thưa dữ liệu dài hạn, đăng nhập cho dashboard.

## 15. Nhóm thực hiện

| Họ tên | Vai trò |
|---|---|
| `<Họ tên>` | `<Vai trò>` |
| `<Họ tên>` | `<Vai trò>` |
| `<Họ tên>` | `<Vai trò>` |
| `<Họ tên>` | `<Vai trò>` |