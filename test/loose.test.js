'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { looseEnds, updateLooseList } = require('../wme-sl-road-import.user.js');

const LON0 = 14.5;
const LAT0 = 46;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const KY = 110540;
const at = (x, y) => [LON0 + x / KX, LAT0 + y / KY];

// WME segments and nodes as the SDK returns them, from { id, from, to, coords }.
function network(segs) {
  const nodes = new Map();
  for (const s of segs) {
    for (const [nodeId, p] of [[s.from, s.coords[0]], [s.to, s.coords[s.coords.length - 1]]]) {
      if (!nodes.has(nodeId)) nodes.set(nodeId, { id: nodeId, geometry: { type: 'Point', coordinates: p }, connectedSegmentIds: [] });
      nodes.get(nodeId).connectedSegmentIds.push(s.id);
    }
  }
  return {
    segments: segs.map(s => ({
      id: s.id, roadType: s.roadType ?? 1, fromNodeId: s.from, toNodeId: s.to,
      geometry: { type: 'LineString', coordinates: s.coords }
    })),
    nodes: [...nodes.values()]
  };
}

// The value the runtime uses.
const loose = (segs) => {
  const { segments, nodes } = network(segs);
  return looseEnds(segments, nodes, 5).map(e => e.nodeId).sort((a, b) => a - b);
};

const MAIN = { id: 1, from: 1, to: 2, coords: [at(-100, 0), at(100, 0)] };

test('a dead end a few metres from another road is flagged', () => {
  assert.deepStrictEqual(loose([MAIN, { id: 2, from: 3, to: 4, coords: [at(0, 3), at(0, 100)] }]), [3]);
});

test('the flag sits on the dead end node', () => {
  const { segments, nodes } = network([MAIN, { id: 2, from: 3, to: 4, coords: [at(0, 3), at(0, 100)] }]);
  assert.deepStrictEqual(looseEnds(segments, nodes, 5), [{ nodeId: 3, segmentId: 2, coords: at(0, 3) }]);
});

test('a road joined at a node is not flagged', () => {
  assert.deepStrictEqual(loose([
    { id: 1, from: 1, to: 5, coords: [at(-100, 0), at(0, 0)] },
    { id: 3, from: 5, to: 2, coords: [at(0, 0), at(100, 0)] },
    { id: 2, from: 5, to: 4, coords: [at(0, 0), at(0, 100)] }
  ]), []);
});

test('a dead end further than 5 m from any road is left alone', () => {
  assert.deepStrictEqual(loose([MAIN, { id: 2, from: 3, to: 4, coords: [at(0, 8), at(0, 100)] }]), []);
});

test('a dead end with nothing near it is not flagged', () => {
  // Its own segment is right there, but that is not another road.
  assert.deepStrictEqual(loose([MAIN]), []);
});

test('two roads ending on top of each other are both flagged', () => {
  assert.deepStrictEqual(loose([
    { id: 1, from: 1, to: 2, coords: [at(-100, 0), at(0, 0)] },
    { id: 2, from: 3, to: 4, coords: [at(1, 1), at(100, 0)] }
  ]), [2, 3]);
});

test('railways, ferries and runways never count, either way round', () => {
  for (const roadType of [15, 18, 19]) {
    assert.deepStrictEqual(loose([
      { ...MAIN, roadType },
      { id: 2, from: 3, to: 4, coords: [at(0, 3), at(0, 100)] }
    ]), [], `a road ending next to road type ${roadType}`);
    assert.deepStrictEqual(loose([
      MAIN,
      { id: 2, from: 3, to: 4, coords: [at(0, 3), at(0, 100)], roadType }
    ]), [], `road type ${roadType} ending next to a road`);
  }
});

test('a node whose segment WME has not loaded is skipped', () => {
  const { segments, nodes } = network([MAIN]);
  nodes.push({ id: 9, geometry: { type: 'Point', coordinates: at(0, 3) }, connectedSegmentIds: [99] });
  assert.deepStrictEqual(looseEnds(segments, nodes, 5), []);
});

test('missing geometry is skipped', () => {
  const { segments, nodes } = network([MAIN, { id: 2, from: 3, to: 4, coords: [at(0, 3), at(0, 100)] }]);
  segments.push({ id: 7, roadType: 1, fromNodeId: 8, toNodeId: 9, geometry: null });
  nodes.push({ id: 8, geometry: null, connectedSegmentIds: [7] });
  assert.deepStrictEqual(looseEnds(segments, nodes, 5).map(e => e.nodeId), [3]);
});

