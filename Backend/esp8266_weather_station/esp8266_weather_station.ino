// esp8266_weather_station.ino
// Đọc DHT22 + LDR + cảm biến mưa, gửi lên backend mỗi 10 giây.
// Khớp đúng format API của backend (server.js): POST /api/sensors

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <DHT.h>

// ---------- Cấu hình chân ----------
#define DHTPIN D4
#define DHTTYPE DHT22
#define LDR_PIN A0      // ESP8266 chỉ có 1 chân analog (A0)
#define RAIN_PIN D5     // cảm biến mưa digital (module thông dụng: D0 ra digital HIGH/LOW)

DHT dht(DHTPIN, DHTTYPE);

// ---------- Cấu hình Wi-Fi & server ----------
const char* ssid        = "Xuan Thai";
const char* password    = "123456789";
const char* serverUrl   = "http://192.168.1.98:3000/api/sensors"; // đổi thành IP máy chạy backend
const char* deviceApiKey = "tonlien007"; // PHẢI khớp DEVICE_API_KEY trong .env
const char* deviceId     = "ESP8266-WX01";

const unsigned long SEND_INTERVAL_MS = 10000; // 10 giây/lần, chỉnh theo nhu cầu
unsigned long lastSend = 0;

void connectWiFi() {
  Serial.print("Đang kết nối Wi-Fi");
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nĐã kết nối. Địa chỉ IP: " + WiFi.localIP().toString());
}

void setup() {
  Serial.begin(115200);
  dht.begin();
  pinMode(RAIN_PIN, INPUT);
  connectWiFi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
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

  int lightRaw = analogRead(LDR_PIN);         // 0–1023
  int light = map(lightRaw, 0, 1023, 0, 1200); // quy đổi thô sang thang "lux" cho khớp UI
  int rain = digitalRead(RAIN_PIN) == LOW ? 1 : 0; // nhiều module rain: LOW = có nước, kiểm tra lại theo module thực tế
  int rssi = WiFi.RSSI();

  WiFiClient client;
  HTTPClient http;
  http.begin(client, serverUrl);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", deviceApiKey);

  String payload = "{";
  payload += "\"temp\":" + String(temp, 1) + ",";
  payload += "\"hum\":" + String(hum, 0) + ",";
  payload += "\"light\":" + String(light) + ",";
  payload += "\"rain\":" + String(rain) + ",";
  payload += "\"device_id\":\"" + String(deviceId) + "\",";
  payload += "\"rssi\":" + String(rssi);
  payload += "}";

  int httpCode = http.POST(payload);
  Serial.printf("Gửi dữ liệu -> HTTP %d: %s\n", httpCode, payload.c_str());

  if (httpCode != 201) {
    Serial.println("Phản hồi: " + http.getString());
  }

  http.end();
}
