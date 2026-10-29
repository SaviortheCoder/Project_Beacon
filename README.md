# B.E.A.C.O.N. Dispatch (Senior Design I sample)

The dispatcher side of the alert path, runnable on one laptop with no hardware:

- **Backend** (`src/server.js`): MQTT broker for development, incident handling, WebSocket push to the console, REST actions for the dispatcher.
- **Station simulator** (`src/station-sim.js`): sends exactly the topics and JSON the ESP32 firmware will send (midterm report, Section 7.7).
- **Console** (`public/`): live campus map, incident queue, Acknowledge, canned and typed messages, Close, station health.
- **Station screen** (`public/station.html`, open at `/station`): the station's 10.1 in screen, panic button, light ring and strobe in the browser. It is a real MQTT client that sends the same messages as the ESP32 firmware, so it can stand in for the hardware in demos.

## Run it

Needs Node.js 18 or newer.

```bash
npm install
npm start                 # terminal 1: backend + broker + console
npm run station           # terminal 2: fake station st07
```

Open http://localhost:3000, then press `a` in the station terminal. The alert appears on the map and the console beeps (click the page once first so the browser allows sound). Click **Acknowledge** or press Space, send a message, then close the incident. The station terminal prints what its ring, screen and strobe would do.

### Station screen in the browser (no terminal needed)

With `npm start` running, open http://localhost:3000/station next to the console. Click **Someone walks up** to wake the screen, then click the red button (or touch EMERGENCY on the screen). Acknowledge in the console and the station shows "Help is on the way"; dispatcher messages appear in large type, and the caller answers with the on-screen buttons. During a call, press and hold the red button to "talk" (the simulator sends a note in place of audio until SD2). The side panel simulates tamper, a loud bang, going idle (commands are queued and delivered on wake), and losing power (the console marks the station offline from its last will). A second station: http://localhost:3000/station?id=st03. Don't run the terminal simulator and the browser station with the same id at once.

### Terminal simulator

Station keys: `a` alert · `t` tamper · `s` sound flag · `o` "I'm OK" · `m` "I need medical help" · `i` go idle · `w` wake · `x` crash (tests the last-will message) · `q` quit.

- Second station: `npm run station2` (st03).
- Hands-free alert for screen recordings: `npm run station -- --auto`.
- Stations and their map positions: `config/stations.json`.
- Health reports default to every 30 s so the missed-report fault shows quickly. Change with `HEALTH_INTERVAL_S=60 npm start` (the real station reports every 4 h).

## What it already does

| Behavior | Report section |
|---|---|
| Station resends the alert every 5 s until acknowledged; backend matches on the alert id, so a resend never makes a second incident | Table 7.3 |
| Incident states New → Acknowledged → Resolved | 7.12 |
| `ack` and `cmd` (text, close, ping) go back to the station with QoS 1 | Table 7.6 |
| Persistent sessions: a command sent to an idle station is held by the broker and delivered when it reconnects; the backend logs where the wake-up SMS would go | 7.7.3 |
| Retained `status` topic: `online`, `idle` before a normal disconnect, last-will `offline` on a crash | Table 7.6 |
| Fault after two missed health reports | 7.12 |
| Caller replies ("I'm OK", "I need medical help") shown in the conversation | 2.3.1 |

One addition to the report: the caller's on-screen replies use a `reply` topic (station → backend, QoS 1), which is not in Table 7.6 yet. Add it there.

## Connecting the real ESP32

Point the firmware at the laptop's IP address on port 1883 (Wi-Fi first, then LTE through the SIM7600) and publish the same JSON to the same topics:

| Topic (prefix `beacon/{station_id}/`) | Direction | QoS | Payload |
|---|---|---|---|
| `alert` | station → backend | 1 | `{"v":1,"id":"st07-000123","station":"st07","ts":"…","trigger":"button","lat":28.6024,"lon":-81.2001,"loc_src":"surveyed","soc":86,"batt_v":13.28,"temp_c":31.5,"rssi_dbm":-87,"fw":"0.3.1"}` |
| `event/tamper`, `event/acoustic` | station → backend | 1 | same fields plus sensor data |
| `health` | station → backend | 0 | `soc`, `batt_v`, `solar_w`, `temp_c`, `rssi_dbm`, `uptime_s`, `fw` |
| `status` (retained) | station → broker | 1 | plain text `online` / `idle`; last will `offline` |
| `reply` | station → backend | 1 | `{"incident":"inc-00001","text":"I'm OK"}` |
| `ack` | backend → station | 1 | `{"incident":"inc-00001","alert":"st07-000123"}` |
| `cmd` | backend → station | 1 | `{"type":"text","text":"…"}`, `{"type":"close"}`, `{"type":"ping"}` |

Use client id `station-{id}` with clean session off, so queued commands survive an idle period. To reach the laptop from the LTE modem, the broker needs a public address, for example a small cloud VM running Mosquitto (`mosquitto/mosquitto.conf`, then `MQTT_URL=mqtt://<host>:1883 npm start`).

## Not built yet (planned)

- TLS on port 8883 with one client certificate per station and per-station topic permissions (Section 8.5)
- PostgreSQL in place of `data/incidents.json`
- HTTPS upload endpoint for photos and push-to-talk clips; transcription in SD2
- The real wake-up SMS through the 1NCE API
- Dispatcher logins and roles
- Map tiles: the public OpenStreetMap server is for the demo only (Section 8.6); `TILE_URL` in `public/app.js` switches to a self-hosted server