// The session list, from ends as looseEnds returns them.
const end = (nodeId, segmentId, coords = at(0, 3)) => ({ nodeId, segmentId, coords });
const ZOOMED_IN = { allRoadTypes: true, spotLoaded: () => false };
const listed = (list, found, segs, extra = {}) => {
  const { segments, nodes } = network(segs);
  return updateLooseList(list, found, segments, nodes.concat(extra.nodes || []), { ...ZOOMED_IN, ...extra.view });
};

test('a listed end stays while WME has none of it loaded', () => {
  assert.deepStrictEqual(listed([end(3, 2)], [], []), [end(3, 2)]);
});

test('new ends go at the bottom and listed ones keep their place', () => {
  assert.deepStrictEqual(
    listed([end(5, 4)], [end(3, 2), end(5, 4)], []).map(e => e.nodeId),
    [5, 3]);
});

test('a listed end takes its new position when found again', () => {
  assert.deepStrictEqual(listed([end(3, 2, at(0, 3))], [end(3, 2, at(0, 2))], []), [end(3, 2, at(0, 2))]);
});

test('an end connected to the road drops off', () => {
  // Node 3 now joins segments 1 and 2, both loaded.
  assert.deepStrictEqual(listed([end(3, 2)], [], [
    { id: 1, from: 1, to: 3, coords: [at(-100, 3), at(0, 3)] },
    { id: 2, from: 3, to: 4, coords: [at(0, 3), at(0, 100)] }
  ]), []);
});

test('an end moved away from the road drops off', () => {
  assert.deepStrictEqual(listed([end(3, 2)], [], [
    MAIN, { id: 2, from: 3, to: 4, coords: [at(0, 30), at(0, 100)] }
  ]), []);
});

test('zoomed out, an end with no road loaded near it stays', () => {
  // WME loads only the bigger road types then, so the road it misses may be absent.
  const segs = [{ id: 2, from: 3, to: 4, coords: [at(0, 3), at(0, 100)] }];
  assert.deepStrictEqual(listed([end(3, 2)], [], segs, { view: { allRoadTypes: false } }), [end(3, 2)]);
});

test('zoomed out, an end that got a second segment drops off', () => {
  assert.deepStrictEqual(listed([end(3, 2)], [], [
    { id: 2, from: 3, to: 4, coords: [at(0, 3), at(0, 100)] }
  ], { nodes: [{ id: 3, geometry: { type: 'Point', coordinates: at(0, 3) }, connectedSegmentIds: [1, 2] }],
    view: { allRoadTypes: false } }), []);
});

test('an end whose node is loaded without its segment stays', () => {
  const lone = { id: 3, geometry: { type: 'Point', coordinates: at(0, 3) }, connectedSegmentIds: [2] };
  assert.deepStrictEqual(listed([end(3, 2)], [], [MAIN], { nodes: [lone] }), [end(3, 2)]);
});

test('an end dragged onto a road drops off', () => {
  // WME merged node 3 into node 5 on the main road, so segment 2 now starts there.
  assert.deepStrictEqual(listed([end(3, 2)], [], [
    { id: 1, from: 1, to: 5, coords: [at(-100, 0), at(0, 0)] },
    { id: 3, from: 5, to: 2, coords: [at(0, 0), at(100, 0)] },
    { id: 2, from: 5, to: 4, coords: [at(0, 0), at(0, 100)] }
  ]), []);
});

test('a deleted road drops off only once WME has loaded its spot', () => {
  assert.deepStrictEqual(listed([end(3, 2)], [], [MAIN]), [end(3, 2)]);
  assert.deepStrictEqual(listed([end(3, 2)], [], [MAIN], { view: { spotLoaded: () => true } }), []);
});

test('a loaded spot does not drop an end that is still there', () => {
  const segs = [MAIN, { id: 2, from: 3, to: 4, coords: [at(0, 3), at(0, 100)] }];
  const { segments, nodes } = network(segs);
  const found = looseEnds(segments, nodes, 5);
  assert.deepStrictEqual(updateLooseList([end(3, 2)], found, segments, nodes, { allRoadTypes: true, spotLoaded: () => true }),
    [end(3, 2)]);
});
