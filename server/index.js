/**
 * Breathing room — Node WebSocket server
 *
 * Multiple rooms share one process; each room has its own breath timeline and connections.
 * Protocol: snapshot | phase | presence (JSON on the wire).
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const LISTEN_PORT = Number(process.env.PORT) || 8085;
const WS_OPEN = 1;

/** Seconds per step: inhale, hold1, exhale, hold2 — same shape as useBreathingCycle. */
const ROOM_PATTERNS = {
  deep: { inhaleSec: 6, hold1Sec: 0, exhaleSec: 6, hold2Sec: 0 },
  box: { inhaleSec: 4, hold1Sec: 4, exhaleSec: 4, hold2Sec: 4 },
  'extended-exhale': { inhaleSec: 4, hold1Sec: 0, exhaleSec: 6, hold2Sec: 0 },
};


// my app expects patterns is milliseconds
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

// OUTGOING DATA — websocket "protocal" 
//
// | type        | When sent                         | Main purpose |
// |-------------|-----------------------------------|--------------|
// | snapshot    | New connection; after client join | Full state + pattern + count |
// | phase       | Each breath step boundary         | Timing + phase + participantCount |
// | presence    | Someone connects or disconnects   | participantCount only |
// | room_stats  | New WS connection; any room count change | All canonical room sizes (picker / lobby) |
//
// All timing messages include serverTimeMs + phaseEndsAtMs so clients can sync clocks.



// Full picture of current States
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

// On one phase information 
// send every time the phase moves to the next step. 
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

// On someone connects or disconnects
// send the participantCount only
function buildPresenceMessage(room) {
  return {
    type: 'presence',
    serverTimeMs: Date.now(),
    roomId: room.id,
    participantCount: room.connections.size,
  };
}

function sendJsonToRoom(room, payload) {
  const text = JSON.stringify(payload);
  for (const socket of room.connections) {
    if (socket.readyState === WS_OPEN) socket.send(text);
  }
}

/** Same numbers as participantCount in snapshot/presence: open WS connections assigned to each room. */
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
// Assign socket to a room (join / default on connect)
// -----------------------------------------------------------------------------

function assignSocketToRoom(socket, rawRoomId) {
  const id = normalizeRoomId(rawRoomId);
  const room = rooms[id];
  const prevId = socket.__breathRoomId;

  if (prevId === id) {
    if (socket.readyState === WS_OPEN) {
      socket.send(JSON.stringify(buildSnapshotMessage(room)));
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
    socket.send(JSON.stringify(buildSnapshotMessage(room)));
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

const wss = new WebSocketServer({ server });

// CONNECTION PIPELINE — stages when a client connects over WebSocket

//
// 1. TCP accepted → HTTP upgrade → WebSocket OPEN
// 2. Immediate room_stats JSON (all canonical room counts) for pickers not yet joined
// 3. Socket is not in any room until the client sends { type: "join", room: "<id>" }
// 4. On join / room move / disconnect → membership changes; room_stats broadcast to every WS client
// 5. On join → assign room, broadcast presence to that room, send snapshot to that client

function broadcastRoomStatsToAll() {
  const text = JSON.stringify(buildRoomStatsMessage());
  for (const client of wss.clients) {
    if (client.readyState === WS_OPEN) client.send(text);
  }
}

wss.on('connection', (socket) => {
  if (socket.readyState === WS_OPEN) {
    socket.send(JSON.stringify(buildRoomStatsMessage()));
  }

  socket.on('message', (rawBuffer) => {
    let parsed;
    try {
      parsed = JSON.parse(rawBuffer.toString());
    } catch {
      return;
    }
    if (parsed && parsed.type === 'join') {
      assignSocketToRoom(socket, parsed.room);
    }
  });

  socket.on('close', () => {
    removeSocketFromRoom(socket);
  });
});

/** Render (and many hosts) require binding to all interfaces; PORT comes from the platform. */
const LISTEN_HOST = process.env.LISTEN_HOST || '0.0.0.0';

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`Server running on port ${LISTEN_PORT}`);
  for (const id of Object.keys(rooms)) {
    const room = rooms[id];
    room.currentStepEndsAtMs = Date.now() + room.steps[room.stepIndexInCycle].durationMs;
    scheduleNextBoundary(room);
  }
  console.log(`Breathing rooms: ${Object.keys(rooms).join(', ')} — GET /api/rooms for per-room counts`);
});
