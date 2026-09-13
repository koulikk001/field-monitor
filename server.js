"use strict";
/**
 * Field Monitor backend.
 *
 * Responsibilities:
 *  - Accepts sensor readings pushed from the ESP32 sensor/GPS node (POST /api/ingest)
 *  - Keeps the latest reading + a rolling history per device, in memory
 *  - Appends every reading and every hazard-state change to append-only log files on disk
 *  - Proxies the ESP32-CAM's MJPEG stream / snapshot so the browser only ever talks to
 *    this backend (fixes CORS and the https-page-fetching-http-device "mixed content" block)
 *  - Pushes live updates to connected dashboards over WebSocket
 *  - Serves the dashboard itself as a static site (public/)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const express = require("express");
const { WebSocketServer } = require("ws");

// ---------------------------------------------------------------------------
// config — config.json overrides these defaults; a few fields can also come
// from environment variables (handy for containers / systemd units).
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  port: 8080,
  cameraStreamUrl: "",
  cameraSnapshotUrl: "",
  ingestKey: "",
  historyMaxPoints: 2400,
  thresholds: {
    co2:   { unit: "ppm", safe: 1000, caution: 5000, max: 8000 },
    co:    { unit: "ppm", safe: 9,    caution: 35,   max: 100 },
    so2:   { unit: "ppm", safe: 2,    caution: 5,    max: 10 },
    smoke: { unit: "%",   safe: 20,   caution: 50,   max: 100 }
  }
};

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      console.error("[config] could not parse config.json, ignoring it:", err.message);
    }
  } else {
    console.warn("[config] no config.json found — using defaults. Copy config.example.json to config.json to customize.");
  }

  const envOverrides = {
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    cameraStreamUrl: process.env.CAMERA_STREAM_URL,
    cameraSnapshotUrl: process.env.CAMERA_SNAPSHOT_URL,
    ingestKey: process.env.INGEST_KEY
  };
  Object.keys(envOverrides).forEach((k) => envOverrides[k] === undefined && delete envOverrides[k]);

  return Object.assign({}, DEFAULT_CONFIG, fileConfig, envOverrides, {
    thresholds: Object.assign({}, DEFAULT_CONFIG.thresholds, fileConfig.thresholds || {})
  });
}

const CONFIG = loadConfig();

// ---------------------------------------------------------------------------
// storage — in-memory latest state + rolling history, plus permanent
// append-only logs on disk for after-action review.
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const READINGS_LOG = path.join(DATA_DIR, "readings-log.ndjson");
const ALERTS_LOG = path.join(DATA_DIR, "alerts-log.ndjson");

/** device_id -> { latest, history: [], lastSeen, lastStatus } */
const devices = new Map();

function classify(sensorId, value) {
  const t = CONFIG.thresholds[sensorId];
  if (!t || !Number.isFinite(value)) return "safe";
  if (value >= t.caution) return "danger";
  if (value >= t.safe) return "caution";
  return "safe";
}

function worstStatus(reading) {
  const rank = { safe: 0, caution: 1, danger: 2 };
  const fields = { co2: "co2_ppm", co: "co_ppm", so2: "so2_ppm", smoke: "smoke_pct" };
  let worst = "safe";
  Object.keys(fields).forEach((sensorId) => {
    const v = Number(reading[fields[sensorId]]);
    const cls = classify(sensorId, v);
    if (rank[cls] > rank[worst]) worst = cls;
  });
  return worst;
}

function recordReading(deviceId, reading) {
  const now = Date.now();
  const entry = Object.assign({}, reading, { device_id: deviceId, received_at: now });

  if (!devices.has(deviceId)) {
    devices.set(deviceId, { latest: null, history: [], lastSeen: 0, lastStatus: "safe" });
  }
  const d = devices.get(deviceId);
  d.latest = entry;
  d.lastSeen = now;
  d.history.push(entry);
  if (d.history.length > CONFIG.historyMaxPoints) d.history.shift();

  fs.appendFile(READINGS_LOG, JSON.stringify(entry) + "\n", (err) => {
    if (err) console.error("[log] failed to write readings log:", err.message);
  });

  const status = worstStatus(entry);
  if (status !== d.lastStatus) {
    fs.appendFile(
      ALERTS_LOG,
      JSON.stringify({ device_id: deviceId, status, at: now, reading: entry }) + "\n",
      (err) => { if (err) console.error("[log] failed to write alerts log:", err.message); }
    );
  }
  d.lastStatus = status;

  broadcast({ type: "reading", device_id: deviceId, data: entry, status });
  return { entry, status };
}

