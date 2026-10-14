'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ROAD_TYPES,
  categoryInfo,
  roadTypeName,
  planSegment,
  describeLine
} = require('../wme-sl-road-import.user.js');

// SDK ROAD_TYPE ids
const FREEWAY = 3;
const MINOR_HIGHWAY = 7;
const PRIMARY_STREET = 2;
const STREET = 1;
const OFF_ROAD = 8;
const PRIVATE_ROAD = 17;

test('every known category maps to its road type', () => {
  const expected = {
    0: STREET, 1: FREEWAY, 2: MINOR_HIGHWAY,
    3: PRIMARY_STREET, 4: PRIMARY_STREET,
    5: PRIMARY_STREET, 6: PRIMARY_STREET, 7: PRIMARY_STREET, 8: PRIMARY_STREET,
    9: STREET, 10: STREET,
    11: PRIMARY_STREET, 12: PRIMARY_STREET, 13: STREET,
    17: OFF_ROAD, 18: PRIVATE_ROAD
  };
  for (const [code, roadType] of Object.entries(expected)) {
    const info = categoryInfo(Number(code));
    assert.strictEqual(info.roadType, roadType, `category ${code}`);
    assert.strictEqual(info.excluded, false, `category ${code}`);
  }
});

test('cycle paths, hiking trails and footpaths are excluded', () => {
  for (const code of [14, 16, 19, 20]) {
    assert.strictEqual(categoryInfo(code).excluded, true, `category ${code}`);
  }
});

test('only forest roads are unpaved', () => {
  assert.strictEqual(categoryInfo(17).unpaved, true);
  for (const code of [0, 1, 9, 10, 13, 18]) {
    assert.strictEqual(categoryInfo(code).unpaved, false, `category ${code}`);
  }
});

test('categories carry the cadastre name', () => {
  assert.strictEqual(categoryInfo(17).name, 'gozdna cesta');
  assert.strictEqual(categoryInfo(12).name, 'zbirna mestna ali krajevna cesta');
});

test('an unknown category is offered as a plain street', () => {
  for (const code of [15, 42]) {
    assert.deepStrictEqual(categoryInfo(code), {
      name: `kategorija ${code}`, roadType: STREET, unpaved: false, excluded: false
    });
  }
});

test('auto road type comes from the category', () => {
  assert.deepStrictEqual(planSegment({ category: 9 }, null), { roadType: STREET, unpaved: false });
  assert.deepStrictEqual(planSegment({ category: 17 }, null), { roadType: OFF_ROAD, unpaved: true });
});

test('an override replaces the road type but not the unpaved flag', () => {
  // A forest road set to Street by hand is still a gravel track.
  assert.deepStrictEqual(planSegment({ category: 17 }, STREET), { roadType: STREET, unpaved: true });
  assert.deepStrictEqual(planSegment({ category: 9 }, OFF_ROAD), { roadType: OFF_ROAD, unpaved: false });
});

test('every road type in the dropdown has a name', () => {
  for (const { id, name } of ROAD_TYPES) assert.strictEqual(roadTypeName(id), name);
  assert.strictEqual(roadTypeName(99), 'road type 99');
});

test('the hover text follows the dropdown', () => {
  const forest = { category: 17, lengthM: 311.6 };
  assert.strictEqual(describeLine(forest, null), 'gozdna cesta → Off-road / Not maintained, unpaved, 312 m');
  assert.strictEqual(describeLine(forest, STREET), 'gozdna cesta → Street, unpaved, 312 m');
  assert.strictEqual(describeLine({ category: 9, lengthM: 40 }, null), 'lokalna cesta → Street, 40 m');
});
