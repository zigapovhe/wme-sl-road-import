'use strict';

// Boots the whole userscript against stubbed browser and WME globals, as the HN
// importer's suite does. The only code that runs init(), so it catches undefined
// identifiers and broken wiring that `node --check` cannot see.
//
// A test failing on an SDK or browser call these stubs don't provide is a missing
// stub, not a bug: add it below.
//
// node --test also runs this file (it matches test/**/*.js). It defines no tests,
// so that run is a no-op.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, '..', 'wme-sl-road-import.user.js');
const LAYER = 'qrsl-roads';
const ENDS_LAYER = 'qrsl-ends';

const FOREST_ID = '300200000000000017-0/0'; // line 300200000000000017-0, first missing piece
const FOREST_COORDS = [[14.55, 46.05], [14.551, 46.05], [14.551, 46.051]];
const FOREST = {
  type: 'Feature',
  id: 'LINIJE_CESTE_G.300200000000000017',
  geometry: { type: 'LineString', coordinates: [[14.55, 46.05, 500.1], [14.551, 46.05, 501.2], [14.551, 46.051, 502.3]] },
  properties: { FEATUREID: 17, EID_LINIJA: '300200000000000017', GJI_TEMATIKA_ID: 1, GJI_ATR1_SIFRA: 17 }
};
const TRAIL = {
  type: 'Feature',
  id: 'LINIJE_CESTE_G.300200000000000019',
  geometry: { type: 'LineString', coordinates: [[14.56, 46.06, 600], [14.561, 46.061, 601]] },
  properties: { FEATUREID: 19, EID_LINIJA: '300200000000000019', GJI_TEMATIKA_ID: 1, GJI_ATR1_SIFRA: 19 }
};
const DEFAULT_CADASTRE = { type: 'FeatureCollection', features: [FOREST, TRAIL], numberMatched: 2, numberReturned: 2 };

const realSetTimeout = setTimeout;

