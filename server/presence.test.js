const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  IP_PULSE_MAX,
  IP_PULSE_WINDOW_MS,
  MAX_CONNECTIONS_PER_IP,
  MAX_PARTICIPANTS,
  PROTOCOL_VERSION,
  PULSE_COOLDOWN_MS,
  createPresenceRoom,
} = require('./presence');
const { COUNTRY_ANCHORS, spreadFor } = require('./countries');

const OPEN = 1;
const CLOSED = 3;

function fakeSocket() {
  const ws = new EventEmitter();
  ws.readyState = OPEN;
  ws.raw = [];
  ws.sent = [];
  ws.closed = null;
  ws.sendShouldThrow = false;
  ws.send = (text) => {
    if (ws.sendShouldThrow) throw new Error('boom');
    ws.raw.push(text);
    ws.sent.push(JSON.parse(text));
  };
  ws.close = (code, reason) => {
    ws.readyState = CLOSED;
    ws.closed = { code, reason };
    ws.emit('close', code, reason);
  };
  ws.ofType = (type) => ws.sent.filter((m) => m.type === type);
  ws.say = (payload) => ws.emit('message', Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)));
  return ws;
}

function req(headers = {}, remoteAddress = '10.0.0.1') {
  return { headers, socket: { remoteAddress } };
}

function setup(options = {}) {
  const clock = { t: 1_000_000 };
  let n = 0;
  const room = createPresenceRoom({
    now: () => clock.t,
    random: () => 0.5,
    newId: () => `u${++n}`,
    ...options,
  });
  const join = (headers, ip) => {
    const ws = fakeSocket();
    room.handleConnection(ws, req(headers, ip));
    return ws;
  };
  return { room, clock, join };
}

test('first user alone: snapshot contains only themselves; nothing else is sent', () => {
  const { join, room } = setup();
  const a = join({ 'cf-ipcountry': 'JP' });
  assert.equal(room.size(), 1);
  assert.equal(a.sent.length, 1);
  const snap = a.sent[0];
  assert.equal(snap.type, 'snapshot');
  assert.equal(snap.v, PROTOCOL_VERSION);
  assert.equal(snap.selfId, 'u1');
  assert.equal(snap.pulseCooldownMs, PULSE_COOLDOWN_MS);
  assert.equal(snap.participants.length, 1);
  assert.equal(snap.participants[0].id, 'u1');
});

test('second user: gets both in the snapshot; first gets a join; joiner is not told about themselves', () => {
  const { join } = setup();
  const a = join({ 'cf-ipcountry': 'JP' }, '10.0.0.1');
  const b = join({ 'cf-ipcountry': 'BR' }, '10.0.0.2');

  assert.deepEqual(b.sent[0].participants.map((p) => p.id), ['u1', 'u2']);
  assert.equal(b.sent[0].selfId, 'u2');

  const joins = a.ofType('join');
  assert.equal(joins.length, 1);
  assert.equal(joins[0].participant.id, 'u2');
  assert.equal(b.ofType('join').length, 0);
});

test('leaving: remaining users get a leave once; closing twice does not double-notify', () => {
  const { join, room } = setup();
  const a = join({}, '10.0.0.1');
  const b = join({}, '10.0.0.2');

  b.close(1000);
  b.emit('close', 1000);

  assert.equal(room.size(), 1);
  assert.deepEqual(a.ofType('leave'), [{ type: 'leave', id: 'u2' }]);
});

test('privacy: only id/lat/lon are shared, coordinates are coarse, and the IP never appears on the wire', () => {
  const { join } = setup();
  const ip = '203.0.113.77';
  const a = join({ 'cf-ipcountry': 'JP', 'cf-connecting-ip': ip }, '10.9.9.9');
  const b = join({ 'cf-ipcountry': 'DE' }, ip);

  for (const ws of [a, b]) {
    for (const raw of ws.raw) {
      assert.ok(!raw.includes(ip), 'outbound message leaked an IP');
      assert.ok(!raw.includes('10.9.9.9'), 'outbound message leaked a socket address');
      assert.ok(!/"country"/i.test(raw), 'outbound message leaked a country code');
    }
  }

  for (const p of b.sent[0].participants) {
    assert.deepEqual(Object.keys(p).sort(), ['id', 'lat', 'lon']);
  }

  const jp = b.sent[0].participants.find((p) => p.id === 'u1');
  const [aLat, aLon] = COUNTRY_ANCHORS.JP;
  assert.ok(Math.abs(jp.lat - aLat) <= spreadFor('JP') + 0.01);
  assert.ok(Math.abs(jp.lon - aLon) <= spreadFor('JP') / Math.cos((aLat * Math.PI) / 180) + 0.01);
});

