'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  bootScript, fire, argsOf, load, features,
  LAYER, FOREST, FOREST_ID, FOREST_COORDS
} = require('./harness.js');

const click = (ctx, featureId = FOREST_ID, layerName = LAYER) =>
  fire(ctx.handlers, 'wme-layer-feature-clicked', { featureId, layerName });

test('clicking a road creates one segment from its geometry', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    click(ctx);

    assert.deepStrictEqual(argsOf(ctx.calls, 'DataModel.Segments.addSegment'), [{
      geometry: { type: 'LineString', coordinates: FOREST_COORDS },
      roadType: 8
    }]);
    assert.deepStrictEqual(argsOf(ctx.calls, 'DataModel.Segments.updateSegment'), [{
      segmentId: -101, direction: 'TWO_WAY', flagAttributes: { unpaved: true }
    }]);
    assert.deepStrictEqual(argsOf(ctx.calls, 'DataModel.Cities.getCity'), [{ cityName: '', countryId: 197 }]);
    assert.deepStrictEqual(argsOf(ctx.calls, 'DataModel.Streets.getStreet'), [{ streetName: '', cityId: 55 }]);
    assert.deepStrictEqual(argsOf(ctx.calls, 'DataModel.Segments.updateAddress'), [{
      segmentId: -101, addressData: { primaryStreetId: 77 }
    }]);
    assert.deepStrictEqual(argsOf(ctx.calls, 'Editing.setSelection'), [{
      selection: { ids: [-101], objectType: 'segment' }
    }]);
    assert.strictEqual(features(ctx)[0].properties.state, 'imported');
  });
});

test('the click handler is registered', async () => {
  const { handlers } = await bootScript();
  assert.ok(handlers.has('wme-layer-feature-clicked'));
});

test('a second click on the same road creates nothing', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    click(ctx);
    click(ctx);
    assert.strictEqual(argsOf(ctx.calls, 'DataModel.Segments.addSegment').length, 1);
  });
});

test('clicks on other layers are ignored', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    click(ctx, FOREST_ID, 'some-other-script-layer');
    assert.strictEqual(argsOf(ctx.calls, 'DataModel.Segments.addSegment').length, 0);
  });
});

test('an unknown feature id is ignored', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    click(ctx, 'nope-0');
    assert.strictEqual(argsOf(ctx.calls, 'DataModel.Segments.addSegment').length, 0);
  });
});

test('a paved category is not marked unpaved', async () => {
  const street = JSON.parse(JSON.stringify(FOREST));
  street.properties.GJI_ATR1_SIFRA = 9;
  await bootScript({}, async (ctx) => {
    await load(ctx);
    click(ctx);
    assert.deepStrictEqual(argsOf(ctx.calls, 'DataModel.Segments.addSegment')[0].roadType, 1);
    assert.deepStrictEqual(argsOf(ctx.calls, 'DataModel.Segments.updateSegment'), [{
      segmentId: -101, direction: 'TWO_WAY'
    }]);
  }, { cadastre: { type: 'FeatureCollection', features: [street], numberMatched: 1, numberReturned: 1 } });
});

test('nothing is created where editing is not allowed', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    click(ctx);
    assert.strictEqual(argsOf(ctx.calls, 'DataModel.Segments.addSegment').length, 0);
    assert.strictEqual(features(ctx)[0].properties.state, 'missing');
  }, { editingAllowed: false });
});

test('a failed addSegment leaves the road clickable', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    click(ctx);
    assert.strictEqual(features(ctx)[0].properties.state, 'missing');
    assert.strictEqual(argsOf(ctx.calls, 'DataModel.Segments.updateSegment').length, 0);

    ctx.options.addSegmentThrows = false;
    click(ctx);
    assert.strictEqual(argsOf(ctx.calls, 'DataModel.Segments.addSegment').length, 2);
    assert.strictEqual(features(ctx)[0].properties.state, 'imported');
  }, { addSegmentThrows: true });
});

test('a failure after the segment exists still marks the road imported', async () => {
  // The segment is there; a second click would make a duplicate.
  await bootScript({}, async (ctx) => {
    await load(ctx);
    click(ctx);
    assert.strictEqual(features(ctx)[0].properties.state, 'imported');
    assert.strictEqual(argsOf(ctx.calls, 'Editing.setSelection').length, 1, 'later steps still run');
    click(ctx);
    assert.strictEqual(argsOf(ctx.calls, 'DataModel.Segments.addSegment').length, 1);
  }, { updateAddressThrows: true });
});

test('an imported road stays drawn when WME data reloads', async () => {
  // The new segment covers it, but it is shown grey as a record of what was added.
  await bootScript({}, async (ctx) => {
    await load(ctx);
    click(ctx);
    ctx.options.wmeSegments = [{ id: -101, geometry: { type: 'LineString', coordinates: FOREST_COORDS } }];
    fire(ctx.handlers, 'wme-map-data-loaded', {});
    assert.deepStrictEqual(features(ctx).map(f => f.properties.state), ['imported']);
  });
});
