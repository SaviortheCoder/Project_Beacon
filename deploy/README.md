# Deploy

Running BEACON on a real server instead of a laptop, so real stations can reach it over LTE.

**Status:** planned. Needed when the first real station connects from outside the lab.

| File | Purpose |
|---|---|
| `docker-compose.yml` | Starts the Mosquitto broker, the backend and PostgreSQL together with one command |
| `Caddyfile` | Serves the dispatcher's screen over HTTPS with an automatic certificate |

## What changes from the laptop demo

| | Laptop demo | Deployed |
|---|---|---|
| Broker | Built into the backend, port 1883, no encryption | Mosquitto, port 8883, TLS, one certificate per station |
| Storage | JSON file in `backend/data/` | PostgreSQL, encrypted disk |
| Dispatcher's screen | http://localhost:3000, no login | HTTPS, dispatcher logins |
| Address | The laptop | A cloud server with a public address |

The same code runs in both. Only the settings change. See [`docs/security.md`](../docs/security.md) for the encryption details.
