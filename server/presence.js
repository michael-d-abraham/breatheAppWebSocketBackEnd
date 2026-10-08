/**
 * Global Room — presence + pulses (ephemeral, in-memory, no history).
 *
 * One shared room. The server owns:
 *   - who is connected (an ephemeral session id + a coarse point per connection),
 *   - distributing pulses (one per user per ~5 s), and
 *   - rate limiting.
 * The client owns rendering, haptics and fade-out of departed dots.
 *
 * Privacy: the only location input is the Cloudflare country header. Nothing here is ever
 * logged or sent to other users except the coarse point. IPs are used only as in-memory
 * rate-limit keys and are never written to logs or messages.
 *
 * Wire protocol: see server/GLOBAL_PRESENCE.md.
 */

const crypto = require('crypto');
const { pointForCountry } = require('./countries');

const WS_OPEN = 1;

const PROTOCOL_VERSION = 1;

/** Advertised per-user pulse cooldown. */
const PULSE_COOLDOWN_MS = 5000;
/** Network jitter allowance so a client that waited the full cooldown is never rejected. */
const PULSE_COOLDOWN_TOLERANCE_MS = 500;

/** Hard caps — this is an intimate room, not a stadium. */
const MAX_PARTICIPANTS = 1000;
const MAX_CONNECTIONS_PER_IP = 8;

/** Per-IP pulse ceiling so reconnecting cannot bypass the per-user cooldown. */
const IP_PULSE_WINDOW_MS = 60000;
const IP_PULSE_MAX = 10;

/** Inbound messages are tiny (`{"type":"pulse"}`); the ws server also enforces this as maxPayload. */
const MAX_MESSAGE_BYTES = 1024;

const noopLog = { info() {}, warn() {} };

function defaultNewId() {
  return crypto.randomBytes(8).toString('base64url');
}

