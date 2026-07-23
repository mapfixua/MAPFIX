'use strict';

/**
 * Places import helpers for Mapfix mockLocations.
 * Sources: OSM Overpass (default), Google Places (optional), CSV/JSON files.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

const CITY_PRESETS = {
  kotsyubynske: {
    id: 'kotsyubynske',
    name: 'смт Коцюбинське',
    // west, south, east, north
    bbox: [30.31, 50.478, 30.355, 50.505],
    center: { lat: 50.4905, lng: 30.3345 },
  },
  kyiv: {
    id: 'kyiv',
    name: 'м. Київ (центр)',
    bbox: [30.48, 50.43, 30.55, 50.47],
    center: { lat: 50.45, lng: 30.52 },
  },
};

/** Mapfix category → OSM Overpass tag filters */
const CATEGORY_OSM_FILTERS = {
  beauty: [
    'shop=beauty',
    'shop=hairdresser',
    'shop=cosmetics',
    'craft=hairdresser',
    'amenity=beauty_salon',
  ],
  auto: [
    'shop=car',
    'shop=car_repair',
    'shop=tyres',
    'amenity=car_wash',
    'amenity=fuel',
    'craft=car_repair',
    'shop=car_parts',
  ],
  repair: [
    'shop=computer',
    'shop=electronics',
    'craft=electronics_repair',
    'shop=mobile_phone',
    'craft=computer',
  ],
  pets: ['shop=pet', 'amenity=veterinary', 'shop=pet_grooming'],
  home: [
    'shop=hardware',
    'shop=doityourself',
    'craft=plumber',
    'craft=electrician',
    'shop=furniture',
  ],
  education: [
    'amenity=school',
    'amenity=kindergarten',
    'amenity=college',
    'amenity=language_school',
  ],
  sport: [
    'leisure=fitness_centre',
    'leisure=sports_centre',
    'leisure=stadium',
    'sport=fitness',
  ],
};

const CATEGORY_SUBCAT_HINTS = {
  beauty: ['nails', 'barber', 'hair'],
  auto: ['tyre', 'wash', 'service'],
  repair: ['phone', 'pc'],
  pets: ['grooming', 'vet'],
  home: ['plumber', 'electric'],
  education: ['school'],
  sport: ['fitness'],
};

function makeLocationId(seed) {
  const hash = crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 8);
  return `loc-imp-${hash}`;
}

function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 && digits.startsWith('0')) return '+38' + digits;
  if (digits.startsWith('380')) return '+' + digits;
  if (digits.startsWith('38')) return '+' + digits;
  return String(raw).trim();
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function resolveCity(cityKeyOrName) {
  const key = String(cityKeyOrName || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  if (CITY_PRESETS[key]) return CITY_PRESETS[key];
  if (key.includes('коцюб') || key.includes('kots')) return CITY_PRESETS.kotsyubynske;
  if (key.includes('київ') || key.includes('kyiv') || key.includes('kiev')) {
    return CITY_PRESETS.kyiv;
  }
  return CITY_PRESETS.kotsyubynske;
}

function buildOverpassQuery(city, category) {
  const filters = CATEGORY_OSM_FILTERS[category] || CATEGORY_OSM_FILTERS.beauty;
  const [w, s, e, n] = city.bbox;
  const clauses = filters
    .map((f) => {
      const [k, v] = f.split('=');
      return `node["${k}"="${v}"](${s},${w},${n},${e});\n    way["${k}"="${v}"](${s},${w},${n},${e});`;
    })
    .join('\n    ');

  return `
[out:json][timeout:60];
(
  ${clauses}
);
out center tags;
`.trim();
}

function osmElementToLocation(el, category) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const title = tags.name || tags['name:uk'] || tags['name:en'] || tags.brand;
  if (!title) return null;

  const phone = normalizePhone(tags.phone || tags['contact:phone'] || tags['phone:mobile'] || '');
  const addressParts = [
    tags['addr:city'] || tags['addr:place'],
    tags['addr:street'],
    tags['addr:housenumber'],
  ].filter(Boolean);

  const osmId = `${el.type}/${el.id}`;
  const subHint = CATEGORY_SUBCAT_HINTS[category] || [];

  return {
    id: makeLocationId(`osm:${osmId}`),
    providerId: null,
    lat: Number(lat),
    lng: Number(lng),
    cat: category,
    title: String(title).trim(),
    text: tags.description || tags.opening_hours || `Імпортовано з OpenStreetMap (${osmId})`,
    rating: 0,
    reviewsCount: 0,
    openStatus: 'open',
    workingHours: tags.opening_hours || '09:00 - 18:00',
    phone,
    address: addressParts.join(', ') || resolveCity('kotsyubynske').name,
    schedule: { 'Пн-Пт': tags.opening_hours || '09:00 - 18:00' },
    subcats: subHint.slice(0, 1),
    prices: {},
    reviews: [],
    importMeta: {
      source: 'osm',
      osmId,
      importedAt: new Date().toISOString(),
    },
  };
}

