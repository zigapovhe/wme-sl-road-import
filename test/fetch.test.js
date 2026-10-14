'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildItemsUrl } = require('../wme-sl-road-import.user.js');

test('the request asks for one page of the view', () => {
  assert.strictEqual(
    buildItemsUrl({ minLon: 14.5, minLat: 46, maxLon: 14.6, maxLat: 46.1 }, 2000),
    'https://ipi.eprostor.gov.si/wfs-si-gurs-kgi/ogc/features/collections/SI.GURS.KGI:LINIJE_CESTE_G/items'
      + '?f=application/json&limit=1000&startIndex=2000&bbox=14.5,46,14.6,46.1'
  );
});

test('the first page starts at zero', () => {
  assert.match(buildItemsUrl({ minLon: 1, minLat: 2, maxLon: 3, maxLat: 4 }, 0), /&startIndex=0&bbox=1,2,3,4$/);
});
