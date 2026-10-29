// Fake B.E.A.C.O.N. station. It sends exactly what the ESP32 firmware will send (Section 7.7),
// so the backend and console can be built before any hardware arrives.
//
//   npm run station                    station st07, keyboard control
//   npm run station -- --id st03       a second station
//   npm run station -- --auto          raises an alert by itself (handy for screen recordings)
//
// Keys:  a alert   t tamper   s sound flag   o "I'm OK"   m "I need medical help"
//        i go idle (normal disconnect)   w wake up   x crash (tests the last-will message)   q quit

const fs = require("fs");
const path = require("path");
const mqtt = require("mqtt");
const readline = require("readline");

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const ID = arg("id", "st07");
const URL = arg("url", process.env.MQTT_URL || "mqtt://localhost:1883");
const HEALTH_S = Number(arg("health", process.env.HEALTH_INTERVAL_S || 30));
const AUTO = args.includes("--auto");
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "config", "stations.json"), "utf8")).find((s) => s.id === ID) || { lat: 28.6024, lon: -81.2001 };

const T = (s) => `beacon/${ID}/${s}`;
// Sequence seeded from the clock so alert ids never repeat between runs (the ESP32 keeps its counter in NVS)
let client = null, alertSeq = Math.floor(Date.now() / 1000) % 1000000, pending = null, incident = null, healthTimer = null, soc = 86;
const say = (tag, msg) => console.log(`${new Date().toLocaleTimeString()}  ${tag.padEnd(8)} ${msg}`);
const now = () => new Date().toISOString();

function connect() {
  client = mqtt.connect(URL, {
    clientId: "station-" + ID,
    clean: false,                                     // persistent session: queued commands arrive on reconnect
    will: { topic: T("status"), payload: "offline", qos: 1, retain: true },
  });
  client.on("connect", () => {
    say("[link]", `connected to ${URL} as ${ID}`);
    client.publish(T("status"), "online", { qos: 1, retain: true });
    client.subscribe([T("ack"), T("cmd")], { qos: 1 });
    sendHealth();
    clearInterval(healthTimer);
    healthTimer = setInterval(sendHealth, HEALTH_S * 1000);
  });
  client.on("message", onMessage);
  client.on("error", (e) => say("[link]", e.message));
}

function sendHealth() {
  soc = Math.max(5, soc - Math.random() * 0.3);
  client.publish(T("health"), JSON.stringify({
    v: 1, station: ID, ts: now(), soc: Math.round(soc), batt_v: +(12.9 + soc / 300).toFixed(2),
    solar_w: +(Math.random() * 25).toFixed(1), temp_c: +(30 + Math.random() * 6).toFixed(1),
    rssi_dbm: -80 - Math.round(Math.random() * 15), uptime_s: Math.round(process.uptime()), fw: "0.3.1",
  }), { qos: 0 });
}

function raise(trigger) {
  if (pending) return say("[alert]", "already sending; waiting for the dispatcher");
  const id = `${ID}-${String(++alertSeq).padStart(6, "0")}`;
  const payload = {
    v: 1, id, station: ID, ts: now(), trigger, lat: cfg.lat, lon: cfg.lon, loc_src: "surveyed",
    soc: Math.round(soc), batt_v: 13.28, temp_c: 31.5, rssi_dbm: -87, fw: "0.3.1",
  };
  let tries = 0;
  const send = () => {
    client.publish(T("alert"), JSON.stringify(payload), { qos: 1 });
    say("[alert]", tries++ === 0 ? `sent ${id} (${trigger}). Ring: pulsing red. Screen: "Sending your alert"` : `resent ${id} (no acknowledgment yet)`);
  };
  send();
  pending = { id, timer: setInterval(send, 5000) };   // resend every 5 s until acknowledged
}

function onMessage(topic, buf) {
  const p = JSON.parse(buf.toString());
  if (topic === T("ack")) {
    if (pending && p.alert === pending.id) { clearInterval(pending.timer); pending = null; }
    if (incident === p.incident) return;
    incident = p.incident;
    say("[ack]", `dispatcher acknowledged ${p.incident}. Screen: "Help is on the way". Ring: green (hold to talk)`);
    if (AUTO) setTimeout(() => reply("I need medical help"), 4000);
  } else if (topic === T("cmd")) {
    if (p.type === "text") say("[screen]", `Dispatcher: "${p.text}"`);
    else if (p.type === "close") { say("[screen]", "Incident closed. Strobe off, ring off."); incident = null; }
    else if (p.type === "ping") say("[cmd]", "ping from backend");
  }
}

function reply(text) {
  if (!incident) return say("[reply]", "no open incident to reply to");
  client.publish(T("reply"), JSON.stringify({ v: 1, station: ID, ts: now(), incident, text }), { qos: 1 });
  say("[reply]", `caller tapped "${text}"`);
}

function event(kind, extra) {
  client.publish(T("event/" + kind), JSON.stringify({ v: 1, station: ID, ts: now(), trigger: kind, lat: cfg.lat, lon: cfg.lon, ...extra }), { qos: 1 });
  say("[event]", `${kind} sent`);
}

function goIdle() {
  client.publish(T("status"), "idle", { qos: 1, retain: true }, () => {
    clearInterval(healthTimer);
    client.end(false, () => say("[link]", "idle: MQTT closed, modem stays registered (press w to wake)"));
  });
}

connect();

if (AUTO) {
  setTimeout(() => raise("button"), 3000);
} else if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  console.log("Keys: a alert | t tamper | s sound flag | o I'm OK | m medical help | i idle | w wake | x crash | q quit");
  process.stdin.on("keypress", (_, key) => {
    if (!key) return;
    if (key.ctrl && key.name === "c") process.exit(0);
    switch (key.name) {
      case "a": raise("button"); break;
      case "t": event("tamper", { source: "adxl345", peak_g: 2.4 }); break;
      case "s": event("acoustic", { peak_db: 112, rise_ms: 3, clip: null }); break;
      case "o": reply("I'm OK"); break;
      case "m": reply("I need medical help"); break;
      case "i": goIdle(); break;
      case "w": say("[wake]", "woken (button, motion or SMS)"); connect(); break;
      case "x": say("[crash]", "connection lost without a goodbye"); client.stream.destroy(); setTimeout(() => process.exit(0), 300); break;
      case "q": client.end(false, () => process.exit(0)); break;
    }
  });
}
