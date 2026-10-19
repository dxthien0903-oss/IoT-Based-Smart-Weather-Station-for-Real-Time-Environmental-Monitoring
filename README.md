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
5. [Hướng dẫn chạy từ đầu (tải ZIP từ GitHub)](#5-hướng-dẫn-chạy-từ-đầu-tải-zip-từ-github)
6. [Backend](#6-backend)
7. [Frontend (Dashboard)](#7-frontend-dashboard)
8. [Phần cứng và code ESP8266](#8-phần-cứng-và-code-esp8266)
9. [Chạy thử khi chưa có phần cứng](#9-chạy-thử-khi-chưa-có-phần-cứng)
10. [Phát hiện bất thường](#10-phát-hiện-bất-thường)
11. [Xử lý sự cố](#11-xử-lý-sự-cố)
12. [Triển khai lên cloud (tùy chọn)](#12-triển-khai-lên-cloud-tùy-chọn)
13. [Bảo mật và đưa dự án lên GitHub](#13-bảo-mật-và-đưa-dự-án-lên-github)
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
- Cảnh báo bất thường được lưu lại, kèm thời gian, giá trị, mức độ.
- Hiển thị trạng thái kết nối thiết bị (Đã kết nối / Mất kết nối).

## 2. Kiến trúc hệ thống

```
┌──────────────────┐   HTTP POST (JSON)   ┌─────────────────────────┐
│ ESP8266          │ ───────────────────> │ Backend (Node.js)       │
│ DHT22, LDR, mưa  │   x-api-key          │ Express + SQLite        │
└──────────────────┘                      │ - lưu bản ghi           │
                                          │ - phát hiện bất thường  │
                                          │ - phục vụ Frontend      │
                                          └────────────┬────────────┘
                                                       │ HTTP GET (JSON)
                                          ┌────────────▼────────────┐
                                          │ Dashboard (trình duyệt) │
                                          │ HTML + Chart.js         │
                                          └─────────────────────────┘
```

Cảm biến đo định kỳ, ESP8266 đọc và gửi lên backend; backend kiểm tra bất
thường, lưu vào database; dashboard hỏi backend mỗi 10 giây để cập nhật số liệu,
biểu đồ và cảnh báo.

## 3. Cấu trúc thư mục

```
IoT-Based-Smart-Weather-Station-for-Real-Time-Environmental-Monitoring/
├── README.md                      Tài liệu này
├── .gitignore
├── Frontend/
│   └── index.html                 Dashboard (HTML + CSS + JS)
└── Backend/
    ├── server.js                  Server Express + SQLite
    ├── simulate.js                Giả lập ESP8266 khi chưa có phần cứng
    ├── package.json
    ├── .env.example               Mẫu cấu hình (giá trị giả)
    ├── .env                       Cấu hình thật (tự tạo, KHÔNG có trên GitHub)
    ├── weather.db*                Database (tự tạo khi chạy, KHÔNG có trên GitHub)
    └── esp8266_weather_station/
        ├── esp8266_weather_station.ino   Code Arduino cho ESP8266
        ├── secrets.h.example             Mẫu Wi-Fi và API key (giá trị giả)
        └── secrets.h                     Thông tin thật (tự tạo, KHÔNG có trên GitHub)
```

Các file đánh dấu "KHÔNG có trên GitHub" được cố ý loại khỏi repo (chứa bí mật
hoặc sinh tự động), nên người tải về phải tự tạo theo mục 5 và mục 8.

## 4. Yêu cầu

| Thành phần | Yêu cầu |
|---|---|
| Máy chạy backend | Node.js **18 trở lên** (khuyến nghị bản LTS) |
| Trình duyệt | Chrome, Edge, Firefox bản mới; cần Internet lần đầu để tải Chart.js từ CDN |
| Nạp code ESP8266 (tùy chọn) | Arduino IDE, hỗ trợ board ESP8266, cáp USB có truyền dữ liệu |
| Mạng | Wi-Fi **2.4 GHz** dùng chung cho máy chạy backend và ESP8266 |

Hướng dẫn dưới đây dùng **Command Prompt (cmd)** trên Windows. Trên macOS/Linux
dùng Terminal, các lệnh khác biệt được ghi chú.

## 5. Hướng dẫn chạy từ đầu (tải ZIP từ GitHub)

### Bước 1: Cài Node.js (làm một lần)
1. Vào **nodejs.org**, tải bản **LTS** và cài đặt.
2. Mở terminal **mới** và kiểm tra:
```cmd
   node -v
   npm -v
```
   `node -v` phải hiện **v18** trở lên. Nếu báo "not recognized", đóng hết
   terminal rồi mở lại (hoặc khởi động lại máy).

### Bước 2: Tải và giải nén
1. Trên trang GitHub của dự án, bấm **Code → Download ZIP**.
2. Chuột phải file ZIP → **Extract All…** (phải giải nén, không chạy trực tiếp
   trong file ZIP).
3. Nên giải nén ra chỗ có đường dẫn ngắn (Desktop hoặc `D:\`). Thư mục sau khi
   giải nén thường có đuôi `-main`. Bên trong có `README.md`, `Backend`,
   `Frontend`.

> Cách khác: nếu đã cài Git, dùng `git clone <link-repo>` thay cho bước tải ZIP.

### Bước 3: Cài thư viện cho backend
1. Mở thư mục **`Backend`**.
2. Chuột phải vào khoảng trống → **Open in Terminal** (hoặc bấm thanh địa chỉ,
   gõ `cmd`, nhấn Enter).
3. Chạy:
```cmd
   npm install
```
   Xong khi thư mục `node_modules` xuất hiện.

### Bước 4: Tạo file cấu hình `.env`
| Hệ điều hành | Lệnh |
|---|---|
| Windows (cmd / PowerShell) | `copy .env.example .env` |
| macOS / Linux | `cp .env.example .env` |

Mở `.env` bằng Notepad và đặt:

```
DEVICE_API_KEY=mot-chuoi-bi-mat-cua-ban
PORT=3000
```

`DEVICE_API_KEY` tự chọn, không được để trống hoặc dùng giá trị mặc định của file
mẫu.

### Bước 5: Chạy server
```cmd
npm start
```
Nếu báo không có script `start`, dùng `node server.js`.

Thành công khi thấy `Weather backend đang chạy tại http://localhost:3000`.
**Giữ nguyên cửa sổ này.**

### Bước 6: Mở dashboard
Mở trình duyệt (tab thường) và vào **`http://localhost:3000`**. Lúc này dashboard
ở trạng thái chờ vì chưa có dữ liệu.

### Bước 7: Gửi dữ liệu
Nếu **chưa có ESP8266**, mở **cửa sổ terminal thứ hai** trong thư mục `Backend`
và chạy:
```cmd
node simulate.js
```
Mỗi 10 giây in một dòng dạng `201 {"temp":30.4,...}` (mã `201` là thành công).
Nếu đã có ESP8266, xem mục 8.

### Bước 8: Quan sát kết quả
Quay lại dashboard (không cần F5):
- Số liệu và biểu đồ cập nhật mỗi khoảng 10 giây, trạng thái "Đã kết nối" (xanh).
- Sau khoảng **3 phút 20 giây**, một nhiệt độ bất thường (85 °C) được chèn vào và
  cảnh báo xuất hiện trong danh sách "Cảnh báo bất thường"; cảnh báo này nằm lại.
- Dừng `simulate.js` (Ctrl+C), sau hơn 30 giây dashboard chuyển "Mất kết nối".

### Bước 9: Xem trên điện thoại (tùy chọn)
1. Điện thoại và máy tính nối **cùng Wi-Fi**.
2. Trên máy tính chạy `ipconfig`, lấy dòng **IPv4 Address** (dạng `192.168.x.x`).
3. Trên điện thoại mở `http://<IPv4>:3000`.
4. Nếu không vào được: cho phép **Node.js** qua Windows Firewall (mạng Private),
   hoặc dùng điểm phát Wi-Fi từ điện thoại cho cả hai thiết bị.

### Bước 10: Dừng và chạy lại lần sau
- Dừng: **Ctrl+C** trong từng cửa sổ terminal.
- Lần sau chỉ cần làm lại Bước 5, 6, 7 (không cần cài lại).
- Xóa sạch dữ liệu cũ: dừng server, xóa ba file `weather.db`, `weather.db-wal`,
  `weather.db-shm` trong `Backend`, rồi chạy lại server.

## 6. Backend

Backend nhận dữ liệu từ ESP8266, lưu vào SQLite (file `weather.db` tự tạo), phát
hiện bất thường, cung cấp API cho dashboard và phục vụ thư mục `Frontend`.

> Mỗi lần sửa `server.js` hoặc `.env` phải dừng server (Ctrl+C) rồi chạy lại.

### 6.1. Cấu hình `.env`

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DEVICE_API_KEY` | `demo-key-change-me` | "Mật khẩu" cho thiết bị gửi dữ liệu. Phải **giống hệt** `DEVICE_API_KEY` trong `secrets.h` của ESP8266. `simulate.js` tự đọc giá trị này từ `.env` |
| `PORT` | `3000` | Cổng chạy server |

### 6.2. API ghi dữ liệu (ESP8266 gửi lên)

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

### 6.3. API đọc dữ liệu (dashboard dùng)

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

**`GET /api/sensors/history?range=1h|6h|24h|7d`**: lịch sử, cũ đến mới, `range`
mặc định `1h`.

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

**`GET /api/alerts?limit=20`**: cảnh báo bất thường, mới nhất trước (`limit` mặc
định 20, tối đa 100). Cảnh báo được **lưu vĩnh viễn**.

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

**`GET /api/health`**: kiểm tra server còn sống, trả về `{"ok":true,...}`.

### 6.4. Cơ sở dữ liệu

SQLite, file `Backend/weather.db` (kèm `weather.db-wal`, `weather.db-shm`):

| Bảng | Nội dung |
|---|---|
| `readings` | Mỗi lần đo: `temp`, `hum`, `light`, `rain`, `device_id`, `rssi`, `created_at` (UTC) |
| `alerts` | Mỗi cảnh báo: `sensor`, `value`, `expected`, `reason`, `severity`, `created_at` (UTC) |

## 7. Frontend (Dashboard)

Dashboard một trang, gồm `Frontend/index.html` (HTML + CSS + JavaScript thuần,
biểu đồ dùng Chart.js qua CDN). Không cần build.

### 7.1. Cách mở

**Khuyến nghị:** chạy backend rồi mở `http://localhost:3000`. Xem trên điện
thoại: cùng Wi-Fi, mở `http://<IPv4-máy-chạy-backend>:3000`.

**Cách khác:** mở trực tiếp `index.html` (`file:///...`). Khi đó dashboard tự gọi
`http://localhost:3000`, chỉ hoạt động trên chính máy chạy backend. Nên dùng tab
trình duyệt thường, không dùng chế độ giả lập thiết bị của DevTools (sẽ có cảnh
báo `Unsafe attempt to load URL`, không ảnh hưởng chức năng).

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
- **Biểu đồ lịch sử:** chọn chỉ số, chọn khoảng thời gian, bật so sánh với chỉ số
  khác (hai trục Y).
- **Cảnh báo bất thường:** danh sách lấy từ backend, kèm thời gian, cảm biến, giá
  trị, giá trị kỳ vọng, mức độ. Badge thẻ báo "Bất thường" nếu cảm biến đó có
  cảnh báo trong 60 giây gần nhất; banner chỉ hiện với cảnh báo dưới 20 giây.
- **Nút "Làm mới dữ liệu":** tải lại ngay, không chờ chu kỳ 10 giây.

Mỗi chu kỳ dashboard gọi `GET /api/sensors/latest`, `GET /api/sensors/history`
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

Lưu ý: ESP8266 chỉ có **một chân analog (A0)**. Nếu cả LDR và cảm biến mưa đều là
tín hiệu analog thì không đọc đồng thời được trên một chân; thường dùng A0 cho
LDR và chân số (DO) của cảm biến mưa để lấy giá trị 0/1.

### 8.3. Cấu hình Wi-Fi và API key (`secrets.h`)

Thông tin bí mật nằm trong file riêng `secrets.h`, không đưa lên GitHub.

1. Trong thư mục `Backend/esp8266_weather_station/`, sao chép
   `secrets.h.example` thành `secrets.h`:
   | Hệ điều hành | Lệnh |
   |---|---|
   | Windows | `copy secrets.h.example secrets.h` |
   | macOS / Linux | `cp secrets.h.example secrets.h` |
2. Mở `secrets.h` và điền giá trị thật:
```cpp
   #define WIFI_SSID      "TEN_WIFI"
   #define WIFI_PASSWORD  "MAT_KHAU_WIFI"
   #define SERVER_URL     "http://192.168.x.x:3000/api/sensors"
   #define DEVICE_API_KEY "GIA_TRI_DEVICE_API_KEY"
```

Yêu cầu bắt buộc:
- `SERVER_URL` dùng **IPv4 của máy chạy backend** (xem bằng `ipconfig`), không
  dùng `localhost`.
- ESP8266 và máy chạy backend **cùng mạng Wi-Fi**, băng tần **2.4 GHz**.
- Dùng `http://` khi chạy trong mạng LAN.
- `DEVICE_API_KEY` phải giống `DEVICE_API_KEY` trong `.env`.
- Nếu Windows Firewall chặn, cho phép **Node.js** qua firewall (mạng Private).
- IP của máy có thể đổi sau khi khởi động lại máy hoặc router; nếu thiết bị đột
  nhiên không gửi được, kiểm tra lại IP.

### 8.4. Nạp code

1. Cài **Arduino IDE** và hỗ trợ board ESP8266.
2. Mở `esp8266_weather_station.ino` (file `secrets.h` phải nằm cùng thư mục).
3. **Tools → Board:** NodeMCU 1.0 (ESP-12E Module).
4. Cắm ESP8266 bằng cáp USB, **Tools → Port:** chọn cổng COM (nếu không thấy, cài
   driver CH340 hoặc CP2102 tùy chip).
5. Nếu báo thiếu thư viện (cho DHT22, JSON...), cài trong **Sketch → Include
   Library → Manage Libraries** theo các dòng `#include` của file `.ino`.
6. Bấm **Upload**, rồi mở **Serial Monitor** ở **115200 baud**.

Mã phản hồi trên Serial Monitor: **201** thành công, **401** sai API key, **-1**
không kết nối được server. Khi thành công, dashboard cập nhật số liệu và badge
"Đã kết nối".

## 9. Chạy thử khi chưa có phần cứng

`Backend/simulate.js` đóng vai ESP8266: cứ 10 giây gửi một bản ghi, và cứ 20 lần
gửi (khoảng 3 phút 20 giây) chèn một nhiệt độ bất thường (85 °C) để thử cảnh
báo. Script tự đọc `DEVICE_API_KEY` từ file `.env`.

1. Terminal 1 (thư mục `Backend`): `npm start`.
2. Terminal 2 (thư mục `Backend`): `node simulate.js`.
3. Mở `http://localhost:3000` và quan sát.

Dừng giả lập bằng **Ctrl+C**.

> Khi viết báo cáo, ghi rõ dữ liệu là **mô phỏng** nếu chưa dùng cảm biến thật.

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

### Khi cài đặt và chạy server

| Triệu chứng | Cách xử lý |
|---|---|
| `node` hoặc `npm` "not recognized" | Cài Node.js, đóng và mở lại terminal |
| PowerShell báo `npm.ps1 cannot be loaded` (execution policy) | Dùng **Command Prompt (cmd)** thay cho PowerShell |
| `npm install` báo lỗi build (`better-sqlite3`, `node-gyp`) | Dùng Node.js bản **LTS**; nếu vẫn lỗi, gỡ bản Node quá mới và cài lại bản LTS |
| `Cannot find module ...` | Chưa chạy `npm install`, hoặc đang đứng nhầm thư mục (phải là `Backend`) |
| `EADDRINUSE: address already in use` | Cổng 3000 đang bị chiếm: đóng server cũ hoặc đổi `PORT` trong `.env` |
| `SqliteError: no such table` | Code tạo bảng đặt sai thứ tự: bảng `readings` phải được tạo trước các câu lệnh dùng nó |

### Khi gửi dữ liệu

| Triệu chứng | Cách xử lý |
|---|---|
| `fetch failed` / `Failed to connect` | Server chưa chạy: làm lại Bước 5 |
| Mã `401` | API key không khớp: so lại `.env`, `secrets.h`; sửa `.env` xong phải khởi động lại server |
| Mã `400` | Thiếu trường hoặc sai kiểu: xem bảng ở mục 6.2 |
| Mã `-1` trên Serial Monitor | ESP8266 không tới được server: kiểm tra IP, cùng Wi-Fi, firewall |
| Không thấy cổng COM khi nạp code | Cài driver CH340/CP2102, thử cáp khác (cáp chỉ sạc không dùng được) |

### Trên dashboard

| Triệu chứng | Cách xử lý |
|---|---|
| Trang `localhost:3000` không hiện | Kiểm tra server đang chạy; dùng tab trình duyệt thường |
| "Lỗi kết nối server" | Backend chưa chạy hoặc sai `API_BASE`; mở F12 → Console xem lỗi |
| Thẻ hiện `--`, trạng thái "Đang chờ" | Chưa có dữ liệu: chạy `simulate.js` hoặc bật ESP8266 |
| "Mất kết nối" dù đã gửi dữ liệu | Dữ liệu cũ hơn 30 giây: kiểm tra thiết bị hoặc `simulate.js` còn chạy không |
| Danh sách cảnh báo luôn rỗng | Chưa có số đo bất thường, hoặc chưa khởi động lại server sau khi sửa code; gửi thử `temp` = 85 |
| Biểu đồ trống | Chưa có dữ liệu trong khoảng đã chọn: chọn khoảng dài hơn hoặc gửi thêm dữ liệu |
| Điện thoại không vào được `http://IP:3000` | Cho phép Node.js qua firewall, hoặc dùng điểm phát Wi-Fi từ điện thoại (một số Wi-Fi chặn thiết bị giao tiếp với nhau) |

## 12. Triển khai lên cloud (tùy chọn)

Có thể deploy lên dịch vụ như Render để demo từ xa mà không cần cùng Wi-Fi:

1. Đẩy dự án lên GitHub (theo mục 13, không kèm bí mật).
2. Tạo Web Service, kết nối repo; thư mục gốc của dịch vụ là `Backend`.
3. Build command: `npm install`. Start command: `npm start`.
4. Thêm biến môi trường `DEVICE_API_KEY` trong phần Environment.
5. Dùng domain được cấp thay cho `localhost:3000` ở `SERVER_URL` của ESP8266
   (dashboard tự dùng cùng domain).

Lưu ý:
- Ổ đĩa gói miễn phí thường **không lưu lâu dài**: file SQLite có thể bị xóa khi
  dịch vụ khởi động lại hoặc deploy lại. Muốn giữ dữ liệu cần gắn ổ đĩa bền vững
  hoặc dùng database bên ngoài.
- Gói miễn phí có thể tạm ngủ khi không có truy cập, khiến dashboard báo mất kết
  nối trong lúc dịch vụ thức dậy.
- Domain cloud dùng **HTTPS**; ESP8266 cần `WiFiClientSecure` (ví dụ
  `setInsecure()` khi demo) thay cho `WiFiClient`.
- Tính năng và giới hạn của gói miễn phí có thể thay đổi, hãy xem tài liệu của
  nhà cung cấp.

## 13. Bảo mật và đưa dự án lên GitHub

**File bí mật không được commit.** `.gitignore` của dự án phải có:

```
.env
node_modules/
weather.db
weather.db-wal
weather.db-shm
secrets.h
```

Chỉ commit các file mẫu (`.env.example`, `secrets.h.example`) chứa **giá trị
giả**.

**Kiểm tra trước khi commit** (chạy ở thư mục gốc dự án):

```cmd
git status
git check-ignore -v Backend/.env Backend/esp8266_weather_station/secrets.h
git grep -n "<API-key-thật>"
git grep -n "<mật-khẩu-Wi-Fi-thật>"
```

- `git status` không được liệt kê `.env`, `secrets.h`, `weather.db*`,
  `node_modules`.
- `git check-ignore -v` phải in ra một dòng cho mỗi file (nghĩa là file đang bị
  chặn).
- Hai lệnh `git grep` (thay bằng giá trị thật của bạn) không được in ra gì.

**Nếu lỡ commit bí mật:** xóa file đi không đủ vì nó còn trong lịch sử. Hãy đổi
ngay API key và mật khẩu Wi-Fi, rồi gỡ file khỏi git
(`git rm --cached <file>`) hoặc tạo lại repo mới nếu chưa ai dùng.

**Khuyến nghị khác:**
- Đặt `DEVICE_API_KEY` dài và khó đoán; mỗi lần đổi phải khởi động lại server và
  nạp lại code ESP8266.
- Các endpoint đọc (`/api/sensors/*`, `/api/alerts`) **không yêu cầu xác thực**:
  phù hợp demo trong mạng nội bộ, nhưng nên thêm xác thực nếu mở công khai.

## 14. Hạn chế đã biết và hướng phát triển

**Hạn chế:**
- Phát hiện bất thường dựa trên **thống kê**, chưa phải học máy; chưa kiểm tra
  cảm biến mưa.
- Nếu giá trị bất thường kéo dài, mỗi bản ghi sinh thêm một cảnh báo (chưa gộp
  hoặc giới hạn tần suất).
- Số đo bất thường vẫn nằm trong 30 bản ghi dùng làm mốc so sánh, có thể làm tăng
  độ lệch chuẩn và giảm độ nhạy ngay sau đó.
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