// storage: localStorage contents to boot with.
// whileStubbed: run after boot and before the stubs come down. Anything that calls
// back into the script goes here.
// options, read at call time so a test may change them mid-run:
//   zoom (default 17), extent (what Map.getMapExtent returns),
//   wmeSegments (what Segments.getAll returns), wmeNodes (Nodes.getAll),
//   editingAllowed (default true), addSegmentThrows, updateAddressThrows,
//   selection (what Editing.getSelection returns), segments (id -> segment for getById),
//   cadastre: the FeatureCollection every request returns, or 'reject' for an HTTP 400.
//   respond: (requestNumber) => what that request gets instead: a FeatureCollection,
//     'reject', 'timeout' or 'error'. Returning undefined falls back to cadastre.
//   responseDelayMs: how long each request takes, a number or (requestNumber) => ms.
//
// Waits of a second or more, which are the retry backoff and the toast fade, run 20
// times faster, so retry tests take milliseconds.
async function bootScript(storage = {}, whileStubbed = null, options = {}) {
  const calls = [];
  const layers = new Map();
  const requests = [];
  const domHandlers = [];
  const handlers = new Map();

  // querySelector hands out one element per selector, which keeps what the script
  // sets on it, and click handlers remember the selector they were added under.
  const bySelector = new Map();
  const element = (selector = null) => {
    const props = {};
    return new Proxy(function () {}, {
      get: (t, k) => {
        if (k in props) return props[k];
        if (k === 'style') return {};
        if (k === 'classList') return { add() {}, remove() {}, toggle() {} };
        if (k === 'querySelector') return (sel) => {
          if (!bySelector.has(sel)) bySelector.set(sel, element(sel));
          return bySelector.get(sel);
        };
        if (k === 'closest') return () => element();
        if (k === 'querySelectorAll') return () => [];
        if (k === 'hasAttribute') return () => false;
        if (k === 'addEventListener') return (type, handler) => domHandlers.push({ type, handler, selector });
        if (k === 'innerHTML' || k === 'textContent' || k === 'value') return '';
        return element();
      },
      set: (t, k, v) => { props[k] = v; return true; },
      apply: () => element()
    });
  };

  function handleSdkCall(name, arg) {
    calls.push({ name, arg });
    switch (name) {
      case 'Events.on':
        if (!handlers.has(arg.eventName)) handlers.set(arg.eventName, []);
        handlers.get(arg.eventName).push(arg.eventHandler);
        return undefined;
      case 'Map.addLayer':
        // visible starts undefined, not false, so "created hidden" can tell an
        // explicit hide from a layer nobody touched.
        layers.set(arg.layerName, { visible: undefined, features: [], styleRules: arg.styleRules });
        return undefined;
      case 'Map.setLayerVisibility':
        if (layers.has(arg.layerName)) layers.get(arg.layerName).visible = arg.visibility;
        return undefined;
      case 'Map.addFeaturesToLayer':
        if (layers.has(arg.layerName)) layers.get(arg.layerName).features = arg.features;
        return undefined;
      case 'Map.removeFeaturesFromLayer':
        if (layers.has(arg.layerName)) layers.get(arg.layerName).features = [];
        return undefined;
      case 'Map.getZoomLevel': return options.zoom ?? 17;
      case 'Map.getMapExtent': return options.extent ?? [14.5, 46.0, 14.6, 46.1];
      case 'Events.once': return Promise.resolve();
      case 'Sidebar.registerScriptTab':
        return Promise.resolve({ tabLabel: element(), tabPane: element() });
      case 'DataModel.Segments.getAll': return options.wmeSegments || [];
      case 'DataModel.Nodes.getAll': return options.wmeNodes || [];
      case 'DataModel.Segments.addSegment':
        if (options.addSegmentThrows) throw new Error('InvalidStateError: not allowed to add a segment');
        return -101;
      case 'DataModel.Segments.updateAddress':
        if (options.updateAddressThrows) throw new Error('InvalidStateError: editing not allowed');
        return undefined;
      case 'Editing.isEditingAllowed': return options.editingAllowed ?? true;
      case 'Editing.getSelection': return options.selection ?? null;
      case 'DataModel.Segments.getById': return (options.segments || {})[arg && arg.segmentId] ?? null;
      case 'DataModel.Countries.getTopCountry': return { id: 197, name: 'Slovenia' };
      case 'DataModel.Cities.getCity': return { id: 55, isEmpty: true };
      case 'DataModel.Streets.getStreet': return { id: 77, isEmpty: true };
      default:
        return name.endsWith('getAll') ? [] : undefined;
    }
  }

  // Callable at any depth, so DataModel.Segments.getAll() resolves like the real SDK.
  const deepStub = (segments) => new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : deepStub(segments.concat(String(k)))),
    apply: (t, self, args) => handleSdkCall(segments.join('.'), args[0])
  });

  const saved = {};
  const globals = {
    window: { location: { href: 'https://www.waze.com/editor' }, SDK_INITIALIZED: Promise.resolve() },
    document: {
      createElement: () => element(), createTextNode: () => element(),
      getElementById: () => element(), querySelector: () => element(),
      querySelectorAll: () => [], addEventListener() {}, body: element(), head: element()
    },
    getWmeSdk: () => deepStub([]),
    I18n: { translations: { en: { layers: { name: {} } } }, currentLocale: () => 'en' },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    setTimeout: (fn, ms) => realSetTimeout(fn, ms >= 1000 ? ms / 20 : ms),
    GM_xmlhttpRequest(req) {
      requests.push(req);
      const n = requests.length;
      const delay = typeof options.responseDelayMs === 'function'
        ? options.responseDelayMs(n)
        : (options.responseDelayMs || 0);
      setTimeout(() => {
        const body = options.respond?.(n) ?? options.cadastre ?? DEFAULT_CADASTRE;
        if (body === 'timeout') { req.ontimeout(); return; }
        if (body === 'error') { req.onerror(); return; }
        if (body === 'reject') {
          req.onload({ status: 400, responseText: '<html>Bad Request</html>' });
          return;
        }
        req.onload({ status: 200, responseText: JSON.stringify(body) });
      }, delay);
    },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem() {}
    }
  };
  globals.unsafeWindow = globals.window;

  for (const [k, v] of Object.entries(globals)) { saved[k] = global[k]; global[k] = v; }
  try {
    new Function('module', fs.readFileSync(SCRIPT_PATH, 'utf8'))({});
    await new Promise(resolve => setTimeout(resolve, 50));
    if (whileStubbed) {
      const dom = (selector) => bySelector.get(selector);
      await whileStubbed({ calls, layers, handlers, domHandlers, requests, options, dom });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    for (const k of Object.keys(globals)) global[k] = saved[k];
  }
  return { calls, layers, handlers, domHandlers, requests };
}

async function waitFor(cond, what, ms = 1000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

const fire = (handlers, eventName, payload) => {
  for (const h of handlers.get(eventName) || []) h(payload);
};
const argsOf = (calls, name) => calls.filter(c => c.name === name).map(c => c.arg);
const shortcut = (calls, id) =>
  argsOf(calls, 'Shortcuts.createShortcut').find(a => a.shortcutId === id).callback;

// Presses Load and waits for the response to be drawn.
async function load(ctx) {
  const before = ctx.requests.length;
  shortcut(ctx.calls, 'qrsl-load')();
  await waitFor(() => ctx.requests.length > before, 'the cadastre request');
  await new Promise(r => setTimeout(r, 30));
}

const features = (ctx) => ctx.layers.get(LAYER).features;

module.exports = {
  bootScript, waitFor, fire, argsOf, shortcut, load, features,
  LAYER, ENDS_LAYER, FOREST, FOREST_ID, FOREST_COORDS, DEFAULT_CADASTRE
};
