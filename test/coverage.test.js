'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { missingPieces, prepareSegments } = require('../wme-sl-road-import.user.js');

const LON0 = 14.5;
const LAT0 = 46;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const KY = 110540;
const at = (x, y) => [LON0 + x / KX, LAT0 + y / KY];
const toMetres = ([lon, lat]) => [(lon - LON0) * KX, (lat - LAT0) * KY];

// The values the runtime uses.
const STEP = 5;
const MAX = 15;
const MIN = 30;

// A 200 m cadastre road running east.
const line = [at(0, 0), at(200, 0)];

const missing = (coords, segmentLines) =>
  missingPieces(coords, prepareSegments(segmentLines), STEP, MAX, MIN);

function assertLine(actual, expected) {
  assert.strictEqual(actual.length, expected.length, `got ${JSON.stringify(actual)}`);
  actual.forEach((p, i) => {
    assert.ok(Math.abs(p[0] - expected[i][0]) < 1e-9 && Math.abs(p[1] - expected[i][1]) < 1e-9,
      `point ${i}: got ${p}, expected ${expected[i]}`);
  });
}

test('a road with nothing near it is missing whole', () => {
  assert.deepStrictEqual(missing(line, []), [line]);
  assert.deepStrictEqual(missing(line, [[at(5000, 5000), at(5200, 5000)]]), [line]);
});

test('a road WME has along its whole length is not missing', () => {
  assert.deepStrictEqual(missing(line, [[at(-10, 10), at(210, 10)]]), []);
});

test('a WME road further away than the threshold does not count', () => {
  assert.deepStrictEqual(missing(line, [[at(-10, 20), at(210, 20)]]), [line]);
});

test('a road mapped along its first half is missing only after it', () => {
  // The WME road is within 15 m up to ~114 m, so the piece starts at the next sample.
  const pieces = missing(line, [[at(0, 5), at(100, 5)]]);
  assert.strictEqual(pieces.length, 1);
  assertLine(pieces[0], [at(115, 0), at(200, 0)]);
});

test('a WME road drawn the other way still counts', () => {
  assert.deepStrictEqual(missing(line, [[at(210, 10), at(-10, 10)]]), []);
});

test('a road mapped in the middle is missing at both ends', () => {
  const pieces = missing(line, [[at(60, 5), at(140, 5)]]);
  assert.strictEqual(pieces.length, 2);
  assertLine(pieces[0], [at(0, 0), at(45, 0)]);
  assertLine(pieces[1], [at(155, 0), at(200, 0)]);
});

test('a short leftover is dropped', () => {
  // Usually the same road drawn slightly differently, not a missing one.
  assert.deepStrictEqual(missing(line, [[at(0, 5), at(180, 5)]]), []);
});

test('a short road with nothing near it is still offered', () => {
  const short = [at(0, 0), at(20, 0)];
  assert.deepStrictEqual(missing(short, []), [short]);
});

test('a piece keeps the original bends between its ends', () => {
  const bent = [at(0, 0), at(100, 0), at(100, 100)];
  const pieces = missing(bent, [[at(0, 5), at(50, 5)]]);
  assert.strictEqual(pieces.length, 1);
  assertLine(pieces[0], [at(65, 0), at(100, 0), at(100, 100)]);
});

test('a road leaving a WME road at a corner starts at the corner', () => {
  // The case from WME: the cadastre follows a village road, then turns off into the
  // forest. Only the forest part is missing, and it starts where the turn is.
  const bent = [at(0, 0), at(100, 0), at(100, 100)];
  const pieces = missing(bent, [[at(-50, 0), at(100, 0)]]);
  assert.strictEqual(pieces.length, 1);
  assert.strictEqual(pieces[0].length, 2, `got ${JSON.stringify(pieces[0])}`);
  const [x, y] = toMetres(pieces[0][0]);
  assert.ok(Math.abs(x - 100) < 1e-6 && y >= 0 && y <= 5, `should start at the corner, got ${x}, ${y}`);
  assertLine([pieces[0][1]], [at(100, 100)]);
});

test('a cut just before a vertex leaves no tiny segment', () => {
  // Keeping both the cut and the vertex would start the new road with a 0.2 m segment.
  // The corner is at 102 m so it never sits on a sample; the 105 m sample is the
  // first missing one, 0.2 m before the vertex at 105.2 m.
  const bent = [at(0, 0), at(102, 0), at(102, 3.2), at(110, 60)];
  const [piece] = missing(bent, [[at(-50, 0), at(102, 0)]]);
  for (let i = 1; i < piece.length; i++) {
    const [ax, ay] = toMetres(piece[i - 1]);
    const [bx, by] = toMetres(piece[i]);
    assert.ok(Math.hypot(bx - ax, by - ay) >= 1, `segment ${i} is ${Math.hypot(bx - ax, by - ay).toFixed(2)} m`);
  }
});

test('a short road joining two roads is offered whole', () => {
  // Both ends meet a road, but neither road runs along it.
  const connector = [at(0, 0), at(0, 30)];
  const roads = [[at(-100, 0), at(100, 0)], [at(-100, 30), at(100, 30)]];
  assert.deepStrictEqual(missing(connector, roads), [connector]);
});

test('a road meeting another at a right angle reaches all the way to it', () => {
  const spur = [at(0, 0), at(0, 100)];
  assert.deepStrictEqual(missing(spur, [[at(-100, 0), at(100, 0)]]), [spur]);
});

test('a road that only crosses the line does not cut it', () => {
  assert.deepStrictEqual(missing(line, [[at(100, -100), at(100, 100)]]), [line]);
});

test('a road crossing at a shallow angle cuts out the stretch it runs along', () => {
  // 20° off the line's direction: close and alongside for a while, so that part counts.
  const t = Math.tan(20 * Math.PI / 180);
  const pieces = missing(line, [[at(0, -100 * t), at(200, 100 * t)]]);
  assert.strictEqual(pieces.length, 2);
  assert.ok(pieces[0][pieces[0].length - 1][0] < at(70, 0)[0], 'first piece ends before the crossing');
  assert.ok(pieces[1][0][0] > at(130, 0)[0], 'second piece starts after it');
});

test('degenerate WME geometry is skipped', () => {
  assert.deepStrictEqual(prepareSegments([[at(0, 0)], [], null, undefined]), []);
  assert.deepStrictEqual(missing(line, [[at(0, 0)], [], null]), [line]);
});

test('a far segment is rejected on its cached box alone', () => {
  // The refresh runs on every pan. Re-reading every WME segment's geometry once per
  // cadastre line made that a visible freeze in a city view.
  const [far] = prepareSegments([[at(5000, 5000), at(5200, 5000)]]);
  const untouchable = new Proxy([], { get: () => { throw new Error('coordinates were read'); } });
  assert.deepStrictEqual(missingPieces(line, [{ ...far, coords: untouchable }], STEP, MAX, MIN), [line]);
});
