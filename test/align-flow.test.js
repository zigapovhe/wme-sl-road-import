'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { bootScript, fire, argsOf, shortcut, load, features, LAYER } = require('./harness.js');

// A WME road along the forest fixture, 5 m off it: north of the east leg, west of the
// north leg.
const SEG_COORDS = [[14.55, 46.05005], [14.55094, 46.05005], [14.55094, 46.051]];
const segment = (coords = SEG_COORDS) => ({
  id: 1, hasHouseNumbers: false, geometry: { type: 'LineString', coordinates: coords.map(p => p.slice()) }
});
const SELECTED = { objectType: 'segment', ids: [1] };

const press = (ctx) => shortcut(ctx.calls, 'qrsl-snap')();
const preview = (ctx) => features(ctx).find(f => f.properties.state === 'preview');
const updates = (ctx) => argsOf(ctx.calls, 'DataModel.Segments.updateSegment');

test('the first press previews the aligned shape, the second applies it', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    press(ctx);
    assert.strictEqual(updates(ctx).length, 0, 'nothing changes on the first press');
    const shown = preview(ctx);
    assert.ok(shown, 'a preview is drawn');
    const coords = shown.geometry.coordinates;
    assert.deepStrictEqual(coords[0], SEG_COORDS[0], 'the start node stays put');
    assert.deepStrictEqual(coords[coords.length - 1], SEG_COORDS[2], 'the end node stays put');
    assert.ok(coords.some(c => c[0] === 14.551 && c[1] === 46.05), 'it follows the cadastre corner');

    press(ctx);
    assert.deepStrictEqual(updates(ctx), [{ segmentId: 1, geometry: { type: 'LineString', coordinates: coords } }]);
    assert.strictEqual(preview(ctx), undefined, 'the preview goes once applied');
  }, { selection: SELECTED, segments: { 1: segment() }, wmeSegments: [segment()] });
});

test('the preview lets the mouse through', async () => {
  const { layers } = await bootScript();
  const rule = layers.get(LAYER).styleRules.filter(r => r.predicate({ state: 'preview' })).pop();
  assert.ok(rule, 'a preview has its own style');
  assert.strictEqual(rule.style.pointerEvents, 'none');
});

test('with nothing selected nothing happens', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    press(ctx);
    press(ctx);
    assert.strictEqual(preview(ctx), undefined);
    assert.strictEqual(updates(ctx).length, 0);
  }, { segments: { 1: segment() } });
});

test('with two segments selected nothing happens', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    press(ctx);
    press(ctx);
    assert.strictEqual(preview(ctx), undefined);
    assert.strictEqual(updates(ctx).length, 0);
  }, { selection: { objectType: 'segment', ids: [1, 2] }, segments: { 1: segment(), 2: segment() } });
});

test('a segment the cadastre doesn\'t follow is left alone', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    press(ctx);
    press(ctx);
    assert.strictEqual(preview(ctx), undefined);
    assert.strictEqual(updates(ctx).length, 0);
  }, { selection: SELECTED, segments: { 1: segment([[14.56, 46.06], [14.561, 46.06]]) } });
});

test('before a load there is nothing to align to', async () => {
  await bootScript({}, async (ctx) => {
    press(ctx);
    press(ctx);
    assert.strictEqual(updates(ctx).length, 0);
  }, { selection: SELECTED, segments: { 1: segment() } });
});

test('selecting something else drops the preview', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    press(ctx);
    assert.ok(preview(ctx));
    ctx.options.selection = null;
    fire(ctx.handlers, 'wme-selection-changed', {});
    assert.strictEqual(preview(ctx), undefined);

    // Coming back to the segment starts over with a preview, not an apply.
    ctx.options.selection = SELECTED;
    fire(ctx.handlers, 'wme-selection-changed', {});
    press(ctx);
    assert.ok(preview(ctx));
    assert.strictEqual(updates(ctx).length, 0);
  }, { selection: SELECTED, segments: { 1: segment() } });
});

test('a segment edited since the preview is previewed again, not changed', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    press(ctx);
    ctx.options.segments[1].geometry.coordinates[1] = [14.55093, 46.05004];
    press(ctx);
    assert.strictEqual(updates(ctx).length, 0);
    assert.ok(preview(ctx), 'a fresh preview for the edited segment');
  }, { selection: SELECTED, segments: { 1: segment() } });
});

test('clear drops the preview', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    press(ctx);
    shortcut(ctx.calls, 'qrsl-clear')();
    assert.strictEqual(preview(ctx), undefined);
    press(ctx);
    assert.strictEqual(updates(ctx).length, 0);
  }, { selection: SELECTED, segments: { 1: segment() } });
});

test('nothing changes where editing is not allowed', async () => {
  await bootScript({}, async (ctx) => {
    await load(ctx);
    press(ctx);
    press(ctx);
    assert.strictEqual(updates(ctx).length, 0);
  }, { selection: SELECTED, segments: { 1: segment() }, editingAllowed: false });
});
