/**
 * Breathing room — Node WebSocket server
 *
 * Multiple rooms share one process; each room has its own breath timeline and connections.
 * Protocol: snapshot | phase | presence | room_stats (JSON on the wire).
 *
 * Environment (see server/ENV.md):
 *   PORT        — required in production (Render sets automatically); local default 8085
 *   LISTEN_HOST — optional bind address (default 0.0.0.0)
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const LISTEN_PORT = Number(process.env.PORT) || 8085;
const WS_OPEN = 1;

const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const MAX_ROOM_STRING_LEN = 64;
const HEARTBEAT_MS = 30000;

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function logInfo(msg, meta) {
  const line = meta != null ? `${msg} ${JSON.stringify(meta)}` : msg;
  console.log(`[breath] ${new Date().toISOString()} ${line}`);
}

function logWarn(msg, meta) {
  const line = meta != null ? `${msg} ${JSON.stringify(meta)}` : msg;
  console.warn(`[breath] ${new Date().toISOString()} ${line}`);
}

function logError(msg, err, meta) {
  const line = meta != null ? `${msg} ${JSON.stringify(meta)}` : msg;
  if (err != null && typeof err === 'object' && err.message) {
    console.error(`[breath] ${new Date().toISOString()} ${line}`, err.stack || err.message);
  } else if (err != null) {
    console.error(`[breath] ${new Date().toISOString()} ${line}`, err);
  } else {
    console.error(`[breath] ${new Date().toISOString()} ${line}`);
  }
}

/** Seconds per step: inhale, hold1, exhale, hold2 — same shape as useBreathingCycle. */
const ROOM_PATTERNS = {
  deep: { inhaleSec: 6, hold1Sec: 0, exhaleSec: 6, hold2Sec: 0 },
  box: { inhaleSec: 4, hold1Sec: 4, exhaleSec: 4, hold2Sec: 4 },
  'extended-exhale': { inhaleSec: 4, hold1Sec: 0, exhaleSec: 6, hold2Sec: 0 },
};

function buildStepsFromPatternSeconds(patternSec) {
  return [
    { name: 'inhale', durationMs: patternSec.inhaleSec * 1000 },
    { name: 'hold1', durationMs: patternSec.hold1Sec * 1000 },
    { name: 'exhale', durationMs: patternSec.exhaleSec * 1000 },
    { name: 'hold2', durationMs: patternSec.hold2Sec * 1000 },
  ];
}

/** Map client join strings to canonical room ids (unknown → deep). */
function normalizeRoomId(raw) {
  if (!raw || typeof raw !== 'string') return 'deep';
  const r = raw.toLowerCase().trim();
  if (r === 'global') return 'deep';
  if (r === 'extended' || r === 'extended_exhale') return 'extended-exhale';
  if (ROOM_PATTERNS[r]) return r;
  return 'deep';
}

function createRoom(roomId) {
  const patternSeconds = { ...ROOM_PATTERNS[roomId] };
  const steps = buildStepsFromPatternSeconds(patternSeconds);
  return {
    id: roomId,
    patternSeconds,
    steps,
    stepIndexInCycle: 0,
    completedBreathLoops: 0,
    phaseSequence: 1,
    currentStepEndsAtMs: Date.now() + steps[0].durationMs,
    boundaryTimerId: null,
    connections: new Set(),
  };
}

const rooms = {};
for (const id of Object.keys(ROOM_PATTERNS)) {
  rooms[id] = createRoom(id);
}

function buildSnapshotMessage(room) {
  const serverTimeMs = Date.now();
  const step = room.steps[room.stepIndexInCycle];
  return {
    type: 'snapshot',
    serverTimeMs,
    roomId: room.id,
    participantCount: room.connections.size,
    pattern: { ...room.patternSeconds },
    phase: step.name,
    phaseSeq: room.phaseSequence,
    cycleIndex: room.completedBreathLoops,
    phaseDurationMs: step.durationMs,
    phaseEndsAtMs: room.currentStepEndsAtMs,
  };
}