async function fetchOsmPlaces({ city, category }) {
  const preset = typeof city === 'string' ? resolveCity(city) : city;
  const cat = category && CATEGORY_OSM_FILTERS[category] ? category : 'beauty';
  const query = buildOverpassQuery(preset, cat);

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'MapfixImport/1.0 (https://mapfix-wine.vercel.app; local-dev)',
    },
    body: 'data=' + encodeURIComponent(query),
  });

  if (!res.ok) {
    throw new Error(`Overpass HTTP ${res.status}`);
  }

  const json = await res.json();
  const elements = Array.isArray(json.elements) ? json.elements : [];
  const locations = [];
  const seen = new Set();

  for (const el of elements) {
    const loc = osmElementToLocation(el, cat);
    if (!loc) continue;
    if (seen.has(loc.id)) continue;
    seen.add(loc.id);
    locations.push(loc);
  }

  return { city: preset, category: cat, locations, source: 'osm' };
}

/**
 * Google Places Text Search (New) — requires GOOGLE_PLACES_API_KEY.
 * Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
 */
async function fetchGooglePlaces({ city, category, apiKey }) {
  const key = apiKey || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set');
  }

  const preset = typeof city === 'string' ? resolveCity(city) : city;
  const cat = category && CATEGORY_OSM_FILTERS[category] ? category : 'beauty';
  const catNames = {
    beauty: 'салон краси перукарня манікюр',
    auto: 'СТО шиномонтаж автомийка',
    repair: 'ремонт телефонів компʼютерів',
    pets: 'ветклініка грумінг зоомагазин',
    home: 'сантехнік електрик будівельні послуги',
    education: 'школа курси репетитор',
    sport: 'спортзал фітнес',
  };

  const textQuery = `${catNames[cat] || cat} ${preset.name}`;
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.rating,places.userRatingCount,places.regularOpeningHours',
    },
    body: JSON.stringify({
      textQuery,
      locationBias: {
        circle: {
          center: {
            latitude: preset.center.lat,
            longitude: preset.center.lng,
          },
          radius: 3500,
        },
      },
      languageCode: 'uk',
      regionCode: 'UA',
      maxResultCount: 20,
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error?.message || `Places API HTTP ${res.status}`);
  }

  const places = Array.isArray(json.places) ? json.places : [];
  const locations = places
    .map((p) => {
      const lat = p.location?.latitude;
      const lng = p.location?.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const title = p.displayName?.text;
      if (!title) return null;
      const placeId = p.id || title + lat + lng;
      return {
        id: makeLocationId(`ggl:${placeId}`),
        providerId: null,
        lat,
        lng,
        cat,
        title: String(title).trim(),
        text: 'Імпортовано з Google Places',
        rating: Number(p.rating) || 0,
        reviewsCount: Number(p.userRatingCount) || 0,
        openStatus: 'open',
        workingHours: '09:00 - 18:00',
        phone: normalizePhone(p.nationalPhoneNumber || ''),
        address: p.formattedAddress || preset.name,
        schedule: { 'Пн-Пт': '09:00 - 18:00' },
        subcats: (CATEGORY_SUBCAT_HINTS[cat] || []).slice(0, 1),
        prices: {},
        reviews: [],
        importMeta: {
          source: 'google_places',
          placeId,
          importedAt: new Date().toISOString(),
        },
      };
    })
    .filter(Boolean);

  return { city: preset, category: cat, locations, source: 'google_places' };
}

