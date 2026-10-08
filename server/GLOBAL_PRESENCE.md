# Global Room — presence + pulses

A single shared, ephemeral room where people appear as dots on a world map and can send each other
one gentle pulse. No chat, no profiles, no history.

**Endpoint:** `wss://<host>/global` (local: `ws://localhost:8085/global`). Same process, same port,
same deploy as the breathing rooms. Every *other* path still speaks the original breathing-room
protocol (`snapshot | phase | presence | room_stats`), so released app builds are unaffected.

Implementation: [`presence.js`](presence.js) (room logic), [`countries.js`](countries.js) (coarse
location), wired in [`index.js`](index.js).

## Joining

Connecting **is** joining — there is no handshake message. The server immediately sends a
`snapshot`. Query strings on the URL are ignored.

## Server → client

All messages are JSON text frames with a `type` field.

### `snapshot` (once, right after connect)

```json
{
  "type": "snapshot",
  "v": 1,
  "serverTimeMs": 1730000000000,
  "selfId": "q3J2h8xK9sA",
  "pulseCooldownMs": 5000,
  "participants": [
    { "id": "q3J2h8xK9sA", "lat": 35.41, "lon": 137.02 },
    { "id": "X1m0PzLw2Qk", "lat": -14.88, "lon": -49.6 }
  ]
}
```

- `participants` **includes the receiving user**; match on `selfId`.
- A lone user receives a snapshot with exactly one participant (themselves).
- `pulseCooldownMs` is the advertised per-user cooldown (≈ 5 s).

### `join`

```json
{ "type": "join", "participant": { "id": "…", "lat": 48.2, "lon": 9.1 } }
```

Sent to everyone **except** the joiner.

### `leave`

```json
{ "type": "leave", "id": "…" }
```

Sent when a participant disconnects. The server keeps no record of them afterwards. Clients that
want a fading "recently here" dot should do that locally.

### `pulse`

```json
{ "type": "pulse", "id": "…", "serverTimeMs": 1730000000123 }
```

Sent to **everyone, including the sender**. The sender's echo is their confirmation: a pulse that
was rejected never produces a `pulse` message, so the sender needs no optimistic state. Position
for the ripple comes from the participant's `lat`/`lon` already known to the client.

### `cooldown`

```json
{ "type": "cooldown", "retryAfterMs": 3200 }
```

Sent to the **sender only**, when their pulse was rejected (per-user cooldown or per-IP ceiling).
Nothing is broadcast.

## Client → server

| Message | Meaning |
|---|---|
| `{ "type": "pulse" }` | Send one pulse. |

Everything else (unknown `type`, invalid JSON, arrays, `null`) is silently ignored. Frames over
1 KB are rejected by the WebSocket layer (close code `1009`).

## Limits and safeguards

| Limit | Value | Notes |
|---|---|---|
| Per-user pulse cooldown | 5000 ms | 500 ms tolerance for network jitter, so a client that waits the advertised cooldown is never rejected. Rejected pulses do **not** extend the cooldown. |
| Per-IP pulses | 10 per 60 s | Stops reconnecting from bypassing the per-user cooldown. |
| Connections per IP | 8 | Extra sockets are closed with `1013`. |
| Participants | 1000 | Extra sockets are closed with `1013`. |
| Inbound frame | 1 KB | `1009` on exceed. |
| Heartbeat | 30 s ping/pong | Stale sockets are terminated → `leave`. |

## Reconnection

There is no resume. A reconnecting client gets a **new** session id and a **fresh** `snapshot`. The
server never stores or replays pulses; anything sent while a client was away is gone.

## Location and privacy

- The only location input is the two-letter country code Cloudflare adds to the request
  (`CF-IPCountry`). The server never sees GPS and the client never sends coordinates.
- Each connection gets **one random point near a country anchor** (jitter radius ≈ 0.2°–11°
  depending on country size), rounded to 2 decimals, held only in memory for that connection.
- Unknown country (`XX`), Tor (`T1`), or no header: a random open-ocean point, so nobody is pinned
  to a real place.
- Ids are random per connection (`crypto.randomBytes`). They are not tied to a device or account
  and are not reused.
- IPs are used only as in-memory rate-limit keys. Global-room logs contain participant **counts**
  only — never IPs, countries or coordinates.
- Nothing is persisted. A restart empties the room.

**Header trust:** `CF-IPCountry` is only meaningful behind Cloudflare. A client that talks to the
Render origin directly can send any value — the worst outcome is that they place their *own* dot
somewhere else.

## Local development

No Cloudflare locally, so every connection would land in the ocean. Set a country to test:

```bash
DEV_COUNTRY=JP npm start
```

or send the header yourself:

```bash
npx wscat -c ws://localhost:8085/global -H "cf-ipcountry: BR"
```

## Tests

```bash
npm test   # node:test — unit (countries, presence) + real-socket integration
```

The integration suite also asserts the original breathing-room protocol and `GET /api/rooms` are
unchanged, and that legacy sockets never receive Global Room traffic.
