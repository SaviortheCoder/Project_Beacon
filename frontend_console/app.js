// Dispatch console: live map, incident queue, acknowledge, text to the station, close.
const state = { stations: new Map(), incidents: [], selected: null, healthMs: 30000 };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : "—");
const KIND = { alert: "Alert", tamper: "Tamper", acoustic: "Sound" };
const CANNED = [
  "Help is on the way. Stay near the station if it is safe.",
  "Officers are about 2 minutes away.",
  "Can you tell us what happened? Hold the button to talk.",
  "If you are safe now, tap \"I'm OK\" on the screen.",
];

// ---------- Map ----------
// Vector basemap drawn by MapLibre with our dark style (map_style.js). The map is created on the
// first snapshot so it opens framed on the stations in config/stations.json, wherever they are.
// Station pins are HTML markers so they keep the console's alert styling.
let map = null, mapReady = false;
const markers = new Map();
let safety = [];
const mapNote = (text) => { const n = $("mapNote"); n.textContent = text || ""; n.hidden = !text; };

function stationBounds() {
  const pts = [...state.stations.values()].filter((s) => s.lat != null);
  if (!pts.length) return null;
  const lons = pts.map((s) => s.lon), lats = pts.map((s) => s.lat);
  return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
}
function fitStations(animate) {
  const b = stationBounds();
  if (map && b) map.fitBounds(b, { padding: 90, maxZoom: 17, duration: animate ? 800 : 0 });
}
function initMap() {
  if (map || !stationBounds()) return;
  try {
    map = new maplibregl.Map({
      container: "map", style: BEACON_STYLE, bounds: stationBounds(), fitBoundsOptions: { padding: 90, maxZoom: 17 },
      pitch: 45, bearing: -15, maxPitch: 70, attributionControl: false,
    });
  } catch (e) {
    mapNote("This browser cannot draw the map (WebGL is turned off). Alerts, stations and messages still work.");
    return;
  }
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution:
    '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>' }));
  map.on("load", () => { mapReady = true; drawSafety(); });
  map.on("error", (e) => {
    if (/fetch|network|ajax|load/i.test(String(e.error?.message))) mapNote("Map tiles are not loading. Check the internet connection; alerts and messages still work.");
  });
  map.on("sourcedata", (e) => { if (e.sourceId === "omt" && e.tile) mapNote(""); }); // a basemap tile arrived
}

function pinClass(st) {
  const open = state.incidents.some((i) => i.station === st.id && i.state !== "Resolved");
  if (open) return "alert";
  if (st.fault) return "fault";
  return st.status;
}
function drawMarker(st) {
  if (!map || st.lat == null) return;
  if (!markers.has(st.id)) {
    const el = document.createElement("div");
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const inc = state.incidents.find((i) => i.station === st.id && i.state !== "Resolved");
      if (inc) select(inc.id);
    });
    markers.set(st.id, { el, m: new maplibregl.Marker({ element: el, anchor: "left", offset: [-9, 0] }).setLngLat([st.lon, st.lat]).addTo(map) });
  }
  const { el } = markers.get(st.id), cls = pinClass(st);
  el.className = `pin-wrap ${cls}`;
  el.title = `${st.name} · ${st.status}`;
  el.innerHTML = `<div class="pin ${esc(cls)}"></div><span class="pin-tag">${esc(st.name)}</span>`;
}

// AEDs and emergency phones from the backend's landmark lookup; vector tiles rarely include them.
function drawSafety() {
  if (!mapReady) return;
  const data = { type: "FeatureCollection", features: safety.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { name: p.name, cat: p.cat } })) };
  if (map.getSource("safety")) return map.getSource("safety").setData(data);
  map.addSource("safety", { type: "geojson", data });
  map.addLayer({ id: "safety-dot", type: "circle", source: "safety", minzoom: 15,
    paint: { "circle-radius": 6, "circle-color": ["match", ["get", "cat"], "aed", "#ff5a6e", "#3ccf8e"], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
  map.addLayer({ id: "safety-label", type: "symbol", source: "safety", minzoom: 16.5,
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-anchor": "left", "text-offset": [0.9, 0] },
    paint: { "text-color": ["match", ["get", "cat"], "aed", "#ff8a98", "#7fe3b3"], "text-halo-color": "#1d2025", "text-halo-width": 1.5 } });
}
fetch("/api/landmarks").then((r) => r.json()).then((d) => { safety = d.safety || []; drawSafety(); }).catch(() => {});
$("fitBtn").addEventListener("click", () => fitStations(true));

// ---------- Sound on new alerts (browsers allow it after the first click) ----------
let audio = null;
document.addEventListener("click", () => { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); }, { once: true });
function beep() {
  if (!audio) return;
  for (const t of [0, 0.25]) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g).connect(audio.destination);
    o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.15);
  }
}

