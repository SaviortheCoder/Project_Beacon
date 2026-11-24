// B.E.A.C.O.N. dispatch backend (Senior Design I sample)
//
// - Runs an MQTT broker for development (Aedes), or connects to Mosquitto if MQTT_URL is set
// - Turns station alerts and events into incidents (New -> Acknowledged -> Resolved)
// - Pushes every change to the dispatch console over a WebSocket
// - Sends the dispatcher's acknowledgment, text and close commands back to the station
//
// Topics follow Table 7.6 of the midterm report: beacon/{station_id}/{alert|event/...|health|status|ack|cmd|reply}

const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const express = require("express");
const mqtt = require("mqtt");
const { WebSocketServer, createWebSocketStream } = require("ws");
const landmarks = require("./landmarks");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 3000;
const MQTT_URL = process.env.MQTT_URL || "";          // e.g. mqtt://localhost:1883 to use Mosquitto
const MQTT_PORT = Number(process.env.MQTT_PORT) || 1883;
// Real stations report every 4 h. The demo uses 30 s so the fault check is visible.
const HEALTH_MS = (Number(process.env.HEALTH_INTERVAL_S) || 30) * 1000;
// An idle station sleeps between reports, and the simulators stop reporting while idle,
// so an idle station is only faulted after two missed real-station reports (2 x 4 h).
const IDLE_HEALTH_MS = (Number(process.env.IDLE_HEALTH_INTERVAL_S) || 4 * 3600) * 1000;
const DATA_FILE = path.join(__dirname, "data", "incidents.json");

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// ---------- State ----------
const stations = new Map();
for (const s of JSON.parse(fs.readFileSync(path.join(ROOT, "config", "stations.json"), "utf8"))) {
  stations.set(s.id, { ...s, status: "unknown", fault: null, lastHealthAt: null, health: null });
}
let incidents = [];
try { incidents = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { /* first run */ }
let seq = incidents.reduce((m, i) => Math.max(m, Number(i.id.slice(4)) || 0), 0);

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(incidents, null, 1));
  }, 200);
}

function station(id) {
  if (!stations.has(id)) stations.set(id, { id, name: id, lat: null, lon: null, status: "unknown", fault: null, lastHealthAt: null, health: null });
  return stations.get(id);
}

// ---------- WebSocket to consoles ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, "frontend_console")));
app.use("/vendor/maplibre", express.static(path.join(ROOT, "node_modules", "maplibre-gl", "dist")));
app.use("/vendor/mqtt", express.static(path.join(ROOT, "node_modules", "mqtt", "dist")));
app.use("/station", express.static(path.join(ROOT, "station", "simulator"), { index: "screen.html" }));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });       // console updates
const mqttWs = new WebSocketServer({ noServer: true });    // MQTT over WebSocket for the browser station screen
let aedes = null;
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else if (pathname === "/mqtt" && aedes) mqttWs.handleUpgrade(req, socket, head, (ws) => aedes.handle(createWebSocketStream(ws)));
  else socket.destroy();
});
// The browser station connects to the built-in broker at /mqtt. With Mosquitto, set MQTT_WS_URL
// (for example ws://localhost:9001 with a websockets listener in mosquitto.conf).
app.get("/api/config", (req, res) => res.json({ mqttWs: aedes ? "/mqtt" : (process.env.MQTT_WS_URL || null), healthMs: HEALTH_MS }));

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}
const pushIncident = (i) => { save(); broadcast({ type: "incident", incident: i }); };
const pushStation = (s) => broadcast({ type: "station", station: s });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "snapshot", stations: [...stations.values()], incidents, healthMs: HEALTH_MS }));
});

// ---------- MQTT ----------
let client;
function publish(stationId, sub, obj) {
  const st = station(stationId);
  if (st.status !== "online") {
    // Section 7.7.3: an idle station is reached by SMS. The broker keeps the QoS 1
    // command (persistent session) and delivers it when the station reconnects.
    log(`[sms] ${stationId} is ${st.status}: would send a wake-up SMS through the 1NCE API now`);
  }
  client.publish(`beacon/${stationId}/${sub}`, JSON.stringify({ v: 1, ts: new Date().toISOString(), ...obj }), { qos: 1 });
}

function newIncident(stationId, kind, payload) {
  const st = station(stationId);
  const inc = {
    id: "inc-" + String(++seq).padStart(5, "0"),
    station: stationId,
    kind,                                   // alert | tamper | acoustic
    trigger: payload.trigger || kind,
    alertId: payload.id || null,
    state: "New",
    createdAt: new Date().toISOString(),
    stationTs: payload.ts || null,
    ackAt: null,
    closedAt: null,
    lat: payload.lat ?? st.lat,
    lon: payload.lon ?? st.lon,
    place: landmarks.describe({ lat: payload.lat ?? st.lat, lon: payload.lon ?? st.lon }),
    data: payload,
    messages: [],
  };
  incidents.unshift(inc);
  log(`[incident] ${inc.id} ${kind} from ${stationId} (${inc.trigger})`);
  pushIncident(inc);
  return inc;
}

