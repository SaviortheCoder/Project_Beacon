// Landmarks around the stations, from OpenStreetMap through the Overpass API.
//
// Nothing is preloaded: the backend asks for named places inside the box around the stations in
// config/stations.json, so a station anywhere gets the same treatment. Results are cached in
// backend/data/landmarks.json and refreshed weekly, so the public Overpass service is asked about
// once a week, not once per console. The same data will feed station wayfinding.
//
// describe(point) turns coordinates into the sentence a dispatcher reads:
//   "65 m SE of John C. Hitt Library · On Gemini Blvd N · nearest AED 60 m SE"

const fs = require("fs");
const path = require("path");

const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const CACHE_FILE = path.join(__dirname, "data", "landmarks.json");
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const PAD_M = 450; // search this far past the outermost stations

// Category: label, colour on the map, and how much it matters to someone giving directions.
const CATS = {
  police:   { label: "Police",     color: "#4ea1ff", rank: 9 },
  medical:  { label: "Medical",    color: "#ff5a6e", rank: 9 },
  aed:      { label: "AED",        color: "#ff5a6e", rank: 8 },
  callbox:  { label: "Call box",   color: "#3ccf8e", rank: 7 },
  building: { label: "Building",   color: "#9aa7b4", rank: 6 },
  parking:  { label: "Parking",    color: "#5b8def", rank: 5 },
  green:    { label: "Park/field", color: "#4fbf72", rank: 4 },
  transit:  { label: "Bus stop",   color: "#2bb3c0", rank: 3 },
  food:     { label: "Food",       color: "#f2a93b", rank: 2 },
  other:    { label: "Place",      color: "#a98bff", rank: 1 },
};

function categorize(t) {
  if (t.amenity === "police" || t.amenity === "fire_station") return "police";
  if (["hospital", "clinic", "doctors", "pharmacy"].includes(t.amenity) || t.healthcare) return "medical";
  if (t.emergency === "defibrillator") return "aed";
  if (t.emergency === "phone") return "callbox";
  if (t.amenity === "parking" || t.amenity === "parking_entrance") return "parking";
  if (t.highway === "bus_stop" || t.public_transport === "platform") return "transit";
  if (["restaurant", "cafe", "fast_food", "food_court"].includes(t.amenity)) return "food";
  if (t.leisure) return "green";
  if (t.building || ["library", "university", "college", "school", "theatre", "arts_centre", "community_centre"].includes(t.amenity)) return "building";
  return "other";
}

// ---------- geometry ----------
const R = 6371000, rad = (d) => (d * Math.PI) / 180;
function dist(a, b) {
  const x = rad(b.lon - a.lon) * Math.cos(rad((a.lat + b.lat) / 2)), y = rad(b.lat - a.lat);
  return Math.hypot(x, y) * R;
}
function bearing(from, to) {
  const x = rad(to.lon - from.lon) * Math.cos(rad((from.lat + to.lat) / 2)), y = rad(to.lat - from.lat);
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}
const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
function distToSegment(p, a, b) {
  const kx = Math.cos(rad(p.lat)) * R * Math.PI / 180, ky = R * Math.PI / 180;
  const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
const fmtM = (m) => (m < 1000 ? `${Math.round(m / 5) * 5 || 5} m` : `${(m / 1000).toFixed(1)} km`);

function bbox(stations) {
  const lats = stations.map((s) => s.lat), lons = stations.map((s) => s.lon);
  const dLat = PAD_M / 111320, dLon = PAD_M / (111320 * Math.cos(rad(lats[0])));
  return [Math.min(...lats) - dLat, Math.min(...lons) - dLon, Math.max(...lats) + dLat, Math.max(...lons) + dLon].map((v) => +v.toFixed(5));
}

// ---------- fetch + cache ----------
let data = null; // { bbox, at, places: [...], roads: [...] }

function parse(json) {
  const places = [], roads = [];
  for (const e of json.elements || []) {
    const t = e.tags || {};
    if (e.type === "way" && t.highway && e.geometry) { roads.push({ name: t.name, cls: t.highway, pts: e.geometry.map((g) => ({ lat: g.lat, lon: g.lon })) }); continue; }
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat == null) continue;
    const cat = categorize(t);
    const name = t.name || (cat === "aed" ? "AED" : cat === "callbox" ? "Emergency phone" : cat === "transit" ? "Bus stop" : null);
    if (!name) continue;
    // short_name / alt_name / ref are kept for destination search (e.g. "ENG II", building numbers).
    const aka = [t.short_name, t.alt_name, t.official_name, t.ref].filter(Boolean).flatMap((s) => s.split(";")).map((s) => s.trim());
    places.push({ id: e.type + e.id, name, cat, lat, lon, rank: CATS[cat].rank, sub: t.amenity || t.building || t.leisure || t.emergency || t.highway || "", aka });
  }
  // The same building is often both a node and a polygon: keep one per name within 40 m.
  const dedup = [];
  for (const p of places.sort((a, b) => b.rank - a.rank)) if (!dedup.some((q) => q.name === p.name && dist(p, q) < 40)) dedup.push(p);
  return { places: dedup, roads };
}

