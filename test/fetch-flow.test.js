'use strict';

// Load against a flaky eProstor: retries, partial results and the page cap, through
// the real fetch code.

const test = require('node:test');
const assert = require('node:assert');

const { bootScript, waitFor, shortcut, features, FOREST } = require('./harness.js');

const STREET = JSON.parse(JSON.stringify(FOREST));
STREET.properties.EID_LINIJA = '300200000000000009';
STREET.properties.GJI_ATR1_SIFRA = 9;
STREET.geometry.coordinates = [[14.56, 46.06, 0], [14.561, 46.06, 0]];

const page = (feature, numberMatched, numberReturned = 1) =>
  ({ type: 'FeatureCollection', features: [feature], numberMatched, numberReturned });
const press = (ctx, id) => shortcut(ctx.calls, id)();
const status = (ctx) => ctx.dom('#qrsl-status').textContent;
const startIndexes = (ctx) => ctx.requests.map(r => Number(r.url.match(/startIndex=(\d+)/)[1]));

// Presses Load and waits until it has finished, however it ended.
async function loadAndSettle(ctx) {
  press(ctx, 'qrsl-load');
  await waitFor(() => !/Loading/.test(status(ctx)), 'the load to settle', 3000);
}

test('a page that times out is fetched again and the load completes', async () => {
  await bootScript({}, async (ctx) => {
    await loadAndSettle(ctx);
    assert.deepStrictEqual(startIndexes(ctx), [0, 0]);
    assert.strictEqual(features(ctx).length, 1);
    assert.doesNotMatch(status(ctx), /partially/);
  }, { respond: (n) => (n === 1 ? 'timeout' : undefined) });
});

test('the load follows the pages the server reports', async () => {
  await bootScript({}, async (ctx) => {
    await loadAndSettle(ctx);
    assert.deepStrictEqual(startIndexes(ctx), [0, 1000]);
    assert.strictEqual(features(ctx).length, 2, 'a road from each page');
    assert.doesNotMatch(status(ctx), /partially/);
  }, { respond: (n) => (n === 1 ? page(FOREST, 1001, 1000) : page(STREET, 1001)) });
});

test('a page that keeps failing after others arrived keeps what loaded', async () => {
  await bootScript({}, async (ctx) => {
    await loadAndSettle(ctx);
    assert.deepStrictEqual(startIndexes(ctx), [0, 1000, 1000, 1000], 'three attempts at the second page');
    assert.strictEqual(features(ctx).length, 1);
    assert.match(status(ctx), /Loaded partially/);
  }, { respond: (n) => (n === 1 ? page(FOREST, 2000, 1000) : 'error') });
});

test('a first page that keeps timing out loads nothing and Load still works', async () => {
  await bootScript({}, async (ctx) => {
    await loadAndSettle(ctx);
    assert.strictEqual(ctx.requests.length, 3);
    assert.deepStrictEqual(features(ctx), []);
    assert.strictEqual(status(ctx), 'eProstor timed out, no roads loaded');

    ctx.options.respond = undefined;
    await loadAndSettle(ctx);
    assert.strictEqual(features(ctx).length, 1);
  }, { respond: () => 'timeout' });
});

test('a rejected request is not retried', async () => {
  await bootScript({}, async (ctx) => {
    await loadAndSettle(ctx);
    assert.strictEqual(ctx.requests.length, 1);
    assert.strictEqual(status(ctx), 'eProstor rejected the request (HTTP 400), no roads loaded');
  }, { cadastre: 'reject' });
});

test('every page draws on one retry budget', async () => {
  // Two retries on each of the first two pages spend all four, so the third page's
  // first timeout ends the load with what arrived.
  const replies = ['timeout', 'timeout', page(FOREST, 5000, 1000), 'timeout', 'timeout', page(FOREST, 5000, 1000), 'timeout'];
  await bootScript({}, async (ctx) => {
    await loadAndSettle(ctx);
    assert.deepStrictEqual(startIndexes(ctx), [0, 0, 0, 1000, 1000, 1000, 2000]);
    assert.match(status(ctx), /Loaded partially/);
  }, { respond: (n) => replies[n - 1] });
});

test('a load stops after 30 pages', async () => {
  await bootScript({}, async (ctx) => {
    await loadAndSettle(ctx);
    assert.strictEqual(ctx.requests.length, 30);
    assert.match(status(ctx), /Loaded partially/);
  }, { respond: () => page(FOREST, 1e6, 1000) });
});

test('clear during a retry backoff stops the load', async () => {
  await bootScript({}, async (ctx) => {
    press(ctx, 'qrsl-load');
    await new Promise(r => setTimeout(r, 10));
    press(ctx, 'qrsl-clear');
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(ctx.requests.length, 1, 'no retry after Clear');
  }, { respond: () => 'timeout' });
});
