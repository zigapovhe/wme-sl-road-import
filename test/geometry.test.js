'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { splitLines, simplifyLine, lineLengthM } = require('../wme-sl-road-import.user.js');

// Points given as metre offsets from 14.5°E 46°N, with the same flat projection the
// script uses, so distances in these tests are exact.
const LON0 = 14.5;
const LAT0 = 46;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const KY = 110540;
const at = (x, y) => [LON0 + x / KX, LAT0 + y / KY];
const toMetres = ([lon, lat]) => [(lon - LON0) * KX, (lat - LAT0) * KY];

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

test('a LineString becomes one line without heights', () => {
  assert.deepStrictEqual(
    splitLines({ type: 'LineString', coordinates: [[14.5, 46, 300.5], [14.6, 46.1, 301]] }),
    [[[14.5, 46], [14.6, 46.1]]]
  );
});

test('a MultiLineString becomes one line per member', () => {
  assert.deepStrictEqual(
    splitLines({
      type: 'MultiLineString',
      coordinates: [[[14.5, 46, 1], [14.6, 46, 1]], [[14.7, 46, 1], [14.8, 46, 1]]]
    }),
    [[[14.5, 46], [14.6, 46]], [[14.7, 46], [14.8, 46]]]
  );
});

test('points the SDK would reject are dropped', () => {
  assert.deepStrictEqual(
    splitLines({ type: 'LineString', coordinates: [[14.5, 46], [NaN, 46], [14.6, null], 'x', [14.7, 46]] }),
    [[[14.5, 46], [14.7, 46]]]
  );
});

test('repeated points are collapsed', () => {
  assert.deepStrictEqual(
    splitLines({ type: 'LineString', coordinates: [[14.5, 46, 1], [14.5, 46, 2], [14.6, 46, 3]] }),
    [[[14.5, 46], [14.6, 46]]]
  );
});

test('a line that collapses to one point is dropped', () => {
  // It would become a zero-length segment.
  assert.deepStrictEqual(splitLines({ type: 'LineString', coordinates: [[14.5, 46, 1], [14.5, 46, 2]] }), []);
  assert.deepStrictEqual(splitLines({ type: 'LineString', coordinates: [[14.5, 46]] }), []);
});

test('anything that is not a line gives nothing', () => {
  assert.deepStrictEqual(splitLines({ type: 'Point', coordinates: [14.5, 46] }), []);
  assert.deepStrictEqual(splitLines(null), []);
  assert.deepStrictEqual(splitLines({ type: 'LineString' }), []);
  assert.deepStrictEqual(splitLines({ type: 'MultiLineString' }), []);
});

test('points within the tolerance of a straight run are removed', () => {
  const coords = [at(0, 0), at(50, 1), at(100, -1), at(150, 0)];
  assert.deepStrictEqual(simplifyLine(coords, 2), [at(0, 0), at(150, 0)]);
});

test('a corner beyond the tolerance is kept', () => {
  const coords = [at(0, 0), at(100, 0), at(100, 100)];
  assert.deepStrictEqual(simplifyLine(coords, 2), coords);
});

test('the simplified line stays within the tolerance of every original point', () => {
  // A winding forest road.
  const coords = [];
  for (let i = 0; i <= 200; i++) coords.push(at(i * 5, 30 * Math.sin(i / 10)));
  const simplified = simplifyLine(coords, 2);

  assert.ok(simplified.length < coords.length / 2, `kept ${simplified.length} of ${coords.length}`);
  assert.deepStrictEqual(simplified[0], coords[0]);
  assert.deepStrictEqual(simplified[simplified.length - 1], coords[coords.length - 1]);
  for (const p of coords) {
    const d = distanceToPolyline(p, simplified);
    assert.ok(d <= 2 + 1e-6, `a point ended up ${d.toFixed(2)} m away`);
  }
});

test('two points stay as they are', () => {
  const coords = [at(0, 0), at(10, 0)];
  assert.deepStrictEqual(simplifyLine(coords, 2), coords);
});

test('a closed loop keeps its shape', () => {
  // First and last point coincide, so the first chord has zero length.
  const coords = [at(0, 0), at(100, 0), at(100, 100), at(0, 100), at(0, 0)];
  assert.deepStrictEqual(simplifyLine(coords, 2), coords);
});

test('length is measured in metres', () => {
  const len = lineLengthM([at(0, 0), at(300, 0), at(300, 400)]);
  assert.ok(Math.abs(len - 700) < 0.01, `got ${len}`);
});

test('a line with fewer than two points has no length', () => {
  assert.strictEqual(lineLengthM([at(0, 0)]), 0);
  assert.strictEqual(lineLengthM([]), 0);
});
