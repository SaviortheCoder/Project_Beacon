# Tests

Programs that run BEACON by themselves and check the results, so nobody has to click through the demo by hand to know it still works.

**Status:** planned. Built after the simulator's shared `station_logic.js`, which lets a test create stations directly.

| File | What it checks |
|---|---|
| `flow.test.js` | One full emergency, start to finish: alert → incident created once (even with resends) → acknowledge → station stops resending → caller reply → dispatcher text → close. Prints pass or fail for each step. |
| `scale.js` | Many stations (for example 50) alerting at once. Checks that every alert becomes exactly one incident, and measures how long each takes to reach the dispatcher's screen. |

## When to run them

- Before every push that changes the backend, the simulator or the protocol.
- After any change to `docs/protocol.md`.

Planned command: `npm test`.
