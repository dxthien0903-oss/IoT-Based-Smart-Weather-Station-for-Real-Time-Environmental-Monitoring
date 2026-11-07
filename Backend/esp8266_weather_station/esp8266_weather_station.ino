// esp8266_weather_station.ino
// Đọc DHT22 + LDR + cảm biến mưa, gửi lên backend mỗi 10 giây.
// Khớp format API của backend (server.js): POST /api/sensors
// Bí mật Wi-Fi / API key nằm trong secrets.h (KHÔNG commit file đó).

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
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
unsigned long lastSend = 0;

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

  WiFiClient client;
  HTTPClient http;
  http.setTimeout(8000); // tránh treo khi server chậm
  http.begin(client, SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", DEVICE_API_KEY);

  String payload = "{";
  payload += "\"temp\":" + String(temp, 1) + ",";
  payload += "\"hum\":" + String(hum, 0) + ",";
  payload += "\"light\":" + String(light) + ",";
  payload += "\"rain\":" + String(rain) + ",";
  payload += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"rssi\":" + String(rssi);
  payload += "}";

  int httpCode = http.POST(payload);
  Serial.printf("Gửi dữ liệu -> HTTP %d: %s\n", httpCode, payload.c_str());

  if (httpCode != 201) {
    Serial.println("Phản hồi: " + http.getString());
  }

  http.end();
}
