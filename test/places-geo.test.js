'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pointInAllowedArea, allowedAreaId, coveringTiles } = require('../places-geo.js');

test('Kyiv city and Kotsyubynske are inside and neighbouring towns are outside', () => {
  assert.equal(allowedAreaId(50.4501, 30.5234), 'kyiv');
  assert.equal(pointInAllowedArea(50.464, 30.355), true);
  assert.equal(pointInAllowedArea(50.409, 30.424), true);
  assert.equal(allowedAreaId(50.49, 30.333), 'kotsyubynske');

  assert.equal(pointInAllowedArea(50.521, 30.25), false);
  assert.equal(pointInAllowedArea(50.548, 30.211), false);
  assert.equal(pointInAllowedArea(50.385, 30.37), false);
  assert.equal(pointInAllowedArea(50.41, 30.348), false);
  assert.equal(pointInAllowedArea(50.518, 30.737), false);
});

test('search tiles cover the polygons and are rectangles', () => {
  const tiles = coveringTiles();
  assert.ok(tiles.length > 10);
  assert.ok(tiles.length < 120);
  for (const tile of tiles) {
    assert.ok(tile.south < tile.north);
    assert.ok(tile.west < tile.east);
  }
  const covers = (lat, lng) => tiles.some((tile) => lat >= tile.south && lat <= tile.north && lng >= tile.west && lng <= tile.east);
  assert.equal(covers(50.4501, 30.5234), true);
  assert.equal(covers(50.49, 30.333), true);
});
