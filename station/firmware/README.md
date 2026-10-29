# Station firmware

The code that runs on the real ESP32-S3 inside the call box. Built with ESP-IDF on FreeRTOS. Owner: Savion. Design: midterm report §7.2–7.11.

**Status:** planned. Starts at hardware bring-up on the devkit.

## How it is organized

The firmware is a set of FreeRTOS tasks around one central event manager (report Figure 7.1). Each task owns one piece of hardware and talks to the event manager through message queues, so no two tasks share a peripheral and the order of operations is decided in one place. Each task gets its own folder in `components/`.

| Folder | Task | What it does | Priority | Core |
|---|---|---|---|---|
| `components/event_manager/` | event_manager | State machine; alert life cycle; decides what runs | Highest | 0 |
| `components/modem/` | modem_task | LTE link (esp_modem, PPP); MQTT client with TLS; SMS wake-up | High | 0 |
| `components/audio/` | audio_task | Push-to-talk recording and playback; Opus encode/decode | High | 1 |
| `components/display/` | ui_task | EVE screen display lists; touch; brightness | Medium | 1 |
| `components/sensors/` | sensor_task | ADXL345 (driver written from scratch), INA226 charge counting, TMP102 | Medium | 0 |
| `components/camera/` | camera_task | Arducam Mega photo capture into PSRAM | Medium | 1 |
| `components/power/` | power_task | Rail switching through the PCA9555; load shedding; deep sleep | Medium | 0 |
| `components/ota/` | ota_task | Download, verify and install firmware updates | Low | 0 |

`main/main.c` starts every task.

## Files to add at bring-up

| File | Purpose |
|---|---|
| `CMakeLists.txt` | ESP-IDF build file |
| `sdkconfig.defaults` | Chip settings, including Secure Boot v2 and flash encryption |
| `partitions.csv` | Two firmware slots for safe updates, plus the encrypted settings (NVS) partition |
| `main/main.c` | Starts every task |

## Build order (report §7.16)

1. **Alert spine first:** button → event manager → modem → MQTT `alert` → backend acknowledges → station stops resending. Nothing else until this works end to end.
2. Health reports and the `status` topic.
3. Screen, then sensors, power management, camera, audio, updates.

## Rules

- Send exactly what [`docs/protocol.md`](../../docs/protocol.md) says. The simulator in `station/simulator/` already does, so the backend can't tell them apart. If the firmware and the simulator disagree, one of them is breaking the protocol.
- The station's identity, location, TLS certificate and key, broker address and thresholds live in encrypted NVS, never in the code.
