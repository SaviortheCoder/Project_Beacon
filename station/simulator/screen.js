// Browser station: a real MQTT client that sends exactly what the ESP32 firmware will send
// (same topics, JSON, last will, persistent session and 5 s alert resends). Open /station?id=st03 for a second station.
(() => {
  const $ = (id) => document.getElementById(id);
  const ID = (new URLSearchParams(location.search).get("id") || "st07").replace(/[^a-z0-9_-]/gi, "");
  const T = (s) => `beacon/${ID}/${s}`;
  const now = () => new Date().toISOString();
  const LAT = { st07: [28.6024, -81.2001], st03: [28.6058, -81.1968] }[ID] || [28.6024, -81.2001];
  const SCREEN_ON_S = 60;

  let client = null, cfg = null, linkState = "down", powered = true, healthTimer = null;
  let state = "off", incident = null, pending = null, soc = 86;
  // Sequence seeded from the clock so ids never repeat across page reloads (the ESP32 keeps its counter in NVS)
  let seq = Math.floor(Date.now() / 1000) % 1000000;
  let screenOffAt = 0, closedTimer = null, talkStart = 0, pressStart = 0, faultTimer = null;

  // Only one copy of a station may be connected: the broker drops the older connection whenever a
  // second client uses the same id, and the two would knock each other offline every 2 s.
  // The newest tab takes over and older tabs stop.
  const TAB = Math.random().toString(36).slice(2);
  const bc = "BroadcastChannel" in window ? new BroadcastChannel("beacon-station") : null;
  let replaced = false;
  bc?.addEventListener("message", (e) => {
    if (e.data?.type === "claim" && e.data.id === ID && e.data.tab !== TAB && !replaced) stopForTakeover();
  });
  function claim() { replaced = false; $("takeover").hidden = true; bc?.postMessage({ type: "claim", id: ID, tab: TAB }); }
  function stopForTakeover() {
    replaced = true;
    clearInterval(healthTimer); clearTimeout(faultTimer);
    if (pending) { clearInterval(pending.timer); pending = null; }
    if (client) client.end(false);
    $("takeover").hidden = false;
    $("link").className = "link-pill idle"; $("link").textContent = "Stopped: open in another tab";
    log("sys", "", `Station ${ID} was opened in another tab; this tab stopped`);
  }

  $("sid").textContent = ID;
  $("sname").textContent = `Station ${ID.replace(/^st/, "")}`;
  document.title = `BEACON Station ${ID}`;

  // ---------- Log of messages on the wire ----------
  function log(dir, topic, body) {
    const li = document.createElement("li");
    li.className = dir;
    const arrow = dir === "out" ? "SENT" : dir === "in" ? "RECV" : "NOTE";
    li.innerHTML = `<span class="dir">${arrow}</span>${new Date().toLocaleTimeString()} ${topic ? `<b>${topic.replace(`beacon/${ID}/`, "")}</b> ` : ""}${body ? escapeHtml(body) : ""}`;
    $("log").prepend(li);
    while ($("log").children.length > 40) $("log").lastChild.remove();
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function pub(sub, obj, opts = { qos: 1 }) {
    const payload = typeof obj === "string" ? obj : JSON.stringify(obj);
    client.publish(T(sub), payload, opts);
    log("out", T(sub), sub === "health" ? `soc ${obj.soc}%` : payload.length > 90 ? payload.slice(0, 90) + "…" : payload);
  }

  // ---------- Screen, ring and strobe ----------
  const RING_TEXT = { off: "Ring: off (nobody near)", ready: "Ring: solid red (ready)", sending: "Ring: pulsing red (sending)", talk: "Ring: green (hold to talk)", talking: "Ring: bright green (talking)" };
  function ring(r) { $("ring").dataset.ring = r; $("ringText").textContent = RING_TEXT[r]; }
  function strobe(on) { $("strobe").classList.toggle("on", on); }
  function show(s) {
    state = s;
    $("screen").dataset.state = s;
    $("stScreen").textContent = s;
    if (s === "home") screenOffAt = Date.now() + SCREEN_ON_S * 1000;
  }
  function setLink(s) {
    linkState = s;
    const el = $("link");
    el.className = "link-pill " + (s === "up" ? "up" : s === "idle" ? "idle" : "down");
    el.textContent = { up: "Online", idle: "Idle (modem asleep)", down: powered ? "No connection" : "Power off" }[s];
    $("stLink").textContent = { up: "online", idle: "idle", down: powered ? "disconnected" : "power off" }[s];
    $("idle").innerHTML = s === "idle" ? "Wake up<small>button, motion or SMS</small>" : "Go idle<small>modem sleeps, MQTT closed</small>";
    $("cut").innerHTML = powered ? "Lose power<small>tests the last-will message</small>" : "Restore power<small>station boots again</small>";
  }

  // Screen timeout: off after 60 s on the home screen with no one interacting
  setInterval(() => {
    $("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (state === "home") {
      const left = Math.ceil((screenOffAt - Date.now()) / 1000);
      $("screenTimer").textContent = left > 0 ? `Screen turns off in ${left} s with no one nearby` : "";
      if (left <= 0) { show("off"); ring("off"); }
    } else $("screenTimer").textContent = "";
  }, 500);

  // ---------- MQTT link ----------
  function connect() {
    if (!cfg.mqttWs) { log("sys", "", "No MQTT WebSocket address. Use the built-in broker (npm start without MQTT_URL)."); return; }
    const url = new URL(cfg.mqttWs, location.href);
    if (url.protocol.startsWith("http")) url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    client = mqtt.connect(url.href, {
      clientId: "station-" + ID,
      clean: false,                                         // persistent session: queued commands arrive on reconnect
      reconnectPeriod: 2000,
      will: { topic: T("status"), payload: "offline", qos: 1, retain: true },
    });
    client.on("connect", () => {
      clearTimeout(faultTimer);
      setLink("up");
      log("sys", "", "Connected to the broker");
      client.publish(T("status"), "online", { qos: 1, retain: true });
      client.subscribe([T("ack"), T("cmd")], { qos: 1 });
      sendHealth();
      clearInterval(healthTimer);
      healthTimer = setInterval(sendHealth, cfg.healthMs || 30000);
      if (state === "fault") show(incident ? "incident" : "home");
    });
    client.on("close", () => {
      if (replaced || !powered || linkState !== "up") return;
      setLink("down");
      // A real station rides out short network blips; show the fault screen only after 5 s offline
      clearTimeout(faultTimer);
      faultTimer = setTimeout(() => { if (linkState === "down" && powered && !replaced && state !== "off") show("fault"); }, 5000);
    });
    client.on("message", onMessage);
  }

  function sendHealth() {
    soc = Math.max(5, soc - Math.random() * 0.3);
    $("stBatt").textContent = Math.round(soc) + "%";
    pub("health", { v: 1, station: ID, ts: now(), soc: Math.round(soc), batt_v: +(12.9 + soc / 300).toFixed(2), solar_w: +(Math.random() * 25).toFixed(1), temp_c: +(30 + Math.random() * 6).toFixed(1), rssi_dbm: -80 - Math.round(Math.random() * 15), uptime_s: Math.round(performance.now() / 1000), fw: "0.3.1" }, { qos: 0 });
  }

  function onMessage(topic, buf) {
    const text = buf.toString();
    log("in", topic, text.length > 90 ? text.slice(0, 90) + "…" : text);
    let p; try { p = JSON.parse(text); } catch { return; }
    if (topic === T("ack")) {
      if (pending && p.alert === pending.id) { clearInterval(pending.timer); pending = null; }
      if (incident === p.incident && state === "incident") return;
      incident = p.incident;
      $("stInc").textContent = incident;
      $("msgs").innerHTML = `<p class="hint">Messages from the dispatcher will appear here.</p>`;
      show("incident"); ring("talk"); strobe(true);
    } else if (topic === T("cmd")) {
      if (p.type === "text") addMsg("Dispatcher", p.text, false);
      else if (p.type === "close") closeIncident();
    }
  }

  // ---------- Station behavior ----------
  function wakeScreen() {
    if (!powered) return;
    if (state === "off" || state === "closed") { show("home"); }
    else if (state === "home") screenOffAt = Date.now() + SCREEN_ON_S * 1000;
    if ($("ring").dataset.ring === "off") ring("ready");
  }

  function raise(trigger) {
    if (replaced || !powered || pending || state === "incident" || state === "sending") return;
    if (linkState === "idle") { log("sys", "", "Panic press wakes the modem"); connect(); }
    const id = `${ID}-${String(++seq).padStart(6, "0")}`;
    const payload = { v: 1, id, station: ID, ts: now(), trigger, lat: LAT[0], lon: LAT[1], loc_src: "surveyed", soc: Math.round(soc), batt_v: 13.28, temp_c: 31.5, rssi_dbm: -87, fw: "0.3.1" };
    let tries = 0;
    show("sending"); ring("sending"); strobe(true);
    const send = () => {
      if (!client || !client.connected) { $("attempt").textContent = `Waiting for the network… attempt ${++tries}`; if (client) client.publish(T("alert"), JSON.stringify(payload), { qos: 1 }); return; }
      tries++;
      $("attempt").textContent = tries === 1 ? "Attempt 1" : `Attempt ${tries} · retrying every 5 s until dispatch answers`;
      pub("alert", payload);
    };
    send();
    pending = { id, timer: setInterval(send, 5000) };
  }

  function addMsg(who, text, mine) {
    const box = $("msgs");
    box.querySelector(".hint")?.remove();
    box.querySelectorAll(".latest").forEach((m) => m.classList.remove("latest"));
    const d = document.createElement("div");
    d.className = "msg" + (mine ? " mine" : " latest");
    d.innerHTML = `<small>${who} · ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small>${escapeHtml(text)}`;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  function reply(text) {
    if (!incident) return;
    pub("reply", { v: 1, station: ID, ts: now(), incident, text });
    addMsg("You", text, true);
  }

  function closeIncident() {
    incident = null; $("stInc").textContent = "none";
    strobe(false); show("closed"); ring("ready");
    clearTimeout(closedTimer);
    closedTimer = setTimeout(() => { if (state === "closed") show("home"); }, 6000);
  }

  // Panic button: a click raises an alert; during a call, press and hold to talk
  const panic = $("panic");
  panic.addEventListener("pointerdown", (e) => {
    if (!powered) return;
    panic.setPointerCapture(e.pointerId);
    pressStart = Date.now();
    if (state === "incident") { talkStart = Date.now(); ring("talking"); $("talking").hidden = false; }
  });
  panic.addEventListener("pointerup", () => {
    if (!powered) return;
    if (talkStart) {
      const s = Math.max(1, Math.round((Date.now() - talkStart) / 1000));
      talkStart = 0; ring("talk"); $("talking").hidden = true;
      // Real audio clips go over HTTPS in Senior Design II; the simulator sends a note so the dispatcher sees it
      reply(`[Voice message, ${s} s: audio playback comes in Senior Design II]`);
      return;
    }
    wakeScreen();
    raise("button");
  });
  panic.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); wakeScreen(); raise("button"); } });

  $("touchSos").addEventListener("click", () => raise("screen"));
  document.querySelectorAll("[data-reply]").forEach((b) => b.addEventListener("click", () => reply(b.dataset.reply)));

  // ---------- Simulation controls ----------
  $("walk").addEventListener("click", () => { log("sys", "", "Motion sensor: someone approaches"); wakeScreen(); });
  $("knock").addEventListener("click", () => {
    if (!powered || linkState !== "up") return log("sys", "", "Tamper detected but the station is not connected");
    pub("event/tamper", { v: 1, station: ID, ts: now(), trigger: "tamper", lat: LAT[0], lon: LAT[1], source: "adxl345", peak_g: +(1.5 + Math.random() * 2).toFixed(1) });
  });
  $("bang").addEventListener("click", () => {
    if (!powered || linkState !== "up") return log("sys", "", "Impulsive sound detected but the station is not connected");
    pub("event/acoustic", { v: 1, station: ID, ts: now(), trigger: "acoustic", lat: LAT[0], lon: LAT[1], peak_db: 108 + Math.round(Math.random() * 8), rise_ms: 3, clip: null });
  });
  $("idle").addEventListener("click", () => {
    if (!powered) return;
    if (linkState === "idle") { log("sys", "", "Woken up (button, motion or SMS)"); connect(); return; }
    if (!client || !client.connected) return;
    clearInterval(healthTimer);
    client.publish(T("status"), "idle", { qos: 1, retain: true }, () => {
      log("out", T("status"), "idle");
      const c = client; setLink("idle"); c.end(false, () => log("sys", "", "MQTT closed; modem stays registered on the network"));
    });
  });
  $("cut").addEventListener("click", () => {
    if (powered) {
      powered = false; clearInterval(healthTimer);
      if (pending) { clearInterval(pending.timer); pending = null; }
      incident = null; $("stInc").textContent = "none";
      if (client) client.end(true);                       // no goodbye: the broker publishes the last will
      setLink("down"); show("off"); ring("off"); strobe(false);
      panic.disabled = true;
      log("sys", "", "Power lost. The broker will announce the last will: offline");
    } else {
      powered = true; panic.disabled = false;
      log("sys", "", "Power restored; station boots");
      show("off"); ring("off"); connect();
    }
  });

  // ---------- Start ----------
  ring("off"); strobe(false); show("off"); setLink("down");
  $("takeBack").addEventListener("click", () => { claim(); connect(); });
  claim();
  fetch("/api/config").then((r) => r.json()).then((c) => { cfg = c; connect(); })
    .catch(() => log("sys", "", "Can't reach the backend. Is npm start running?"));
})();