// ---------- Rendering ----------
function renderIncidents() {
  const box = $("incidents");
  if (!state.incidents.length) { box.innerHTML = `<p class="empty">No incidents yet. Press <kbd>a</kbd> in the station simulator to raise one.</p>`; }
  else box.innerHTML = state.incidents.slice(0, 40).map((i) => {
    const st = state.stations.get(i.station) || { name: i.station };
    return `<button class="inc ${i.state === "New" ? "new" : ""} ${i.state === "Resolved" ? "resolved" : ""} ${state.selected === i.id ? "sel" : ""}" data-id="${i.id}">
      <span class="badge ${esc(i.kind)}">${KIND[i.kind] || esc(i.kind)}</span>
      <span class="who">${esc(st.name)}</span>
      <span class="when">${time(i.createdAt)}</span>
      <span class="sub">${esc(i.id)} · <span class="pill ${i.state}">${i.state}</span></span>
    </button>`;
  }).join("");
  const open = state.incidents.filter((i) => i.state !== "Resolved").length;
  $("openCount").textContent = `${open} open`;
  $("openCount").classList.toggle("hot", state.incidents.some((i) => i.state === "New"));
}

function renderStations() {
  $("stations").innerHTML = [...state.stations.values()].map((s) => {
    const h = s.health;
    const meta = h ? `${h.soc}% · ${h.batt_v} V · ${h.rssi_dbm} dBm · ${h.temp_c} °C` : "no health report yet";
    return `<div class="st"><span class="dot ${s.fault ? "fault" : esc(s.status)}"></span><strong>${esc(s.name)}</strong><span class="pill">${esc(s.status)}</span>
      <span class="meta">${meta}${s.lastHealthAt ? " · " + time(s.lastHealthAt) : ""}</span>
      ${s.fault ? `<span class="fault-msg">${esc(s.fault)}</span>` : ""}</div>`;
  }).join("");
  for (const s of state.stations.values()) drawMarker(s);
}

function renderDetail() {
  const box = $("detail");
  const prev = $("msgInput"); const draft = prev ? prev.value : ""; const hadFocus = prev && document.activeElement === prev;
  const i = state.incidents.find((x) => x.id === state.selected);
  if (!i) { box.innerHTML = `<div class="placeholder"><h2>No incident selected</h2><p>New alerts open here automatically. Acknowledge first, then talk to the caller.</p></div>`; return; }
  const st = state.stations.get(i.station) || { name: i.station };
  const d = i.data || {};
  const closed = i.state === "Resolved";
  const timeline = [
    { cls: "sys", text: `${KIND[i.kind] || i.kind} received ${time(i.createdAt)}` },
    ...(i.ackAt ? [{ cls: "sys", text: `Acknowledged ${time(i.ackAt)}` }] : []),
    ...i.messages.map((m) => ({ cls: m.from, text: m.text, at: m.at, who: m.from === "dispatch" ? "Dispatcher" : "Caller" })),
    ...(i.closedAt ? [{ cls: "sys", text: `Closed ${time(i.closedAt)}` }] : []),
  ];
  box.innerHTML = `
    <div class="d-head"><span class="badge ${esc(i.kind)}">${KIND[i.kind] || esc(i.kind)}</span><h3>${esc(st.name)}</h3><span class="pill ${i.state}">${i.state}</span></div>
    <div id="timer" class="timer ${i.state === "New" ? "" : "ok"}"></div>
    ${whereCard(i.place || st.place, i, d)}
    <dl class="d-grid">
      <dt>Incident</dt><dd>${esc(i.id)}</dd>
      <dt>Trigger</dt><dd>${esc(i.trigger)}</dd>
      <dt>Battery</dt><dd>${d.soc != null ? d.soc + "% · " + d.batt_v + " V" : "—"}</dd>
      <dt>Signal</dt><dd>${d.rssi_dbm != null ? d.rssi_dbm + " dBm" : "—"}</dd>
      ${i.kind === "tamper" ? `<dt>Sensor</dt><dd>${esc(d.source || "")} ${d.peak_g ? d.peak_g + " g" : ""}</dd>` : ""}
      ${i.kind === "acoustic" ? `<dt>Peak</dt><dd>${d.peak_db ?? "—"} dB, rise ${d.rise_ms ?? "—"} ms</dd>` : ""}
    </dl>
    <div class="chat" id="chat">${timeline.map((m) => `<div class="msg ${m.cls}">${m.who ? `<small>${m.who} · ${time(m.at)}</small>` : ""}${esc(m.text)}</div>`).join("")}</div>
    <div class="actions">
      ${i.state === "New" ? `<button class="btn primary" id="ackBtn">Acknowledge (Space)</button>` : ""}
      ${!closed ? `
        <div class="canned">${CANNED.map((c, n) => `<button class="btn ghost" data-canned="${n}">${esc(c)}</button>`).join("")}</div>
        <form class="send" id="sendForm"><input id="msgInput" maxlength="280" placeholder="Type a message for the station screen" autocomplete="off"><button class="btn" type="submit">Send</button></form>
        <button class="btn" id="closeBtn">Close incident</button>` : ""}
    </div>`;
  const chat = $("chat"); chat.scrollTop = chat.scrollHeight;
  const inp = $("msgInput"); if (inp && draft) inp.value = draft; if (inp && hadFocus) inp.focus();
  tick();
}

