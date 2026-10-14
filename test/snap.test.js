'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { snapToCadastre } = require('../wme-sl-road-import.user.js');

const LON0 = 14.5;
const LAT0 = 46;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const KY = 110540;
const at = (x, y) => [LON0 + x / KX, LAT0 + y / KY];
const toMetres = ([lon, lat]) => [(lon - LON0) * KX, (lat - LAT0) * KY];

// The values the runtime uses.
const snap = (segment, cadastre) => snapToCadastre(segment, cadastre, 5, 15, 15, 2);

function distanceToPolyline(p, coords) {
  const [px, py] = toMetres(p);
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const [ax, ay] = toMetres(coords[i - 1]);
    const [bx, by] = toMetres(coords[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - px, ay + t * dy - py));
  }
  return best;
}

function assertSnapped(result, segment, cadastre) {
  assert.ok(result, 'should snap');
  assert.deepStrictEqual(result[0], segment[0], 'the start node stays put');
  assert.deepStrictEqual(result[result.length - 1], segment[segment.length - 1], 'the end node stays put');
  for (const p of result.slice(1, -1)) {
    const d = Math.min(...cadastre.map(line => distanceToPolyline(p, line)));
    assert.ok(d < 0.01, `point ${toMetres(p).map(v => v.toFixed(1))} is ${d.toFixed(2)} m off the cadastre`);
  }
}

// A winding forest road, and the same road in WME: 6 m off, with a node every 50 m.
const winding = [];
for (let i = 0; i <= 80; i++) winding.push(at(i * 5, 25 * Math.sin(i / 8)));
const coarse = [];
for (let i = 0; i <= 80; i += 10) coarse.push(at(i * 5, 25 * Math.sin(i / 8) + 6));

test('a road a few metres off a winding cadastre line is moved onto it, ends unchanged', () => {
  const result = snap(coarse, [winding]);
  assertSnapped(result, coarse, [winding]);
  // And it really follows the bends: every cadastre vertex away from the ends is
  // within the simplification tolerance of the result.
  for (const p of winding.slice(4, -4)) {
    const d = distanceToPolyline(p, result);
    assert.ok(d <= 2.01, `cadastre vertex ${toMetres(p).map(v => v.toFixed(1))} is ${d.toFixed(2)} m from the result`);
  }
});

test('a hairpin keeps its apex', () => {
  const hairpin = [at(0, 0), at(150, 0), at(0, 60)];
  const wme = [at(0, 5), at(140, 5), at(5, 55)];
  const result = snap(wme, [hairpin]);
  assertSnapped(result, wme, [hairpin]);
  assert.ok(result.some(p => p[0] === hairpin[1][0] && p[1] === hairpin[1][1]), 'the apex vertex is in the result');
});

test('a segment running along two cadastre lines follows both, corner included', () => {
  const first = [at(0, 0), at(100, 0)];
  const second = [at(100, 0), at(100, 100)];
  const wme = [at(0, 5), at(95, 5), at(95, 100)];
  const result = snap(wme, [first, second]);
  assertSnapped(result, wme, [first, second]);
  assert.ok(result.some(p => p[0] === first[1][0] && p[1] === first[1][1]), 'the junction corner is in the result');
});

test('a cadastre line drawn the other way is followed in the segment\'s direction', () => {
  const result = snap(coarse, [winding.slice().reverse()]);
  assertSnapped(result, coarse, [winding]);
  const xs = result.map(p => toMetres(p)[0]);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], 'points run west to east like the segment');
});

test('a segment the cadastre leaves in the middle is not snapped', () => {
  const ends = [[at(0, 0), at(60, 0)], [at(140, 0), at(200, 0)]];
  assert.strictEqual(snap([at(0, 5), at(200, 5)], ends), null);
});

test('a segment the cadastre doesn\'t follow at all is not snapped', () => {
  assert.strictEqual(snap([at(0, 5), at(200, 5)], [[at(0, 100), at(200, 100)]]), null);
  assert.strictEqual(snap([at(0, 5), at(200, 5)], []), null);
});

test('a mismatch near the ends is tolerated', () => {
  // Junctions are where WME and the cadastre disagree most.
  const cadastre = [at(10, 0), at(200, 0)];
  const wme = [at(0, 5), at(200, 5)];
  assertSnapped(snap(wme, [cadastre]), wme, [cadastre]);
});

test('a road between two carriageways stays on one of them', () => {
  const north = [at(0, 6), at(100, 6), at(200, 6)];
  const south = [at(0, -6), at(100, -6), at(200, -6)];
  // Weaves across the middle, so the nearer carriageway keeps changing.
  const wme = [at(0, 1), at(50, -1), at(100, 1), at(150, -1), at(200, 1)];
  const result = snap(wme, [north, south]);
  assertSnapped(result, wme, [north, south]);
  const inner = result.slice(1, -1).map(p => Math.round(toMetres(p)[1]));
  assert.ok(inner.every(y => y === inner[0]), `zigzagged between carriageways: ${inner}`);
});
