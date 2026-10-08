/**
 * Real-socket tests against the actual HTTP + WebSocket server.
 *
 * Main purpose: prove /global works end to end AND the original breathing-room protocol on every
 * other path is unchanged (already-released app builds still talk to this server).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { server } = require('./index');

let port;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(async () => {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function connect(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const queue = [];
    const waiters = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });
    const next = (timeoutMs = 2000) =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('timed out waiting for message')), timeoutMs);
            waiters.push((m) => {
              clearTimeout(timer);
              res(m);
            });
          });
    const nextOfType = async (type) => {
      for (let i = 0; i < 20; i += 1) {
        const m = await next();
        if (m.type === type) return m;
      }
      throw new Error(`no ${type} message`);
    };
    ws.once('open', () => resolve({ ws, next, nextOfType, queue }));
    ws.once('error', reject);
  });
}

const closeAll = (...clients) =>
  Promise.all(
    clients.map(
      ({ ws }) =>
        new Promise((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) return resolve();
          ws.once('close', resolve);
          ws.close();
        }),
    ),
  );

test('/global: snapshot, join, pulse delivery, and cooldown over real sockets', async () => {
  const a = await connect('/global', { 'cf-ipcountry': 'JP' });
  const snapA = await a.next();
  assert.equal(snapA.type, 'snapshot');
  assert.equal(snapA.participants.length, 1);
  assert.equal(snapA.participants[0].id, snapA.selfId);

  const b = await connect('/global', { 'cf-ipcountry': 'BR' });
  const snapB = await b.next();
  assert.equal(snapB.participants.length, 2);

  const joined = await a.next();
  assert.equal(joined.type, 'join');
  assert.equal(joined.participant.id, snapB.selfId);

  b.ws.send(JSON.stringify({ type: 'pulse' }));
  const pulseOnA = await a.next();
  const pulseOnB = await b.next();
  assert.equal(pulseOnA.type, 'pulse');
  assert.equal(pulseOnA.id, snapB.selfId);
  assert.equal(pulseOnB.id, snapB.selfId);

  b.ws.send(JSON.stringify({ type: 'pulse' }));
  const cooldown = await b.next();
  assert.equal(cooldown.type, 'cooldown');
  assert.ok(cooldown.retryAfterMs > 0 && cooldown.retryAfterMs <= 5000);

  const leaveWaiter = a.next();
  await closeAll(b);
  const left = await leaveWaiter;
  assert.deepEqual(left, { type: 'leave', id: snapB.selfId });

  await closeAll(a);
});

test('/global with a query string still routes to the Global Room', async () => {
  const a = await connect('/global?client=ios');
  const snap = await a.next();
  assert.equal(snap.type, 'snapshot');
  assert.ok(snap.selfId);
  await closeAll(a);
});

test('legacy breathing rooms: original protocol unchanged on the root path', async () => {
  const legacy = await connect('/');

  // The original server sends room_stats immediately on connect.
  const stats = await legacy.next();
  assert.equal(stats.type, 'room_stats');
  assert.deepEqual(Object.keys(stats.rooms).sort(), ['box', 'deep', 'extended-exhale']);

  legacy.ws.send(JSON.stringify({ type: 'join', room: 'box' }));
  const snapshot = await legacy.nextOfType('snapshot');
  assert.equal(snapshot.roomId, 'box');
  assert.deepEqual(snapshot.pattern, { inhaleSec: 4, hold1Sec: 4, exhaleSec: 4, hold2Sec: 4 });
  assert.equal(typeof snapshot.phaseSeq, 'number');
  assert.ok(['inhale', 'hold1', 'exhale', 'hold2'].includes(snapshot.phase));
  assert.ok(snapshot.participantCount >= 1);

  await closeAll(legacy);
});

test('legacy clients never receive Global Room traffic (and vice versa)', async () => {
  const legacy = await connect('/');
  await legacy.next(); // room_stats
  legacy.ws.send(JSON.stringify({ type: 'join', room: 'deep' }));
  await legacy.nextOfType('snapshot');

  const g = await connect('/global');
  await g.next(); // snapshot
  g.ws.send(JSON.stringify({ type: 'pulse' }));
  await g.next(); // own pulse

  // Give the server a moment, then make sure nothing global leaked to the legacy socket.
  await new Promise((r) => setTimeout(r, 150));
  const leaked = legacy.queue.filter((m) => ['pulse', 'join', 'leave', 'cooldown'].includes(m.type) && !m.roomId);
  assert.deepEqual(leaked, []);

  // A legacy-style join sent on /global must be ignored (no chat/room mechanics there).
  g.ws.send(JSON.stringify({ type: 'join', room: 'box' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(g.queue.length, 0);

  await closeAll(legacy, g);
});

test('GET /api/rooms is unchanged and does not count Global Room sockets', async () => {
  const g = await connect('/global');
  await g.next();

  const res = await fetch(`http://127.0.0.1:${port}/api/rooms`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'room_stats');
  assert.deepEqual(Object.keys(body.rooms).sort(), ['box', 'deep', 'extended-exhale']);

  await closeAll(g);
});

test('oversized frame on /global closes the connection without affecting others', async () => {
  const good = await connect('/global');
  await good.next();
  const bad = await connect('/global');
  await bad.next();
  await good.next(); // join of bad

  const closed = new Promise((resolve) => bad.ws.once('close', (code) => resolve(code)));
  bad.ws.send('x'.repeat(5000));
  const code = await closed;
  assert.equal(code, 1009);

  const leave = await good.next();
  assert.equal(leave.type, 'leave');

  good.ws.send(JSON.stringify({ type: 'pulse' }));
  assert.equal((await good.next()).type, 'pulse');

  await closeAll(good);
});