// Where it is, in words first: the nearest landmark, the road, the nearest AED and police.
// Coordinates stay at the bottom for the record.
function whereCard(p, i, d) {
  const coords = `${i.lat?.toFixed?.(5) ?? "—"}, ${i.lon?.toFixed?.(5) ?? "—"}${d.loc_src ? " · " + esc(d.loc_src) : ""}`;
  if (!p) return `<div class="where"><div class="where-head">Location</div><div class="where-dim">Landmarks not loaded yet. Showing coordinates.</div><div class="where-coords">${coords}</div></div>`;
  return `<div class="where">
    <div class="where-head">${esc(p.headline || "No named landmark within 300 m")}</div>
    ${p.road ? `<div class="where-road">${esc(p.road)}</div>` : ""}
    <dl class="where-grid">
      <dt>Nearest AED</dt><dd>${esc(p.aed || "None mapped nearby")}</dd>
      <dt>Police</dt><dd>${esc(p.police || "None in the search area")}</dd>
      ${p.around?.length ? `<dt>Also near</dt><dd>${p.around.slice(0, 3).map(esc).join("<br>")}</dd>` : ""}
    </dl>
    <div class="where-coords">${coords}</div>
  </div>`;
}

function renderAll() { renderIncidents(); renderStations(); renderDetail(); }

function tick() {
  $("clock").textContent = new Date().toLocaleTimeString();
  const i = state.incidents.find((x) => x.id === state.selected);
  const el = $("timer");
  if (!i || !el) return;
  if (i.state === "New") {
    const s = Math.floor((Date.now() - Date.parse(i.createdAt)) / 1000);
    el.textContent = `Waiting ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  } else if (i.state === "Acknowledged") {
    el.textContent = `Acknowledged in ${Math.round((Date.parse(i.ackAt) - Date.parse(i.createdAt)) / 1000)} s`;
  } else el.textContent = "";
}
setInterval(tick, 1000);

function select(id) { state.selected = id; renderIncidents(); renderDetail(); }

// ---------- Actions ----------
async function act(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!r.ok) alert((await r.json()).error || "Request failed");
}
document.addEventListener("click", (e) => {
  const inc = e.target.closest(".inc"); if (inc) return select(inc.dataset.id);
  const id = state.selected;
  if (e.target.id === "ackBtn") act(`/api/incidents/${id}/ack`);
  if (e.target.id === "closeBtn") act(`/api/incidents/${id}/close`);
  const c = e.target.closest("[data-canned]"); if (c) act(`/api/incidents/${id}/message`, { text: CANNED[c.dataset.canned] });
});
document.addEventListener("submit", (e) => {
  if (e.target.id !== "sendForm") return;
  e.preventDefault();
  const input = $("msgInput"); const text = input.value.trim(); if (!text) return;
  act(`/api/incidents/${state.selected}/message`, { text }); input.value = "";
});
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement?.tagName !== "INPUT" && $("ackBtn")) { e.preventDefault(); $("ackBtn").click(); }
});

// ---------- Live connection ----------
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => { $("conn").textContent = "Live"; $("conn").className = "conn up"; };
  ws.onclose = () => { $("conn").textContent = "Reconnecting…"; $("conn").className = "conn down"; setTimeout(connect, 2000); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "snapshot") {
      state.stations = new Map(msg.stations.map((s) => [s.id, s]));
      state.incidents = msg.incidents; state.healthMs = msg.healthMs;
      initMap();
      if (!state.selected) state.selected = state.incidents.find((i) => i.state !== "Resolved")?.id || null;
      renderAll();
    } else if (msg.type === "station") {
      state.stations.set(msg.station.id, msg.station); renderStations();
      if (state.incidents.some((i) => i.station === msg.station.id && i.id === state.selected)) renderDetail();
    } else if (msg.type === "landmarks") {
      safety = msg.safety || []; drawSafety();
    } else if (msg.type === "incident") {
      const n = msg.incident;
      const idx = state.incidents.findIndex((i) => i.id === n.id);
      if (idx >= 0) state.incidents[idx] = n;
      else {
        state.incidents.unshift(n); beep();
        const cur = state.incidents.find((i) => i.id === state.selected);
        if (!cur || cur.state === "Resolved" || n.kind === "alert") state.selected = n.id;
        const st = state.stations.get(n.station);
        if (map && st?.lat != null && n.station === state.incidents.find((x) => x.id === state.selected)?.station)
          map.flyTo({ center: [st.lon, st.lat], zoom: Math.max(map.getZoom(), 17.5), duration: 900 });
      }
      renderAll();
    }
  };
}
connect();