function buildPhaseMessage(room) {
  const serverTimeMs = Date.now();
  const step = room.steps[room.stepIndexInCycle];
  return {
    type: 'phase',
    serverTimeMs,
    roomId: room.id,
    participantCount: room.connections.size,
    phase: step.name,
    phaseSeq: room.phaseSequence,
    cycleIndex: room.completedBreathLoops,
    phaseDurationMs: step.durationMs,
    phaseEndsAtMs: room.currentStepEndsAtMs,
  };
}

function buildPresenceMessage(room) {
  return {
    type: 'presence',
    serverTimeMs: Date.now(),
    roomId: room.id,
    participantCount: room.connections.size,
  };
}

function safeSend(ws, text) {
  if (ws.readyState !== WS_OPEN) return;
  try {
    ws.send(text);
  } catch (err) {
    logWarn('websocket send failed', { message: err.message });
  }
}

function sendJsonToRoom(room, payload) {
  const text = JSON.stringify(payload);
  for (const socket of room.connections) {
    safeSend(socket, text);
  }
}

function buildRoomStatsMessage() {
  const roomsOut = {};
  for (const id of Object.keys(ROOM_PATTERNS)) {
    roomsOut[id] = rooms[id].connections.size;
  }
  return {
    type: 'room_stats',
    serverTimeMs: Date.now(),
    rooms: roomsOut,
    semantics:
      'Each value is the number of open WebSocket connections currently assigned to that room (same as participantCount in snapshot/presence).',
  };
}

// -----------------------------------------------------------------------------
// Timeline (per room)
// -----------------------------------------------------------------------------

function moveToNextBreathStep(room) {
  const previousIndex = room.stepIndexInCycle;
  room.stepIndexInCycle = (room.stepIndexInCycle + 1) % room.steps.length;
  room.phaseSequence += 1;
  if (previousIndex === 3 && room.stepIndexInCycle === 0) {
    room.completedBreathLoops += 1;
  }
}

function setEndTimeForCurrentStep(room) {
  const durationMs = room.steps[room.stepIndexInCycle].durationMs;
  room.currentStepEndsAtMs = durationMs === 0 ? Date.now() : Date.now() + durationMs;
}

function cancelScheduledBoundary(room) {
  if (room.boundaryTimerId) {
    clearTimeout(room.boundaryTimerId);
    room.boundaryTimerId = null;
  }
}

function scheduleNextBoundary(room) {
  cancelScheduledBoundary(room);
  const delayMs = Math.max(0, room.currentStepEndsAtMs - Date.now());
  room.boundaryTimerId = setTimeout(() => onScheduledBoundary(room), delayMs);
}

function onScheduledBoundary(room) {
  moveToNextBreathStep(room);
  setEndTimeForCurrentStep(room);
  sendJsonToRoom(room, buildPhaseMessage(room));

  while (room.steps[room.stepIndexInCycle].durationMs === 0) {
    moveToNextBreathStep(room);
    setEndTimeForCurrentStep(room);
    sendJsonToRoom(room, buildPhaseMessage(room));
  }

  scheduleNextBoundary(room);
}

// -----------------------------------------------------------------------------
// Assign socket to a room (join)
// -----------------------------------------------------------------------------

function assignSocketToRoom(socket, rawRoomId) {
  const id = normalizeRoomId(rawRoomId);
  const room = rooms[id];
  const prevId = socket.__breathRoomId;

  if (prevId === id) {
    if (socket.readyState === WS_OPEN) {
      safeSend(socket, JSON.stringify(buildSnapshotMessage(room)));
    }
    return;
  }

  if (prevId && rooms[prevId]) {
    rooms[prevId].connections.delete(socket);
    sendJsonToRoom(rooms[prevId], buildPresenceMessage(rooms[prevId]));
  }

  socket.__breathRoomId = id;
  room.connections.add(socket);
  sendJsonToRoom(room, buildPresenceMessage(room));
  if (socket.readyState === WS_OPEN) {
    safeSend(socket, JSON.stringify(buildSnapshotMessage(room)));
  }
  broadcastRoomStatsToAll();
}

function removeSocketFromRoom(socket) {
  const id = socket.__breathRoomId;
  if (!id || !rooms[id]) return;
  rooms[id].connections.delete(socket);
  socket.__breathRoomId = undefined;
  sendJsonToRoom(rooms[id], buildPresenceMessage(rooms[id]));
  broadcastRoomStatsToAll();
}

// -----------------------------------------------------------------------------
// HTTP + WebSocket
// -----------------------------------------------------------------------------

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
};

