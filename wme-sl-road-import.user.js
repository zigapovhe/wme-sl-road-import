// ==UserScript==
// @name         WME Quick Road Importer - Slovenia
// @namespace    https://github.com/zigapovhe/wme-sl-road-import
// @version      0.1.0
// @description  Show Slovenian roads missing from WME and add them with one click
// @author       ThatByte
// @downloadURL  https://raw.githubusercontent.com/zigapovhe/wme-sl-road-import/main/wme-sl-road-import.user.js
// @updateURL    https://raw.githubusercontent.com/zigapovhe/wme-sl-road-import/main/wme-sl-road-import.user.js
// @supportURL   https://github.com/zigapovhe/wme-sl-road-import/issues
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/*
// @exclude      https://www.waze.com/user/editor*
// @connect      ipi.eprostor.gov.si
// @grant        GM_xmlhttpRequest
// @license      MIT
// @noframes
// ==/UserScript==

/* global I18n, getWmeSdk, unsafeWindow */

(function () {
  'use strict';

  let wmeSDK;
  const SCRIPT_ID = 'quick-road-sl-importer';
  const SDK_LAYER_NAME = 'qrsl-roads';

  const CADASTRE_API = 'https://ipi.eprostor.gov.si/wfs-si-gurs-kgi/ogc/features/collections/SI.GURS.KGI:LINIJE_CESTE_G/items';
  const CADASTRE_LIMIT = 1000;
  const CADASTRE_MAX_PAGES = 30;

  // Same retry policy as the HN importer: eProstor times out at random, and the
  // per-load budget bounds how long a sick server can keep a load spinning.
  const FETCH_TIMEOUT_MS = 30000;
  const FETCH_PAGE_RETRIES = 2;                 // 3 attempts per page
  const FETCH_RETRY_BACKOFF_MS = [1000, 3000];
  const FETCH_RETRY_BUDGET = 4;                 // retries per load, across all pages

  // Coverage only sees segments WME has loaded, so loading below this zoom would
  // show roads WME has but hasn't fetched.
  const MIN_LOAD_ZOOM = 16;
  const SIMPLIFY_TOLERANCE_M = 2;
  const COVERAGE_STEP_M = 5;
  const COVERAGE_MAX_DISTANCE_M = 15;
  const MIN_PIECE_LENGTH_M = 30;

  const LS = {
    getLayerVisible() { return localStorage.getItem('qrsl-layer-visible') !== '0'; }, // default on
    setLayerVisible(v){ localStorage.setItem('qrsl-layer-visible', v ? '1' : '0'); }
  };

  const INSTRUCTIONS_HTML = `<b>Instructions</b><br/>
    1) Zoom in to level ${MIN_LOAD_ZOOM}+ • 2) Click "Load roads in view" • 3) <b>Click a pink line to add it as a segment</b><br/>
    Connect it to the network yourself. Grey dashed = added since the last load.`;

  const KBD_STYLE = 'margin-left:6px;font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'
    + 'background:rgba(0,0,0,0.08);border-radius:3px;padding:2px 5px;color:#555;';

  const TOAST_COLORS = {
    info:    { bg: '#e7f1ff', border: '#5b9bd5', text: '#12385e' },
    success: { bg: '#d4edda', border: '#28a745', text: '#155724' },
    warning: { bg: '#fff3cd', border: '#ffc107', text: '#7a5b00' },
    error:   { bg: '#f8d7da', border: '#dc3545', text: '#721c24' }
  };
  const TOAST_TIMEOUT_MS = 4000;

  // Plain DOM because the SDK has no notifications API.
  let toastHost = null;
  const toast = (msg, type = 'info') => {
    console.info(`[SL-ROAD] ${msg}`);
    try {
      if (!toastHost) {
        toastHost = document.createElement('div');
        toastHost.style.cssText = 'position:fixed;top:70px;right:16px;z-index:10001;'
          + 'display:flex;flex-direction:column;gap:6px;align-items:flex-end;'
          + 'pointer-events:none;max-width:340px;';
        document.body.appendChild(toastHost);
      }

      const colors = TOAST_COLORS[type] || TOAST_COLORS.info;
      const el = document.createElement('div');
      el.textContent = msg;
      el.style.cssText = `background:${colors.bg};border:1px solid ${colors.border};`
        + `color:${colors.text};border-radius:4px;padding:8px 12px;font-size:12px;`
        + 'box-shadow:0 2px 6px rgba(0,0,0,0.2);opacity:0;transition:opacity 150ms;';
      toastHost.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = '1'; });

      setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 200);
      }, TOAST_TIMEOUT_MS);
    } catch (e) {
      console.debug('[SL-ROAD] toast render failed:', e);
    }
  };

  // True in Tampermonkey, false when the test suite require()s this file. Everything
  // gated on it is browser-only setup.
  const IN_USERSCRIPT_ENV = typeof unsafeWindow !== 'undefined' || typeof window !== 'undefined';

  // wz-checkbox keeps its state in an attribute, not a .checked property.
  const isChecked  = (el) => el?.hasAttribute('checked');
  const setChecked = (el, v) => v ? el.setAttribute('checked', '') : el.removeAttribute('checked');

  // Waze road type ids, from the SDK's ROAD_TYPE constant. Literals, because the
  // constant is a module export in the SDK typings, not something on the instance.
  // Also the order of the road type dropdown.
  const ROAD_TYPES = [
    { id: 3,  name: 'Freeway' },
    { id: 6,  name: 'Major Highway' },
    { id: 7,  name: 'Minor Highway' },
    { id: 2,  name: 'Primary Street' },
    { id: 1,  name: 'Street' },
    { id: 8,  name: 'Off-road / Not maintained' },
    { id: 17, name: 'Private Road' },
    { id: 20, name: 'Parking Lot Road' }
  ];

  // GJI_ATR1_SIFRA from the cadastre, with its own GJI_ATR1_NAZIV_SL name. Code 15
  // does not exist. Cycle paths, hiking trails and footpaths are never offered.
  const ROAD_CATEGORIES = {
    0:  { name: 'ni podatka',                       roadType: 1 },
    1:  { name: 'avtocesta',                        roadType: 3 },
    2:  { name: 'hitra cesta',                      roadType: 7 },
    3:  { name: 'glavna cesta I. reda',             roadType: 2 },
    4:  { name: 'glavna cesta II. reda',            roadType: 2 },
    5:  { name: 'regionalna cesta I. reda',         roadType: 2 },
    6:  { name: 'regionalna cesta II. reda',        roadType: 2 },
    7:  { name: 'regionalna cesta III. reda',       roadType: 2 },
    8:  { name: 'turistična cesta',                 roadType: 2 },
    9:  { name: 'lokalna cesta',                    roadType: 1 },
    10: { name: 'javna pot',                        roadType: 1 },
    11: { name: 'glavna mestna cesta',              roadType: 2 },
    12: { name: 'zbirna mestna ali krajevna cesta', roadType: 2 },
    13: { name: 'mestna ali krajevna cesta',        roadType: 1 },
    14: { name: 'državna kolesarska pot',           excluded: true },
    16: { name: 'občinska kolesarska pot',          excluded: true },
    17: { name: 'gozdna cesta',                     roadType: 8, unpaved: true },
    18: { name: 'nekategorizirana cesta',           roadType: 17 },
    19: { name: 'planinska pot',                    excluded: true },
    20: { name: 'pešpoti',                          excluded: true }
  };

  function roadTypeName(id) {
    const type = ROAD_TYPES.find(t => t.id === id);
    return type ? type.name : `road type ${id}`;
  }

  function categoryInfo(code) {
    const c = ROAD_CATEGORIES[code];
    if (!c) return { name: `kategorija ${code}`, roadType: 1, unpaved: false, excluded: false };
    return { name: c.name, roadType: c.roadType ?? null, unpaved: !!c.unpaved, excluded: !!c.excluded };
  }

  // Unpaved follows the category, not the chosen road type.
  function planSegment(line, overrideRoadType) {
    const info = categoryInfo(line.category);
    return { roadType: overrideRoadType ?? info.roadType, unpaved: info.unpaved };
  }

  // Sidebar hover text. Shows the road type a click would use right now, so it
  // follows the dropdown.
  function describeLine(line, overrideRoadType) {
    const { roadType, unpaved } = planSegment(line, overrideRoadType);
    return `${categoryInfo(line.category).name} → ${roadTypeName(roadType)}`
      + `${unpaved ? ', unpaved' : ''}, ${Math.round(line.lengthM)} m`;
  }

  // Metres per degree for a local flat projection. Plenty for the few km a cadastre
  // line spans. It only feeds simplification and coverage; WME gets plain lon/lat.
  const M_PER_DEG_LAT = 110540;
  const M_PER_DEG_LON_AT_EQUATOR = 111320;

  function metresPerDegLon(lat) {
    return M_PER_DEG_LON_AT_EQUATOR * Math.cos(lat * Math.PI / 180);
  }

  // [lon, lat] -> [x, y] metres from origin.
  function makeLocalProjection([lon0, lat0]) {
    const kx = metresPerDegLon(lat0);
    return ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG_LAT];
  }

  // Distance from p to the segment a-b, all [x, y] in metres.
  function pointToSegmentDistance([px, py], [ax, ay], [bx, by]) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    return Math.hypot(ax + t * dx - px, ay + t * dy - py);
  }

  // The cadastre geometry as plain [lon, lat] lines. Heights go (WME geometry is 2D),
  // and so does anything the SDK would choke on: it rejects a whole feature batch over
  // one bad coordinate, and a line that collapses to one point would become a
  // zero-length segment.
  function splitLines(geometry) {
    let parts;
    if (geometry && geometry.type === 'LineString') parts = [geometry.coordinates];
    else if (geometry && geometry.type === 'MultiLineString') parts = geometry.coordinates;
    else return [];

    const lines = [];
    for (const part of Array.isArray(parts) ? parts : []) {
      if (!Array.isArray(part)) continue;
      const coords = [];
      for (const p of part) {
        if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        const prev = coords[coords.length - 1];
        if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
        coords.push([p[0], p[1]]);
      }
      if (coords.length >= 2) lines.push(coords);
    }
    return lines;
  }

  // Douglas-Peucker in local metres. Iterative, since forest roads can have thousands
  // of vertices.
  function simplifyLine(coords, toleranceM) {
    if (coords.length <= 2) return coords.slice();
    const pts = coords.map(makeLocalProjection(coords[0]));
    const keep = new Array(coords.length).fill(false);
    keep[0] = true;
    keep[coords.length - 1] = true;

    const stack = [[0, coords.length - 1]];
    while (stack.length) {
      const [first, last] = stack.pop();
      let maxDist = 0;
      let index = -1;
      for (let i = first + 1; i < last; i++) {
        const d = pointToSegmentDistance(pts[i], pts[first], pts[last]);
        if (d > maxDist) { maxDist = d; index = i; }
      }
      if (index !== -1 && maxDist > toleranceM) {
        keep[index] = true;
        stack.push([first, index], [index, last]);
      }
    }
    return coords.filter((_, i) => keep[i]);
  }

  function lineLengthM(coords) {
    if (coords.length < 2) return 0;
    const pts = coords.map(makeLocalProjection(coords[0]));
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    return len;
  }

  function bboxOf(coords) {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lon, lat] of coords) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    return { minLon, minLat, maxLon, maxLat };
  }

  // WME segment geometries with their boxes, computed once per refresh rather than
  // once per cadastre line: the refresh runs on every pan.
  function prepareSegments(segmentLines) {
    return segmentLines
      .filter(seg => Array.isArray(seg) && seg.length >= 2)
      .map(coords => ({ coords, box: bboxOf(coords) }));
  }

  // The point dM metres along coords, cum being the cumulative vertex distances.
  // Linear in lon/lat, which is the same as linear in the local projection.
  function pointAlong(coords, cum, dM) {
    let i = 1;
    while (i < coords.length - 1 && cum[i] < dM) i++;
    const len = cum[i] - cum[i - 1];
    const t = len ? Math.min(1, Math.max(0, (dM - cum[i - 1]) / len)) : 0;
    const [ax, ay] = coords[i - 1];
    const [bx, by] = coords[i];
    return [ax + t * (bx - ax), ay + t * (by - ay)];
  }

  // The stretch of coords between two distances along it, keeping the original
  // vertices in between.
  function subLine(coords, cum, fromM, toM) {
    const out = [pointAlong(coords, cum, fromM)];
    for (let i = 0; i < coords.length; i++) {
      if (cum[i] > fromM && cum[i] < toM) out.push(coords[i]);
    }
    out.push(pointAlong(coords, cum, toM));
    return out;
  }

  // The stretches of a cadastre line with no WME road within maxDistM, as [lon, lat]
  // lines. Sampled every stepM metres rather than measured as overlap, so a WME road
  // drawn a few metres off the cadastre (the usual case) still counts. segments come
  // from prepareSegments.
  //
  // Each stretch reaches back to the last sample that still had a road nearby, so its
  // loose end sits next to the road the editor connects it to. Stretches shorter than
  // minLengthM are dropped: they are usually the same road drawn slightly differently
  // on a bend. A line with nothing near it at all is kept whole, however short.
  function missingStretches(coords, segments, stepM, maxDistM, minLengthM) {
    if (coords.length < 2) return [];

    // Segments wholly outside the line's box, grown by maxDistM, cannot reach any
    // sample. Checked in degrees so the thousands of far segments in a view are
    // never projected.
    const box = bboxOf(coords);
    const padLon = maxDistM / metresPerDegLon(coords[0][1]);
    const padLat = maxDistM / M_PER_DEG_LAT;
    const project = makeLocalProjection(coords[0]);

    const edges = [];
    for (const { coords: seg, box: b } of segments) {
      if (b.maxLon < box.minLon - padLon || b.minLon > box.maxLon + padLon
        || b.maxLat < box.minLat - padLat || b.minLat > box.maxLat + padLat) continue;
      const sp = seg.map(project);
      for (let i = 1; i < sp.length; i++) edges.push([sp[i - 1], sp[i]]);
    }
    if (!edges.length) return [coords.slice()];

    const pts = coords.map(project);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    const total = cum[cum.length - 1];

    const ds = [];
    for (let d = 0; d < total; d += stepM) ds.push(d);
    ds.push(total);
    const near = ds.map(d => {
      const p = project(pointAlong(coords, cum, d));
      return edges.some(([a, b]) => pointToSegmentDistance(p, a, b) <= maxDistM);
    });
    if (!near.some(Boolean)) return [coords.slice()];

    const stretches = [];
    for (let k = 0; k < ds.length; k++) {
      if (near[k]) continue;
      let j = k;
      while (j + 1 < ds.length && !near[j + 1]) j++;
      const fromM = k > 0 ? ds[k - 1] : 0;
      const toM = j + 1 < ds.length ? ds[j + 1] : total;
      if (toM - fromM >= minLengthM) stretches.push(subLine(coords, cum, fromM, toM));
      k = j;
    }
    return stretches;
  }

  function buildItemsUrl(bbox, startIndex) {
    return CADASTRE_API
      + '?f=application/json'
      + '&limit=' + CADASTRE_LIMIT
      + '&startIndex=' + startIndex
      + '&bbox=' + [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat].join(',');
  }

  // Cadastre features to drawable, clickable lines. Ids use EID_LINIJA, a string:
  // FEATUREID is a number above 2^53, so JSON.parse rounds it and distinct lines
  // collide. Repeats are dropped, since paging over a live table can return a row
  // twice and two map features with one id would make clicks hit the wrong line.
  function buildRoadLines(apiFeatures) {
    const lines = [];
    const seen = new Set();
    for (const f of apiFeatures) {
      const category = f?.properties?.GJI_ATR1_SIFRA;
      if (categoryInfo(category).excluded) continue;
      const eid = f?.properties?.EID_LINIJA ?? f?.id;
      if (eid == null) continue;
      splitLines(f.geometry).forEach((part, i) => {
        const id = `${eid}-${i}`;
        if (seen.has(id)) return;
        seen.add(id);
        const coords = simplifyLine(part, SIMPLIFY_TOLERANCE_M);
        lines.push({ id, eid: String(eid), category, coords, lengthM: lineLengthM(coords) });
      });
    }
    return lines;
  }

  // What went wrong with one page request, and is it worth another attempt?
  //   kind:   'timeout' | 'error' | 'load'  (which GM_xmlhttpRequest handler fired)
  //   status: HTTP status when there is one
  // `reason` completes the sentence "eProstor ...".
  function classifyFetchFailure(kind, status) {
    if (kind === 'timeout') return { retryable: true, reason: 'timed out' };
    if (kind === 'error') return { retryable: true, reason: 'request failed' };
    if (typeof status === 'number' && status >= 500) {
      return { retryable: true, reason: 'returned a server error' };
    }
    if (typeof status === 'number' && status >= 400) {
      // Our query is what it objects to, so repeating it verbatim cannot help.
      return { retryable: false, reason: `rejected the request (HTTP ${status})` };
    }
    return { retryable: false, reason: 'returned an unreadable response' };
  }

  //   'retry'   same page, same startIndex, after a backoff
  //   'partial' stop, keep the pages that did arrive (complete: false)
  //   'fail'    stop with nothing to keep
  function decideFetchRetry({ retryable, attempt, retriesUsed, haveFeatures }) {
    if (retryable && attempt <= FETCH_PAGE_RETRIES && retriesUsed < FETCH_RETRY_BUDGET) {
      return 'retry';
    }
    return haveFeatures ? 'partial' : 'fail';
  }

  // Clamped, so the table can be shorter than the retry count.
  function fetchRetryDelay(attempt) {
    const i = Math.max(0, Math.min(attempt - 1, FETCH_RETRY_BACKOFF_MS.length - 1));
    return FETCH_RETRY_BACKOFF_MS[i];
  }

  // Cadastre roads in bbox, page by page. shouldAbort is checked between pages and
  // after each backoff, so a Clear or a newer Load stops the chain.
  //
  // Resolves { features, complete }. complete is false when the page cap was hit or a
  // page failed after earlier ones arrived. Rejects with err.userMessage when nothing
  // loaded.
  function fetchCadastre(bbox, shouldAbort) {
    return new Promise((resolve, reject) => {
      const allFeatures = [];
      let startIndex = 0;
      let pageCount = 0;
      let retriesUsed = 0;

      const aborted = () => typeof shouldAbort === 'function' && shouldAbort();

      function handleFailure(attempt, kind, status) {
        const { retryable, reason } = classifyFetchFailure(kind, status);
        const verdict = decideFetchRetry({
          retryable, attempt, retriesUsed, haveFeatures: allFeatures.length > 0
        });

        if (verdict === 'retry') {
          retriesUsed++;
          toast(
            `eProstor ${reason}, retrying (attempt ${attempt + 1} of ${FETCH_PAGE_RETRIES + 1})`,
            'warning'
          );
          setTimeout(() => {
            if (aborted()) { resolve({ features: allFeatures, complete: false }); return; }
            requestPage(attempt + 1);
          }, fetchRetryDelay(attempt));
          return;
        }

        if (verdict === 'partial') {
          console.warn(`[SL-ROAD] eProstor ${reason}; result is partial`);
          toast(`eProstor ${reason}, showing the ${allFeatures.length} roads that loaded`, 'warning');
          resolve({ features: allFeatures, complete: false });
          return;
        }

        const err = new Error(`eProstor ${reason}`);
        err.userMessage = `eProstor ${reason}, no roads loaded`;
        reject(err);
      }

      function requestPage(attempt) {
        if (aborted()) {
          resolve({ features: allFeatures, complete: false });
          return;
        }
        // Counted per page, not per attempt: a retry re-fetches the same startIndex.
        if (attempt === 1 && ++pageCount > CADASTRE_MAX_PAGES) {
          console.warn(`[SL-ROAD] cadastre result truncated at ${CADASTRE_MAX_PAGES} pages`);
          toast('Too many roads in view, result truncated. Zoom in.', 'warning');
          resolve({ features: allFeatures, complete: false });
          return;
        }

        GM_xmlhttpRequest({
          method: 'GET',
          url: buildItemsUrl(bbox, startIndex),
          timeout: FETCH_TIMEOUT_MS,
          onload: function (response) {
            let data;
            try {
              data = JSON.parse(response.responseText);
            } catch (err) {
              handleFailure(attempt, 'load', response.status);
              return;
            }
            if (!data.features || !Array.isArray(data.features)) {
              handleFailure(attempt, 'load', response.status);
              return;
            }

            allFeatures.push(...data.features);

            const returned = data.numberReturned || data.features.length;
            const total = typeof data.numberMatched === 'number' ? data.numberMatched : null;
            const hasMore = total != null
              ? startIndex + returned < total
              : returned >= CADASTRE_LIMIT;
            if (hasMore && returned > 0) {
              startIndex += returned;
              requestPage(1);
            } else {
              resolve({ features: allFeatures, complete: true });
            }
          },
          onerror: function () {
            handleFailure(attempt, 'error');
          },
          ontimeout: function () {
            handleFailure(attempt, 'timeout');
          }
        });
      }

      requestPage(1);
    });
  }

  function init() {
    const lines = new Map();     // id -> RoadLine, for the current load
    const pieces = new Map();    // id -> the part of a line WME has no road along
    const imported = new Map();  // id -> { lineId, coords } of segments added since the last load
    let importedCount = 0;
    let partial = false;         // the last load hit the page cap or lost pages
    let isLoading = false;
    let currentLoadId = 0;
    let overrideRoadType = null; // null = Auto from category
    let layerWanted = LS.getLayerVisible();
    let layerShown = false;
    let layerIds = [];

    try {
      I18n.translations[I18n.currentLocale()].layers.name[SCRIPT_ID] = 'Quick Road Importer';
    } catch (_) {}

    wmeSDK.Map.addLayer({
      layerName: SDK_LAYER_NAME,
      styleRules: [
        {
          predicate: (p) => p.state === 'missing',
          style: {
            strokeColor: '#ff00ff', strokeWidth: 5, strokeOpacity: 0.85,
            hoverStrokeColor: '#ffff00', hoverStrokeWidth: 7, cursor: 'pointer'
          }
        },
        {
          predicate: (p) => p.state === 'imported',
          style: { strokeColor: '#888888', strokeWidth: 4, strokeOpacity: 0.5, strokeDashstyle: 'dash' }
        }
      ]
    });
    wmeSDK.Map.setLayerVisibility({ layerName: SDK_LAYER_NAME, visibility: false });
    wmeSDK.Events.trackLayerEvents({ layerName: SDK_LAYER_NAME });

    function updateLayerVisibility() {
      const visible = layerWanted && wmeSDK.Map.getZoomLevel() >= MIN_LOAD_ZOOM;
      if (visible === layerShown) return;
      // Recorded only after the SDK accepted it, so a failed call is retried next time.
      try {
        wmeSDK.Map.setLayerVisibility({ layerName: SDK_LAYER_NAME, visibility: visible });
      } catch (e) {
        console.warn('[SL-ROAD] could not change layer visibility:', e);
        return;
      }
      layerShown = visible;
    }

    // Cuts every line down to the stretches WME has no road along. What this session
    // added counts as a road too, so a piece can't reappear beside its own segment
    // before WME lists that segment.
    function refreshPieces() {
      const segments = prepareSegments(wmeSDK.DataModel.Segments.getAll()
        .map(s => s.geometry && s.geometry.coordinates)
        .concat([...imported.values()].map(a => a.coords)));
      pieces.clear();
      for (const line of lines.values()) {
        missingStretches(line.coords, segments, COVERAGE_STEP_M, COVERAGE_MAX_DISTANCE_M, MIN_PIECE_LENGTH_M)
          .forEach((coords, k) => {
            const id = `${line.id}/${k}`;
            pieces.set(id, { id, lineId: line.id, category: line.category, coords, lengthM: lineLengthM(coords) });
          });
      }
    }

    // Ids are recorded before the add: if it throws part-way, removing an id that never
    // landed is harmless, while an orphan feature would stay clickable.
    function render() {
      const feature = (id, coords, state) => ({
        type: 'Feature', id, geometry: { type: 'LineString', coordinates: coords }, properties: { state }
      });
      const features = [
        ...[...pieces.values()].map(p => feature(p.id, p.coords, 'missing')),
        ...[...imported].map(([id, a]) => feature(id, a.coords, 'imported'))
      ];
      try {
        if (layerIds.length) {
          wmeSDK.Map.removeFeaturesFromLayer({ layerName: SDK_LAYER_NAME, featureIds: layerIds });
          layerIds = [];
        }
        if (!features.length) return;
        layerIds = features.map(f => f.id);
        wmeSDK.Map.addFeaturesToLayer({ layerName: SDK_LAYER_NAME, features });
      } catch (e) {
        console.warn('[SL-ROAD] rendering failed:', e);
      }
    }

    function resetState() {
      lines.clear();
      pieces.clear();
      imported.clear();
      partial = false;
    }

    wmeSDK.Events.on({ eventName: 'wme-map-zoom-changed', eventHandler: () => updateLayerVisibility() });
    updateLayerVisibility();

    wmeSDK.Sidebar.registerScriptTab().then(({ tabLabel, tabPane }) => {
      tabLabel.innerText = 'SL-ROAD';
      tabLabel.title = 'Quick Road Importer (Slovenia)';

      const typeOptions = ['<option value="">Auto from category</option>']
        .concat(ROAD_TYPES.map(t => `<option value="${t.id}">${t.name}</option>`))
        .join('');

      tabPane.innerHTML = `
        <div id="qrsl-pane" style="padding:10px;">
          <h2 style="margin-top:0;">Quick Road Importer 🇸🇮</h2>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 8px 0;">
            <button id="qrsl-load" class="wz-button"><span id="qrsl-load-label">Load roads in view</span> <kbd style="${KBD_STYLE}">Alt+Shift+R</kbd></button>
            <button id="qrsl-clear" class="wz-button wz-button--secondary">Clear <kbd style="${KBD_STYLE}">Alt+Shift+X</kbd></button>
          </div>
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <wz-checkbox id="qrsl-toggle">Show layer</wz-checkbox>
            <label style="font-size:12px;">Road type <select id="qrsl-roadtype" style="margin-left:6px;">${typeOptions}</select></label>
          </div>
          <div id="qrsl-status" style="margin-top:10px;font-size:12px;color:#666;line-height:1.4;">${INSTRUCTIONS_HTML}</div>
          <div id="qrsl-hover" style="margin-top:6px;font-size:12px;font-weight:bold;min-height:1.4em;"></div>
        </div>
      `;

      const btnLoad      = tabPane.querySelector('#qrsl-load');
      const btnLoadLabel = tabPane.querySelector('#qrsl-load-label');
      const btnClear     = tabPane.querySelector('#qrsl-clear');
      const chkVis       = tabPane.querySelector('#qrsl-toggle');
      const selRoadType  = tabPane.querySelector('#qrsl-roadtype');
      const statusDiv    = tabPane.querySelector('#qrsl-status');
      const hoverDiv     = tabPane.querySelector('#qrsl-hover');

      setChecked(chkVis, layerWanted);

      chkVis.addEventListener('click', () => {
        const on = isChecked(chkVis);
        setChecked(chkVis, !on);
        layerWanted = !on;
        LS.setLayerVisible(!on);
        updateLayerVisibility();
      });

      selRoadType.addEventListener('change', () => {
        overrideRoadType = selRoadType.value === '' ? null : Number(selRoadType.value);
      });

      function updateStatus() {
        if (!lines.size) {
          statusDiv.textContent = 'No roads in view.';
          return;
        }
        const open = new Set([...pieces.values(), ...imported.values()].map(p => p.lineId));
        const mapped = [...lines.keys()].filter(id => !open.has(id)).length;
        let text = `${pieces.size} missing, ${mapped} already mapped`;
        if (imported.size) text += `, ${imported.size} added`;
        if (partial) text += '. Loaded partially, zoom in and load again.';
        statusDiv.textContent = text;
      }

      async function loadRoads() {
        if (isLoading) return;
        if (wmeSDK.Map.getZoomLevel() < MIN_LOAD_ZOOM) {
          toast(`Zoom in to level ${MIN_LOAD_ZOOM}+ to load roads`, 'warning');
          return;
        }
        isLoading = true;
        const myLoadId = ++currentLoadId;

        // try/finally, or one throw leaves isLoading stuck and every later Load ignored.
        try {
          btnLoad.disabled = true;
          btnLoadLabel.textContent = 'Loading…';
          resetState();
          render();
          hoverDiv.textContent = '';
          statusDiv.textContent = 'Loading roads…';

          const ext = wmeSDK.Map.getMapExtent();
          const [minLon, minLat, maxLon, maxLat] = Array.isArray(ext)
            ? ext
            : [ext.lonMin, ext.latMin, ext.lonMax, ext.latMax];

          let result;
          try {
            result = await fetchCadastre({ minLon, minLat, maxLon, maxLat }, () => myLoadId !== currentLoadId);
          } catch (err) {
            if (myLoadId !== currentLoadId) return;
            console.warn('[SL-ROAD] fetch failed:', err);
            const msg = err.userMessage || 'Error fetching roads.';
            toast(msg, 'error');
            statusDiv.textContent = msg;
            return;
          }
          if (myLoadId !== currentLoadId) return; // Clear or a newer Load since

          for (const line of buildRoadLines(result.features)) lines.set(line.id, line);
          partial = !result.complete;
          refreshPieces();
          render();
          updateStatus();

          // Load is an explicit request to see the result.
          if (!layerWanted) {
            layerWanted = true;
            setChecked(chkVis, true);
            LS.setLayerVisible(true);
          }
          updateLayerVisibility();
        } finally {
          // After a Clear, Load was already released, and a newer load may own it now.
          if (myLoadId === currentLoadId) {
            btnLoad.disabled = false;
            btnLoadLabel.textContent = 'Load roads in view';
            isLoading = false;
          }
        }
      }

      // A request in flight can't be cancelled. Bumping the id makes its result drop,
      // and Load is released now rather than when that request returns.
      function clearRoads() {
        currentLoadId++;
        isLoading = false;
        btnLoad.disabled = false;
        btnLoadLabel.textContent = 'Load roads in view';
        resetState();
        render();
        hoverDiv.textContent = '';
        statusDiv.innerHTML = INSTRUCTIONS_HTML;
      }

      // Wrapped, so the click event never lands in a parameter.
      btnLoad.addEventListener('click', () => loadRoads());
      btnClear.addEventListener('click', () => clearRoads());

      wmeSDK.Events.on({
        eventName: 'wme-map-data-loaded',
        eventHandler: () => {
          if (!lines.size) return;
          refreshPieces();
          render();
          updateStatus();
        }
      });

      wmeSDK.Events.on({
        eventName: 'wme-layer-feature-mouse-enter',
        eventHandler: ({ featureId, layerName } = {}) => {
          if (layerName !== SDK_LAYER_NAME) return;
          const piece = pieces.get(String(featureId));
          hoverDiv.textContent = piece ? describeLine(piece, overrideRoadType) : '';
        }
      });
      wmeSDK.Events.on({
        eventName: 'wme-layer-feature-mouse-leave',
        eventHandler: ({ layerName } = {}) => {
          if (layerName === SDK_LAYER_NAME) hoverDiv.textContent = '';
        }
      });

      // The empty street with no city, in the country WME is centred on.
      function setEmptyAddress(segmentId) {
        const country = wmeSDK.DataModel.Countries.getTopCountry();
        if (!country) throw new Error('WME has no top country here');
        const countryId = country.id;
        const city = wmeSDK.DataModel.Cities.getCity({ cityName: '', countryId })
          || wmeSDK.DataModel.Cities.addCity({ cityName: '', countryId });
        const street = wmeSDK.DataModel.Streets.getStreet({ streetName: '', cityId: city.id })
          || wmeSDK.DataModel.Streets.addStreet({ streetName: '', cityId: city.id });
        wmeSDK.DataModel.Segments.updateAddress({ segmentId, addressData: { primaryStreetId: street.id } });
      }

      // One click, one segment from exactly the clicked piece. Junctions and
      // connections are the editor's job.
      function onPieceClicked({ featureId, layerName } = {}) {
        if (layerName !== SDK_LAYER_NAME) return;
        const piece = pieces.get(String(featureId));
        if (!piece) return;
        if (!wmeSDK.Editing.isEditingAllowed()) {
          toast('Editing is not allowed here', 'warning');
          return;
        }

        const { roadType, unpaved } = planSegment(piece, overrideRoadType);
        let segmentId;
        try {
          segmentId = wmeSDK.DataModel.Segments.addSegment({
            geometry: { type: 'LineString', coordinates: piece.coords },
            roadType
          });
        } catch (e) {
          console.error('[SL-ROAD] addSegment failed:', e);
          toast(`Could not create the segment: ${e.message || e}`, 'error');
          return;
        }
        // From here on the segment exists, so a second click must not make another.
        imported.set(`added-${++importedCount}`, { lineId: piece.lineId, coords: piece.coords });

        const failed = [];
        try {
          // The default direction of a new segment is undocumented, so always set it.
          wmeSDK.DataModel.Segments.updateSegment(unpaved
            ? { segmentId, direction: 'TWO_WAY', flagAttributes: { unpaved: true } }
            : { segmentId, direction: 'TWO_WAY' });
        } catch (e) {
          console.error('[SL-ROAD] updateSegment failed:', e);
          failed.push(unpaved ? 'direction and unpaved' : 'direction');
        }
        try {
          setEmptyAddress(segmentId);
        } catch (e) {
          console.error('[SL-ROAD] setting the address failed:', e);
          failed.push('address');
        }
        try {
          wmeSDK.Editing.setSelection({ selection: { ids: [segmentId], objectType: 'segment' } });
        } catch (e) {
          console.error('[SL-ROAD] selecting the new segment failed:', e);
          failed.push('selection');
        }

        refreshPieces();
        render();
        updateStatus();
        const what = `${roadTypeName(roadType)}, ${Math.round(piece.lengthM)} m`;
        if (failed.length) {
          toast(`${what} created, but setting ${failed.join(', ')} failed. Fix it by hand.`, 'warning');
        } else {
          toast(`${what} created`, 'success');
        }
      }

      wmeSDK.Events.on({ eventName: 'wme-layer-feature-clicked', eventHandler: onPieceClicked });

      ['qrsl-load', 'qrsl-clear'].forEach(id => {
        try { wmeSDK.Shortcuts.deleteShortcut({ shortcutId: id }); } catch (_) {}
      });
      [
        { shortcutId: 'qrsl-load',  shortcutKeys: 'AS+r', description: 'SL-ROAD: Load roads in view', callback: () => loadRoads() },
        { shortcutId: 'qrsl-clear', shortcutKeys: 'AS+x', description: 'SL-ROAD: Clear',              callback: () => clearRoads() }
      ].forEach(spec => {
        try { wmeSDK.Shortcuts.createShortcut(spec); }
        catch (e) { console.warn('[SL-ROAD] failed to register shortcut', spec.shortcutId, e); }
      });
    });
  }

  // The single entry point, and the one thing the test suite skips.
  if (IN_USERSCRIPT_ENV) {
  (unsafeWindow || window).SDK_INITIALIZED.then(() => {
    wmeSDK = getWmeSdk({ scriptId: SCRIPT_ID, scriptName: 'Quick Road Importer (SI)' });
    wmeSDK.Events.once({ eventName: 'wme-ready' }).then(() => {
      // Checked against the SDK docs at v2.374 on 2026-10-14. getWmeSdk is called
      // without a `version`, so WME always hands this script the latest SDK, and these
      // lists catch a renamed method before it fails silently. Keep them in step with:
      //   grep -oE 'wmeSDK\.[A-Za-z.]+\(' wme-sl-road-import.user.js | sort -u
      // Anything in `required` aborts startup.
      const required = [
        'DataModel.Segments.getAll',
        'DataModel.Segments.addSegment',
        'DataModel.Segments.updateSegment',
        'DataModel.Segments.updateAddress',
        'DataModel.Countries.getTopCountry',
        'DataModel.Cities.getCity',
        'DataModel.Cities.addCity',
        'DataModel.Streets.getStreet',
        'DataModel.Streets.addStreet',
        'Editing.setSelection',
        'Editing.isEditingAllowed',
        'Events.on',
        'Events.once',
        'Events.trackLayerEvents',
        'Sidebar.registerScriptTab',
        'Map.addLayer',
        'Map.addFeaturesToLayer',
        'Map.removeFeaturesFromLayer',
        'Map.setLayerVisibility',
        'Map.getZoomLevel',
        'Map.getMapExtent'
      ];
      const optional = [
        'Shortcuts.createShortcut',
        'Shortcuts.deleteShortcut'
      ];

      const isMissing = (path) => {
        let cur = wmeSDK;
        for (const p of path.split('.')) { cur = cur?.[p]; if (cur == null) return true; }
        return false;
      };

      const missing = required.filter(isMissing);
      if (missing.length) {
        console.error('[SL-ROAD] WME SDK missing required APIs:', missing);
        toast(`SL-ROAD: WME SDK is missing ${missing.length} required APIs. See console.`, 'error');
        return;
      }

      const missingOptional = optional.filter(isMissing);
      if (missingOptional.length) {
        console.warn('[SL-ROAD] WME SDK missing optional APIs (features degraded):', missingOptional);
      }

      init();
    });
  });
  }

  // Test-only surface. `module` does not exist in Tampermonkey, so this is a no-op
  // there. Only pure functions are exposed.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ROAD_TYPES,
      categoryInfo,
      roadTypeName,
      planSegment,
      describeLine,
      splitLines,
      simplifyLine,
      lineLengthM,
      prepareSegments,
      missingStretches,
      buildItemsUrl,
      buildRoadLines,
      classifyFetchFailure,
      decideFetchRetry,
      fetchRetryDelay
    };
  }
})();
