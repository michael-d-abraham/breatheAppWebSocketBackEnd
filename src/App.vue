<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';

const url = import.meta.env.VITE_WS_URL;

/** Must match server ROOM_PATTERNS keys + join aliases handled on server. */
const ROOM_OPTIONS = [
  { id: 'deep', label: 'Deep breathing' },
  { id: 'box', label: 'Box breathing (4-4-4-4)' },
  { id: 'extended-exhale', label: 'Extended exhale (4-0-6-0)' },
];

const selectedRoomId = ref('deep');

const status = ref('Disconnected');
const reconnectAttempts = ref(0);
const maxReconnects = 5;
const reconnectDelayMs = 2000;

/** Clock sync: serverNow ≈ Date.now() + serverOffsetMs (updated on each message with serverTimeMs). */
const serverOffsetMs = ref(0);

const roomId = ref('deep');
const participantCount = ref(0);
const pattern = ref(null);

const phase = ref('—');
const phaseSeq = ref(0);
const cycleIndex = ref(0);
const phaseDurationMs = ref(0);
const phaseEndsAtMs = ref(0);

const nowMs = ref(Date.now());
let tickTimer = null;

let ws = null;
let reconnectTimer = null;
let allowReconnect = true;

const PHASE_LABELS = {
  inhale: 'Inhale',
  hold1: 'Hold',
  exhale: 'Exhale',
  hold2: 'Hold',
};

function applyServerTime(serverTimeMs) {
  if (typeof serverTimeMs === 'number') {
    serverOffsetMs.value = serverTimeMs - Date.now();
  }
}

function applySyncPayload(data) {
  applyServerTime(data.serverTimeMs);
  if (typeof data.participantCount === 'number') participantCount.value = data.participantCount;
  if (data.roomId != null) roomId.value = data.roomId;
  if (data.pattern && typeof data.pattern === 'object') pattern.value = data.pattern;
  if (typeof data.phase === 'string') phase.value = data.phase;
  if (typeof data.phaseSeq === 'number') phaseSeq.value = data.phaseSeq;
  if (typeof data.cycleIndex === 'number') cycleIndex.value = data.cycleIndex;
  if (typeof data.phaseDurationMs === 'number') phaseDurationMs.value = data.phaseDurationMs;
  if (typeof data.phaseEndsAtMs === 'number') phaseEndsAtMs.value = data.phaseEndsAtMs;
}

const phaseLabel = computed(() => {
  const p = phase.value;
  if (!p || p === '—') return '—';
  return PHASE_LABELS[p] ?? p;
});

/** Remaining time in current phase using synced server clock (nowMs tick keeps this fresh). */
const timeLeftMs = computed(() => {
  void nowMs.value;
  const end = phaseEndsAtMs.value;
  if (!end) return 0;
  const serverNow = Date.now() + serverOffsetMs.value;
  return Math.max(0, end - serverNow);
});

const timeLeftSec = computed(() => Math.ceil(timeLeftMs.value / 1000));

const patternSummary = computed(() => {
  const p = pattern.value;
  if (!p) return null;
  return [p.inhaleSec, p.hold1Sec, p.exhaleSec, p.hold2Sec].join(' · ');
});

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function connect() {
  clearReconnect();
  if (!url) {
    status.value = 'Disconnected';
    return;
  }
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }
  try {
    ws = new WebSocket(url);
  } catch {
    status.value = 'Disconnected';
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    status.value = 'Connected';
    reconnectAttempts.value = 0;
    ws.send(JSON.stringify({ type: 'join', room: selectedRoomId.value }));
  };

  ws.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    const t = data.type;
    if (t === 'snapshot' || t === 'phase') {
      applySyncPayload(data);
    } else if (t === 'presence') {
      applyServerTime(data.serverTimeMs);
      if (typeof data.participantCount === 'number') participantCount.value = data.participantCount;
      if (data.roomId != null) roomId.value = data.roomId;
    }
  };

  ws.onclose = () => {
    status.value = 'Disconnected';
    if (allowReconnect) scheduleReconnect();
  };

  ws.onerror = () => {
    status.value = 'Disconnected';
  };
}

function scheduleReconnect() {
  clearReconnect();
  if (!url) return;
  if (reconnectAttempts.value >= maxReconnects) return;
  reconnectTimer = setTimeout(() => {
    reconnectAttempts.value += 1;
    connect();
  }, reconnectDelayMs);
}

function manualReconnect() {
  clearReconnect();
  reconnectAttempts.value = 0;
  allowReconnect = false;
  const old = ws;
  ws = null;
  if (old) old.close();
  allowReconnect = true;
  connect();
}

