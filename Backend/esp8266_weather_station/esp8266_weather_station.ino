// esp8266_weather_station.ino
// Đọc DHT22 + LDR + cảm biến mưa, gửi lên backend mỗi 10 giây.
// Khớp format API của backend (server.js): POST /api/sensors
// Bí mật Wi-Fi / API key nằm trong secrets.h (KHÔNG commit file đó).
//
// Hỗ trợ HTTP (LAN) và HTTPS (cloud) — chọn theo SERVER_URL trong secrets.h.
//
// ---------------------------------------------------------------------------
// TỰ ĐỘNG LẤY SERVER_URL TỪ XA (không cần nạp lại firmware khi URL đổi)
// ---------------------------------------------------------------------------
// Nếu SERVER_URL trong secrets.h bắt đầu bằng "@", phần còn lại được hiểu là
// URL của một file TEXT chứa địa chỉ server hiện tại. Ví dụ:
//
//   #define SERVER_URL "@https://raw.githubusercontent.com/USER/REPO/main/tunnel-url.txt"
//
// Firmware sẽ tải file đó (mỗi REFRESH_URL_MINUTES phút), đọc dòng đầu tiên
// làm địa chỉ server. Nhờ vậy bạn có thể đổi link Cloudflare Tunnel
// (quick tunnel đổi URL mỗi lần restart) mà KHÔNG cần nạp lại firmware —
// chỉ cần cập nhật file tunnel-url.txt trên GitHub.
//
// Dùng cho demo đồ án: URL tĩnh trên GitHub + quick tunnel đổi ở server.
// ---------------------------------------------------------------------------

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <DHT.h>
#include "secrets.h" // WIFI_SSID, WIFI_PASSWORD, SERVER_URL, DEVICE_API_KEY, DEVICE_ID

// ---------- Cấu hình chân ----------
#define DHTPIN D4
#define DHTTYPE DHT22
#define LDR_PIN A0      // ESP8266 chỉ có 1 chân analog (A0)
#define RAIN_PIN D5     // cảm biến mưa digital (module thông dụng: DO ra HIGH/LOW)

DHT dht(DHTPIN, DHTTYPE);

const unsigned long SEND_INTERVAL_MS = 10000; // 10 giây/lần
const uint8_t WIFI_RETRY_MAX = 40;            // ~20 giây chờ Wi-Fi mỗi lần kết nối lại
const unsigned long REFRESH_URL_MINUTES = 5;   // 5 phút làm mới SERVER_URL từ xa
unsigned long lastSend = 0;
unsigned long lastUrlFetch = 0;

// Địa chỉ server đang dùng (có thể được cập nhật từ xa)
String currentServerUrl = "";
String cachedUrl = "";       // giá trị đọc được từ file từ xa
unsigned long cachedUrlAt = 0;

// Bật khi SERVER_URL bắt đầu bằng "@" -> lấy URL thật từ file từ xa
bool serverUrlIsRemote() {
  return strlen(SERVER_URL) > 1 && SERVER_URL[0] == '@';
}
String remoteUrlSource() {
  return String(SERVER_URL).substring(1);
}

// Bật khi URL bắt đầu bằng "https://"
bool urlIsHttps(const String &url) {
  return url.startsWith("https://");
}

// ---------- Tải SERVER_URL từ file từ xa ----------
// File chứa đúng 1 dòng: địa chỉ server (ví dụ https://abc.trycloudflare.com/api/sensors)
//
// Lưu ý: file được tạo bằng PowerShell/Windows có thể chứa BOM (UTF-8 BOM
// = 3 byte EF BB BF). Arduino String.trim() KHÔNG loại BOM, nên ta tự lọc thủ công.
String sanitizeRemoteUrl(String raw) {
  // Cắt BOM và mọi ký tự điều khiển ở đầu
  while (raw.length() > 0) {
    char c = raw[0];
    if ((unsigned char)c <= 0x20 || c == 0xEF || c == 0xBB || c == 0xBF) {
      raw.remove(0, 1);
    } else {
      break;
    }
  }
  // Lấy dòng đầu tiên
  int nl = raw.indexOf('\n');
  if (nl >= 0) raw = raw.substring(0, nl);
  // Bỏ khoảng trắng thừa ở hai đầu
  raw.trim();
  return raw;
}

bool isValidRemoteUrl(const String &u) {
  return u.startsWith("http://") || u.startsWith("https://");
}

void refreshServerUrlFromRemote() {
  String source = remoteUrlSource();
  if (source.length() == 0) return;

  Serial.print("[URL] Đang tải cấu hình từ: ");
  Serial.println(source);

  HTTPClient http;
  http.setTimeout(10000);
  http.addHeader("Cache-Control", "no-cache"); // yêu cầu CDN không cache file cũ

  WiFiClientSecure secureClient;
  bool https = urlIsHttps(source);

  if (https) {
    secureClient.setInsecure();
    http.begin(secureClient, source);
  } else {
    static WiFiClient plainClient;
    http.begin(plainClient, source);
  }

  int code = http.GET();
  if (code == 200) {
    String body = http.getString();
    http.end();
    String candidate = sanitizeRemoteUrl(body);
    if (isValidRemoteUrl(candidate)) {
      cachedUrl = candidate;
      cachedUrlAt = millis();
      Serial.println("[URL] Đã cập nhật: " + cachedUrl);
      return;
    }
    Serial.println("[URL] Nội dung file không phải URL hợp lệ, giữ link cũ.");
  } else {
    http.end();
    Serial.printf("[URL] Tải thất bại (HTTP %d)\n", code);
  }
}