async function load(stations, log = console.log) {
  const pts = stations.filter((s) => s.lat != null && s.lon != null);
  if (!pts.length) return null;
  const box = bbox(pts);
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    const covers = cached.bbox[0] <= box[0] && cached.bbox[1] <= box[1] && cached.bbox[2] >= box[2] && cached.bbox[3] >= box[3];
    if (covers && Date.now() - cached.at < MAX_AGE_MS) { data = cached; log(`[landmarks] ${data.places.length} places from cache`); return data; }
  } catch { /* no cache yet */ }

  const b = box.join(",");
  const q = `[out:json][timeout:25];
    ( nwr["name"]["building"](${b}); nwr["name"]["amenity"](${b}); nwr["name"]["leisure"](${b});
      nwr["name"]["shop"](${b}); nwr["name"]["tourism"](${b}); nwr["name"]["healthcare"](${b});
      nwr["emergency"~"^(defibrillator|phone)$"](${b}); nwr["highway"="bus_stop"](${b}); nwr["amenity"="police"](${b}); )->.p;
    .p out center tags;
    way["highway"]["name"](${b})->.r;
    .r out tags geom;`;
  try {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      body: "data=" + encodeURIComponent(q),
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "BEACON-dispatch/0.1 (UCF Senior Design Group 23)" },
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
    data = { bbox: box, at: Date.now(), ...parse(await res.json()) };
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
    log(`[landmarks] ${data.places.length} places, ${data.roads.length} named roads from OpenStreetMap`);
  } catch (e) {
    log(`[landmarks] lookup failed (${e.message}); the console shows coordinates until it succeeds`);
    try { data = data || JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { /* still nothing */ }
  }
  return data;
}

// ---------- the sentence a dispatcher reads ----------
function describe(pt) {
  if (!data || pt?.lat == null) return null;
  const near = data.places.map((p) => ({ ...p, d: dist(pt, p) }));
  // Anchor: the most useful named place nearby. Rank buys distance: a library 60 m away beats a café 30 m away.
  const anchor = near.filter((p) => !["aed", "callbox", "transit"].includes(p.cat) && p.d < 300)
    .sort((a, b) => a.d / (1 + a.rank / 4) - b.d / (1 + b.rank / 4))[0];
  let road = null, roadD = Infinity;
  for (const r of data.roads) {
    if (["footway", "path", "cycleway", "steps", "service", "pedestrian"].includes(r.cls)) continue;
    for (let i = 1; i < r.pts.length; i++) { const d = distToSegment(pt, r.pts[i - 1], r.pts[i]); if (d < roadD) { roadD = d; road = r; } }
  }
  const nearest = (cat) => near.filter((p) => p.cat === cat).sort((a, b) => a.d - b.d)[0];
  const aed = nearest("aed"), police = nearest("police");
  return {
    headline: anchor ? `${fmtM(anchor.d)} ${compass(bearing(anchor, pt))} of ${anchor.name}` : null,
    road: road ? (roadD < 40 ? `On ${road.name}` : `${fmtM(roadD)} from ${road.name}`) : null,
    aed: aed ? `${fmtM(aed.d)} ${compass(bearing(pt, aed))}${aed.name !== "AED" ? ` (${aed.name})` : ""}` : null,
    police: police ? `${police.name}, ${fmtM(police.d)} ${compass(bearing(pt, police))}` : null,
    around: near.filter((p) => p.d < 200 && p !== anchor && !["aed", "callbox"].includes(p.cat))
      .sort((a, b) => b.rank - a.rank || a.d - b.d).slice(0, 4)
      .map((p) => `${p.name} (${fmtM(p.d)} ${compass(bearing(pt, p))})`),
  };
}

// Points the console map draws on top of the vector tiles (AEDs and call boxes are rarely in them).
const safetyPoints = () => (data ? data.places.filter((p) => p.cat === "aed" || p.cat === "callbox").map(({ name, cat, lat, lon }) => ({ name, cat, lat, lon })) : []);

module.exports = { CATS, load, describe, safetyPoints, dist, bearing, compass, get data() { return data; } };
