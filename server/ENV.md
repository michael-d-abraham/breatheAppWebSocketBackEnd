# Backend environment variables

## Required in production (Render)

| Variable | Notes |
|----------|--------|
| **`PORT`** | Set automatically by Render. The server **must** listen on this port. Do **not** set a fixed port in the dashboard for the app process. |

## Optional

| Variable | Default | Notes |
|----------|---------|--------|
| **`LISTEN_HOST`** | `0.0.0.0` | Bind address. Use default on Render (required for external traffic). For local-only binding you could use `127.0.0.1` (not typical). |
| **`NODE_ENV`** | unset | If `production`, used only for logging context (`production: true` in startup log). Does not change protocol behavior. |
| **`LOG_LEVEL`** | reserved | Not read by the server yet; logs are always on at `info`/`warn`/`error`. |

## Client URLs (not server env)

These are **not** read by `server/index.js`; they belong in the **mobile / web app** build (e.g. `VITE_WS_URL`, `EXPO_PUBLIC_*`):

- **Local:** `ws://localhost:8085` (or your chosen `PORT` when testing).
- **Production:** `wss://api.hellobreathbro.app` (TLS required in the browser and for typical mobile TLS stacks).

## Summary

- **Render:** Add nothing if `PORT` is injected (default). Optional: `NODE_ENV=production` for clearer logs.
- **Local:** No env required; server falls back to **8085** and `0.0.0.0`.
