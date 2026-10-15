'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { bootScript, fire, argsOf, shortcut, load, features, LAYER, LOOSE_LAYER } = require('./harness.js');

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

const rings = (ctx) => ctx.layers.get(LOOSE_LAYER).features;
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

const styleOf = (layers, state) => layers.get(LOOSE_LAYER).styleRules.filter(r => r.predicate({ state })).pop()?.style;

test('the ring lets the mouse through to the node under it', async () => {
  const { layers } = await bootScript();
  for (const state of ['loose', 'loose-dot']) {
    assert.ok(styleOf(layers, state), `${state} has its own style`);
    assert.strictEqual(styleOf(layers, state).pointerEvents, 'none');
  }
});

test('disconnected ends show at any zoom, whatever Show layer says', async () => {
  await bootScript({ 'qrsl-layer-visible': '0' }, async (ctx) => {
    await settle();
    assert.strictEqual(ctx.layers.get(LAYER).visible, false);
    assert.notStrictEqual(ctx.layers.get(LOOSE_LAYER).visible, false);
    assert.strictEqual(rings(ctx).length, 1);
  }, { ...DISCONNECTED, zoom: 12 });
});

test('zoomed out, an end is a solid dot, zoomed in a ring', async () => {
  await bootScript({}, async (ctx) => {
    await settle();
    assert.deepStrictEqual(rings(ctx).map(f => f.properties.state), ['loose-dot']);
    assert.ok(styleOf(ctx.layers, 'loose-dot').fillOpacity > 0.5, 'the dot is filled');
    ctx.options.zoom = 17;
    fire(ctx.handlers, 'wme-map-zoom-changed');
    assert.deepStrictEqual(rings(ctx).map(f => f.properties.state), ['loose']);
  }, { ...DISCONNECTED, zoom: 14 });
});

test('an end stays listed after WME unloads it', async () => {
  await bootScript({}, async (ctx) => {
    await settle();
    // Panned far away: WME drops the data and loads another area.
    ctx.options.wmeSegments = [];
    ctx.options.wmeNodes = [];
    ctx.options.extent = [15.0, 46.5, 15.1, 46.6];
    fire(ctx.handlers, 'wme-data-model-objects-removed', { dataModelName: 'segments', objectIds: [1, 2] });
    fire(ctx.handlers, 'wme-map-data-loaded');
    await settle();
    assert.strictEqual(rings(ctx).length, 1);
    assert.match(ctx.dom('#qrsl-loose-list').innerHTML, /46\.00003, 14\.50000/);
  }, { ...DISCONNECTED });
});

test('zoomed out, an end stays when WME has dropped the road next to it', async () => {
  await bootScript({}, async (ctx) => {
    await settle();
    ctx.options.zoom = 14;
    ctx.options.wmeSegments = [SEGMENTS[1]];
    ctx.options.wmeNodes = NODES.slice(2);
    fire(ctx.handlers, 'wme-map-zoom-changed');
    fire(ctx.handlers, 'wme-map-data-loaded');
    await settle();
    assert.deepStrictEqual(rings(ctx).map(f => f.properties.state), ['loose-dot']);
  }, { ...DISCONNECTED });
});

test('a deleted road clears once WME has loaded its spot again', async () => {
  await bootScript({}, async (ctx) => {
    await settle();
    ctx.options.wmeSegments = [SEGMENTS[0]];
    ctx.options.wmeNodes = NODES.slice(0, 2);
    fire(ctx.handlers, 'wme-data-model-objects-removed', { dataModelName: 'segments', objectIds: [2] });
    await settle();
    assert.strictEqual(rings(ctx).length, 1, 'an edit alone could be WME still loading');
    fire(ctx.handlers, 'wme-map-data-loaded');
    await settle();
    assert.deepStrictEqual(rings(ctx), []);
  }, { ...DISCONNECTED });
});

test('the sidebar lists each end and a click centres the map on it', async () => {
  await bootScript({}, async (ctx) => {
    await settle();
    assert.match(ctx.dom('#qrsl-loose').textContent, /^1 disconnected end/);
    const html = ctx.dom('#qrsl-loose-list').innerHTML;
    assert.match(html, /data-node="3"/);
    assert.match(html, /46\.00003, 14\.50000/);
    const click = ctx.domHandlers.find(h => h.selector === '#qrsl-loose-list' && h.type === 'click').handler;
    click({ target: { closest: () => ({ dataset: { node: '3' } }) } });
    const [lon, lat] = at(0, 3);
    assert.deepStrictEqual(argsOf(ctx.calls, 'Map.setMapCenter'), [{ lonLat: { lon, lat }, zoomLevel: 18 }]);
  }, { ...DISCONNECTED });
});

test('going to an end never zooms the map out', async () => {
  await bootScript({}, async (ctx) => {
    await settle();
    const click = ctx.domHandlers.find(h => h.selector === '#qrsl-loose-list' && h.type === 'click').handler;
    click({ target: { closest: () => ({ dataset: { node: '3' } }) } });
    assert.strictEqual(argsOf(ctx.calls, 'Map.setMapCenter')[0].zoomLevel, 20);
  }, { ...DISCONNECTED, zoom: 20 });
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
