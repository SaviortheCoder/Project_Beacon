# Message protocol

The rules every part of BEACON follows when it talks over MQTT. The real firmware, both simulators and the backend all send and expect exactly what is written here. This is the single source of truth for messages (midterm report §7.7, Table 7.6).

**Rule:** change this file first, then change the firmware, the simulator and the backend to match.

## Quick terms

- **Topic** — the address a message is sent to, like `beacon/st07/alert`.
- **QoS 0** — sent once, no confirmation. Used where losing one message is harmless.
- **QoS 1** — delivered at least once; the broker retries until the receiver confirms. Used for anything that matters.
- **Retained** — the broker keeps the last message on the topic and hands it to anyone who subscribes later.
- **Last will** — a message a station leaves with the broker when it connects. If the station disappears without saying goodbye, the broker publishes it for the station.

## Topics

Every topic starts with `beacon/{station_id}/`.

| Topic | Direction | QoS | Payload |
|---|---|---|---|
| `alert` | station → backend | 1 | `{"v":1,"id":"st07-000123","station":"st07","ts":"…","trigger":"button","lat":28.6024,"lon":-81.2001,"loc_src":"surveyed","soc":86,"batt_v":13.28,"temp_c":31.5,"rssi_dbm":-87,"fw":"0.3.1"}` |
| `event/tamper`, `event/acoustic` | station → backend | 1 | same fields as `alert`, plus the sensor data |
| `health` | station → backend | 0 | `soc`, `batt_v`, `solar_w`, `temp_c`, `rssi_dbm`, `uptime_s`, `fw` |
| `status` (retained) | station → broker | 1 | plain text `online` / `idle`; last will `offline` |
| `reply` | station → backend | 1 | `{"incident":"inc-00001","text":"I'm OK"}` |
| `ack` | backend → station | 1 | `{"incident":"inc-00001","alert":"st07-000123"}` |
| `cmd` | backend → station | 1 | `{"type":"text","text":"…"}`, `{"type":"close"}`, `{"type":"ping"}` |

> The `reply` topic is in the code but not yet in Table 7.6 of the report. Add it there.

## Rules for every station

- **Client id:** `station-{id}`, with clean session **off**, so commands queued while the station is idle are delivered when it reconnects.
- **Only one connection per station id.** A second connection with the same id knocks the first off the broker.
- **On connect:** set the last will (`status` = `offline`, retained), publish `status` = `online` (retained), subscribe to `ack` and `cmd`.
- **Alerts:** give each alert a unique `id` and resend it every 5 s until an `ack` with that id arrives (Table 7.3).
- **Going idle:** publish `status` = `idle` (retained) before disconnecting, so the backend knows the station is asleep rather than lost.

## Connecting the real ESP32

Point the firmware at the backend's broker on port 1883 (Wi-Fi first, then LTE through the modem) and publish the same JSON to the same topics. To reach a laptop from the LTE modem, the broker needs a public address, for example a small cloud server running Mosquitto with `config/mosquitto.conf`, then `MQTT_URL=mqtt://<host>:1883 npm start`.

Before deployment the broker moves to port 8883 with TLS and one certificate per station. See `docs/security.md`.
