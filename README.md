# B.E.A.C.O.N.

**Battery-Backed Emergency Alert, Call & Observation Network** — a solar-powered, cellular-connected campus safety call station. UCF Senior Design, Group 23 (EEL 4914, Fall 2026).

A person presses the button on a station. The alert travels over LTE to the backend, which opens an incident and shows it on the dispatcher's screen. The dispatcher acknowledges, talks to the caller, and closes the incident. The design is described in full in the midterm report.

## How the pieces connect

```
station  ──►  broker  ──►  backend  ──►  frontend_console
(call box)    (MQTT)       (the brain)   (dispatcher's screen)
```

Stations and the backend never talk directly. They send messages through the MQTT broker using the topics in [`docs/protocol.md`](docs/protocol.md). The backend and the dispatcher's screen talk over a WebSocket.

## Folder guide

| Folder | What lives here | Report |
|---|---|---|
| `config/` | Settings every part reads: station list, broker settings, encryption keys | §7.7, §8.5 |
| `station/simulator/` | A call box made of software, for demos and testing. Sends exactly what the firmware will send | §7.7 |
| `station/firmware/` | The real ESP32-S3 code (ESP-IDF + FreeRTOS) | §7.2–7.11 |
| `hardware/` | PCB design files (main board, power board) and the enclosure CAD | Ch. 6 |
| `backend/` | Receives station messages, runs each incident, feeds the dispatcher's screen | §7.12 |
| `frontend_console/` | The dispatcher's screen ("dispatch console" in the report) | §7.13 |
| `tests/` | Programs that run BEACON by themselves and check the results | Ch. 10 |
| `deploy/` | Running BEACON on a real server instead of a laptop | §7.14 |
| `docs/` | Message rules (`protocol.md`) and the encryption plan (`security.md`) | §7.7, §8.5 |

### Station: simulator vs. firmware

- **firmware/** is the code that runs on the real ESP32-S3 inside the call box.
- **simulator/** is a call box made of software. It sends exactly the same messages as the firmware, so the backend cannot tell them apart.
- Use the simulator to build and test the backend and the dispatcher's screen without hardware, to run many stations at once for scale testing, and as a backup during demos. Use the firmware for the real station.
- **Rule:** if a message changes, update `docs/protocol.md` first, then both the firmware and the simulator.

## Run the demo

Needs Node.js 18 or newer. Everything runs on one laptop with no hardware.

```bash
npm install
npm start                 # terminal 1: backend + built-in broker + dispatcher's screen
npm run station           # terminal 2: terminal station st07
```

Open http://localhost:3000, then press `a` in the station terminal. The console needs internet for the map tiles and, on first start, the landmark lookup; without it, alerts and messages still work and the location shows as coordinates. The alert appears on the map and the console beeps (click the page once first so the browser allows sound). Click **Acknowledge** or press Space, send a message, then close the incident. The station terminal prints what its ring, screen and strobe would do.

### Browser station (no terminal needed)

With `npm start` running, open http://localhost:3000/station next to the dispatcher's screen. Click **Someone walks up** to wake the screen, then click the red button (or touch EMERGENCY on the screen). Acknowledge in the console and the station shows "Help is on the way"; dispatcher messages appear in large type, and the caller answers with the on-screen buttons. During a call, press and hold the red button to "talk" (the simulator sends a note in place of audio until Senior Design II).

The side panel simulates tamper, a loud bang, going idle (commands are queued and delivered on wake), and losing power (the console marks the station offline from its last will). A second station: http://localhost:3000/station?id=st03.

> **Run each station id only once.** The terminal station and the browser station both default to `st07`. Two copies of the same id knock each other off the broker every 2 seconds, and the console flips between online and offline. Use `?id=st03` for the browser station while the terminal station is running.

### Terminal station

Keys: `a` alert · `t` tamper · `s` sound flag · `o` "I'm OK" · `m` "I need medical help" · `i` go idle · `w` wake · `x` crash (tests the last-will message) · `q` quit.

- Second station: `npm run station2` (st03).
- Hands-free alert for screen recordings: `npm run station -- --auto`.
- Stations and their map positions: `config/stations.json`.
- Health reports default to every 30 s so the missed-report fault shows quickly. Change with `HEALTH_INTERVAL_S=60 npm start` (the real station reports every 4 h).

## What already works

| Behavior | Report |
|---|---|
| Station resends the alert every 5 s until acknowledged; backend matches on the alert id, so a resend never makes a second incident | Table 7.3 |
| Incident states New → Acknowledged → Resolved | §7.12 |
| `ack` and `cmd` (text, close, ping) go back to the station with QoS 1 | Table 7.6 |
| Persistent sessions: a command sent to an idle station is held by the broker and delivered when it reconnects; the backend logs where the wake-up SMS would go | §7.7.3 |
| Retained `status` topic: `online`, `idle` before a normal disconnect, last-will `offline` on a crash | Table 7.6 |
| Fault after two missed health reports | §7.12 |
| Caller replies ("I'm OK", "I need medical help") shown in the conversation | §2.3.1 |
| Vector map (MapLibre) with a dark style, 3D buildings, road and place labels; opens framed on the stations in `config/stations.json` | §7.13 |
| Incident location in words: nearest landmark, road, nearest AED and police, looked up from OpenStreetMap and cached weekly | §7.13 |

## Known bugs

- **Online/offline flapping** when two copies of the same station id run at once (see the warning above). This is the broker doing its job; the backend logs a warning naming the station.

## Not built yet

- TLS on port 8883 with one client certificate per station and per-station topic permissions — see `docs/security.md` (§8.5)
- PostgreSQL in place of the JSON file in `backend/data/` — see `backend/db/`
- HTTPS upload endpoint for photos and push-to-talk clips; transcription in Senior Design II
- The real wake-up SMS through the 1NCE API
- Dispatcher logins and roles
- Self-hosted map tiles: the console uses the free OpenFreeMap vector tiles for the demo (§8.6); `TILES` and `GLYPHS` at the top of `frontend_console/map_style.js` switch to a self-hosted file
- Landmark lookups use the public Overpass API once a week per station area (cached in `backend/data/landmarks.json`); a deployment would run its own