test('location: lowercase header works, missing header uses fallbackCountry, no header and no fallback gets an open-ocean point', () => {
  const lower = setup().join({ 'cf-ipcountry': 'jp' });
  const upper = setup().join({ 'cf-ipcountry': 'JP' });
  assert.deepEqual(lower.sent[0].participants[0], upper.sent[0].participants[0]);

  const dev = setup({ fallbackCountry: 'JP' }).join({});
  assert.deepEqual(dev.sent[0].participants[0], upper.sent[0].participants[0]);

  const none = setup().join({}).sent[0].participants[0];
  assert.ok(Number.isFinite(none.lat) && Number.isFinite(none.lon));
  // Not within Japan's spread: unknown users must not be pinned to a real place.
  assert.ok(Math.abs(none.lat - COUNTRY_ANCHORS.JP[0]) > 10);
});

test('pulse: delivered to everyone including the sender, stamped with the sender id', () => {
  const { join, clock } = setup();
  const a = join({}, '10.0.0.1');
  const b = join({}, '10.0.0.2');

  clock.t += 123;
  b.say({ type: 'pulse' });

  const expected = { type: 'pulse', id: 'u2', serverTimeMs: clock.t };
  assert.deepEqual(a.ofType('pulse'), [expected]);
  assert.deepEqual(b.ofType('pulse'), [expected]);
});

test('empty room: a lone user can still pulse and receives their own echo', () => {
  const { join } = setup();
  const a = join({});
  a.say({ type: 'pulse' });
  assert.deepEqual(a.ofType('pulse').map((m) => m.id), ['u1']);
});

test('pulse cooldown: rejected inside the window (sender only), accepted after, tolerance honoured', () => {
  const { join, clock } = setup();
  const a = join({}, '10.0.0.1');
  const b = join({}, '10.0.0.2');

  a.say({ type: 'pulse' });
  assert.equal(a.ofType('pulse').length, 1);

  clock.t += 1000;
  a.say({ type: 'pulse' });
  assert.equal(a.ofType('pulse').length, 1, 'second pulse must not broadcast');
  assert.equal(b.ofType('pulse').length, 1, 'others must not see a rejected pulse');
  assert.deepEqual(a.ofType('cooldown'), [{ type: 'cooldown', retryAfterMs: 4000 }]);
  assert.equal(b.ofType('cooldown').length, 0);

  // 4499 ms after the first: still inside (cooldown 5000 - tolerance 500).
  clock.t += 3499;
  a.say({ type: 'pulse' });
  assert.equal(a.ofType('pulse').length, 1);

  // 4500 ms after the first: allowed.
  clock.t += 1;
  a.say({ type: 'pulse' });
  assert.equal(a.ofType('pulse').length, 2);
  assert.equal(b.ofType('pulse').length, 2);
});

test('rejected pulses do not extend the cooldown', () => {
  const { join, clock } = setup();
  const a = join({});
  a.say({ type: 'pulse' });
  for (let i = 0; i < 5; i += 1) {
    clock.t += 500;
    a.say({ type: 'pulse' });
  }
  // 2500 ms elapsed, spam rejected. After the original window it still works.
  clock.t += 2000;
  a.say({ type: 'pulse' });
  assert.equal(a.ofType('pulse').length, 2);
});

test('overlapping pulses from different users in the same instant are all delivered, in order', () => {
  const { join } = setup();
  const a = join({}, '10.0.0.1');
  const b = join({}, '10.0.0.2');
  const c = join({}, '10.0.0.3');

  a.say({ type: 'pulse' });
  c.say({ type: 'pulse' });
  b.say({ type: 'pulse' });

  for (const ws of [a, b, c]) {
    assert.deepEqual(ws.ofType('pulse').map((m) => m.id), ['u1', 'u3', 'u2']);
  }
});

test('per-IP ceiling: reconnecting cannot bypass the per-user cooldown', () => {
  const { join, clock } = setup();
  const ip = '198.51.100.9';

  for (let i = 0; i < IP_PULSE_MAX; i += 1) {
    const ws = join({}, ip);
    ws.say({ type: 'pulse' });
    assert.equal(ws.ofType('pulse').length, 1, `pulse ${i} should pass`);
    ws.close(1000);
    clock.t += 100;
  }

  const blocked = join({}, ip);
  blocked.say({ type: 'pulse' });
  assert.equal(blocked.ofType('pulse').length, 0);
  assert.equal(blocked.ofType('cooldown').length, 1);
  assert.ok(blocked.ofType('cooldown')[0].retryAfterMs > 0);

  clock.t += IP_PULSE_WINDOW_MS;
  const later = join({}, ip);
  later.say({ type: 'pulse' });
  assert.equal(later.ofType('pulse').length, 1);
});