function switchRoom(newId) {
  if (selectedRoomId.value === newId) return;
  selectedRoomId.value = newId;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'join', room: newId }));
  }
}

onMounted(() => {
  tickTimer = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 100);
  connect();
});

onUnmounted(() => {
  if (tickTimer != null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  allowReconnect = false;
  clearReconnect();
  if (ws) {
    ws.close();
    ws = null;
  }
});
</script>

<template>
  <div class="wrap">
    <h1 class="title">Breathing room</h1>
    <p v-if="!url" class="hint">
      Set <code>VITE_WS_URL</code> in <code>.env.local</code> (see <code>.env.example</code>).
    </p>
    <p class="status" :data-on="status === 'Connected'">
      {{ status }}
    </p>

    <div v-if="url" class="room-picker" role="group" aria-label="Breathing room type">
      <p class="room-picker-label">Room</p>
      <div class="room-buttons">
        <button
          v-for="opt in ROOM_OPTIONS"
          :key="opt.id"
          type="button"
          class="room-btn"
          :class="{ active: selectedRoomId === opt.id }"
          @click="switchRoom(opt.id)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <p v-if="patternSummary" class="pattern-line">
      <span class="pattern-label">Pattern (s)</span><br />
      <span class="pattern-values">{{ patternSummary }}</span>
      <span class="pattern-legend">inhale · hold1 · exhale · hold2</span>
    </p>

    <div class="main">
      <p class="phase">{{ phaseLabel }}</p>
      <p class="countdown">
        <template v-if="phaseEndsAtMs && phase !== '—'">
          {{ timeLeftSec }}s
        </template>
        <template v-else>—</template>
      </p>
      <p class="meta">
        {{ participantCount }} in room · cycle {{ cycleIndex }}
        <span v-if="roomId" class="room"> · {{ roomId.replace('extended-exhale', 'extended exhale') }}</span>
      </p>
      <p class="seq">seq {{ phaseSeq }}</p>
    </div>

    <button
      v-if="url && reconnectAttempts >= maxReconnects"
      type="button"
      class="reconnect"
      @click="manualReconnect"
    >
      Reconnect
    </button>
  </div>
</template>

<style scoped>
.wrap {
  box-sizing: border-box;
  width: 100%;
  max-width: 28rem;
  margin: 0 auto;
  padding: 1.25rem;
  font-family: system-ui, sans-serif;
  font-size: 1.125rem;
  line-height: 1.45;
  color: #1a1a1a;
}

.title {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0 0 1rem;
}

.hint {
  font-size: 0.95rem;
  color: #555;
  margin: 0 0 1rem;
}

.hint code {
  font-size: 0.85em;
}

.status {
  margin: 0 0 1rem;
  font-weight: 500;
}

.status[data-on='true'] {
  color: #0d6b2c;
}

.status[data-on='false'] {
  color: #8a1c1c;
}

.room-picker {
  margin-bottom: 1rem;
}

.room-picker-label {
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #666;
  margin: 0 0 0.5rem;
}

.room-buttons {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.room-btn {
  text-align: left;
  padding: 0.55rem 0.75rem;
  font-size: 0.95rem;
  border: 1px solid #ccc;
  border-radius: 8px;
  background: #fafafa;
  cursor: pointer;
}

.room-btn:hover:not(:disabled) {
  background: #f0f0f0;
}

.room-btn.active {
  border-color: #0d6b2c;
  background: #e8f5ec;
  font-weight: 600;
}

.room-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.pattern-line {
  margin: 0 0 1.25rem;
  font-size: 0.95rem;
  color: #333;
}

.pattern-label {
  font-weight: 600;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #666;
}

.pattern-values {
  font-size: 1.15rem;
  font-weight: 600;
}

.pattern-legend {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.8rem;
  color: #777;
}

.main {
  text-align: center;
}

.phase {
  font-size: 2.25rem;
  font-weight: 700;
  margin: 0 0 0.35rem;
  letter-spacing: 0.02em;
}

.countdown {
  font-size: 2rem;
  font-weight: 600;
  margin: 0 0 0.75rem;
  font-variant-numeric: tabular-nums;
}

.meta {
  font-size: 1.05rem;
  margin: 0;
  color: #444;
}

.room {
  color: #666;
}

.seq {
  margin: 0.5rem 0 0;
  font-size: 0.8rem;
  color: #999;
}

.reconnect {
  margin-top: 1.5rem;
  padding: 0.6rem 1rem;
  font-size: 1rem;
  cursor: pointer;
  border: 1px solid #333;
  border-radius: 6px;
  background: #fff;
}
</style>
