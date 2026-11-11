#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <DHT.h>
#include "secrets.h"

#define DHTPIN D4
#define DHTTYPE DHT11
#define CDS_PIN A0
#define LED_OK D8
#define LED_ALARM 3  // RX
#define BUZZER_PIN D5
#define NGUONG_TOI 350

DHT dht(DHTPIN, DHTTYPE);

const unsigned long SEND_INTERVAL_MS = 10000;
unsigned long lastSend = 0;
unsigned long lastBeep = 0;
bool beepOn = false;
bool gAlarm = false;

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Dang noi WiFi");
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500); Serial.print(".");
  }
  Serial.println();
}

int docCDS() {
  long sum = 0;
  for (int i = 0; i < 10; i++) { sum += analogRead(CDS_PIN); delay(5); }
  return sum / 10;
}

// ---------- HTTPS ổn định: hỗ trợ SERVER_URL dạng "@link-github-raw" ----------
// Nếu SERVER_URL bắt đầu bằng '@', ESP tự tải link thật từ file tunnel-url.txt
// trên GitHub Raw (do start-tunnel.ps1 tự ghi + bạn push lên). Làm mới mỗi 5 phút
// nên tunnel đổi URL cũng không cần nạp lại firmware.
String gResolvedUrl = "";
unsigned long gLastResolve = 0;
const unsigned long RESOLVE_INTERVAL_MS = 5UL * 60UL * 1000UL;

String taiLinkThat(const String &src) {
  bool srcHttps = src.startsWith("https://");
  HTTPClient http;
  int code = -1;
  String body = "";
  if (srcHttps) {
    BearSSL::WiFiClientSecure c;
    c.setInsecure(); // GitHub Raw + trycloudflare đều có cert hợp lệ, demo chấp nhận bỏ qua verify
    c.setTimeout(10000);
    http.begin(c, src);
    code = http.GET();
    if (code == 200) body = http.getString();
    http.end();
  } else {
    WiFiClient c;
    http.begin(c, src);
    code = http.GET();
    if (code == 200) body = http.getString();
    http.end();
  }
  body.trim();
  int nl = body.indexOf('\n');
  if (nl > 0) body = body.substring(0, nl);
  body.trim();
  if (code == 200 && (body.startsWith("http://") || body.startsWith("https://"))) return body;
  return "";
}

String layUrlHieuLuc() {
  String s = String(SERVER_URL);
  s.trim();
  if (!s.startsWith("@")) return s;
  if (gResolvedUrl.length() > 0 && (millis() - gLastResolve) < RESOLVE_INTERVAL_MS) return gResolvedUrl;
  String src = s.substring(1);
  src.trim();
  String that = taiLinkThat(src);
  if (that.length() > 0) {
    gResolvedUrl = that;
    gLastResolve = millis();
    Serial.printf("Lay link tunnel moi: %s\n", gResolvedUrl.c_str());
    return gResolvedUrl;
  }
  if (gResolvedUrl.length() > 0) return gResolvedUrl; // giữ link cũ khi GitHub lỗi
  return "";
}

bool guiDuLieu(const String &url, const String &payload) {
  bool isHttps = url.startsWith("https://");
  HTTPClient http;
  http.setTimeout(12000);
  int code = -1;
  String traLoi = "";
  if (isHttps) {
    BearSSL::WiFiClientSecure client;
#ifdef CA_CERT
    // Production: verify cert bằng CA. CA_CERT định nghĩa trong secrets.h
    BearSSL::X509List cert(CA_CERT);
    client.setTrustAnchors(&cert);
#else
    client.setInsecure(); // Demo: bỏ qua verify (chỉ dùng cho đồ án, chấp nhận MITM)
#endif
    client.setTimeout(12000);
    http.begin(client, url);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-api-key", DEVICE_API_KEY);
    code = http.POST(payload);
    traLoi = http.getString();
    http.end();
  } else {
    WiFiClient client;
    http.begin(client, url);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-api-key", DEVICE_API_KEY);
    code = http.POST(payload);
    traLoi = http.getString();
    http.end();
  }
  Serial.printf("POST %d %s\n", code, payload.c_str());
  Serial.println(traLoi);
  return (code == 201);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_OK, OUTPUT);
  pinMode(LED_ALARM, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  dht.begin();
  connectWiFi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { connectWiFi(); delay(1000); return; }

  if (gAlarm) {
    if (millis() - lastBeep > (beepOn ? 200 : 800)) {
      beepOn = !beepOn;
      lastBeep = millis();
      digitalWrite(BUZZER_PIN, beepOn ? HIGH : LOW);
    }
  } else {
    beepOn = false;
    digitalWrite(BUZZER_PIN, LOW);
  }

  if (millis() - lastSend < SEND_INTERVAL_MS) return;
  lastSend = millis();

  float hum = dht.readHumidity();
  float temp = dht.readTemperature();
  if (isnan(hum) || isnan(temp)) {
    Serial.println("DHT11 loi, bo qua lan nay");
    return;
  }
  int cdsRaw = docCDS();
  bool troiToi = cdsRaw < NGUONG_TOI;
  int light = map(cdsRaw, 0, 1023, 0, 1200);
  light = constrain(light, 0, 1200);

  gAlarm = (temp > 35.0) || troiToi;
  digitalWrite(LED_ALARM, gAlarm ? HIGH : LOW);

  String urlGui = layUrlHieuLuc();
  if (urlGui.length() == 0) {
    Serial.println("Chua lay duoc link tunnel, doi 5s thu lai");
    delay(5000);
    return;
  }

  String payload = "{\"temp\":" + String(temp, 1) +
    ",\"hum\":" + String(hum, 0) +
    ",\"light\":" + String(light) +
    ",\"device_id\":\"" + String(DEVICE_ID) +
    "\",\"rssi\":" + String(WiFi.RSSI()) + "}";

  Serial.printf("CDS=%d light=%d\n", cdsRaw, light);
  if (guiDuLieu(urlGui, payload)) {
    digitalWrite(LED_OK, HIGH); delay(150);
    digitalWrite(LED_OK, LOW);
  }
}