const server = http.createServer((req, res) => {
  const pathname = (req.url || '').split('?')[0];

  if (req.method === 'OPTIONS' && pathname === '/api/rooms') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/api/rooms') {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(buildRoomStatsMessage()));
    return;
  }

  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('WebSocket backend is running');
    return;
  }

  if (pathname === '/health' || pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
  clientTracking: true,
});

function broadcastRoomStatsToAll() {
  const text = JSON.stringify(buildRoomStatsMessage());
  for (const client of wss.clients) {
    safeSend(client, text);
  }
}

/** Validate join payload; ignore unknown message shapes safely. */
function parseJoinMessage(rawBuffer) {
  if (!rawBuffer || rawBuffer.length > MAX_WS_MESSAGE_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawBuffer.toString());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.type !== 'join') return null;
  const room = parsed.room;
  if (room != null && typeof room !== 'string') return null;
  if (typeof room === 'string' && room.length > MAX_ROOM_STRING_LEN) return null;
  return { room };
}

function clientLabel(req) {
  const xf = req.headers['x-forwarded-for'];
  const fromXf = typeof xf === 'string' ? xf.split(',')[0].trim() : '';
  return fromXf || req.socket?.remoteAddress || 'unknown';
}

let heartbeatTimer = null;

function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        logInfo('websocket terminating stale client');
        try {
          ws.terminate();
        } catch (err) {
          logWarn('terminate failed', { message: err.message });
        }
        return;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (err) {
        logWarn('ping failed', { message: err.message });
      }
    });
  }, HEARTBEAT_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

wss.on('connection', (ws, req) => {
  const label = clientLabel(req);
  ws.__clientLabel = label;
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  logInfo('websocket client connected', { client: label, clients: wss.clients.size });

  safeSend(ws, JSON.stringify(buildRoomStatsMessage()));

  ws.on('message', (rawBuffer) => {
    const join = parseJoinMessage(rawBuffer);
    if (join == null) {
      if (rawBuffer && rawBuffer.length > MAX_WS_MESSAGE_BYTES) {
        logWarn('websocket message rejected (too large)', { client: label, bytes: rawBuffer.length });
      }
      return;
    }
    logInfo('websocket message received', { client: label, type: 'join', roomLen: join.room ? join.room.length : 0 });
    try {
      assignSocketToRoom(ws, join.room);
    } catch (err) {
      logError('assignSocketToRoom failed', err, { client: label });
    }
  });

  ws.on('close', (code, reason) => {
    const r = reason && reason.length ? reason.toString() : '';
    logInfo('websocket client disconnected', { client: label, code, reason: r || undefined });
    try {
      removeSocketFromRoom(ws);
    } catch (err) {
      logError('removeSocketFromRoom failed', err, { client: label });
    }
  });

  ws.on('error', (err) => {
    logError('websocket socket error', err, { client: label });
  });
});

wss.on('error', (err) => {
  logError('WebSocketServer error', err);
});

server.on('error', (err) => {
  logError('HTTP server error', err);
  process.exit(1);
});

/** Render (and many hosts) require binding to all interfaces; PORT comes from the platform. */
const LISTEN_HOST = process.env.LISTEN_HOST || '0.0.0.0';

function startBreathTimers() {
  for (const id of Object.keys(rooms)) {
    const room = rooms[id];
    room.currentStepEndsAtMs = Date.now() + room.steps[room.stepIndexInCycle].durationMs;
    scheduleNextBoundary(room);
  }
}

function shutdown(signal) {
  logInfo('shutdown', { signal });
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const id of Object.keys(rooms)) {
    cancelScheduledBoundary(rooms[id]);
  }
  try {
    wss.close(() => {});
  } catch (err) {
    logWarn('wss.close', { message: err.message });
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  logInfo('server started', {
    port: LISTEN_PORT,
    host: LISTEN_HOST,
    nodeEnv: process.env.NODE_ENV || 'development',
    production: IS_PRODUCTION,
  });
  startBreathTimers();
  startHeartbeat();
  logInfo('breath timers running', { rooms: Object.keys(rooms) });
  logInfo('http routes', { root: '/', health: '/health, /healthz', roomStats: 'GET /api/rooms' });
});
