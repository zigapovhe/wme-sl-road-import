'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  bootScript, fire, argsOf, shortcut, load, features,
  LAYER, FOREST_ID, FOREST_COORDS, DEFAULT_CADASTRE
} = require('./harness.js');

test('the script boots without throwing', async () => {
  await assert.doesNotReject(bootScript);
});

test('the road layer is created hidden and tracks layer events', async () => {
  const { calls, layers } = await bootScript({ 'qrsl-layer-visible': '0' });
  assert.ok(layers.has(LAYER));
  assert.deepStrictEqual(argsOf(calls, 'Map.setLayerVisibility')[0], { layerName: LAYER, visibility: false });
  assert.deepStrictEqual(argsOf(calls, 'Events.trackLayerEvents'), [{ layerName: LAYER }]);
});

test('the layer is shown by default from zoom 16', async () => {
  const { layers } = await bootScript();
  assert.strictEqual(layers.get(LAYER).visible, true);
});

test('a hidden layer setting is remembered', async () => {
  const { layers } = await bootScript({ 'qrsl-layer-visible': '0' });
  assert.strictEqual(layers.get(LAYER).visible, false);
});

test('below zoom 16 the layer stays hidden', async () => {
  const { layers } = await bootScript({}, null, { zoom: 15 });
  assert.strictEqual(layers.get(LAYER).visible, false);
});

test('startup registers the map and layer event handlers', async () => {
  const { handlers } = await bootScript();
  for (const evt of [
    'wme-map-zoom-changed', 'wme-map-data-loaded',
    'wme-layer-feature-mouse-enter', 'wme-layer-feature-mouse-leave'
  ]) {
    assert.ok(handlers.has(evt), `expected a handler for ${evt}`);
  }
});

test('firing every registered handler throws nothing', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    for (const [eventName, list] of ctx.handlers) {
      for (const handler of list) {
        assert.doesNotThrow(() => handler({ x: 0, y: 0 }), `handler for ${eventName} threw`);
      }
    }
  });
});

test('every panel handler runs without throwing', async () => {
  await bootScript({}, ({ domHandlers }) => {
    assert.ok(domHandlers.length >= 4, `expected load, clear, toggle and dropdown, got ${domHandlers.length}`);
    for (const { type, handler } of domHandlers) {
      assert.doesNotThrow(() => handler({ preventDefault() {}, stopPropagation() {}, target: {} }),
        `a "${type}" handler threw`);
    }
  });
});

test('load draws missing roads and never excluded ones', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    assert.match(ctx.requests[0].url, /&startIndex=0&bbox=14\.5,46,14\.6,46\.1$/);
    assert.deepStrictEqual(features(ctx), [{
      type: 'Feature',
      id: FOREST_ID,
      geometry: { type: 'LineString', coordinates: FOREST_COORDS },
      properties: { state: 'missing' }
    }]);
  });
});

test('load turns the layer on', async () => {
  await bootScript({ 'qrsl-layer-visible': '0' }, async (ctx) => {
    await load(ctx);
    assert.strictEqual(ctx.layers.get(LAYER).visible, true);
  });
});

test('a road WME already has is not drawn', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    assert.deepStrictEqual(features(ctx), []);
  }, { wmeSegments: [{ id: 1, geometry: { type: 'LineString', coordinates: FOREST_COORDS } }] });
});

test('WME data arriving after the load hides roads WME has', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    assert.strictEqual(features(ctx).length, 1);
    ctx.options.wmeSegments = [{ id: 1, geometry: { type: 'LineString', coordinates: FOREST_COORDS } }];
    fire(ctx.handlers, 'wme-map-data-loaded', {});
    assert.deepStrictEqual(features(ctx), []);
  });
});

test('clear during a load drops the late result', async () => {
  await bootScript({}, async (ctx) => {
    shortcut(ctx.calls, 'qrsl-load')();
    shortcut(ctx.calls, 'qrsl-clear')();
    await new Promise(r => setTimeout(r, 50));
    assert.deepStrictEqual(features(ctx), []);
  });
});

test('load right after clear starts a new load', async () => {
  // Clear cannot cancel the request already in flight. It must not leave Load refusing
  // to start until that request finally returns, up to 30 s later.
  await bootScript({}, async (ctx) => {
    shortcut(ctx.calls, 'qrsl-load')();
    shortcut(ctx.calls, 'qrsl-clear')();
    shortcut(ctx.calls, 'qrsl-load')();
    assert.strictEqual(ctx.requests.length, 2, 'the second load goes out at once');

    // The stale first load returns at 50 ms while the second is still in flight, so
    // another press must still be refused.
    await new Promise(r => setTimeout(r, 100));
    shortcut(ctx.calls, 'qrsl-load')();
    assert.strictEqual(ctx.requests.length, 2, 'the stale load must not release Load');

    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(features(ctx).length, 1, 'the second load is drawn');
  }, { responseDelayMs: (n) => (n === 1 ? 50 : 200) });
});

test('below zoom 16 load does not fetch', async () => {
  await bootScript({}, async (ctx) => {
    shortcut(ctx.calls, 'qrsl-load')();
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(ctx.requests.length, 0);
  }, { zoom: 15 });
});

test('a rejected request leaves the layer empty and load usable', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    assert.deepStrictEqual(features(ctx), []);
    ctx.options.cadastre = DEFAULT_CADASTRE;
    await load(ctx);
    assert.strictEqual(features(ctx).length, 1);
  }, { cadastre: 'reject' });
});
