'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { coverageFraction, prepareSegments } = require('../wme-sl-road-import.user.js');

const LON0 = 14.5;
const LAT0 = 46;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const KY = 110540;
const at = (x, y) => [LON0 + x / KX, LAT0 + y / KY];

// The values the runtime uses.
const STEP = 5;
const MAX = 15;
const HIDE = 0.8;

// A 200 m cadastre road running east.
const line = [at(0, 0), at(200, 0)];

const cover = (coords, segmentLines) => coverageFraction(coords, prepareSegments(segmentLines), STEP, MAX);

test('a WME road alongside the whole line covers it', () => {
  assert.strictEqual(cover(line, [[at(-10, 10), at(210, 10)]]), 1);
});

test('a WME road further away than the threshold does not', () => {
  assert.strictEqual(cover(line, [[at(-10, 20), at(210, 20)]]), 0);
});

test('a WME road along half the line covers about half', () => {
  // Samples up to ~114 m are within 15 m of that road's end.
  const f = cover(line, [[at(0, 5), at(100, 5)]]);
  assert.ok(f > 0.5 && f < 0.65, `got ${f}`);
});

test('a road mapped along most of its length is hidden, one mapped along two thirds is not', () => {
  const most = cover(line, [[at(0, 5), at(160, 5)]]);
  const twoThirds = cover(line, [[at(0, 5), at(130, 5)]]);
  assert.ok(most >= HIDE, `most: ${most}`);
  assert.ok(twoThirds < HIDE, `two thirds: ${twoThirds}`);
});

test('a road that only crosses the line covers just the crossing', () => {
  // A cadastre forest road crossing a mapped road must stay visible.
  const f = cover(line, [[at(100, -100), at(100, 100)]]);
  assert.ok(f > 0.1 && f < 0.25, `got ${f}`);
});

test('far segments are ignored', () => {
  assert.strictEqual(cover(line, [[at(5000, 5000), at(5200, 5000)]]), 0);
});

test('no WME segments, no coverage', () => {
  assert.strictEqual(cover(line, []), 0);
});

test('degenerate WME geometry is skipped', () => {
  assert.deepStrictEqual(prepareSegments([[at(0, 0)], [], null, undefined]), []);
  assert.strictEqual(cover(line, [[at(0, 0)], [], null]), 0);
});

test('a far segment is rejected on its cached box alone', () => {
  // refreshCoverage runs on every pan. Re-reading every WME segment's geometry once
  // per cadastre line made that a visible freeze in a city view.
  const [far] = prepareSegments([[at(5000, 5000), at(5200, 5000)]]);
  const untouchable = new Proxy([], { get: () => { throw new Error('coordinates were read'); } });
  assert.strictEqual(coverageFraction(line, [{ ...far, coords: untouchable }], STEP, MAX), 0);
});

test('a multi-vertex WME road counts on every edge', () => {
  const bent = [[at(0, 5), at(100, 5), at(100, 50), at(200, 5)]];
  // The detour leaves a gap between about 115 and 175 m.
  const f = cover(line, bent);
  assert.ok(f > 0.5 && f < 1, `got ${f}`);
});
