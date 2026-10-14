'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { missingStretches, prepareSegments } = require('../wme-sl-road-import.user.js');

const LON0 = 14.5;
const LAT0 = 46;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const KY = 110540;
const at = (x, y) => [LON0 + x / KX, LAT0 + y / KY];

// The values the runtime uses.
const STEP = 5;
const MAX = 15;
const MIN = 30;

// A 200 m cadastre road running east.
const line = [at(0, 0), at(200, 0)];

const missing = (coords, segmentLines) =>
  missingStretches(coords, prepareSegments(segmentLines), STEP, MAX, MIN);

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
  // The WME road is within 15 m up to ~114 m. The piece starts at the last sample
  // still that close, so its loose end sits next to the road it must connect to.
  const pieces = missing(line, [[at(0, 5), at(100, 5)]]);
  assert.strictEqual(pieces.length, 1);
  assertLine(pieces[0], [at(110, 0), at(200, 0)]);
});

test('a road mapped in the middle is missing at both ends', () => {
  const pieces = missing(line, [[at(60, 5), at(140, 5)]]);
  assert.strictEqual(pieces.length, 2);
  assertLine(pieces[0], [at(0, 0), at(50, 0)]);
  assertLine(pieces[1], [at(150, 0), at(200, 0)]);
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
  assertLine(pieces[0], [at(60, 0), at(100, 0), at(100, 100)]);
});

test('a road that crosses the line splits it at the crossing', () => {
  // At 102 m, so no sample sits exactly 15 m away where rounding would decide.
  const pieces = missing(line, [[at(102, -100), at(102, 100)]]);
  assert.strictEqual(pieces.length, 2);
  assertLine(pieces[0], [at(0, 0), at(90, 0)]);
  assertLine(pieces[1], [at(115, 0), at(200, 0)]);
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
  assert.deepStrictEqual(missingStretches(line, [{ ...far, coords: untouchable }], STEP, MAX, MIN), [line]);
});