// ---------------------------------------------------------------------------
// express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "256kb" }));

// Permissive CORS: the dashboard can be hosted anywhere and still reach this
// backend. Tighten this (set a fixed origin) before exposing the backend
// publicly on the open internet.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Device-Key");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// Thresholds live here, not in the browser, so every dashboard tab shows the
// same hazard classification.
app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    thresholds: CONFIG.thresholds,
    cameraConfigured: Boolean(CONFIG.cameraStreamUrl || CONFIG.cameraSnapshotUrl),
    devices: Array.from(devices.keys())
  });
});

// The ESP32 sensor/GPS node POSTs its readings here every few seconds.
app.post("/api/ingest", (req, res) => {
  if (CONFIG.ingestKey) {
    if (req.get("X-Device-Key") !== CONFIG.ingestKey) {
      return res.status(401).json({ ok: false, error: "invalid or missing X-Device-Key header" });
    }
  }

  const body = req.body || {};
  const deviceId = String(body.device_id || "default");
  const required = ["co2_ppm", "co_ppm", "so2_ppm", "smoke_pct"];
  const missing = required.filter((k) => body[k] === undefined);
  if (missing.length) {
    return res.status(400).json({ ok: false, error: "missing fields: " + missing.join(", ") });
  }

  const { status } = recordReading(deviceId, body);
  res.json({ ok: true, status });
});

app.get("/api/latest", (req, res) => {
  const deviceId = String(req.query.device || "default");
  const d = devices.get(deviceId);
  if (!d || !d.latest) {
    return res.status(404).json({ ok: false, error: "no data yet for device '" + deviceId + "'" });
  }
  res.json({ ok: true, data: d.latest, status: d.lastStatus, lastSeen: d.lastSeen });
});

app.get("/api/history", (req, res) => {
  const deviceId = String(req.query.device || "default");
  const minutes = Number(req.query.minutes) || 60;
  const d = devices.get(deviceId);
  if (!d) return res.json({ ok: true, data: [] });
  const cutoff = Date.now() - minutes * 60000;
  res.json({ ok: true, data: d.history.filter((e) => e.received_at >= cutoff) });
});

app.get("/api/devices", (req, res) => {
  const list = Array.from(devices.entries()).map(([id, d]) => ({
    device_id: id,
    lastSeen: d.lastSeen,
    status: d.lastStatus
  }));
  res.json({ ok: true, devices: list });
});

// Streams/snapshots are proxied server-to-device, never browser-to-device —
// this is what makes it safe to view the dashboard over https from anywhere
// while the camera itself only ever speaks plain http on the local network.
function proxyMedia(targetUrl, req, res) {
  if (!targetUrl) return res.status(503).send("camera not configured on this backend (set cameraStreamUrl in config.json)");
  const client = targetUrl.startsWith("https") ? https : http;
  const upstream = client.get(targetUrl, (upRes) => {
    res.writeHead(upRes.statusCode || 200, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on("error", (err) => {
    if (!res.headersSent) res.status(502).send("camera unreachable: " + err.message);
  });
  req.on("close", () => upstream.destroy());
}
app.get("/api/camera/stream", (req, res) => proxyMedia(CONFIG.cameraStreamUrl, req, res));
app.get("/api/camera/snapshot", (req, res) =>
  proxyMedia(CONFIG.cameraSnapshotUrl || CONFIG.cameraStreamUrl, req, res)
);

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// websocket — pushes every new reading to every connected dashboard the
// instant it arrives, so responders don't need to poll.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(raw);
  });
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "hello", thresholds: CONFIG.thresholds }));
  devices.forEach((d, id) => {
    if (d.latest) ws.send(JSON.stringify({ type: "reading", device_id: id, data: d.latest, status: d.lastStatus }));
  });
});

server.listen(CONFIG.port, () => {
  console.log("Field Monitor backend listening on port " + CONFIG.port);
  console.log("  Dashboard:      http://localhost:" + CONFIG.port);
  console.log("  Ingest sensors: POST http://localhost:" + CONFIG.port + "/api/ingest");
  console.log(
    CONFIG.cameraStreamUrl
      ? "  Camera proxy:   http://localhost:" + CONFIG.port + "/api/camera/stream -> " + CONFIG.cameraStreamUrl
      : "  Camera proxy:   not configured (set cameraStreamUrl in config.json)"
  );
});
