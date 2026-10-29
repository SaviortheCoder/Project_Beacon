# Security plan

How BEACON is locked down, in one place. Design: midterm report §8.5 (Table 8.4).

**Status:** planned. The laptop demo runs with no encryption on purpose, so it needs no setup. Everything below is switched on for deployment.

## What is protected, how, and where it lives

| What | How | Where it lives |
|---|---|---|
| Messages between station and broker | TLS on port 8883. Every station has its own certificate; the broker rejects unknown certificates | `config/mosquitto.conf`, `config/keys/` |
| Which topics a station may use | Each station may use only `beacon/<its id>/#` | `config/acl.conf` |
| The station's own key | Stored in encrypted NVS; flash encryption on | `station/firmware/sdkconfig.defaults`, `partitions.csv` |
| Firmware updates | Secure Boot v2 signature check; updates only from the backend; automatic rollback on a failed self-test | `station/firmware/`, `components/ota/` |
| Photos and voice clips in transit | Uploaded over HTTPS | backend |
| Dispatcher's screen | HTTPS; dispatcher logins and roles | `deploy/Caddyfile`, backend |
| Stored incidents, photos, audio | Encrypted disk; role-based access; audit log of every access | `deploy/docker-compose.yml` |
| Wake-up SMS | Accepted only from the backend's number with a one-time code; it can only open a session, never command anything | firmware `components/modem/`, backend |

## Rules

- **Keys and certificates are never committed.** `config/keys/` is ignored by git; only its placeholder is tracked.
- **No remote "listen" command exists.** The microphone records only while the caller holds the button, or after an impulsive sound.
- **A stolen station is cut off at the broker** by revoking its certificate. Other stations are unaffected.

## Broker settings for deployment (`config/mosquitto.conf`)

```
listener 8883
cafile   config/keys/ca.crt
certfile config/keys/server.crt
keyfile  config/keys/server.key
require_certificate true
use_identity_as_username true
acl_file config/acl.conf
allow_anonymous false
```

Planned command to create the certificates: `npm run keys`.