function clientIp(req) {
  const headers = (req && req.headers) || {};
  const cf = headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xf = headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  return (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

function countryOf(req, fallbackCountry) {
  const headers = (req && req.headers) || {};
  const fromHeader = headers['cf-ipcountry'];
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader;
  return fallbackCountry;
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now]            Clock (ms). Injected for tests.
 * @param {() => number} [options.random]         Uniform [0,1). Injected for tests.
 * @param {() => string} [options.newId]          Session id factory.
 * @param {string}       [options.fallbackCountry] Used only when no CF header (local dev).
 * @param {{info: Function, warn: Function}} [options.log]
 */
function createPresenceRoom(options = {}) {
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const newId = options.newId || defaultNewId;
  const fallbackCountry = options.fallbackCountry;
  const log = options.log || noopLog;

  /** socket -> { id, lat, lon, lastPulseAt, ip } */
  const participants = new Map();
  /** ip -> open connection count (memory only) */
  const ipConnections = new Map();
  /** ip -> recent accepted pulse timestamps (memory only) */
  const ipPulses = new Map();

  function send(ws, payload) {
    if (ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      log.warn('global send failed', { message: err && err.message });
    }
  }

  function broadcast(payload, except) {
    const text = JSON.stringify(payload);
    for (const socket of participants.keys()) {
      if (socket === except || socket.readyState !== WS_OPEN) continue;
      try {
        socket.send(text);
      } catch (err) {
        log.warn('global broadcast failed', { message: err && err.message });
      }
    }
  }

  function publicView(p) {
    return { id: p.id, lat: p.lat, lon: p.lon };
  }

  function buildSnapshot(selfId) {
    return {
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      serverTimeMs: now(),
      selfId,
      pulseCooldownMs: PULSE_COOLDOWN_MS,
      participants: Array.from(participants.values(), publicView),
    };
  }

  /** Drop stale per-IP pulse buckets so memory stays bounded on a long-lived process. */
  function sweepIpPulses(t) {
    for (const [ip, stamps] of ipPulses) {
      const newest = stamps[stamps.length - 1];
      if (newest === undefined || t - newest >= IP_PULSE_WINDOW_MS) ipPulses.delete(ip);
    }
  }

  function retryAfter(ms) {
    return Math.max(1, Math.ceil(ms));
  }

  function handlePulse(ws, p) {
    const t = now();

    if (p.lastPulseAt != null) {
      const elapsed = t - p.lastPulseAt;
      if (elapsed < PULSE_COOLDOWN_MS - PULSE_COOLDOWN_TOLERANCE_MS) {
        send(ws, { type: 'cooldown', retryAfterMs: retryAfter(PULSE_COOLDOWN_MS - elapsed) });
        return;
      }
    }

    const stamps = (ipPulses.get(p.ip) || []).filter((s) => t - s < IP_PULSE_WINDOW_MS);
    if (stamps.length >= IP_PULSE_MAX) {
      ipPulses.set(p.ip, stamps);
      send(ws, {
        type: 'cooldown',
        retryAfterMs: retryAfter(stamps[0] + IP_PULSE_WINDOW_MS - t),
      });
      return;
    }
    stamps.push(t);
    ipPulses.set(p.ip, stamps);

    p.lastPulseAt = t;
    // Everyone, including the sender: the echo is the sender's confirmation, so a rejected
    // pulse never ripples and the sender needs no optimistic state.
    broadcast({ type: 'pulse', id: p.id, serverTimeMs: t });
  }

  function parseMessage(raw) {
    if (raw == null) return null;
    const text = typeof raw === 'string' ? raw : raw.toString();
    if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) return null;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  }

  function removeParticipant(ws) {
    const p = participants.get(ws);
    if (!p) return;
    participants.delete(ws);
    const remaining = (ipConnections.get(p.ip) || 1) - 1;
    if (remaining > 0) ipConnections.set(p.ip, remaining);
    else ipConnections.delete(p.ip);
    broadcast({ type: 'leave', id: p.id });
    log.info('global leave', { participants: participants.size });
  }

  /** Attach a freshly upgraded socket to the room. */
  function handleConnection(ws, req) {
    const ip = clientIp(req);

    if (participants.size >= MAX_PARTICIPANTS || (ipConnections.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP) {
      try {
        ws.close(1013, 'try again later');
      } catch {
        // ignore
      }
      return;
    }

    sweepIpPulses(now());

    const point = pointForCountry(countryOf(req, fallbackCountry), random);
    const p = { id: newId(), lat: point.lat, lon: point.lon, lastPulseAt: null, ip };
    participants.set(ws, p);
    ipConnections.set(ip, (ipConnections.get(ip) || 0) + 1);

    ws.on('message', (raw) => {
      const msg = parseMessage(raw);
      if (!msg) return;
      if (msg.type === 'pulse') handlePulse(ws, p);
      // Unknown types are ignored on purpose: no chat, no reactions, no typing indicators.
    });
    ws.on('close', () => removeParticipant(ws));
    ws.on('error', (err) => {
      log.warn('global socket error', { message: err && err.message });
    });

    send(ws, buildSnapshot(p.id));
    broadcast({ type: 'join', participant: publicView(p) }, ws);
    log.info('global join', { participants: participants.size });
  }

  function closeAll() {
    for (const socket of participants.keys()) {
      try {
        socket.close(1001, 'server shutting down');
      } catch {
        // ignore
      }
    }
  }

  return {
    handleConnection,
    closeAll,
    size: () => participants.size,
  };
}

module.exports = {
  IP_PULSE_MAX,
  IP_PULSE_WINDOW_MS,
  MAX_CONNECTIONS_PER_IP,
  MAX_MESSAGE_BYTES,
  MAX_PARTICIPANTS,
  PROTOCOL_VERSION,
  PULSE_COOLDOWN_MS,
  PULSE_COOLDOWN_TOLERANCE_MS,
  createPresenceRoom,
};
