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
      coverageFraction
    };
  }
})();
