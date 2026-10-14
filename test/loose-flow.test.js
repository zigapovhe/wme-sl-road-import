'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { bootScript, fire, argsOf, shortcut, load, features, LAYER } = require('./harness.js');

const KX = 111320 * Math.cos(46 * Math.PI / 180);
const at = (x, y) => [14.5 + x / KX, 46 + y / 110540];

// A side road whose end (node 3) stops 3 m short of the main road.
const segment = (id, from, to, coords) => ({
  id, roadType: 1, fromNodeId: from, toNodeId: to, geometry: { type: 'LineString', coordinates: coords }
});
const node = (id, coords, connectedSegmentIds) => ({ id, geometry: { type: 'Point', coordinates: coords }, connectedSegmentIds });
const SEGMENTS = [
  segment(1, 1, 2, [at(-100, 0), at(100, 0)]),
  segment(2, 3, 4, [at(0, 3), at(0, 100)])
];
const NODES = [
  node(1, at(-100, 0), [1]), node(2, at(100, 0), [1]),
  node(3, at(0, 3), [2]), node(4, at(0, 100), [2])
];
const DISCONNECTED = { wmeSegments: SEGMENTS, wmeNodes: NODES };

const rings = (ctx) => features(ctx).filter(f => f.properties.state === 'loose');
const settle = () => new Promise(r => setTimeout(r, 300));

test('a disconnected end is ringed without loading anything', async () => {
  await bootScript({}, async (ctx) => {
    await settle();
    assert.deepStrictEqual(rings(ctx), [{
      type: 'Feature', id: 'loose-3', geometry: { type: 'Point', coordinates: at(0, 3) }, properties: { state: 'loose' }
    }]);
    assert.strictEqual(ctx.requests.length, 0, 'no cadastre request');
  }, DISCONNECTED);
});

test('the ring lets the mouse through to the node under it', async () => {
  const { layers } = await bootScript();
  const rule = layers.get(LAYER).styleRules.filter(r => r.predicate({ state: 'loose' })).pop();
  assert.ok(rule, 'a ring has its own style');
  assert.strictEqual(rule.style.pointerEvents, 'none');
});

test('segment and node changes are tracked', async () => {
  const { calls } = await bootScript();
  const tracked = argsOf(calls, 'Events.trackDataModelEvents').map(a => a.dataModelName).sort();
  assert.deepStrictEqual(tracked, ['nodes', 'segments']);
});

test('connecting the end removes its ring', async () => {
  await bootScript({}, async (ctx) => {
    await settle();
    assert.strictEqual(rings(ctx).length, 1);
    // The editor drags node 3 onto the main road: WME splits it at a new node 5.
    ctx.options.wmeSegments = [
      segment(1, 1, 5, [at(-100, 0), at(0, 0)]),
      segment(3, 5, 2, [at(0, 0), at(100, 0)]),
      segment(2, 5, 4, [at(0, 0), at(0, 100)])
    ];
    ctx.options.wmeNodes = [
      node(1, at(-100, 0), [1]), node(2, at(100, 0), [3]),
      node(5, at(0, 0), [1, 3, 2]), node(4, at(0, 100), [2])
    ];
    fire(ctx.handlers, 'wme-data-model-objects-changed', { dataModelName: 'nodes', objectIds: [5] });
    await settle();
    assert.deepStrictEqual(rings(ctx), []);
  }, { ...DISCONNECTED });
});

test('a new disconnected end is ringed when map data loads', async () => {
  await bootScript({}, async (ctx) => {
    await settle();
    assert.strictEqual(rings(ctx).length, 0);
    ctx.options.wmeSegments = SEGMENTS;
    ctx.options.wmeNodes = NODES;
    fire(ctx.handlers, 'wme-map-data-loaded');
    await settle();
    assert.strictEqual(rings(ctx).length, 1);
  });
});

test('the rings stay through load and clear', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    assert.strictEqual(rings(ctx).length, 1, 'after load');
    assert.ok(features(ctx).some(f => f.properties.state === 'missing'), 'pink roads are drawn as well');
    shortcut(ctx.calls, 'qrsl-clear')();
    assert.strictEqual(rings(ctx).length, 1, 'after clear');
  }, DISCONNECTED);
});

test('turning disconnected ends off is remembered', async () => {
  await bootScript({ 'qrsl-show-loose': '0' }, async (ctx) => {
    await settle();
    fire(ctx.handlers, 'wme-map-data-loaded');
    await settle();
    assert.deepStrictEqual(rings(ctx), []);
  }, DISCONNECTED);
});
