// ==UserScript==
// @name         WME Quick Road Importer - Slovenia
// @namespace    https://github.com/zigapovhe/wme-sl-road-import
// @version      0.1.0
// @description  Show Slovenian roads missing from WME and add them with one click
// @author       ThatByte
// @downloadURL  https://raw.githubusercontent.com/zigapovhe/wme-sl-road-import/main/wme-sl-road-import.user.js
// @updateURL    https://raw.githubusercontent.com/zigapovhe/wme-sl-road-import/main/wme-sl-road-import.user.js
// @supportURL   https://github.com/zigapovhe/wme-sl-road-import/issues
// @icon         https://raw.githubusercontent.com/zigapovhe/wme-sl-road-import/main/icon48.png
// @icon64       https://raw.githubusercontent.com/zigapovhe/wme-sl-road-import/main/icon64.png
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
  const ENDS_LAYER_NAME = 'qrsl-ends';

  const CADASTRE_API = 'https://ipi.eprostor.gov.si/wfs-si-gurs-kgi/ogc/features/collections/SI.GURS.KGI:LINIJE_CESTE_G/items';
  const CADASTRE_LIMIT = 1000;
  const CADASTRE_MAX_PAGES = 30;

  // Same retry policy as the HN importer: eProstor times out at random, and the
  // per-load budget bounds how long a sick server can keep a load spinning.
  const FETCH_TIMEOUT_MS = 30000;
  const FETCH_PAGE_RETRIES = 2; // 3 attempts per page
  const FETCH_RETRY_BACKOFF_MS = [1000, 3000];
  const FETCH_RETRY_BUDGET = 4; // retries per load, across all pages

  // Coverage only sees segments WME has loaded, so loading below this zoom would
  // show roads WME has but hasn't fetched.
  const MIN_LOAD_ZOOM = 16;
  const SIMPLIFY_TOLERANCE_M = 2;
  const COVERAGE_STEP_M = 5;
  const COVERAGE_MAX_DISTANCE_M = 15;
  const MIN_PIECE_LENGTH_M = 30;
  // Junctions are where WME and the cadastre disagree most, so aligning tolerates no
  // match this close to either end of the segment.
  const ALIGN_END_SKIP_M = 15;
  // An end node further than this from the cadastre would leave the aligned road with
  // a bend right at the node, and WME takes turn angles from there. A road that is
  // only shifted harms nobody, so then it isn't aligned at all.
  const ALIGN_MAX_END_OFFSET_M = 3;
  // Further than this, a dead end next to a road is more likely a real dead end than
  // a junction the editor missed.
  const DISCONNECTED_MAX_DISTANCE_M = 5;
  // Close enough to drag a node onto a road.
  const END_JUMP_ZOOM = 18;

  // An on/off setting kept in localStorage. Only a stored '0' turns a default-on
  // setting off, and only '1' turns a default-off one on.
  function setting(key, byDefault) {
    return {
      get: () => (byDefault ? localStorage.getItem(key) !== '0' : localStorage.getItem(key) === '1'),
      set: (on) => localStorage.setItem(key, on ? '1' : '0')
    };
  }

  const SETTINGS = {
    showLayer:  setting('qrsl-layer-visible', true),
    showMapped: setting('qrsl-show-mapped', false),
    // Disconnected ends were called loose ends once. The key stays, or the saved
    // setting would be lost.
    showEnds:   setting('qrsl-show-loose', true)
  };

  const INSTRUCTIONS_HTML = `<b>Instructions</b><br/>
    1) Zoom in to level ${MIN_LOAD_ZOOM}+ • 2) Click "Load roads in view" • 3) <b>Click a pink line to add it as a segment</b><br/>
    Connect it to the network yourself. Grey dashed = added since the last load.<br/>
    Orange ring (a dot when zoomed out) = a dead end next to a road it isn't connected to.`;

  const KBD_STYLE = 'margin-left:6px;font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'
    + 'background:rgba(0,0,0,0.08);border-radius:3px;padding:2px 5px;color:#555;';

  const TOAST_COLORS = {
    info:    { bg: '#e7f1ff', border: '#5b9bd5', text: '#12385e' },
    success: { bg: '#d4edda', border: '#28a745', text: '#155724' },
    warning: { bg: '#fff3cd', border: '#ffc107', text: '#7a5b00' },
    error:   { bg: '#f8d7da', border: '#dc3545', text: '#721c24' }
  };
  const TOAST_TIMEOUT_MS = 4000;

  // --- Page helpers ---

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
  const isChecked = (el) => el?.hasAttribute('checked');
  const setChecked = (el, v) => v ? el.setAttribute('checked', '') : el.removeAttribute('checked');

  // Shows a setting on a checkbox. A click flips both and passes the new state on.
  function bindCheckbox(el, setting, onChange) {
    setChecked(el, setting.get());
    el.addEventListener('click', () => {
      const on = !isChecked(el);
      setChecked(el, on);
      setting.set(on);
      onChange(on);
    });
  }

  // --- Road types and cadastre categories ---

  // Waze road type ids, from the SDK's ROAD_TYPE constant. Literals, because the
  // constant is a module export in the SDK typings, not something on the instance.
  // Also the order of the road type dropdown.
  const ROAD_TYPES = [
    { id: 3, name: 'Freeway' },
    { id: 6, name: 'Major Highway' },
    { id: 7, name: 'Minor Highway' },
    { id: 2, name: 'Primary Street' },
    { id: 1, name: 'Street' },
    { id: 8, name: 'Off-road / Not maintained' },
    { id: 17, name: 'Private Road' },
    { id: 20, name: 'Parking Lot Road' }
  ];

  // GJI_ATR1_SIFRA from the cadastre, with its own GJI_ATR1_NAZIV_SL name. Code 15
  // does not exist. Cycle paths, hiking trails and footpaths are never offered.
  const ROAD_CATEGORIES = {
    0:  { name: 'ni podatka', roadType: 1 },
    1:  { name: 'avtocesta', roadType: 3 },
    2:  { name: 'hitra cesta', roadType: 7 },
    3:  { name: 'glavna cesta I. reda', roadType: 2 },
    4:  { name: 'glavna cesta II. reda', roadType: 2 },
    5:  { name: 'regionalna cesta I. reda', roadType: 2 },
    6:  { name: 'regionalna cesta II. reda', roadType: 2 },
    7:  { name: 'regionalna cesta III. reda', roadType: 2 },
    8:  { name: 'turistična cesta', roadType: 2 },
    9:  { name: 'lokalna cesta', roadType: 1 },
    10: { name: 'javna pot', roadType: 1 },
    11: { name: 'glavna mestna cesta', roadType: 2 },
    12: { name: 'zbirna mestna ali krajevna cesta', roadType: 2 },
    13: { name: 'mestna ali krajevna cesta', roadType: 1 },
    14: { name: 'državna kolesarska pot', excluded: true },
    16: { name: 'občinska kolesarska pot', excluded: true },
    17: { name: 'gozdna cesta', roadType: 8, unpaved: true },
    18: { name: 'nekategorizirana cesta', roadType: 17 },
    19: { name: 'planinska pot', excluded: true },
    20: { name: 'pešpoti', excluded: true }
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

  // --- Geometry, in local metres ---

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

  // Whether box b comes within distM of box a. A miss means nothing in b can be near
  // anything in a. Checked in degrees, so the thousands of far segments in a view are
  // never projected.
  function boxesNear(a, b, distM) {
    const padLon = distM / metresPerDegLon((a.minLat + a.maxLat) / 2);
    const padLat = distM / M_PER_DEG_LAT;
    return b.maxLon >= a.minLon - padLon && b.minLon <= a.maxLon + padLon
      && b.maxLat >= a.minLat - padLat && b.minLat <= a.maxLat + padLat;
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

  // Whether direction u and the edge a-b are within ALONGSIDE_MAX_ANGLE_DEG of each
  // other, either way round.
  function isAlongside(u, [ax, ay], [bx, by]) {
    const vx = bx - ax;
    const vy = by - ay;
    const vv = vx * vx + vy * vy;
    const dot = u[0] * vx + u[1] * vy;
    return vv > 0 && dot * dot >= ALONGSIDE_MIN_COS2 * (u[0] * u[0] + u[1] * u[1]) * vv;
  }

  // --- Missing pieces: cadastre roads with no WME road along them ---

  // WME segment geometries with their boxes, computed once per refresh rather than
  // once per cadastre line: the refresh runs on every pan.
  function prepareSegments(segmentLines) {
    return segmentLines
      .filter(seg => Array.isArray(seg) && seg.length >= 2)
      .map(coords => ({ coords, box: bboxOf(coords) }));
  }

  // The pieces of a cadastre line with no WME road running alongside it within
  // maxDistM, as [lon, lat] lines. Sampled every stepM metres rather than measured as
  // overlap, so a WME road drawn a few metres off the cadastre (the usual case) still
  // counts. segments come from prepareSegments.
  //
  // Pieces shorter than minLengthM are dropped: they are usually the same road
  // drawn slightly differently on a bend. A line with nothing alongside it at all is
  // kept whole, however short.
  function missingPieces(coords, segments, stepM, maxDistM, minLengthM) {
    if (coords.length < 2) return [];

    const box = bboxOf(coords);
    const project = makeLocalProjection(coords[0]);

    const edges = [];
    for (const { coords: seg, box: b } of segments) {
      if (!boxesNear(box, b, maxDistM)) continue;
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

    const pieces = [];
    for (let k = 0; k < ds.length; k++) {
      if (near[k]) continue;
      let j = k;
      while (j + 1 < ds.length && !near[j + 1]) j++;
      const fromM = ds[k];
      const toM = ds[j];
      if (toM - fromM >= minLengthM) pieces.push(subLine(coords, cum, fromM, toM));
      k = j;
    }
    return pieces;
  }

  // --- Disconnected ends ---

  // Ferries, railways and runways are never joined to roads, so a road ending next to
  // one is fine.
  const NEVER_CONNECTED_ROAD_TYPES = new Set([15, 18, 19]);

  // Dead ends (nodes with one segment) within maxDistM of another road: usually a
  // junction the editor meant to make and missed by a few metres. Takes the SDK's
  // segments and nodes, returns [{ nodeId, segmentId, coords }].
  function findDisconnectedEnds(segments, nodes, maxDistM) {
    const roads = [];
    for (const s of segments) {
      const coords = s?.geometry?.coordinates;
      if (NEVER_CONNECTED_ROAD_TYPES.has(s?.roadType) || !Array.isArray(coords) || coords.length < 2) continue;
      roads.push({ id: s.id, coords, box: bboxOf(coords) });
    }
    const roadIds = new Set(roads.map(r => r.id));

    const found = [];
    for (const n of nodes) {
      const p = n?.geometry?.coordinates;
      const ids = n?.connectedSegmentIds;
      // A node whose only segment WME hasn't loaded sits at the edge of the loaded area.
      if (!Array.isArray(p) || !Array.isArray(ids) || ids.length !== 1 || !roadIds.has(ids[0])) continue;
      const box = bboxOf([p]);
      const project = makeLocalProjection(p);
      let near = false;
      for (const r of roads) {
        if (r.id === ids[0] || !boxesNear(box, r.box, maxDistM)) continue;
        const sp = r.coords.map(project);
        for (let i = 1; i < sp.length && !near; i++) near = pointToSegmentDistance([0, 0], sp[i - 1], sp[i]) <= maxDistM;
        if (near) break;
      }
      if (near) found.push({ nodeId: n.id, segmentId: ids[0], coords: [p[0], p[1]] });
    }
    return found;
  }

  // The session's list of disconnected ends after a refresh, given what findDisconnectedEnds
  // finds now. An end stays listed until WME shows it fixed, so panning away doesn't
  // lose it: its node got a second segment, its segment now ends at another node
  // (dragged onto a road), or both are gone from a spot WME has just loaded (the road
  // was deleted). Still a dead end with no road near counts only with every road type
  // loaded: zoomed out WME has just the bigger roads, maybe not the one it misses.
  // view: { allRoadTypes, spotLoaded(coords) }. Listed ends keep their place.
  function updateEndsList(listed, found, segments, nodes, view) {
    const now = new Map(found.map(e => [e.nodeId, e]));
    const segmentIds = new Set(segments.map(s => s?.id));
    const nodeById = new Map(nodes.map(n => [n?.id, n]));
    const fixed = (e) => {
      const n = nodeById.get(e.nodeId);
      if (n) {
        const ids = n.connectedSegmentIds || [];
        return ids.length > 1 || (view.allRoadTypes && ids.every(id => segmentIds.has(id)));
      }
      return segmentIds.has(e.segmentId) || view.spotLoaded(e.coords);
    };
    const kept = listed.filter(e => now.has(e.nodeId) || !fixed(e)).map(e => now.get(e.nodeId) || e);
    const keptIds = new Set(kept.map(e => e.nodeId));
    return kept.concat(found.filter(e => !keptIds.has(e.nodeId)));
  }

  // --- Aligning a WME segment onto the cadastre ---

  // Aligning needs the cadastre alongside at least this share of the segment's samples.
  // Less, and the line matching at both ends is probably a different road between them.
  const ALIGN_MIN_MATCHED = 0.5;

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

  // Walks the segment every stepM metres and matches each sample to the nearest
  // cadastre edge running alongside within maxDistM. Each match has its line, pos
  // (metres along that cadastre line) and d (metres along the segment). It keeps to
  // the same cadastre line while that still qualifies, so a road between two
  // carriageways doesn't zigzag. Samples with no match are left out.
  //
  // null when the segment's first or last match is more than endSkipM from its end,
  // or when under ALIGN_MIN_MATCHED of it matches (probably a different road).
  function matchAlong(segCoords, project, candidates, stepM, maxDistM, endSkipM) {
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
    if (matches.length < ALIGN_MIN_MATCHED * ds.length) return null;
    return matches;
  }

  // The nearest pair of ends of two projected cadastre lines, if within maxDistM, as
  // { a, b } with each end's pos along its line and its point.
  function closestEnds(lineA, lineB, maxDistM) {
    const ends = (line) => [{ pos: 0, pt: line.pts[0] }, { pos: line.cum[line.cum.length - 1], pt: line.pts[line.pts.length - 1] }];
    let joint = null;
    for (const a of ends(lineA)) {
      for (const b of ends(lineB)) {
        const dist = Math.hypot(a.pt[0] - b.pt[0], a.pt[1] - b.pt[1]);
        if (dist <= maxDistM && (!joint || dist < joint.dist)) joint = { a, b, dist };
      }
    }
    return joint;
  }

  // The segment's new points through its matches, from its own first point to its own
  // last. Between two matches on one cadastre line it keeps that line's vertices, so
  // bends keep their shape. Where WME drew a bend too far off for any match, those
  // vertices fill the gap. null when it would jump between cadastre lines that don't
  // meet.
  function pathThrough(segCoords, matches, maxDistM) {
    const out = [segCoords[0]];
    let prev = null;
    for (const m of matches) {
      if (prev && prev.line === m.line) {
        out.push(...verticesBetween(m.line, prev.pos, m.pos, false));
      } else if (prev) {
        // Onto another cadastre line, normally at a cadastre junction: finish the old
        // line to its end there and start the new one from it, so the corner between
        // them is kept.
        const joint = closestEnds(prev.line, m.line, maxDistM);
        if (!joint) return null;
        out.push(...verticesBetween(prev.line, prev.pos, joint.a.pos, false));
        out.push(pointAlong(prev.line.coords, prev.line.cum, joint.a.pos));
        out.push(...verticesBetween(m.line, joint.b.pos, m.pos, true));
      }
      out.push(pointAlong(m.line.coords, m.line.cum, m.pos));
      prev = m;
    }
    out.push(segCoords[segCoords.length - 1]);
    return out;
  }

  // How far a projected point is from a projected cadastre line.
  function distanceToLine(p, line) {
    let best = Infinity;
    for (let j = 1; j < line.pts.length; j++) {
      best = Math.min(best, pointToSegmentDistance(p, line.pts[j - 1], line.pts[j]));
    }
    return best;
  }

  // New geometry for a WME segment, moved onto the cadastre line(s) running alongside
  // it, as { coords, endOffsetsM }. The two end points are the segment's own, so its
  // nodes and connections stay where they are. endOffsetsM says how far the start
  // and end node are from the cadastre line the new geometry joins there: the length
  // of the step it takes to get onto it. null, since a half-aligned road is worse than
  // none, whenever matchAlong or pathThrough gives up.
  function alignToCadastre(segCoords, cadastreLines, stepM, maxDistM, endSkipM, toleranceM) {
    if (segCoords.length < 2) return null;
    const project = makeLocalProjection(segCoords[0]);

    const box = bboxOf(segCoords);
    const candidates = [];
    for (const coords of cadastreLines) {
      if (!Array.isArray(coords) || coords.length < 2 || !boxesNear(box, bboxOf(coords), maxDistM)) continue;
      const pts = coords.map(project);
      candidates.push({ coords, pts, cum: cumulative(pts) });
    }

    const matches = matchAlong(segCoords, project, candidates, stepM, maxDistM, endSkipM);
    const out = matches && pathThrough(segCoords, matches, maxDistM);
    if (!out) return null;
    const deduped = out.filter((p, k) => k === 0 || p[0] !== out[k - 1][0] || p[1] !== out[k - 1][1]);
    const endOffsetsM = [
      distanceToLine(project(segCoords[0]), matches[0].line),
      distanceToLine(project(segCoords[segCoords.length - 1]), matches[matches.length - 1].line)
    ];
    return { coords: simplifyLine(deduped, toleranceM), endOffsetsM };
  }

  // --- Loading from eProstor ---

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

  // One GET. Resolves { kind: 'load', status, text }, or just { kind } for 'error' and
  // 'timeout'. Never rejects, so fetchCadastre handles every outcome in one place.
  function getPage(url) {
    return new Promise(resolve => GM_xmlhttpRequest({
      method: 'GET',
      url,
      timeout: FETCH_TIMEOUT_MS,
      onload: (response) => resolve({ kind: 'load', status: response.status, text: response.responseText }),
      onerror: () => resolve({ kind: 'error' }),
      ontimeout: () => resolve({ kind: 'timeout' })
    }));
  }

  // The page as JSON, or null when it isn't a feature collection.
  function parsePage(text) {
    try {
      const data = JSON.parse(text);
      return Array.isArray(data?.features) ? data : null;
    } catch (_) {
      return null;
    }
  }

  // Cadastre roads in bbox, page by page. shouldAbort is checked between pages and
  // after each backoff, so a Clear or a newer Load stops the chain.
  //
  // Resolves { features, complete }. complete is false when the page cap was hit or a
  // page failed after earlier ones arrived. Rejects with err.userMessage when nothing
  // loaded.
  async function fetchCadastre(bbox, shouldAbort) {
    const features = [];
    let startIndex = 0;
    let retriesUsed = 0;

    for (let page = 1; ; page++) {
      if (shouldAbort()) return { features, complete: false };
      if (page > CADASTRE_MAX_PAGES) {
        console.warn(`[SL-ROAD] cadastre result truncated at ${CADASTRE_MAX_PAGES} pages`);
        toast('Too many roads in view, result truncated. Zoom in.', 'warning');
        return { features, complete: false };
      }

      let data;
      for (let attempt = 1; ; attempt++) {
        const response = await getPage(buildItemsUrl(bbox, startIndex));
        data = response.kind === 'load' ? parsePage(response.text) : null;
        if (data) break;

        const { retryable, reason } = classifyFetchFailure(response.kind, response.status);
        const verdict = decideFetchRetry({ retryable, attempt, retriesUsed, haveFeatures: features.length > 0 });
        if (verdict === 'partial') {
          console.warn(`[SL-ROAD] eProstor ${reason}; result is partial`);
          toast(`eProstor ${reason}, showing the ${features.length} roads that loaded`, 'warning');
          return { features, complete: false };
        }
        if (verdict === 'fail') {
          const err = new Error(`eProstor ${reason}`);
          err.userMessage = `eProstor ${reason}, no roads loaded`;
          throw err;
        }
        retriesUsed++;
        toast(`eProstor ${reason}, retrying (attempt ${attempt + 1} of ${FETCH_PAGE_RETRIES + 1})`, 'warning');
        await new Promise(resolve => setTimeout(resolve, fetchRetryDelay(attempt)));
        if (shouldAbort()) return { features, complete: false };
      }

      features.push(...data.features);
      const returned = data.numberReturned || data.features.length;
      const total = typeof data.numberMatched === 'number' ? data.numberMatched : null;
      const hasMore = total != null ? startIndex + returned < total : returned >= CADASTRE_LIMIT;
      if (!hasMore || returned === 0) return { features, complete: true };
      startIndex += returned;
    }
  }

  // --- WME: the layers, the sidebar and one setup function per feature ---

  // Grey and cyan lines lie exactly on WME segments: the one just created, or a road
  // WME already has. They let the mouse through, or they would catch the drags and
  // clicks meant for those segments and their nodes.
  const ROAD_LAYER_STYLES = [
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
      predicate: (p) => p.state === 'off-end',
      style: {
        pointRadius: 12, fill: false, strokeColor: '#ff1744', strokeWidth: 3, strokeOpacity: 0.95,
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
  ];

  // Zoomed out, a ring around a node is lost among the roads, so it becomes a solid
  // dot. Both sit on a WME node and let the mouse through to it, like the grey lines.
  const ENDS_LAYER_STYLES = [
    {
      predicate: (p) => p.state === 'ring',
      style: {
        pointRadius: 12, fill: false, strokeColor: '#ff8c00', strokeWidth: 3, strokeOpacity: 0.95,
        pointerEvents: 'none'
      }
    },
    {
      predicate: (p) => p.state === 'dot',
      style: {
        pointRadius: 8, fillColor: '#ff8c00', fillOpacity: 0.9, strokeColor: '#ffffff', strokeWidth: 2,
        pointerEvents: 'none'
      }
    }
  ];

  // Swaps a layer's features and returns the ids now on it. Ids are recorded before
  // the add: if it throws part-way, removing an id that never landed is harmless,
  // while an orphan feature would stay clickable.
  function replaceFeatures(layerName, ids, features) {
    try {
      if (ids.length) {
        wmeSDK.Map.removeFeaturesFromLayer({ layerName, featureIds: ids });
        ids = [];
      }
      if (!features.length) return ids;
      ids = features.map(f => f.id);
      wmeSDK.Map.addFeaturesToLayer({ layerName, features });
    } catch (e) {
      console.warn('[SL-ROAD] rendering failed:', e);
    }
    return ids;
  }

  // [minLon, minLat, maxLon, maxLat] of the view.
  function mapBounds() {
    const ext = wmeSDK.Map.getMapExtent();
    return Array.isArray(ext) ? ext : [ext.lonMin, ext.latMin, ext.lonMax, ext.latMax];
  }

  function selectedSegmentId() {
    const sel = wmeSDK.Editing.getSelection();
    return sel?.objectType === 'segment' && sel.ids.length === 1 ? sel.ids[0] : null;
  }

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

  // Fills the sidebar tab and returns the elements the features below work with.
  function buildPane(tabPane) {
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
          <button id="qrsl-align" class="wz-button wz-button--secondary">Align road geometry <kbd style="${KBD_STYLE}">Alt+Shift+G</kbd></button>
        </div>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
          <wz-checkbox id="qrsl-toggle">Show layer</wz-checkbox>
          <wz-checkbox id="qrsl-show-mapped">Show already mapped roads</wz-checkbox>
          <wz-checkbox id="qrsl-show-ends">Show disconnected ends</wz-checkbox>
          <label style="font-size:12px;">Road type <select id="qrsl-roadtype" style="margin-left:6px;">${typeOptions}</select></label>
        </div>
        <div id="qrsl-status" style="margin-top:10px;font-size:12px;color:#666;line-height:1.4;">${INSTRUCTIONS_HTML}</div>
        <div id="qrsl-ends" style="margin-top:6px;font-size:12px;color:#b35f00;"></div>
        <div id="qrsl-ends-list" style="max-height:160px;overflow-y:auto;font-size:12px;color:#b35f00;"></div>
        <div id="qrsl-hover" style="margin-top:6px;font-size:12px;font-weight:bold;min-height:1.4em;"></div>
      </div>
    `;

    return {
      btnLoad:      tabPane.querySelector('#qrsl-load'),
      btnLoadLabel: tabPane.querySelector('#qrsl-load-label'),
      btnClear:     tabPane.querySelector('#qrsl-clear'),
      btnAlign:     tabPane.querySelector('#qrsl-align'),
      chkVis:       tabPane.querySelector('#qrsl-toggle'),
      chkMapped:    tabPane.querySelector('#qrsl-show-mapped'),
      chkEnds:      tabPane.querySelector('#qrsl-show-ends'),
      selRoadType:  tabPane.querySelector('#qrsl-roadtype'),
      statusDiv:    tabPane.querySelector('#qrsl-status'),
      hoverDiv:     tabPane.querySelector('#qrsl-hover'),
      endsDiv:      tabPane.querySelector('#qrsl-ends'),
      endsList:     tabPane.querySelector('#qrsl-ends-list')
    };
  }

  // The road layer and what is on it: the loaded cadastre lines, the pieces of them
  // WME has no road along, the roads added since the load and the align preview.
  // Loading, adding and aligning change what is in the returned object, then call
  // update() or render() to show it.
  function setupRoadLayer(ui) {
    const lines = new Map(); // id -> RoadLine, for the current load
    const pieces = new Map(); // id -> the part of a line WME has no road along
    const imported = new Map(); // id -> { lineId, coords } of segments added since the last load
    const roads = {
      lines, pieces, imported,
      alignPreview: null, // { segmentId, original, coords, offEnds, hasHouseNumbers } awaiting a second press
      partial: false, // the last load hit the page cap or lost pages
      update, render, clear, show
    };
    let layerWanted = SETTINGS.showLayer.get();
    let layerShown = false;
    let showMapped = SETTINGS.showMapped.get();
    let layerIds = [];

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

    // Cuts every line down to the pieces WME has no road along. What this session
    // added counts as a road too, so a piece can't reappear beside its own segment
    // before WME lists that segment.
    function refreshPieces() {
      const segments = prepareSegments(wmeSDK.DataModel.Segments.getAll()
        .map(s => s.geometry?.coordinates)
        .concat([...imported.values()].map(a => a.coords)));
      pieces.clear();
      for (const line of lines.values()) {
        missingPieces(line.coords, segments, COVERAGE_STEP_M, COVERAGE_MAX_DISTANCE_M, MIN_PIECE_LENGTH_M)
          .forEach((coords, k) => {
            const id = `${line.id}/${k}`;
            pieces.set(id, { id, lineId: line.id, category: line.category, coords, lengthM: lineLengthM(coords) });
          });
      }
    }

    function render() {
      const feature = (id, coords, state, type = 'LineString') => ({
        type: 'Feature', id, geometry: { type, coordinates: coords }, properties: { state }
      });
      const preview = roads.alignPreview;
      // Reference lines first, so the pieces draw on top of them. They never go into
      // `pieces`, which is what keeps them unclickable.
      const features = [
        ...(showMapped ? [...lines.values()].map(l => feature(`ref-${l.id}`, l.coords, 'reference')) : []),
        ...[...pieces.values()].map(p => feature(p.id, p.coords, 'missing')),
        ...[...imported].map(([id, a]) => feature(id, a.coords, 'imported')),
        ...(preview ? [feature('align-preview', preview.coords, 'preview')] : []),
        ...(preview ? preview.offEnds.map(e => feature(`align-off-${e.name}`, e.coords, 'off-end', 'Point')) : [])
      ];
      layerIds = replaceFeatures(SDK_LAYER_NAME, layerIds, features);
    }

    function updateStatus() {
      if (!lines.size) {
        ui.statusDiv.textContent = 'No roads in view.';
        return;
      }
      const open = new Set([...pieces.values(), ...imported.values()].map(p => p.lineId));
      const mapped = [...lines.keys()].filter(id => !open.has(id)).length;
      let text = `${pieces.size} missing, ${mapped} already mapped`;
      if (imported.size) text += `, ${imported.size} added`;
      if (roads.partial) text += '. Loaded partially, zoom in and load again.';
      ui.statusDiv.textContent = text;
    }

    // After a load or an edit: cut the pieces again, draw them and count them.
    function update() {
      refreshPieces();
      render();
      updateStatus();
    }

    // Empties the layer, for a new load or a Clear.
    function clear() {
      lines.clear();
      pieces.clear();
      imported.clear();
      roads.alignPreview = null;
      roads.partial = false;
      render();
      ui.hoverDiv.textContent = '';
    }

    // Load is an explicit request to see the result.
    function show() {
      if (!layerWanted) {
        layerWanted = true;
        setChecked(ui.chkVis, true);
        SETTINGS.showLayer.set(true);
      }
      updateLayerVisibility();
    }

    bindCheckbox(ui.chkVis, SETTINGS.showLayer, (on) => {
      layerWanted = on;
      updateLayerVisibility();
    });
    bindCheckbox(ui.chkMapped, SETTINGS.showMapped, (on) => {
      showMapped = on;
      render();
    });

    wmeSDK.Events.on({ eventName: 'wme-map-zoom-changed', eventHandler: () => updateLayerVisibility() });
    wmeSDK.Events.on({
      eventName: 'wme-map-data-loaded',
      eventHandler: () => {
        if (lines.size) update();
      }
    });
    updateLayerVisibility();

    return roads;
  }

  // Load fetches the cadastre roads in view onto the road layer, Clear empties it.
  function setupLoading(ui, roads) {
    let isLoading = false;
    let currentLoadId = 0;

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
        ui.btnLoad.disabled = true;
        ui.btnLoadLabel.textContent = 'Loading…';
        roads.clear();
        ui.statusDiv.textContent = 'Loading roads…';

        const [minLon, minLat, maxLon, maxLat] = mapBounds();

        let result;
        try {
          result = await fetchCadastre({ minLon, minLat, maxLon, maxLat }, () => myLoadId !== currentLoadId);
        } catch (err) {
          if (myLoadId !== currentLoadId) return;
          console.warn('[SL-ROAD] fetch failed:', err);
          const msg = err.userMessage || 'Error fetching roads.';
          toast(msg, 'error');
          ui.statusDiv.textContent = msg;
          return;
        }
        if (myLoadId !== currentLoadId) return; // Clear or a newer Load since

        for (const line of buildRoadLines(result.features)) roads.lines.set(line.id, line);
        roads.partial = !result.complete;
        roads.update();
        roads.show();
      } finally {
        // After a Clear, Load was already released, and a newer load may own it now.
        if (myLoadId === currentLoadId) {
          ui.btnLoad.disabled = false;
          ui.btnLoadLabel.textContent = 'Load roads in view';
          isLoading = false;
        }
      }
    }

    // A request in flight can't be cancelled. Bumping the id makes its result drop,
    // and Load is released now rather than when that request returns.
    function clearRoads() {
      currentLoadId++;
      isLoading = false;
      ui.btnLoad.disabled = false;
      ui.btnLoadLabel.textContent = 'Load roads in view';
      roads.clear();
      ui.statusDiv.innerHTML = INSTRUCTIONS_HTML;
    }

    // Wrapped, so the click event never lands in a parameter.
    ui.btnLoad.addEventListener('click', () => loadRoads());
    ui.btnClear.addEventListener('click', () => clearRoads());

    return { loadRoads, clearRoads };
  }

  // One click, one segment from exactly the clicked piece. Junctions and connections
  // are the editor's job. The road type dropdown and the hover text are here too,
  // since they decide and show what a click creates.
  function setupAdding(ui, roads) {
    let overrideRoadType = null; // null = Auto from category
    let importedCount = 0;

    ui.selRoadType.addEventListener('change', () => {
      overrideRoadType = ui.selRoadType.value === '' ? null : Number(ui.selRoadType.value);
    });

    wmeSDK.Events.on({
      eventName: 'wme-layer-feature-mouse-enter',
      eventHandler: ({ featureId, layerName } = {}) => {
        if (layerName !== SDK_LAYER_NAME) return;
        const piece = roads.pieces.get(String(featureId));
        ui.hoverDiv.textContent = piece ? describeLine(piece, overrideRoadType) : '';
      }
    });
    wmeSDK.Events.on({
      eventName: 'wme-layer-feature-mouse-leave',
      eventHandler: ({ layerName } = {}) => {
        if (layerName === SDK_LAYER_NAME) ui.hoverDiv.textContent = '';
      }
    });

    function onPieceClicked({ featureId, layerName } = {}) {
      if (layerName !== SDK_LAYER_NAME) return;
      const piece = roads.pieces.get(String(featureId));
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
      roads.imported.set(`added-${++importedCount}`, { lineId: piece.lineId, coords: piece.coords });

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

      roads.update();
      const what = `${roadTypeName(roadType)}, ${Math.round(piece.lengthM)} m`;
      if (failed.length) {
        toast(`${what} created, but setting ${failed.join(', ')} failed. Fix it by hand.`, 'warning');
      } else {
        toast(`${what} created`, 'success');
      }
    }

    wmeSDK.Events.on({ eventName: 'wme-layer-feature-clicked', eventHandler: onPieceClicked });
  }

  // Align road geometry. The first press draws the selected segment moved onto the
  // cadastre, a second press on the same, unchanged segment applies it. Anything else
  // starts over with a fresh preview. An end node too far off the cadastre is ringed,
  // and then a second press only says why again.
  function setupAligning(ui, roads) {
    function alignSelected() {
      const segmentId = selectedSegmentId();
      const segment = segmentId == null ? null : wmeSDK.DataModel.Segments.getById({ segmentId });
      const coords = segment?.geometry?.coordinates;
      if (!coords) {
        toast('Select one road segment to align', 'warning');
        return;
      }

      const preview = roads.alignPreview;
      if (preview && !preview.offEnds.length && preview.segmentId === segmentId
        && JSON.stringify(preview.original) === JSON.stringify(coords)) {
        applyAlign();
        return;
      }

      if (!roads.lines.size) {
        toast('Load roads in view first', 'warning');
        return;
      }
      const aligned = alignToCadastre(coords, [...roads.lines.values()].map(l => l.coords),
        COVERAGE_STEP_M, COVERAGE_MAX_DISTANCE_M, ALIGN_END_SKIP_M, SIMPLIFY_TOLERANCE_M);
      if (!aligned) {
        roads.alignPreview = null;
        roads.render();
        toast('Couldn\'t match this segment to one loaded road, nothing to align it to', 'warning');
        return;
      }
      // WME names a segment's start node A and its end node B.
      const offEnds = [
        { name: 'A', coords: coords[0], offsetM: aligned.endOffsetsM[0] },
        { name: 'B', coords: coords[coords.length - 1], offsetM: aligned.endOffsetsM[1] }
      ].filter(e => e.offsetM > ALIGN_MAX_END_OFFSET_M);
      roads.alignPreview = {
        segmentId,
        original: coords.map(p => p.slice()),
        coords: aligned.coords,
        offEnds,
        hasHouseNumbers: !!segment.hasHouseNumbers
      };
      roads.render();
      if (offEnds.length) {
        const where = offEnds.map(e => `${Math.round(e.offsetM)} m off at end ${e.name}`).join(' and ');
        toast(`Cadastre is ${where}, aligning would bend the road there. Not aligning.`, 'warning');
        return;
      }
      toast(`Preview in green: ${aligned.coords.length - 2} geometry nodes. Press Align again to apply.`, 'info');
    }

    function applyAlign() {
      const { segmentId, coords, hasHouseNumbers } = roads.alignPreview;
      if (!wmeSDK.Editing.isEditingAllowed()) {
        toast('Editing is not allowed here', 'warning');
        return;
      }
      roads.alignPreview = null;
      roads.render();
      try {
        wmeSDK.DataModel.Segments.updateSegment({ segmentId, geometry: { type: 'LineString', coordinates: coords } });
      } catch (e) {
        console.error('[SL-ROAD] aligning failed:', e);
        toast(`Could not align the segment: ${e.message || e}`, 'error');
        return;
      }
      if (hasHouseNumbers) {
        toast(`Aligned, ${coords.length - 2} geometry nodes. It has house numbers, check them.`, 'warning');
      } else {
        toast(`Aligned, ${coords.length - 2} geometry nodes`, 'success');
      }
    }

    ui.btnAlign.addEventListener('click', () => alignSelected());

    wmeSDK.Events.on({
      eventName: 'wme-selection-changed',
      eventHandler: () => {
        if (roads.alignPreview && selectedSegmentId() !== roads.alignPreview.segmentId) {
          roads.alignPreview = null;
          roads.render();
        }
      }
    });

    return alignSelected;
  }

  // Rings WME dead ends next to a road they aren't connected to, and lists them in the
  // sidebar. WME data only, so it runs with or without a cadastre load. Its own layer,
  // so the ends show at every zoom and with the roads hidden.
  function setupDisconnectedEnds(ui) {
    let showEnds = SETTINGS.showEnds.get();
    let listedEnds = []; // this session's, kept as updateEndsList describes
    let endIds = [];

    function renderEnds() {
      const state = wmeSDK.Map.getZoomLevel() >= MIN_LOAD_ZOOM ? 'ring' : 'dot';
      endIds = replaceFeatures(ENDS_LAYER_NAME, endIds, listedEnds.map(e => ({
        type: 'Feature', id: `end-${e.nodeId}`, geometry: { type: 'Point', coordinates: e.coords },
        properties: { state }
      })));
    }

    // Only right after a data load does the view stand for what WME has loaded: an
    // edit event can come while WME is still fetching the area just panned to.
    function refreshEnds(dataLoaded = false) {
      if (!showEnds) {
        listedEnds = [];
      } else {
        const segments = wmeSDK.DataModel.Segments.getAll();
        const nodes = wmeSDK.DataModel.Nodes.getAll();
        const allRoadTypes = wmeSDK.Map.getZoomLevel() >= MIN_LOAD_ZOOM;
        let spotLoaded = () => false;
        if (dataLoaded && allRoadTypes) {
          const [minLon, minLat, maxLon, maxLat] = mapBounds();
          spotLoaded = ([lon, lat]) => lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
        }
        listedEnds = updateEndsList(listedEnds, findDisconnectedEnds(segments, nodes, DISCONNECTED_MAX_DISTANCE_M),
          segments, nodes, { allRoadTypes, spotLoaded });
      }
      const n = listedEnds.length;
      ui.endsDiv.textContent = n ? `${n} disconnected ${n === 1 ? 'end, click it' : 'ends, click one'} to go there` : '';
      ui.endsList.innerHTML = listedEnds.map(e => `<div data-node="${e.nodeId}" style="cursor:pointer;text-decoration:underline;">`
        + `${e.coords[1].toFixed(5)}, ${e.coords[0].toFixed(5)}</div>`).join('');
      renderEnds();
    }

    bindCheckbox(ui.chkEnds, SETTINGS.showEnds, (on) => {
      showEnds = on;
      refreshEnds();
    });

    ui.endsList.addEventListener('click', (ev) => {
      const row = ev.target?.closest?.('[data-node]');
      const end = row && listedEnds.find(e => String(e.nodeId) === row.dataset.node);
      if (!end) return;
      try {
        wmeSDK.Map.setMapCenter({
          lonLat: { lon: end.coords[0], lat: end.coords[1] },
          zoomLevel: Math.max(wmeSDK.Map.getZoomLevel(), END_JUMP_ZOOM)
        });
      } catch (e) {
        console.warn('[SL-ROAD] could not centre the map:', e);
      }
    });

    wmeSDK.Events.on({ eventName: 'wme-map-zoom-changed', eventHandler: () => renderEnds() });
    wmeSDK.Events.on({ eventName: 'wme-map-data-loaded', eventHandler: () => refreshEnds(true) });

    // Edits, including connecting a ringed end. WME fires these in bursts, one per
    // batch of objects, so the refresh waits for the burst to end.
    let endsTimer = null;
    const scheduleEnds = () => {
      clearTimeout(endsTimer);
      endsTimer = setTimeout(() => refreshEnds(), 100);
    };
    wmeSDK.Events.trackDataModelEvents({ dataModelName: 'segments' });
    wmeSDK.Events.trackDataModelEvents({ dataModelName: 'nodes' });
    for (const eventName of ['wme-data-model-objects-added', 'wme-data-model-objects-changed', 'wme-data-model-objects-removed']) {
      wmeSDK.Events.on({
        eventName,
        eventHandler: ({ dataModelName } = {}) => {
          if (dataModelName === 'segments' || dataModelName === 'nodes') scheduleEnds();
        }
      });
    }
    refreshEnds();
  }

  // --- Startup ---

  function init() {
    try {
      I18n.translations[I18n.currentLocale()].layers.name[SCRIPT_ID] = 'Quick Road Importer';
    } catch (_) {}

    wmeSDK.Map.addLayer({ layerName: SDK_LAYER_NAME, styleRules: ROAD_LAYER_STYLES });
    wmeSDK.Map.setLayerVisibility({ layerName: SDK_LAYER_NAME, visibility: false });
    wmeSDK.Events.trackLayerEvents({ layerName: SDK_LAYER_NAME });
    wmeSDK.Map.addLayer({ layerName: ENDS_LAYER_NAME, styleRules: ENDS_LAYER_STYLES });

    wmeSDK.Sidebar.registerScriptTab().then(({ tabLabel, tabPane }) => {
      tabLabel.innerText = 'SL-ROAD';
      tabLabel.title = 'Quick Road Importer (Slovenia)';
      const ui = buildPane(tabPane);

      const roads = setupRoadLayer(ui);
      const { loadRoads, clearRoads } = setupLoading(ui, roads);
      setupAdding(ui, roads);
      const alignSelected = setupAligning(ui, roads);
      setupDisconnectedEnds(ui);

      // Align was called Snap once. Its shortcut id stays, or a key an editor rebound
      // would be lost.
      ['qrsl-load', 'qrsl-clear', 'qrsl-snap'].forEach(id => {
        try { wmeSDK.Shortcuts.deleteShortcut({ shortcutId: id }); } catch (_) {}
      });
      [
        { shortcutId: 'qrsl-load', shortcutKeys: 'AS+r', description: 'SL-ROAD: Load roads in view', callback: () => loadRoads() },
        { shortcutId: 'qrsl-clear', shortcutKeys: 'AS+x', description: 'SL-ROAD: Clear', callback: () => clearRoads() },
        { shortcutId: 'qrsl-snap', shortcutKeys: 'AS+g', description: 'SL-ROAD: Align road geometry', callback: () => alignSelected() }
      ].forEach(spec => {
        try { wmeSDK.Shortcuts.createShortcut(spec); }
        catch (e) { console.warn('[SL-ROAD] failed to register shortcut', spec.shortcutId, e); }
      });
    });
  }

  // Checked against the SDK docs at v2.374 on 2026-10-14. getWmeSdk is called without
  // a `version`, so WME always hands this script the latest SDK, and these lists catch
  // a renamed method before it fails silently. A test checks they name every SDK call
  // in this file.
  const REQUIRED_SDK_APIS = [
    'DataModel.Segments.getAll',
    'DataModel.Segments.getById',
    'DataModel.Segments.addSegment',
    'DataModel.Segments.updateSegment',
    'DataModel.Segments.updateAddress',
    'DataModel.Nodes.getAll',
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
    'Events.trackDataModelEvents',
    'Sidebar.registerScriptTab',
    'Map.addLayer',
    'Map.addFeaturesToLayer',
    'Map.removeFeaturesFromLayer',
    'Map.setLayerVisibility',
    'Map.getZoomLevel',
    'Map.getMapExtent'
  ];
  const OPTIONAL_SDK_APIS = [
    'Shortcuts.createShortcut',
    'Shortcuts.deleteShortcut',
    'Map.setMapCenter' // the list of disconnected ends can't take you there
  ];

  // False, after saying why, when the SDK lacks an API the script can't run without.
  function sdkHasRequiredApis() {
    const isMissing = (path) => {
      let cur = wmeSDK;
      for (const p of path.split('.')) { cur = cur?.[p]; if (cur == null) return true; }
      return false;
    };

    const missing = REQUIRED_SDK_APIS.filter(isMissing);
    if (missing.length) {
      console.error('[SL-ROAD] WME SDK missing required APIs:', missing);
      toast(`SL-ROAD: WME SDK is missing ${missing.length} required APIs. See console.`, 'error');
      return false;
    }

    const missingOptional = OPTIONAL_SDK_APIS.filter(isMissing);
    if (missingOptional.length) {
      console.warn('[SL-ROAD] WME SDK missing optional APIs (features degraded):', missingOptional);
    }
    return true;
  }

  // The single entry point, and the one thing the test suite skips.
  if (IN_USERSCRIPT_ENV) {
    (unsafeWindow || window).SDK_INITIALIZED
      .then(() => {
        wmeSDK = getWmeSdk({ scriptId: SCRIPT_ID, scriptName: 'Quick Road Importer (SI)' });
        return wmeSDK.Events.once({ eventName: 'wme-ready' });
      })
      .then(() => {
        if (sdkHasRequiredApis()) init();
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
      missingPieces,
      alignToCadastre,
      findDisconnectedEnds,
      updateEndsList,
      buildItemsUrl,
      buildRoadLines,
      classifyFetchFailure,
      decideFetchRetry,
      fetchRetryDelay
    };
  }
})();
