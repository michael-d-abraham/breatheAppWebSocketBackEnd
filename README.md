# Breathing room

Shared breathing sessions: a **Node** WebSocket server plus a **Vue** web UI. Three rooms (`deep`, `box`, `extended-exhale`) stay in sync per room.

## Quick start

1. **Install**

   ```bash
   npm install
   ```

2. **Config (web app)** — copy `.env.example` to `.env.local` or set:

   ```bash
   VITE_WS_URL=ws://localhost:8085
   ```

   **Production / Render:** the browser needs **`wss://`** (TLS), not `ws://localhost`. Example:

   `VITE_WS_URL=wss://your-service-name.onrender.com`  
   Set this **before** `npm run build` so Vite bakes it into the client.

3. **Run two terminals**

   | Terminal | Command        | What it does                          |
   |----------|----------------|----------------------------------------|
   | 1        | `npm start`    | HTTP + WebSocket server (default **8085**) |
   | 2        | `npm run dev`  | Vite dev server (Vue UI, usually **5173**)   |

4. Open the URL Vite prints (e.g. `http://localhost:5173`). Pick a room after the page connects.

**Port:** Locally, override with `PORT=3000 npm start` and set `VITE_WS_URL` to match (e.g. `ws://localhost:3000`).

## Deploy on Render (Web Service)

1. Create a **Web Service** connected to this repo.
2. **Build command:** `npm install`  
3. **Start command:** `npm start`  
4. Render sets **`PORT`** automatically — the server reads `process.env.PORT` (see `server/index.js`). Do **not** hardcode the port in production.
5. The server listens on **`0.0.0.0`**, which Render expects.
6. **Frontend:** build the Vue app with `VITE_WS_URL=wss://<your-render-host>.onrender.com` (same host as the service, **`wss` not `ws`**). Deploy the `dist/` folder as a static site, or host the UI elsewhere with that env at build time.
7. Optional: use [`render.yaml`](render.yaml) as a starting Blueprint.

**Room stats HTTP:** `https://<your-host>.onrender.com/api/rooms` (e.g. `https://api.hellobreathbro.app/api/rooms`)

Backend env reference: [`server/ENV.md`](server/ENV.md).

## Other commands

- `npm run build` — production build  
- `npm run preview` — preview the built app  

## API note (mobile / room picker)

Per-room headcounts before join: **`GET http://localhost:8085/api/rooms`** (same host/port as the WebSocket server). Details: [`server/ROOM_STATS.md`](server/ROOM_STATS.md).