function parseCsv(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(/[,;]/).map((h) => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(/[,;]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] || '';
    });
    rows.push(row);
  }
  return rows;
}

function csvRowToLocation(row, defaultCategory) {
  const lat = Number(row.lat || row.latitude);
  const lng = Number(row.lng || row.lon || row.longitude);
  const title = row.title || row.name || row.назва;
  if (!title || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const cat = row.cat || row.category || defaultCategory || 'beauty';
  return {
    id: makeLocationId(`csv:${title}:${lat}:${lng}`),
    providerId: null,
    lat,
    lng,
    cat,
    title: String(title).trim(),
    text: row.text || row.description || 'Імпортовано з CSV',
    rating: Number(row.rating) || 0,
    reviewsCount: Number(row.reviewscount || row.reviews_count) || 0,
    openStatus: 'open',
    workingHours: row.workinghours || row.hours || '09:00 - 18:00',
    phone: normalizePhone(row.phone || row.телефон || ''),
    address: row.address || row.адреса || '',
    schedule: { 'Пн-Пт': row.workinghours || '09:00 - 18:00' },
    subcats: row.subcats ? String(row.subcats).split('|').filter(Boolean) : [],
    prices: {},
    reviews: [],
    importMeta: {
      source: 'csv',
      importedAt: new Date().toISOString(),
    },
  };
}

function loadLocationsFromFile(filePath, defaultCategory) {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  if (abs.endsWith('.json')) {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.locations || parsed.mockLocations || [];
    return list
      .map((item) => {
        if (item.lat && item.title) {
          return {
            ...csvRowToLocation(
              {
                ...item,
                title: item.title,
                lat: item.lat,
                lng: item.lng,
                phone: item.phone,
                address: item.address,
                rating: item.rating,
                cat: item.cat || defaultCategory,
              },
              defaultCategory
            ),
            ...item,
            id: item.id || makeLocationId(`json:${item.title}:${item.lat}:${item.lng}`),
            providerId: item.providerId ?? null,
            importMeta: item.importMeta || {
              source: 'json',
              importedAt: new Date().toISOString(),
            },
          };
        }
        return csvRowToLocation(item, defaultCategory);
      })
      .filter(Boolean);
  }
  return parseCsv(raw)
    .map((row) => csvRowToLocation(row, defaultCategory))
    .filter(Boolean);
}

/**
 * Merge imported locations into existing mockLocations.
 * Dedupes by id, same title within 80m, or same phone.
 */
function mergeLocations(existing, incoming, { updateExisting = false } = {}) {
  const result = existing.map((l) => ({ ...l }));
  const added = [];
  const skipped = [];
  const updated = [];

  for (const loc of incoming) {
    const byId = result.findIndex((x) => x.id === loc.id);
    if (byId >= 0) {
      if (updateExisting) {
        result[byId] = { ...result[byId], ...loc, id: result[byId].id };
        updated.push(loc.id);
      } else {
        skipped.push({ id: loc.id, reason: 'duplicate_id' });
      }
      continue;
    }

    const phone = normalizePhone(loc.phone);
    const dup = result.find((x) => {
      if (phone && normalizePhone(x.phone) === phone) return true;
      if (
        String(x.title).toLowerCase() === String(loc.title).toLowerCase() &&
        haversineMeters(x, loc) < 80
      ) {
        return true;
      }
      return false;
    });

    if (dup) {
      skipped.push({ id: loc.id, reason: 'near_duplicate', existingId: dup.id });
      continue;
    }

    // Strip importMeta from persisted object if you want cleaner data.json — keep it for audit
    const { importMeta, ...rest } = loc;
    result.push({ ...rest, importSource: importMeta?.source || 'import' });
    added.push(loc.id);
  }

  return { locations: result, added, skipped, updated };
}

module.exports = {
  CITY_PRESETS,
  CATEGORY_OSM_FILTERS,
  resolveCity,
  fetchOsmPlaces,
  fetchGooglePlaces,
  loadLocationsFromFile,
  mergeLocations,
  parseCsv,
  csvRowToLocation,
  normalizePhone,
};
