/*
  Field Monitor — sensor + GPS node firmware (ESP32)
  ----------------------------------------------------
  Reads CO2, CO, SO2, and smoke sensors plus a GPS module, then POSTs a JSON
  reading to the backend's /api/ingest endpoint on an interval. Runs
  independently of the ESP32-CAM, which keeps using its own stock camera
  server firmware — the backend proxies that separately.

  ASSUMED HARDWARE (swap the read functions below if yours differs):
    CO2   -> MH-Z19B NDIR sensor over UART   (real ppm, no calibration curve needed)
    CO    -> MQ-7 analog sensor              (needs a calibration curve — see notes)
    SO2   -> MQ-136 analog sensor             (needs a calibration curve — see notes)
    Smoke -> MQ-2 analog sensor, read as %FS  (needs a calibration curve — see notes)
    GPS   -> NEO-6M / NEO-M8N over UART, parsed with TinyGPS++

  LIBRARIES (install via Arduino Library Manager):
    - TinyGPSPlus          by Mikal Hart
    - MHZ19                by Jonathan Dempsey  (for the MH-Z19B CO2 sensor)
    - ArduinoJson           (optional, not required for this simple payload)

  This is a reference wiring, not a match to your exact prototype — tell me
  your real sensor part numbers / pins and I'll adjust the read functions
  and calibration curves to match.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <HardwareSerial.h>
#include <TinyGPSPlus.h>
#include <MHZ19.h>

// ---------------- network / backend ----------------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* BACKEND_URL   = "http://192.168.4.10:8080/api/ingest"; // your backend's LAN IP
const char* DEVICE_ID     = "node-1";
const char* DEVICE_KEY    = "change-me"; // must match ingestKey in the backend's config.json

const unsigned long SEND_INTERVAL_MS = 3000;

// ---------------- pins ----------------
// GPS on UART1
#define GPS_RX_PIN 16   // ESP32 RX  <- GPS TX
#define GPS_TX_PIN 17   // ESP32 TX  -> GPS RX
HardwareSerial gpsSerial(1);
TinyGPSPlus gps;

// MH-Z19B CO2 sensor on UART2
#define CO2_RX_PIN 25
#define CO2_TX_PIN 26
HardwareSerial co2Serial(2);
MHZ19 mhz19;

// Analog gas sensors
#define CO_PIN    34   // MQ-7
#define SO2_PIN   35   // MQ-136
#define SMOKE_PIN 32   // MQ-2

// ---------------- calibration ----------------
// Analog sensors output a raw ADC value (0-4095 on ESP32's 12-bit ADC) that
// depends on the specific sensor, its burn-in time, humidity, and your
// circuit's load resistor. These are placeholder linear maps — replace the
// two constants per sensor with a real curve from a calibration gas or a
// reference instrument before trusting the numbers operationally.
float adcToPpm_CO(int raw)   { return raw * (100.0  / 4095.0); }  // 0-100 ppm placeholder
float adcToPpm_SO2(int raw)  { return raw * (10.0   / 4095.0); }  // 0-10 ppm placeholder
float adcToPct_Smoke(int raw){ return raw * (100.0  / 4095.0); }  // 0-100% placeholder

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected, IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi connect failed — will keep retrying in the loop.");
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);

  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  co2Serial.begin(9600, SERIAL_8N1, CO2_RX_PIN, CO2_TX_PIN);
  mhz19.begin(co2Serial);
  mhz19.autoCalibration(false); // disable auto-baseline calibration for field use

  analogReadResolution(12);

  connectWiFi();
}

unsigned long lastSend = 0;

void loop() {
  // Feed the GPS parser continuously so it doesn't fall behind.
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }

  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  if (millis() - lastSend >= SEND_INTERVAL_MS) {
    lastSend = millis();
    sendReading();
  }
}

void sendReading() {
  int co2ppm = mhz19.getCO2();                 // real ppm from the NDIR sensor
  float coppm   = adcToPpm_CO(analogRead(CO_PIN));
  float so2ppm  = adcToPpm_SO2(analogRead(SO2_PIN));
  float smokePct = adcToPct_Smoke(analogRead(SMOKE_PIN));

  bool fix = gps.location.isValid() && gps.location.age() < 5000;
  double lat = fix ? gps.location.lat() : 0.0;
  double lon = fix ? gps.location.lng() : 0.0;
  double alt = fix ? gps.altitude.meters() : 0.0;
  double hdop = gps.hdop.isValid() ? gps.hdop.hdop() : 99.0;
  float accuracyM = fix ? (float)(hdop * 5.0) : -1; // rough estimate, not a real accuracy figure

  String payload = "{";
  payload += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"co2_ppm\":" + String(co2ppm) + ",";
  payload += "\"co_ppm\":" + String(coppm, 1) + ",";
  payload += "\"so2_ppm\":" + String(so2ppm, 2) + ",";
  payload += "\"smoke_pct\":" + String(smokePct, 1) + ",";
  payload += "\"lat\":" + String(lat, 6) + ",";
  payload += "\"lon\":" + String(lon, 6) + ",";
  payload += "\"alt_m\":" + String(alt, 1) + ",";
  payload += "\"gps_fix\":" + String(fix ? "true" : "false") + ",";
  payload += "\"accuracy_m\":" + String(accuracyM, 1) + ",";
  payload += "\"battery_pct\":" + String(readBatteryPercent());
  payload += "}";

  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(BACKEND_URL);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Key", DEVICE_KEY);
    int code = http.POST(payload);
    Serial.print("POST /api/ingest -> ");
    Serial.println(code);
    if (code < 0) {
      Serial.println(http.errorToString(code));
    }
    http.end();
  } else {
    Serial.println("No WiFi — skipping send.");
  }
}

// Placeholder — wire this to your actual battery-monitoring circuit
// (e.g. a resistor divider into an ADC pin) if you have one.
int readBatteryPercent() {
  return -1; // -1 means "unknown"; the dashboard will just show a dash
}
