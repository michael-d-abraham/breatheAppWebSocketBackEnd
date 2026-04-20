# Breathing room

Shared breathing sessions: a **Node** WebSocket server plus a **Vue** web UI. Three rooms (`deep`, `box`, `extended-exhale`) stay in sync per room.

## Quick start

1. **Install**

   ```bash
   npm install
   ```

2. **Config (web app)** — create `.env.local` in the project root:

   ```bash
   VITE_WS_URL=ws://localhost:8085
   ```

3. **Run two terminals**

   | Terminal | Command        | What it does                          |
   |----------|----------------|----------------------------------------|
   | 1        | `npm start`    | HTTP + WebSocket server (default **8085**) |
   | 2        | `npm run dev`  | Vite dev server (Vue UI, usually **5173**)   |

4. Open the URL Vite prints (e.g. `http://localhost:5173`). Pick a room after the page connects.

**Port:** Override the server with `PORT=3000 npm start` — then set `VITE_WS_URL` to match (e.g. `ws://localhost:3000`).

## Other commands

- `npm run build` — production build  
- `npm run preview` — preview the built app  

## API note (mobile / room picker)

Per-room headcounts before join: **`GET http://localhost:8085/api/rooms`** (same host/port as the WebSocket server). Details: [`server/ROOM_STATS.md`](server/ROOM_STATS.md).
