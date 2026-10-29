# Database

The PostgreSQL design for BEACON's records. Design: midterm report §7.14.

**Status:** planned. Today the backend saves incidents to a JSON file in `backend/data/`, which is fine for the demo but not for a real deployment.

## Plan

`schema.sql` will create the tables:

- incidents
- alerts
- acknowledgments
- dispatcher messages
- transcripts
- health reports
- station configuration

Photos and voice clips do **not** go in the database. They go in an object store, keyed by station, date and incident, and the database stores only where to find them.

## Retention (report §7.14)

- Routine telemetry (health reports) expires after 90 days.
- Emergency records are never deleted automatically.

## How the switch from JSON happens

Every place in `backend/server.js` that reads or saves incidents will go through the same small set of functions (save an incident, list incidents, find one). Switching to PostgreSQL then means replacing those functions, not rewriting the backend.
