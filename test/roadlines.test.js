'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildRoadLines } = require('../wme-sl-road-import.user.js');

function feature(eid, category, coordinates, type = 'LineString') {
  return {
    type: 'Feature',
    id: `LINIJE_CESTE_G.${eid}`,
    geometry: { type, coordinates },
    properties: { FEATUREID: Number(eid), EID_LINIJA: eid, GJI_TEMATIKA_ID: 1, GJI_ATR1_SIFRA: category }
  };
}

test('a cadastre feature becomes a road line', () => {
  const [line] = buildRoadLines([feature('300200000000000017', 17, [[14.5, 46, 1], [14.501, 46, 2]])]);
  assert.strictEqual(line.id, '300200000000000017-0');
  assert.strictEqual(line.eid, '300200000000000017');
  assert.strictEqual(line.category, 17);
  assert.deepStrictEqual(line.coords, [[14.5, 46], [14.501, 46]]);
  assert.ok(Math.abs(line.lengthM - 77.33) < 0.05, `got ${line.lengthM}`);
});

test('excluded categories never become lines', () => {
  const lines = buildRoadLines([14, 16, 19, 20].map(c => feature(`3002000000000001${c}`, c, [[14.5, 46], [14.501, 46]])));
  assert.deepStrictEqual(lines, []);
});

test('ids come from EID_LINIJA, not the rounded FEATUREID', () => {
  // Both FEATUREIDs parse to the same double, 300200000406761200.
  const a = feature('300200000406761231', 9, [[14.5, 46], [14.501, 46]]);
  const b = feature('300200000406761232', 9, [[14.6, 46], [14.601, 46]]);
  assert.strictEqual(a.properties.FEATUREID, b.properties.FEATUREID, 'fixture sanity');
  assert.deepStrictEqual(buildRoadLines([a, b]).map(l => l.id), ['300200000406761231-0', '300200000406761232-0']);
});

test('a MultiLineString gives one line per member', () => {
  const lines = buildRoadLines([feature('5', 9, [[[14.5, 46], [14.501, 46]], [[14.6, 46], [14.601, 46]]], 'MultiLineString')]);
  assert.deepStrictEqual(lines.map(l => l.id), ['5-0', '5-1']);
});

test('a feature repeated across pages is kept once', () => {
  const f = feature('7', 9, [[14.5, 46], [14.501, 46]]);
  assert.strictEqual(buildRoadLines([f, f]).length, 1);
});

test('the feature id is the fallback when EID_LINIJA is missing', () => {
  const f = feature('8', 9, [[14.5, 46], [14.501, 46]]);
  delete f.properties.EID_LINIJA;
  assert.deepStrictEqual(buildRoadLines([f]).map(l => l.id), ['LINIJE_CESTE_G.8-0']);
});

test('a feature with no id at all is skipped', () => {
  const f = feature('9', 9, [[14.5, 46], [14.501, 46]]);
  delete f.properties.EID_LINIJA;
  delete f.id;
  assert.deepStrictEqual(buildRoadLines([f]), []);
});

test('lines are simplified', () => {
  const [line] = buildRoadLines([feature('10', 17, [[14.5, 46], [14.5005, 46.000001], [14.501, 46]])]);
  assert.deepStrictEqual(line.coords, [[14.5, 46], [14.501, 46]]);
});