function handle(topic, buf) {
  const m = topic.match(/^beacon\/([^/]+)\/(.+)$/);
  if (!m) return;
  const [, sid, sub] = m;
  const text = buf.toString();
  let p = {};
  if (sub !== "status") { try { p = JSON.parse(text); } catch { log(`[warn] bad JSON on ${topic}`); return; } }
  const st = station(sid);

  if (sub === "alert") {
    // The station resends every 5 s until acknowledged (Table 7.3), so match on the alert id.
    const existing = p.id && incidents.find((i) => i.alertId === p.id && i.station === sid && i.state !== "Resolved");
    if (existing) {
      if (existing.state !== "New") publish(sid, "ack", { incident: existing.id, alert: existing.alertId });
      return;
    }
    newIncident(sid, "alert", p);
  } else if (sub.startsWith("event/")) {
    newIncident(sid, sub.slice(6), p);
  } else if (sub === "health") {
    st.health = p; st.lastHealthAt = new Date().toISOString(); st.fault = null;
    if (st.status !== "online") st.status = "online";
    pushStation(st);
  } else if (sub === "status") {
    st.status = text;                       // online | idle | offline (last will)
    if (text === "offline") st.fault = "Connection dropped (last will)";
    else if (text === "online" && st.fault?.startsWith("Connection dropped")) st.fault = null; // back on the broker
    log(`[status] ${sid} ${text}`);
    pushStation(st);
  } else if (sub === "reply") {
    const inc = incidents.find((i) => i.id === p.incident) || incidents.find((i) => i.station === sid && i.state !== "Resolved");
    if (!inc) return;
    inc.messages.push({ from: "station", text: p.text, at: new Date().toISOString() });
    log(`[reply] ${sid}: ${p.text}`);
    pushIncident(inc);
  }
}

// Health check: two missed reports raise a fault (Section 7.12)
setInterval(() => {
  const now = Date.now();
  for (const st of stations.values()) {
    if (!st.lastHealthAt || st.status === "offline") continue;
    const every = st.status === "idle" ? IDLE_HEALTH_MS : HEALTH_MS;
    const late = now - Date.parse(st.lastHealthAt) > 2 * every + 5000;
    if (late && !st.fault) { st.fault = "Missed two health reports"; log(`[fault] ${st.id} missed two health reports`); pushStation(st); }
  }
}, 5000);

// ---------- Console actions ----------
function findInc(req, res) {
  const inc = incidents.find((i) => i.id === req.params.id);
  if (!inc) res.status(404).json({ error: "No incident with that id" });
  return inc;
}
app.get("/api/state", (req, res) => res.json({ stations: [...stations.values()], incidents }));
app.get("/api/landmarks", (req, res) => res.json({ safety: landmarks.safetyPoints() }));
app.post("/api/incidents/:id/ack", (req, res) => {
  const inc = findInc(req, res); if (!inc) return;
  if (inc.state === "New") { inc.state = "Acknowledged"; inc.ackAt = new Date().toISOString(); }
  publish(inc.station, "ack", { incident: inc.id, alert: inc.alertId });
  log(`[ack] ${inc.id}`);
  pushIncident(inc); res.json(inc);
});
app.post("/api/incidents/:id/message", (req, res) => {
  const inc = findInc(req, res); if (!inc) return;
  const text = String(req.body.text || "").trim().slice(0, 280);
  if (!text) return res.status(400).json({ error: "Message is empty" });
  inc.messages.push({ from: "dispatch", text, at: new Date().toISOString() });
  publish(inc.station, "cmd", { type: "text", incident: inc.id, text });
  log(`[text] ${inc.id} -> ${inc.station}: ${text}`);
  pushIncident(inc); res.json(inc);
});
app.post("/api/incidents/:id/close", (req, res) => {
  const inc = findInc(req, res); if (!inc) return;
  inc.state = "Resolved"; inc.closedAt = new Date().toISOString();
  publish(inc.station, "cmd", { type: "close", incident: inc.id });
  log(`[close] ${inc.id}`);
  pushIncident(inc); res.json(inc);
});
app.post("/api/stations/:id/ping", (req, res) => {
  publish(req.params.id, "cmd", { type: "ping" });
  res.json({ ok: true });
});

// ---------- Start ----------
(async () => {
  let url = MQTT_URL;
  if (!url) {
    aedes = require("aedes")();
    // Two clients with the same id knock each other off the broker every few seconds. Say so plainly.
    const connects = new Map(), warned = new Map();
    aedes.on("client", (c) => {
      const t = Date.now(), list = (connects.get(c.id) || []).filter((x) => t - x < 15000);
      list.push(t); connects.set(c.id, list);
      if (list.length >= 4 && t - (warned.get(c.id) || 0) > 30000) {
        warned.set(c.id, t);
        log(`[warn] two copies of ${c.id.replace("station-", "station ")} are connected and keep knocking each other offline. Close the extra station tab or stop "npm run station".`);
      }
    });
    await new Promise((r) => net.createServer(aedes.handle).listen(MQTT_PORT, r));
    url = `mqtt://localhost:${MQTT_PORT}`;
    log(`[broker] built-in development broker on port ${MQTT_PORT}`);
  }
  client = mqtt.connect(url, { clientId: "beacon-backend", clean: false });
  client.on("connect", () => {
    log(`[mqtt] connected to ${url}`);
    client.subscribe(["beacon/+/alert", "beacon/+/event/#", "beacon/+/health", "beacon/+/status", "beacon/+/reply"], { qos: 1 });
  });
  client.on("message", handle);
  client.on("error", (e) => log("[mqtt] " + e.message));
  server.listen(PORT, () => log(`[console] open http://localhost:${PORT}`));
  describeStations();
})();

// ---------- Landmarks: plain-language station locations for the console ----------
// Looked up in the background so the console starts at once; retried every 15 min until it works.
async function describeStations() {
  const ok = await landmarks.load([...stations.values()], log);
  for (const st of stations.values()) { st.place = landmarks.describe(st); pushStation(st); }
  for (const inc of incidents) if (!inc.place && inc.state !== "Resolved") { inc.place = landmarks.describe(inc); pushIncident(inc); }
  broadcast({ type: "landmarks", safety: landmarks.safetyPoints() });
  if (!ok) setTimeout(describeStations, 15 * 60 * 1000);
}
