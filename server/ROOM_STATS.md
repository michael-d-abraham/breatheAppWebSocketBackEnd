# Room stats API (picker / lobby)

**Stack:** Node `server/index.js`, HTTP + WebSocket in the same process (`ws` on the same `http.Server` as `PORT`).

## What the number means

Each `rooms.<id>` value is the **number of open WebSocket connections currently assigned to that room** — the same definition as `participantCount` in `snapshot` / `presence` / `phase` messages. It is **not** unique users (one person can open multiple tabs); it is **not** identities or PII.

## Canonical room keys

Exact strings (always present, even if `0`):

- `deep`
- `box`
- `extended-exhale`

## HTTP — polling

| Item | Value |
|------|--------|
| **URL** | `GET /api/rooms` |
| **Base URL (dev)** | `http://localhost:<PORT>` — default `PORT` is **8085** unless overridden by env `PORT` |
| **Full example** | `http://localhost:8085/api/rooms` |
| **Response** | `200`, `Content-Type: application/json; charset=utf-8` |

**JSON shape** (same payload as WebSocket `room_stats`):

```json
{
  "type": "room_stats",
  "serverTimeMs": 1730000000000,
  "rooms": {
    "deep": 12,
    "box": 3,
    "extended-exhale": 7
  },
  "semantics": "Each value is the number of open WebSocket connections currently assigned to that room (same as participantCount in snapshot/presence)."
}
```

**CORS:** `OPTIONS /api/rooms` returns `204` with `Access-Control-Allow-Origin: *` for browser clients. `GET` responses include `Access-Control-Allow-Origin: *`. Native mobile (Expo) typically does not need CORS.

**Freshness:** Counts reflect the server state at request time. For polling, **5–10s** is fine.

## WebSocket — live updates

**When sent**

1. **Immediately** after a WebSocket connection opens (before `join` — for pickers with no room yet).
2. **Broadcast to every connected WebSocket client** whenever any room’s membership changes (connect, disconnect, or room move via `{ "type": "join", "room": "<id>" }`).

Same JSON object as HTTP (including `type: "room_stats"`). Clients already in a session can ignore `room_stats` unless they want a global lobby view.

## Expo / env

- `EXPO_PUBLIC_API_BASE_URL` or similar — e.g. `http://localhost:8085` on device simulators; use your LAN IP for physical devices.
- `http://localhost:8085/api/rooms` for dev.

**Render / HTTPS:** use `https://your-app.onrender.com/api/rooms` and WebSocket `wss://your-app.onrender.com` (not `ws://localhost`).
