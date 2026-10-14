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
  // Junctions are where WME and the cadastre disagree most, so a snap tolerates no
  // match this close to either end of the segment.
  const SNAP_END_SKIP_M = 15;

  const LS = {
    getLayerVisible() { return localStorage.getItem('qrsl-layer-visible') !== '0'; }, // default on
    setLayerVisible(v){ localStorage.setItem('qrsl-layer-visible', v ? '1' : '0'); },
    getShowMapped()   { return localStorage.getItem('qrsl-show-mapped') === '1'; },
    setShowMapped(v)  { localStorage.setItem('qrsl-show-mapped', v ? '1' : '0'); }
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

  // Where on the edge a-b the point p comes closest: the distance, and how far along
  // the edge (0..1). All [x, y] in metres.
  function closestOnEdge([px, py], [ax, ay], [bx, by]) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    return { dist: Math.hypot(ax + t * dx - px, ay + t * dy - py), t };
  }

  function pointToSegmentDistance(p, a, b) {
    return closestOnEdge(p, a, b).dist;
  }

  // Cumulative distance to every vertex of pts (in metres).
  function cumulative(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    return cum;
  }

  // Every stepM metres along a line of length totalM, both ends included.
  function sampleDistances(totalM, stepM) {
    const ds = [];
    for (let d = 0; d < totalM; d += stepM) ds.push(d);
    ds.push(totalM);
    return ds;
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

  // Index i of the edge (i-1 -> i) holding the point dM metres along, cum being the
  // cumulative vertex distances.
  function edgeAt(cum, dM) {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < dM) i++;
    return i;
  }

  // The point dM metres along coords. Linear in lon/lat, which is the same as linear
  // in the local projection.
  function pointAlong(coords, cum, dM) {
    const i = edgeAt(cum, dM);
    const len = cum[i] - cum[i - 1];
    const t = len ? Math.min(1, Math.max(0, (dM - cum[i - 1]) / len)) : 0;
    const [ax, ay] = coords[i - 1];
    const [bx, by] = coords[i];
    return [ax + t * (bx - ax), ay + t * (by - ay)];
  }

  // The stretch of coords between two distances along it, keeping the original
  // vertices in between. A vertex within a metre of a cut is skipped, or the new road
  // would start or end with a segment WME editors would have to clean up.
  function subLine(coords, cum, fromM, toM) {
    const out = [pointAlong(coords, cum, fromM)];
    for (let i = 0; i < coords.length; i++) {
      if (cum[i] > fromM + 1 && cum[i] < toM - 1) out.push(coords[i]);
    }
    out.push(pointAlong(coords, cum, toM));
    return out;
  }

  // A WME edge only stands for a stretch of cadastre road if it runs alongside it.
  // A road the line merely meets or crosses is close at that spot, but it is not this
  // road, and counting it cut connectors short or hid them entirely.
  const ALONGSIDE_MAX_ANGLE_DEG = 45;
  const ALONGSIDE_MIN_COS2 = Math.cos(ALONGSIDE_MAX_ANGLE_DEG * Math.PI / 180) ** 2;

  // A snap needs the cadastre alongside at least this share of the segment's samples.
  // Less, and the line matching at both ends is probably a different road between them.
  const SNAP_MIN_MATCHED = 0.5;

  // Whether direction u and the edge a-b are within ALONGSIDE_MAX_ANGLE_DEG of each
  // other, either way round.
  function isAlongside(u, [ax, ay], [bx, by]) {
    const vx = bx - ax;
    const vy = by - ay;
    const vv = vx * vx + vy * vy;
    const dot = u[0] * vx + u[1] * vy;
    return vv > 0 && dot * dot >= ALONGSIDE_MIN_COS2 * (u[0] * u[0] + u[1] * u[1]) * vv;
  }

  // The stretches of a cadastre line with no WME road running alongside it within
  // maxDistM, as [lon, lat] lines. Sampled every stepM metres rather than measured as
  // overlap, so a WME road drawn a few metres off the cadastre (the usual case) still
  // counts. segments come from prepareSegments.
  //
  // Stretches shorter than minLengthM are dropped: they are usually the same road
  // drawn slightly differently on a bend. A line with nothing alongside it at all is
  // kept whole, however short.
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
    const cum = cumulative(pts);
    const ds = sampleDistances(cum[cum.length - 1], stepM);
    const near = ds.map(d => {
      const i = edgeAt(cum, d);
      const dir = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]];
      const p = project(pointAlong(coords, cum, d));
      return edges.some(([a, b]) => pointToSegmentDistance(p, a, b) <= maxDistM && isAlongside(dir, a, b));
    });
    if (!near.some(Boolean)) return [coords.slice()];

    const stretches = [];
    for (let k = 0; k < ds.length; k++) {
      if (near[k]) continue;
      let j = k;
      while (j + 1 < ds.length && !near[j + 1]) j++;
      const fromM = ds[k];
      const toM = ds[j];
      if (toM - fromM >= minLengthM) stretches.push(subLine(coords, cum, fromM, toM));
      k = j;
    }
    return stretches;
  }

  // The vertices of a projected cadastre line between two positions along it, in the
  // order of travel from one to the other. The vertex at fromM itself only when asked.
  function verticesBetween(line, fromM, toM, includeFrom) {
    const out = [];
    const { coords, cum } = line;
    if (fromM <= toM) {
      for (let j = 0; j < coords.length; j++) {
        if ((includeFrom ? cum[j] >= fromM : cum[j] > fromM) && cum[j] < toM) out.push(coords[j]);
      }
    } else {
      for (let j = coords.length - 1; j >= 0; j--) {
        if ((includeFrom ? cum[j] <= fromM : cum[j] < fromM) && cum[j] > toM) out.push(coords[j]);
      }
    }
    return out;
  }

  // New geometry for a WME segment, moved onto the cadastre line(s) running alongside
  // it. The two end points are the segment's own, so its nodes and connections stay
  // where they are.
  //
  // Walks the segment every stepM metres and matches each sample to the nearest
  // cadastre edge running alongside within maxDistM. It keeps to the same cadastre
  // line while that still qualifies, so a road between two carriageways doesn't
  // zigzag, and keeps the cadastre's own vertices between matches, so bends keep their
  // shape. Where WME drew a bend too far off for any match, the cadastre's own
  // geometry between the matches on either side fills the gap.
  //
  // Returns null, since half a snap is worse than none, when the segment's first or
  // last match is more than endSkipM from its end, when under SNAP_MIN_MATCHED of it
  // matches (probably a different road), or when it would jump between cadastre lines
  // that don't meet.
  function snapToCadastre(segCoords, cadastreLines, stepM, maxDistM, endSkipM, toleranceM) {
    if (segCoords.length < 2) return null;
    const project = makeLocalProjection(segCoords[0]);

    const box = bboxOf(segCoords);
    const padLon = maxDistM / metresPerDegLon(segCoords[0][1]);
    const padLat = maxDistM / M_PER_DEG_LAT;
    const candidates = [];
    for (const coords of cadastreLines) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const b = bboxOf(coords);
      if (b.maxLon < box.minLon - padLon || b.minLon > box.maxLon + padLon
        || b.maxLat < box.minLat - padLat || b.minLat > box.maxLat + padLat) continue;
      const pts = coords.map(project);
      candidates.push({ coords, pts, cum: cumulative(pts) });
    }

    const segPts = segCoords.map(project);
    const segCum = cumulative(segPts);
    const total = segCum[segCum.length - 1];

    const matches = [];
    let current = null;
    const ds = sampleDistances(total, stepM);
    for (const d of ds) {
      const i = edgeAt(segCum, d);
      const dir = [segPts[i][0] - segPts[i - 1][0], segPts[i][1] - segPts[i - 1][1]];
      const p = project(pointAlong(segCoords, segCum, d));
      let best = null;
      let bestOnCurrent = null;
      for (const line of candidates) {
        for (let j = 1; j < line.pts.length; j++) {
          const a = line.pts[j - 1];
          const b = line.pts[j];
          if (!isAlongside(dir, a, b)) continue;
          const { dist, t } = closestOnEdge(p, a, b);
          if (dist > maxDistM) continue;
          const m = { line, pos: line.cum[j - 1] + t * (line.cum[j] - line.cum[j - 1]), dist };
          if (!best || dist < best.dist) best = m;
          if (line === current && (!bestOnCurrent || dist < bestOnCurrent.dist)) bestOnCurrent = m;
        }
      }
      const m = bestOnCurrent || best;
      if (!m) {
        if (!matches.length && d > endSkipM) return null;
        continue;
      }
      current = m.line;
      matches.push({ ...m, d });
    }
    if (!matches.length || matches[matches.length - 1].d < total - endSkipM) return null;
    if (matches.length < SNAP_MIN_MATCHED * ds.length) return null;

    const out = [segCoords[0]];
    let prev = null;
    for (const m of matches) {
      if (prev && prev.line === m.line) {
        out.push(...verticesBetween(m.line, prev.pos, m.pos, false));
      } else if (prev) {
        // Onto another cadastre line, normally at a cadastre junction: finish the old
        // line to its end there and start the new one from it, so the corner between
        // them is kept.
        const ends = (line) => [{ pos: 0, pt: line.pts[0] }, { pos: line.cum[line.cum.length - 1], pt: line.pts[line.pts.length - 1] }];
        let joint = null;
        for (const a of ends(prev.line)) {
          for (const b of ends(m.line)) {
            const dist = Math.hypot(a.pt[0] - b.pt[0], a.pt[1] - b.pt[1]);
            if (dist <= maxDistM && (!joint || dist < joint.dist)) joint = { a, b, dist };
          }
        }
        if (!joint) return null;
        out.push(...verticesBetween(prev.line, prev.pos, joint.a.pos, false));
        out.push(pointAlong(prev.line.coords, prev.line.cum, joint.a.pos));
        out.push(...verticesBetween(m.line, joint.b.pos, m.pos, true));
      }
      out.push(pointAlong(m.line.coords, m.line.cum, m.pos));
      prev = m;
    }
    out.push(segCoords[segCoords.length - 1]);

    const deduped = out.filter((p, k) => k === 0 || p[0] !== out[k - 1][0] || p[1] !== out[k - 1][1]);
    return simplifyLine(deduped, toleranceM);
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
    let snapPreview = null;      // { segmentId, original, coords, hasHouseNumbers } awaiting a second press
    let partial = false;         // the last load hit the page cap or lost pages
    let isLoading = false;
    let currentLoadId = 0;
    let overrideRoadType = null; // null = Auto from category
    let layerWanted = LS.getLayerVisible();
    let showMapped = LS.getShowMapped();
    let layerShown = false;
    let layerIds = [];

    try {
      I18n.translations[I18n.currentLocale()].layers.name[SCRIPT_ID] = 'Quick Road Importer';
    } catch (_) {}

    // Grey and cyan lines lie exactly on WME segments: the one just created, or a road
    // WME already has. They let the mouse through, or they would catch the drags and
    // clicks meant for those segments and their nodes.
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
          predicate: (p) => p.state === 'reference',
          style: { strokeColor: '#00e5ff', strokeWidth: 2, strokeOpacity: 0.8, pointerEvents: 'none' }
        },
        {
          predicate: (p) => p.state === 'preview',
          style: {
            strokeColor: '#00ff66', strokeWidth: 4, strokeOpacity: 0.9, strokeDashstyle: 'dash',
            pointerEvents: 'none'
          }
        },
        {
          predicate: (p) => p.state === 'imported',
          style: {
            strokeColor: '#888888', strokeWidth: 4, strokeOpacity: 0.5, strokeDashstyle: 'dash',
            pointerEvents: 'none'
          }
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
      // Reference lines first, so the pieces draw on top of them. They never go into
      // `pieces`, which is what keeps them unclickable.
      const features = [
        ...(showMapped ? [...lines.values()].map(l => feature(`ref-${l.id}`, l.coords, 'reference')) : []),
        ...[...pieces.values()].map(p => feature(p.id, p.coords, 'missing')),
        ...[...imported].map(([id, a]) => feature(id, a.coords, 'imported')),
        ...(snapPreview ? [feature('snap-preview', snapPreview.coords, 'preview')] : [])
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
      snapPreview = null;
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
          <div style="margin:0 0 8px 0;">
            <button id="qrsl-snap" class="wz-button wz-button--secondary">Snap selected road to cadastre <kbd style="${KBD_STYLE}">Alt+Shift+G</kbd></button>
          </div>
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <wz-checkbox id="qrsl-toggle">Show layer</wz-checkbox>
            <wz-checkbox id="qrsl-show-mapped">Show already mapped roads</wz-checkbox>
            <label style="font-size:12px;">Road type <select id="qrsl-roadtype" style="margin-left:6px;">${typeOptions}</select></label>
          </div>
          <div id="qrsl-status" style="margin-top:10px;font-size:12px;color:#666;line-height:1.4;">${INSTRUCTIONS_HTML}</div>
          <div id="qrsl-hover" style="margin-top:6px;font-size:12px;font-weight:bold;min-height:1.4em;"></div>
        </div>
      `;

      const btnLoad      = tabPane.querySelector('#qrsl-load');
      const btnLoadLabel = tabPane.querySelector('#qrsl-load-label');
      const btnClear     = tabPane.querySelector('#qrsl-clear');
      const btnSnap      = tabPane.querySelector('#qrsl-snap');
      const chkVis       = tabPane.querySelector('#qrsl-toggle');
      const chkMapped    = tabPane.querySelector('#qrsl-show-mapped');
      const selRoadType  = tabPane.querySelector('#qrsl-roadtype');
      const statusDiv    = tabPane.querySelector('#qrsl-status');
      const hoverDiv     = tabPane.querySelector('#qrsl-hover');

      setChecked(chkVis, layerWanted);
      setChecked(chkMapped, showMapped);

      chkVis.addEventListener('click', () => {
        const on = isChecked(chkVis);
        setChecked(chkVis, !on);
        layerWanted = !on;
        LS.setLayerVisible(!on);
        updateLayerVisibility();
      });

      chkMapped.addEventListener('click', () => {
        const on = isChecked(chkMapped);
        setChecked(chkMapped, !on);
        showMapped = !on;
        LS.setShowMapped(!on);
        render();
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

      function selectedSegmentId() {
        const sel = wmeSDK.Editing.getSelection();
        return sel && sel.objectType === 'segment' && sel.ids.length === 1 ? sel.ids[0] : null;
      }

      // First press draws the snapped shape, a second press on the same, unchanged
      // segment applies it. Anything else starts over with a fresh preview.
      function snapSelected() {
        const segmentId = selectedSegmentId();
        const segment = segmentId == null ? null : wmeSDK.DataModel.Segments.getById({ segmentId });
        const coords = segment && segment.geometry && segment.geometry.coordinates;
        if (!coords) {
          toast('Select one road segment to snap', 'warning');
          return;
        }

        if (snapPreview && snapPreview.segmentId === segmentId
          && JSON.stringify(snapPreview.original) === JSON.stringify(coords)) {
          applySnap();
          return;
        }

        if (!lines.size) {
          toast('Load roads in view first', 'warning');
          return;
        }
        const snapped = snapToCadastre(coords, [...lines.values()].map(l => l.coords),
          COVERAGE_STEP_M, COVERAGE_MAX_DISTANCE_M, SNAP_END_SKIP_M, SIMPLIFY_TOLERANCE_M);
        if (!snapped) {
          snapPreview = null;
          render();
          toast('Couldn\'t match this segment to one cadastre road, nothing to snap to', 'warning');
          return;
        }
        snapPreview = {
          segmentId,
          original: coords.map(p => p.slice()),
          coords: snapped,
          hasHouseNumbers: !!segment.hasHouseNumbers
        };
        render();
        toast(`Preview in green: ${snapped.length - 2} geometry nodes. Press Snap again to apply.`, 'info');
      }

      function applySnap() {
        const { segmentId, coords, hasHouseNumbers } = snapPreview;
        if (!wmeSDK.Editing.isEditingAllowed()) {
          toast('Editing is not allowed here', 'warning');
          return;
        }
        snapPreview = null;
        render();
        try {
          wmeSDK.DataModel.Segments.updateSegment({ segmentId, geometry: { type: 'LineString', coordinates: coords } });
        } catch (e) {
          console.error('[SL-ROAD] snapping failed:', e);
          toast(`Could not snap the segment: ${e.message || e}`, 'error');
          return;
        }
        if (hasHouseNumbers) {
          toast(`Snapped, ${coords.length - 2} geometry nodes. It has house numbers, check them.`, 'warning');
        } else {
          toast(`Snapped, ${coords.length - 2} geometry nodes`, 'success');
        }
      }

      btnSnap.addEventListener('click', () => snapSelected());

      wmeSDK.Events.on({
        eventName: 'wme-selection-changed',
        eventHandler: () => {
          if (snapPreview && selectedSegmentId() !== snapPreview.segmentId) {
            snapPreview = null;
            render();
          }
        }
      });

      ['qrsl-load', 'qrsl-clear', 'qrsl-snap'].forEach(id => {
        try { wmeSDK.Shortcuts.deleteShortcut({ shortcutId: id }); } catch (_) {}
      });
      [
        { shortcutId: 'qrsl-load',  shortcutKeys: 'AS+r', description: 'SL-ROAD: Load roads in view', callback: () => loadRoads() },
        { shortcutId: 'qrsl-clear', shortcutKeys: 'AS+x', description: 'SL-ROAD: Clear',              callback: () => clearRoads() },
        { shortcutId: 'qrsl-snap',  shortcutKeys: 'AS+g', description: 'SL-ROAD: Snap selected road to cadastre', callback: () => snapSelected() }
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
        'DataModel.Segments.getById',
        'DataModel.Segments.addSegment',
        'DataModel.Segments.updateSegment',
        'DataModel.Segments.updateAddress',
        'DataModel.Countries.getTopCountry',
        'DataModel.Cities.getCity',
        'DataModel.Cities.addCity',
        'DataModel.Streets.getStreet',
        'DataModel.Streets.addStreet',
        'Editing.setSelection',
        'Editing.getSelection',
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
      snapToCadastre,
      buildItemsUrl,
      buildRoadLines,
      classifyFetchFailure,
      decideFetchRetry,
      fetchRetryDelay
    };
  }
})();