test('connection cap per IP: extra sockets are closed with 1013 and never join the room', () => {
  const { join, room } = setup();
  const ip = '192.0.2.50';
  const sockets = [];
  for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i += 1) sockets.push(join({}, ip));
  assert.equal(room.size(), MAX_CONNECTIONS_PER_IP);

  const extra = join({}, ip);
  assert.equal(extra.closed.code, 1013);
  assert.equal(extra.sent.length, 0);
  assert.equal(room.size(), MAX_CONNECTIONS_PER_IP);

  const other = join({}, '192.0.2.51');
  assert.equal(other.closed, null);

  sockets[0].close(1000);
  const afterFree = join({}, ip);
  assert.equal(afterFree.closed, null);
});

test('global participant cap', () => {
  const { join, room } = setup();
  for (let i = 0; i < MAX_PARTICIPANTS; i += 1) join({}, `10.${i >> 8}.${i & 255}.1`);
  assert.equal(room.size(), MAX_PARTICIPANTS);
  const overflow = join({}, '172.16.0.1');
  assert.equal(overflow.closed.code, 1013);
  assert.equal(room.size(), MAX_PARTICIPANTS);
});

test('malformed, oversized and unknown messages are ignored without throwing or broadcasting', () => {
  const { join, room } = setup();
  const a = join({}, '10.0.0.1');
  const b = join({}, '10.0.0.2');
  const before = [a.sent.length, b.sent.length];

  const bad = [
    'not json',
    '',
    '[]',
    'null',
    '42',
    '"pulse"',
    JSON.stringify({ type: 'chat', text: 'hello' }),
    JSON.stringify({ type: 'react', emoji: 'x' }),
    JSON.stringify({ nope: true }),
    JSON.stringify({ type: 'pulse', pad: 'x'.repeat(2000) }),
  ];
  for (const text of bad) {
    assert.doesNotThrow(() => a.say(text), `threw on ${text.slice(0, 20)}`);
  }
  assert.doesNotThrow(() => a.emit('message', undefined));
  assert.doesNotThrow(() => a.emit('message', null));

  assert.deepEqual([a.sent.length, b.sent.length], before);
  assert.equal(room.size(), 2);

  // And the room still works afterwards.
  a.say({ type: 'pulse' });
  assert.equal(b.ofType('pulse').length, 1);
});

test('reconnect: fresh id and fresh snapshot, no pulse replay, old session announced as left', () => {
  const { join, clock } = setup();
  const a = join({}, '10.0.0.1');
  const b = join({}, '10.0.0.2');

  b.say({ type: 'pulse' });
  assert.equal(a.ofType('pulse').length, 1);

  b.close(1006);
  clock.t += 10_000;
  const b2 = join({}, '10.0.0.2');

  assert.equal(b2.sent[0].type, 'snapshot');
  assert.equal(b2.sent[0].selfId, 'u3');
  assert.deepEqual(b2.sent[0].participants.map((p) => p.id), ['u1', 'u3']);
  assert.equal(b2.ofType('pulse').length, 0, 'pulses are never replayed');
  assert.deepEqual(a.ofType('leave'), [{ type: 'leave', id: 'u2' }]);
  assert.equal(a.ofType('join').length, 2); // u2, then u3
});

test('a socket that errors on send does not stop delivery to the others', () => {
  const { join } = setup();
  const a = join({}, '10.0.0.1');
  const b = join({}, '10.0.0.2');
  const c = join({}, '10.0.0.3');
  b.sendShouldThrow = true;

  assert.doesNotThrow(() => a.say({ type: 'pulse' }));
  assert.equal(c.ofType('pulse').length, 1);
});

test('closed sockets are skipped; participant count reflects only the live ones', () => {
  const { join, room } = setup();
  const a = join({}, '10.0.0.1');
  const b = join({}, '10.0.0.2');
  b.readyState = CLOSED; // dropped but close event not yet delivered
  assert.doesNotThrow(() => a.say({ type: 'pulse' }));
  assert.equal(b.ofType('pulse').length, 0);
  b.emit('close', 1006);
  assert.equal(room.size(), 1);
});

test('socket errors are logged without addresses or coordinates', () => {
  const lines = [];
  const log = { info: (m, meta) => lines.push([m, meta]), warn: (m, meta) => lines.push([m, meta]) };
  const { join } = setup({ log });
  const ws = join({ 'cf-ipcountry': 'JP', 'cf-connecting-ip': '203.0.113.5' }, '10.0.0.1');
  ws.emit('error', new Error('ECONNRESET'));
  ws.close(1006);

  const blob = JSON.stringify(lines);
  assert.ok(!blob.includes('203.0.113.5'));
  assert.ok(!blob.includes('10.0.0.1'));
  assert.ok(!/JP/.test(blob));
  assert.ok(!/lat|lon/i.test(blob));
});

test('closeAll closes every open socket', () => {
  const { join, room } = setup();
  const a = join({}, '10.0.0.1');
  const b = join({}, '10.0.0.2');
  room.closeAll();
  assert.equal(a.closed.code, 1001);
  assert.equal(b.closed.code, 1001);
});
