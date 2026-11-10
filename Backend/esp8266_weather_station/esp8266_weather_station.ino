#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <LiquidCrystal.h>
#include <DHT.h>
#include "secrets.h"

#define DHTPIN D4
#define DHTTYPE DHT11
#define CDS_PIN A0
#define LED_OK D3
#define LED_ALARM 1  // chan TX tren board

#define NGUONG_TOI 300

// RS, E, D4, D5, D6, D7
LiquidCrystal lcd(D1, D2, D5, D6, D7, D0);
DHT dht(DHTPIN, DHTTYPE);

const unsigned long SEND_INTERVAL_MS = 10000;
const unsigned long LCD_INTERVAL_MS = 2000;
unsigned long lastSend = 0;
unsigned long lastLcd = 0;

float gTemp = NAN, gHum = NAN;
int gLight = 0;
bool gDark = false, gAlarm = false;

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lcd.clear(); lcd.setCursor(0, 0); lcd.print("Dang noi WiFi...");
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

void capNhatLCD() {
  lcd.clear();
  lcd.setCursor(0, 0);
  if (isnan(gTemp)) {
    lcd.print("Cho du lieu...");
    return;
  }
  lcd.print("T:");
  lcd.print(gTemp, 1);
  lcd.print("C H:");
  lcd.print(gHum, 0);
  lcd.print("%");
  lcd.setCursor(0, 1);
  lcd.print("L:");
  lcd.print(gLight);
  lcd.print(gDark ? " TOI" : " SANG");
  if (gAlarm) lcd.print(" *");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_OK, OUTPUT);
  pinMode(LED_ALARM, OUTPUT);
  dht.begin();
  lcd.begin(16, 2);
  lcd.print("Weather Station");
  lcd.setCursor(0, 1);
  lcd.print("Khoi dong...");
  connectWiFi();
  lcd.clear();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { connectWiFi(); delay(1000); return; }

  if (millis() - lastLcd >= LCD_INTERVAL_MS) {
    lastLcd = millis();
    capNhatLCD();
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

  gTemp = temp; gHum = hum;
  gLight = light; gDark = troiToi;
  gAlarm = (temp > 35.0) || troiToi;

  digitalWrite(LED_ALARM, gAlarm ? HIGH : LOW);
  capNhatLCD();

  WiFiClient client;
  HTTPClient http;
  http.begin(client, SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", DEVICE_API_KEY);

  String payload = "{\"temp\":" + String(temp, 1) +
    ",\"hum\":" + String(hum, 0) +
    ",\"light\":" + String(light) +
    ",\"rain\":0" +
    ",\"device_id\":\"" + String(DEVICE_ID) +
    "\",\"rssi\":" + String(WiFi.RSSI()) + "}";

  int code = http.POST(payload);
  Serial.printf("CDS=%d light=%d -> POST %d %s\n", cdsRaw, light, code, payload.c_str());
  Serial.println(http.getString());
  http.end();

  if (code == 201) {
    digitalWrite(LED_OK, HIGH); delay(150);
    digitalWrite(LED_OK, LOW);
  }
}