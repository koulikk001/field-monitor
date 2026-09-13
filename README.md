# Field Monitor — backend

Backend for the post-disaster search & rescue dashboard: ingests readings from
the sensor/GPS node, proxies the ESP32-CAM feed, pushes live updates to the
dashboard, and logs everything for after-action review.

```
ESP32-CAM  --(its own stock stream server)-->  backend  --proxy-->  dashboard
ESP32 sensor+GPS node --(HTTP POST every few sec)-->  backend --WebSocket-->  dashboard
```

The dashboard never talks to either ESP32 directly — only to this backend.
That's what lets the dashboard be opened safely from any device on the network
(or over https from elsewhere, if you expose the backend) while the hardware
itself stays on a plain local network with no HTTPS or CORS setup needed.

## Run it

```
npm install
cp config.example.json config.json   # then edit the values below
npm start
```

Open `http://<this machine's IP>:8080` on any phone or laptop on the same
network. Multiple people can have it open at once — everyone gets the same
live feed.

## Configure `config.json`

| Field | What it is |
|---|---|
| `port` | Port the backend listens on |
| `cameraStreamUrl` | The ESP32-CAM's MJPEG stream, e.g. `http://192.168.4.1:81/stream` (default address for the stock Arduino "CameraWebServer" example) |
| `cameraSnapshotUrl` | Optional single-JPEG endpoint, e.g. `http://192.168.4.1/capture` |
| `ingestKey` | Shared secret the sensor node must send as `X-Device-Key` — leave `""` to disable |
| `historyMaxPoints` | How many readings per device to keep in memory for the history chart |
| `thresholds` | Safe / caution / max values per sensor — the single source of truth; the dashboard fetches these instead of hardcoding them |

## Flash the sensor node

`firmware/esp32_sensor_node/esp32_sensor_node.ino` reads CO2/CO/SO2/smoke +
GPS and POSTs a JSON reading to `/api/ingest` on an interval. It assumes a
reference set of sensors (MH-Z19B, MQ-7, MQ-136, MQ-2, NEO-6M) — edit the pin
numbers, libraries, and especially the analog-sensor calibration constants
near the top of the file to match your actual prototype. Tell me your exact
part numbers and wiring and I'll tailor it precisely.

The camera node keeps running its existing/stock ESP32-CAM firmware — no
changes needed there, just make sure `cameraStreamUrl` in `config.json`
points at it.

## API

- `POST /api/ingest` — sensor node pushes a reading here (see the in-app
  settings panel for the exact JSON shape and header)
- `GET /api/latest?device=<id>` — most recent reading
- `GET /api/history?device=<id>&minutes=60` — recent history for a device
- `GET /api/devices` — known device IDs and their last-seen time/status
- `GET /api/config` — thresholds + whether a camera is configured
- `GET /api/camera/stream` / `/api/camera/snapshot` — proxied camera feed
- `WS /ws` — live push of every new reading; sends a `hello` with the current
  thresholds on connect

## Logs

Every reading is appended to `data/readings-log.ndjson`. Every time a
device's hazard state changes (safe → caution → danger or back) it's also
appended to `data/alerts-log.ndjson`, so you have a permanent, greppable
record for after-action review. Both are plain newline-delimited JSON — one
reading per line.

## Security notes for field deployment

- Set `ingestKey` so random devices on the network can't spoof readings.
- CORS is wide open (`*`) by default so the dashboard can be hosted anywhere.
  If you expose this backend beyond your local network, put it behind a
  reverse proxy with TLS and tighten the CORS origin in `server.js`.
- There's no dashboard login. For a multi-agency deployment you'd likely want
  to add one — happy to add basic auth if that's useful.