// Chọn URL cần dùng: ưu tiên URL từ xa (nếu có), ngược lại dùng SERVER_URL cứng
String resolveServerUrl() {
  if (!serverUrlIsRemote()) {
    return String(SERVER_URL);
  }
  // Còn cache hợp lệ -> dùng luôn
  if (cachedUrl.length() > 0 &&
      (millis() - cachedUrlAt) < REFRESH_URL_MINUTES * 60UL * 1000UL) {
    return cachedUrl;
  }
  // Hết hạn -> thử tải lại; nếu thất bại thì dùng bản cache cũ (nếu có)
  refreshServerUrlFromRemote();
  if (cachedUrl.length() > 0) return cachedUrl;

  // Không tải được và không có cache -> bỏ qua lần gửi này.
  // KHÔNG dùng String(SERVER_URL).substring(1) làm fallback vì đó là URL của
  // FILE từ xa (bắt đầu bằng http tới file txt), không phải API endpoint.
  Serial.println("[URL] Chưa có link server hợp lệ, bỏ qua lần gửi này.");
  return String("");
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("Đang kết nối Wi-Fi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint8_t tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries++ < WIFI_RETRY_MAX) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nĐã kết nối. Địa chỉ IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\nKết nối Wi-Fi thất bại, sẽ thử lại ở vòng sau.");
  }
}

void setup() {
  Serial.begin(115200);
  delay(100);
  dht.begin();
  pinMode(RAIN_PIN, INPUT);
  connectWiFi();

  if (serverUrlIsRemote()) {
    Serial.println("Chế độ: SERVER_URL lấy động từ file từ xa");
    refreshServerUrlFromRemote();
  } else {
    Serial.println("Giao thức: " + (urlIsHttps(String(SERVER_URL)) ? "HTTPS" : "HTTP"));
  }
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
    delay(1000);
    return; // bỏ qua chu kỳ này nếu chưa có Wi-Fi
  }

  if (millis() - lastSend >= SEND_INTERVAL_MS) {
    lastSend = millis();
    sendReading();
  }
}

void sendReading() {
  float temp = dht.readTemperature();
  float hum  = dht.readHumidity();

  if (isnan(temp) || isnan(hum)) {
    Serial.println("Lỗi đọc DHT22, bỏ qua lần gửi này.");
    return;
  }
  // Lọc nhiễu DHT22: bỏ qua giá trị phi vật lý rõ ràng
  if (temp < -40 || temp > 80 || hum < 0 || hum > 100) {
    Serial.printf("Giá trị DHT22 bất thường (T=%.1f H=%.0f), bỏ qua.\n", temp, hum);
    return;
  }

  int lightRaw = analogRead(LDR_PIN);          // 0–1023
  int light = map(lightRaw, 0, 1023, 0, 1200); // quy đổi thô sang thang "lux" cho khớp UI
  light = constrain(light, 0, 1200);
  int rain = digitalRead(RAIN_PIN) == LOW ? 1 : 0; // nhiều module rain: LOW = có nước, kiểm tra lại theo module thực tế
  int rssi = WiFi.RSSI();

  currentServerUrl = resolveServerUrl();
  if (currentServerUrl.length() == 0) {
    return; // chưa có link server hợp lệ -> bỏ qua lần gửi này
  }

  HTTPClient http;
  http.setTimeout(10000); // TLS bắt tay cần lâu hơn HTTP thường
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", DEVICE_API_KEY);

  if (urlIsHttps(currentServerUrl)) {
    WiFiClientSecure secureClient;
    if (strlen(CA_CERT) > 0) {
      secureClient.setCACert(CA_CERT); // kiểm tra chứng thư — dùng cho production
    } else {
      secureClient.setInsecure(); // demo only: không kiểm tra chứng thư
      Serial.println("[TLS] Không có CA_CERT — dùng setInsecure() (KHÔNG an toàn cho production)");
    }
    http.begin(secureClient, currentServerUrl);
  } else {
    WiFiClient plainClient;
    http.begin(plainClient, currentServerUrl);
  }

  String payload = "{";
  payload += "\"temp\":" + String(temp, 1) + ",";
  payload += "\"hum\":" + String(hum, 0) + ",";
  payload += "\"light\":" + String(light) + ",";
  payload += "\"rain\":" + String(rain) + ",";
  payload += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"rssi\":" + String(rssi);
  payload += "}";

  int httpCode = http.POST(payload);
  Serial.printf("Gửi dữ liệu -> HTTP %d (%s): %s\n", httpCode,
                 currentServerUrl.c_str(), payload.c_str());

  if (httpCode != 201) {
    Serial.println("Phản hồi: " + http.getString());
  } else {
    http.getString(); // đọc nốt body để giải phóng kết nối
  }

  http.end();
}
