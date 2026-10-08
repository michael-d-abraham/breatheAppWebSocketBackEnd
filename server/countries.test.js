const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COUNTRY_ANCHORS,
  UNKNOWN_SPREAD_DEG,
  normalizeCountryCode,
  pointForCountry,
  spreadFor,
} = require('./countries');

/** Deterministic RNG that cycles through the provided values. */
function seq(...values) {
  let i = 0;
  return () => values[i++ % values.length];
}

function decimals(n) {
  const s = String(n);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

test('normalizeCountryCode accepts two letters in any case and rejects the rest', () => {
  assert.equal(normalizeCountryCode('jp'), 'JP');
  assert.equal(normalizeCountryCode('  us '), 'US');
  assert.equal(normalizeCountryCode('XX'), 'XX');
  assert.equal(normalizeCountryCode('USA'), null);
  assert.equal(normalizeCountryCode('1'), null);
  assert.equal(normalizeCountryCode(''), null);
  assert.equal(normalizeCountryCode(undefined), null);
  assert.equal(normalizeCountryCode(42), null);
});

test('known country: point stays within its spread of the anchor and is flagged known', () => {
  for (const code of ['US', 'JP', 'DE', 'BR', 'NZ', 'SG']) {
    const [aLat, aLon] = COUNTRY_ANCHORS[code];
    const spread = spreadFor(code);
    for (let i = 0; i < 200; i += 1) {
      const p = pointForCountry(code);
      assert.equal(p.known, true);
      assert.ok(Math.abs(p.lat - aLat) <= spread + 0.01, `${code} lat ${p.lat} too far from ${aLat}`);
      // Longitude is stretched by 1/cos(lat); allow for that.
      const lonLimit = (spread / Math.max(0.2, Math.cos((aLat * Math.PI) / 180))) + 0.01;
      assert.ok(Math.abs(p.lon - aLon) <= lonLimit, `${code} lon ${p.lon} too far from ${aLon}`);
    }
  }
});

test('output is rounded to two decimals (never more precise than the anchor jitter)', () => {
  for (let i = 0; i < 200; i += 1) {
    const p = pointForCountry('FR');
    assert.ok(decimals(p.lat) <= 2);
    assert.ok(decimals(p.lon) <= 2);
  }
});

test('unknown, Tor, missing and malformed codes fall back to an ocean anchor with wide spread', () => {
  const oceanAnchors = [
    [-12, -20],
    [2, -140],
    [-28, 78],
  ];
  for (const raw of ['XX', 'T1', undefined, null, '', 'ZZ', 'not-a-code']) {
    for (let i = 0; i < 50; i += 1) {
      const p = pointForCountry(raw);
      assert.equal(p.known, false, `${String(raw)} should be unknown`);
      const nearOcean = oceanAnchors.some(
        ([lat, lon]) =>
          Math.abs(p.lat - lat) <= UNKNOWN_SPREAD_DEG + 0.01 &&
          Math.abs(p.lon - lon) <= UNKNOWN_SPREAD_DEG / Math.max(0.2, Math.cos((lat * Math.PI) / 180)) + 0.01,
      );
      assert.ok(nearOcean, `${String(raw)} -> ${p.lat},${p.lon} is not near an ocean anchor`);
    }
  }
});

test('lowercase codes resolve like uppercase', () => {
  const a = pointForCountry('jp', seq(0.3, 0.6, 0.1));
  const b = pointForCountry('JP', seq(0.3, 0.6, 0.1));
  assert.deepEqual(a, b);
});

test('same random draws give the same point (so tests and the server are deterministic)', () => {
  const a = pointForCountry('CA', seq(0.2, 0.7));
  const b = pointForCountry('CA', seq(0.2, 0.7));
  assert.deepEqual(a, b);
});

test('different random draws spread dots apart so same-country users do not stack', () => {
  const points = new Set();
  const random = seq(0.05, 0.9, 0.5, 0.2, 0.8, 0.4, 0.65, 0.15);
  for (let i = 0; i < 4; i += 1) {
    const p = pointForCountry('US', random);
    points.add(`${p.lat},${p.lon}`);
  }
  assert.ok(points.size > 1);
});

test('latitude is clamped and longitude wraps at the antimeridian', () => {
  // Fiji sits near 180° east; a westward/eastward jitter must wrap rather than exceed ±180.
  for (let i = 0; i < 500; i += 1) {
    const p = pointForCountry('FJ');
    assert.ok(p.lon >= -180 && p.lon <= 180);
  }
  for (let i = 0; i < 500; i += 1) {
    const p = pointForCountry('SJ');
    assert.ok(p.lat <= 80 && p.lat >= -80);
  }
});

test('every anchor is a valid coordinate and every key is a two-letter code', () => {
  for (const [code, [lat, lon]] of Object.entries(COUNTRY_ANCHORS)) {
    assert.match(code, /^[A-Z]{2}$/);
    assert.ok(lat >= -90 && lat <= 90, `${code} lat`);
    assert.ok(lon >= -180 && lon <= 180, `${code} lon`);
  }
});
