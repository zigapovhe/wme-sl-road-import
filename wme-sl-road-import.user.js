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
  const COVERAGE_HIDE_FRACTION = 0.8;

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

  // Points every stepM metres along pts (already in metres), both ends included.
  function sampleAlong(pts, stepM) {
    const out = [pts[0]];
    let carry = 0; // distance walked since the last sample
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      const len = Math.hypot(bx - ax, by - ay);
      let d = stepM - carry;
      while (d <= len) {
        const t = d / len;
        out.push([ax + t * (bx - ax), ay + t * (by - ay)]);
        d += stepM;
      }
      carry = len - (d - stepM);
    }
    out.push(pts[pts.length - 1]);
    return out;
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

  // Share of the line, 0..1, that has a WME segment within maxDistM. Sampled rather
  // than measured as overlap, so a WME road drawn a few metres off the cadastre (the
  // usual case) still counts, and a road that merely crosses the line does not.
  function coverageFraction(coords, segmentLines, stepM, maxDistM) {
    if (coords.length < 2) return 0;

    // Segments wholly outside the line's box, grown by maxDistM, cannot cover any
    // sample. Checked in degrees so the thousands of far segments in a view are
    // never projected.
    const box = bboxOf(coords);
    const padLon = maxDistM / metresPerDegLon(coords[0][1]);
    const padLat = maxDistM / M_PER_DEG_LAT;
    const project = makeLocalProjection(coords[0]);

    const edges = [];
    for (const seg of segmentLines) {
      if (!Array.isArray(seg) || seg.length < 2) continue;
      const b = bboxOf(seg);
      if (b.maxLon < box.minLon - padLon || b.minLon > box.maxLon + padLon
        || b.maxLat < box.minLat - padLat || b.minLat > box.maxLat + padLat) continue;
      const sp = seg.map(project);
      for (let i = 1; i < sp.length; i++) edges.push([sp[i - 1], sp[i]]);
    }
    if (!edges.length) return 0;

    const samples = sampleAlong(coords.map(project), stepM);
    let near = 0;
    for (const s of samples) {
      if (edges.some(([a, b]) => pointToSegmentDistance(s, a, b) <= maxDistM)) near++;
    }
    return near / samples.length;
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
      coverageFraction,
      buildItemsUrl,
      buildRoadLines,
      classifyFetchFailure,
      decideFetchRetry,
      fetchRetryDelay
    };
  }
})();
