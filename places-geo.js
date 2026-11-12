'use strict';

const fs = require('fs');
const path = require('path');

const GEOJSON_PATH = path.join(__dirname, 'geo', 'kyiv-kotsyubynske.geojson');

let cached = null;

function loadAllowedAreas() {
  if (cached) return cached;
  const raw = JSON.parse(fs.readFileSync(GEOJSON_PATH, 'utf8'));
  const features = (raw.features || []).filter((f) => f && f.geometry && f.properties);
  cached = { path: GEOJSON_PATH, features };
  return cached;
}

function resetAllowedAreasCache() {
  cached = null;
}

/** Ray cast. Ring is an array of [lng, lat]. */
function pointInRing(lng, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);
    const intersect =
      (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates || [];
  return [];
}

function pointInGeometry(lat, lng, geometry) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  for (const poly of polygonsOf(geometry)) {
    if (!poly || !poly.length) continue;
    if (!pointInRing(lo, la, poly[0])) continue;
    const inHole = poly.slice(1).some((hole) => pointInRing(lo, la, hole));
    if (!inHole) return true;
  }
  return false;
}

/**
 * Official allowed area: Kyiv city polygon OR смт Коцюбинське.
 * Points in Ірпінь, Буча, Вишневе, Борщагівка outside the city, etc. are false.
 */
function pointInAllowedArea(lat, lng, areas = loadAllowedAreas()) {
  return areas.features.some((feature) => pointInGeometry(lat, lng, feature.geometry));
}

function allowedAreaId(lat, lng, areas = loadAllowedAreas()) {
  const hit = areas.features.find((feature) => pointInGeometry(lat, lng, feature.geometry));
  return hit ? hit.properties.id : null;
}

function eachRing(areas, visit) {
  for (const feature of areas.features) {
    for (const poly of polygonsOf(feature.geometry)) {
      for (const ring of poly) visit(ring);
    }
  }
}

function areaBounds(areas = loadAllowedAreas()) {
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  eachRing(areas, (ring) => {
    for (const pair of ring) {
      const lng = Number(pair[0]);
      const lat = Number(pair[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
    }
  });
  return { south, west, north, east };
}

function segmentIntersectsRect(ax, ay, bx, by, rect) {
  const { south, west, north, east } = rect;
  function inside(x, y) {
    return x >= west && x <= east && y >= south && y <= north;
  }
  if (inside(ax, ay) || inside(bx, by)) return true;
  function cross(x1, y1, x2, y2, x3, y3, x4, y4) {
    const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (d === 0) return false;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
    const u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  }
  const edges = [
    [west, south, east, south],
    [east, south, east, north],
    [east, north, west, north],
    [west, north, west, south],
  ];
  return edges.some(([x3, y3, x4, y4]) => cross(ax, ay, bx, by, x3, y3, x4, y4));
}

function rectIntersectsGeometry(rect, geometry) {
  const { south, west, north, east } = rect;
  const samples = [
    [(west + east) / 2, (south + north) / 2],
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [(west + east) / 2, south],
    [(west + east) / 2, north],
    [west, (south + north) / 2],
    [east, (south + north) / 2],
  ];
  if (samples.some(([lng, lat]) => pointInGeometry(lat, lng, geometry))) return true;
  for (const poly of polygonsOf(geometry)) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const ax = Number(a[0]);
        const ay = Number(a[1]);
        const bx = Number(b[0]);
        const by = Number(b[1]);
        if (ay >= south && ay <= north && ax >= west && ax <= east) return true;
        if (segmentIntersectsRect(ax, ay, bx, by, rect)) return true;
      }
    }
  }
  return false;
}

/**
 * Rectangles that cover the allowed polygons for Places Text Search
 * locationRestriction. Anything the rectangle still includes outside the
 * polygon is rejected later by pointInAllowedArea.
 */
function coveringTiles({ stepLat = 0.05, stepLng = 0.08, areas = loadAllowedAreas() } = {}) {
  const bounds = areaBounds(areas);
  const tiles = [];
  const latStep = Math.max(0.01, Number(stepLat) || 0.05);
  const lngStep = Math.max(0.01, Number(stepLng) || 0.08);
  for (let lat = bounds.south; lat < bounds.north - 1e-12; lat += latStep) {
    const south = lat;
    const north = Math.min(bounds.north, lat + latStep);
    for (let lng = bounds.west; lng < bounds.east - 1e-12; lng += lngStep) {
      const rect = {
        south,
        west: lng,
        north,
        east: Math.min(bounds.east, lng + lngStep),
      };
      const hits = areas.features.some((feature) => rectIntersectsGeometry(rect, feature.geometry));
      if (hits) tiles.push(rect);
    }
  }
  return tiles;
}

module.exports = {
  GEOJSON_PATH,
  loadAllowedAreas,
  resetAllowedAreasCache,
  pointInRing,
  pointInGeometry,
  pointInAllowedArea,
  allowedAreaId,
  areaBounds,
  coveringTiles,
};
