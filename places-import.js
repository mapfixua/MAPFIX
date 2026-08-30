'use strict';

/**
 * Places import helpers for Mapfix mockLocations.
 * Sources: OSM Overpass (default), Google Places (optional), CSV/JSON files.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

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
    'leisure=spa',
    'shop=massage',
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
    'shop=laundry',
    'craft=shoemaker',
    'craft=tailor',
    'craft=key_cutter',
  ],
  pets: ['shop=pet', 'amenity=veterinary', 'shop=pet_grooming'],
  home: [
    'shop=hardware',
    'shop=doityourself',
    'craft=plumber',
    'craft=electrician',
    'shop=furniture',
    'craft=painter',
    'shop=locksmith',
  ],
  education: [
    'amenity=school',
    'amenity=kindergarten',
    'amenity=college',
    'amenity=language_school',
    'amenity=driving_school',
    'amenity=music_school',
  ],
  sport: [
    'leisure=fitness_centre',
    'leisure=sports_centre',
    'leisure=stadium',
    'sport=fitness',
    'leisure=swimming_pool',
    'leisure=sports_hall',
  ],
  rental: [
    'shop=rental',
    'amenity=car_rental',
    'shop=car_rental',
    'office=rental',
    'shop=tool_hire',
    'shop=hardware',
    'tourism=apartment',
    'tourism=chalet',
    'tourism=guest_house',
  ],
  medical: [
    'amenity=doctors',
    'amenity=clinic',
    'amenity=hospital',
    'amenity=dentist',
    'healthcare=doctor',
    'healthcare=dentist',
    'healthcare=physiotherapist',
    'healthcare=laboratory',
    'healthcare=psychotherapist',
    'amenity=pharmacy',
    'leisure=spa',
  ],
  food: [
    'shop=bakery',
    'shop=confectionery',
    'shop=pastry',
    'craft=confectionery',
    'amenity=cafe',
    'amenity=fast_food',
    'shop=chocolate',
    'shop=deli',
    'cuisine=cake',
  ],
  furniture: [
    'shop=furniture',
    'craft=carpenter',
    'craft=cabinet_maker',
    'shop=kitchen',
    'shop=bed',
    'shop=interior_decoration',
    'craft=joiner',
  ],
};

const CATEGORY_SUBCAT_HINTS = {
  beauty: ['nails', 'barber', 'hair', 'massage', 'cosmetology'],
  auto: ['tyre', 'wash', 'service', 'auto_repair'],
  repair: ['phone', 'pc', 'shoes', 'appliances'],
  pets: ['grooming', 'vet'],
  home: ['plumber', 'electric', 'cleaning'],
  education: ['school', 'languages', 'tutoring'],
  sport: ['fitness', 'swimming', 'martial'],
  rental: ['housing', 'tools', 'vehicles', 'equipment', 'spaces'],
  medical: ['dentistry', 'therapy', 'diagnostics', 'physiotherapy'],
  food: ['cakes', 'bakery', 'lunch_delivery', 'catering', 'chocolate'],
  furniture: ['custom_furniture', 'assembly', 'kitchen', 'wardrobes', 'upholstery'],
};

function makeLocationId(seed) {
  const hash = crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 8);
  return `loc-imp-${hash}`;
}

const { normalizePhone: normalizePhoneAuth } = require('./telegram-auth.js');

function normalizePhone(raw) {
  return normalizePhoneAuth(raw);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REGION_MIN_SIDE_METERS = 120;
const REGION_MAX_SIDE_METERS = 40000;

function stripCatalogLabel(value) {
  return String(value || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[✂️🚗🛠️🐾🏠🎓⚽🔑💄🪑]/gu, '')
    .trim();
}

function normalizeRegionBounds(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Виділіть область на карті');
  }
  let south = Number(raw.south ?? raw.minLat ?? raw.sw?.lat);
  let north = Number(raw.north ?? raw.maxLat ?? raw.ne?.lat);
  let west = Number(raw.west ?? raw.minLng ?? raw.sw?.lng);
  let east = Number(raw.east ?? raw.maxLng ?? raw.ne?.lng);
  if (![south, north, west, east].every(Number.isFinite)) {
    throw new Error('Некоректні межі області');
  }
  if (south > north) [south, north] = [north, south];
  if (west > east) [west, east] = [east, west];
  if (south < 43.5 || north > 53.5 || west < 21.5 || east > 41.5) {
    throw new Error('Область має бути в межах України');
  }

  const sw = { lat: south, lng: west };
  const se = { lat: south, lng: east };
  const nw = { lat: north, lng: west };
  const width = haversineMeters(sw, se);
  const height = haversineMeters(sw, nw);
  if (width < REGION_MIN_SIDE_METERS || height < REGION_MIN_SIDE_METERS) {
    throw new Error('Область занадто мала — збільшіть прямокутник');
  }
  if (width > REGION_MAX_SIDE_METERS || height > REGION_MAX_SIDE_METERS) {
    throw new Error('Область занадто велика (макс. ~40 км по стороні). Зменшіть виділення');
  }

  return {
    south,
    west,
    north,
    east,
    center: { lat: (south + north) / 2, lng: (west + east) / 2 },
    radiusMeters: Math.max(width, height) / 2,
    bbox: [west, south, east, north],
    widthMeters: Math.round(width),
    heightMeters: Math.round(height),
    label: 'Виділена область',
  };
}

function pointInRegion(lat, lng, region) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || !region) return false;
  return la >= region.south && la <= region.north && lo >= region.west && lo <= region.east;
}

function boundsFromCity(city) {
  try {
    if (city?.bbox && city.bbox.length === 4) {
      const [west, south, east, north] = city.bbox.map(Number);
      return normalizeRegionBounds({ south, west, north, east });
    }
  } catch (_) {
    // Whole-city bbox can exceed Places 40 km cap — fall back to a cap around center.
  }
  const lat = Number(city?.center?.lat);
  const lng = Number(city?.center?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('У міста немає меж для пошуку');
  }
  const radius = Math.min(Math.max(Number(city?.radiusMeters) || 8000, 2500), 18000);
  const dLat = radius / 111320;
  const dLng = radius / (111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return normalizeRegionBounds({
    south: lat - dLat,
    north: lat + dLat,
    west: lng - dLng,
    east: lng + dLng,
  });
}

function pricesFromCatalogServices(masterCatalog, catKey, subKey, serviceNames) {
  const items = masterCatalog?.[catKey]?.subcats?.[subKey]?.items || [];
  const wanted = new Set(
    (Array.isArray(serviceNames) ? serviceNames : [])
      .map((s) => String(s || '').trim())
      .filter(Boolean)
  );
  const prices = {};
  for (const item of items) {
    if (!item?.name || !wanted.has(item.name)) continue;
    prices[item.name] = item.price || 'за домовленістю';
  }
  return prices;
}

function citySlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9а-яіїєґ\-]+/gi, '')
    .slice(0, 48) || 'city';
}

/**
 * Resolve any Ukrainian city/town via Nominatim (or known presets).
 */
async function geocodeCityUkraine(cityName) {
  const raw = String(cityName || '').trim();
  if (raw.length < 2) throw new Error('Вкажіть місто або смт України');

  const key = raw.toLowerCase().replace(/\s+/g, '');
  if (CITY_PRESETS[key]) return { ...CITY_PRESETS[key], radiusMeters: 4500, source: 'preset' };
  if (key.includes('коцюб') || key.includes('kots')) {
    return { ...CITY_PRESETS.kotsyubynske, radiusMeters: 3500, source: 'preset' };
  }

  const url =
    'https://nominatim.openstreetmap.org/search?' +
    new URLSearchParams({
      q: `${raw}, Україна`,
      format: 'json',
      limit: '1',
      countrycodes: 'ua',
      addressdetails: '1',
    }).toString();

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'MapfixCityImport/1.0 (admin import; contact@mapfix.local)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Геокодування міста не вдалося (HTTP ${res.status})`);
  const json = await res.json();
  const hit = Array.isArray(json) ? json[0] : null;
  if (!hit) throw new Error(`Місто «${raw}» не знайдено в Україні. Уточніть назву.`);

  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('Геокодер повернув некоректні координати');
  }

  const bb = Array.isArray(hit.boundingbox) ? hit.boundingbox.map(Number) : null;
  // Nominatim bbox: [south, north, west, east]
  let bbox;
  let radiusMeters = 8000;
  if (bb && bb.length === 4 && bb.every(Number.isFinite)) {
    const [south, north, west, east] = bb;
    bbox = [west, south, east, north];
    const diag = haversineMeters({ lat: south, lng: west }, { lat: north, lng: east });
    radiusMeters = Math.max(3000, Math.min(22000, Math.round(diag / 2)));
  } else {
    const d = 0.04;
    bbox = [lng - d, lat - d, lng + d, lat + d];
  }

  const display =
    hit.namedetails?.name ||
    hit.display_name?.split(',')[0] ||
    raw;

  return {
    id: citySlug(display),
    name: String(display).trim(),
    center: { lat, lng },
    bbox,
    radiusMeters,
    source: 'nominatim',
    displayName: hit.display_name || display,
  };
}

function buildCatalogSearchQueries(masterCatalog) {
  const queries = [];
  for (const [catKey, cat] of Object.entries(masterCatalog || {})) {
    const catLabel = stripCatalogLabel(cat.name || catKey);
    for (const [subKey, sub] of Object.entries(cat.subcats || {})) {
      const tag = Array.isArray(sub.tags) && sub.tags[0] ? sub.tags[0] : '';
      const label = stripCatalogLabel(sub.name || subKey);
      const serviceNames = (sub.items || [])
        .map((item) => stripCatalogLabel(item?.name || ''))
        .filter(Boolean)
        .slice(0, 3);
      queries.push({
        catKey,
        subKey,
        queryCore: [label || catLabel, tag, ...serviceNames.slice(0, 2)].filter(Boolean).join(' '),
      });
    }
  }
  return queries;
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
[out:json][timeout:25];
(
  ${clauses}
);
out center tags qt;
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

  // Public Overpass instances can temporarily return 429/502/504.
  // Ask several independent mirrors in parallel and use the first valid response.
  const controllers = OVERPASS_URLS.map(() => new AbortController());
  const requestOne = async (url, index) => {
    const controller = controllers[index];
    const timer = setTimeout(() => controller.abort(), 22000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': 'MapfixImport/1.0 (https://mapfix-wine.vercel.app)',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${new URL(url).hostname}: HTTP ${res.status}`);
      const json = await res.json();
      if (!json || !Array.isArray(json.elements)) {
        throw new Error(`${new URL(url).hostname}: некоректна відповідь`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  };

  let json;
  try {
    json = await Promise.any(OVERPASS_URLS.map(requestOne));
  } catch (err) {
    const details = (err?.errors || [])
      .map((item) => item?.message)
      .filter(Boolean)
      .join('; ');
    throw new Error(
      'Сервіси OpenStreetMap тимчасово перевантажені. Повторіть перевірку через 1–2 хвилини' +
        (details ? ` (${details})` : '')
    );
  } finally {
    controllers.forEach((controller) => controller.abort());
  }
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
    beauty: 'салон краси перукарня манікюр косметологія масаж',
    auto: 'СТО шиномонтаж автомийка евакуатор',
    repair: 'ремонт телефонів компʼютерів взуття ательє ключі',
    pets: 'ветклініка грумінг зооготель дресирування',
    home: 'сантехнік електрик клінінг кондиціонери',
    education: 'школа курси репетитор автошкола танці',
    sport: 'спортзал фітнес басейн єдиноборства',
    rental: 'оренда житла квартира будинок подобово прокат інструментів авто обладнання',
    medical: 'стоматологія клініка терапевт аналізи фізіотерапія психолог',
    food: 'торт кондитерська випічка пекарня кейтеринг зефір домашні напівфабрикати доставка обідів',
    furniture: 'меблі на замовлення шафа-купе кухня збирання меблів столяр перетяжка диванів',
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
      const weekdayDescriptions = Array.isArray(p.regularOpeningHours?.weekdayDescriptions)
        ? p.regularOpeningHours.weekdayDescriptions
        : [];
      const schedule = mapGoogleSchedule(weekdayDescriptions);
      const hasSchedule = Object.keys(schedule).length > 0;
      const workingHours = hasSchedule
        ? weekdayDescriptions.join('; ')
        : '09:00 - 18:00';
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
        workingHours,
        phone: normalizePhone(p.nationalPhoneNumber || ''),
        address: p.formattedAddress || preset.name,
        schedule: hasSchedule ? schedule : { 'Пн-Пт': '09:00 - 18:00' },
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

  const hours =
    row.working_hours ||
    row.workinghours ||
    row.hours ||
    row.графік ||
    row.график ||
    '09:00 - 18:00';
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
    workingHours: hours,
    phone: normalizePhone(row.phone || row.телефон || ''),
    address: row.address || row.адреса || '',
    schedule: { Графік: hours },
    subcats: row.subcats ? String(row.subcats).split('|').filter(Boolean) : [],
    prices: {},
    reviews: [],
    importMeta: {
      source: 'csv',
      importedAt: new Date().toISOString(),
    },
  };
}

function normalizeImportRow(row) {
  const out = {};
  Object.entries(row || {}).forEach(([key, value]) => {
    const k = String(key || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^\wа-яіїєґ]+/gi, '_');
    out[k] = typeof value === 'string' ? value.trim() : value;
  });
  // Common aliases
  if (out.maps_url || out.google_maps_url || out.url || out.link || out.посилання) {
    out.maps_url = out.maps_url || out.google_maps_url || out.url || out.link || out.посилання;
  }
  if (out.working_hours || out.workinghours || out.hours || out.графік || out.график) {
    out.working_hours =
      out.working_hours || out.workinghours || out.hours || out.графік || out.график;
  }
  return out;
}

async function importExcelRowsToLocations(rows, { defaultCategory, providerId } = {}) {
  const locations = [];
  const errors = [];
  for (let i = 0; i < (rows || []).length; i++) {
    const row = normalizeImportRow(rows[i]);
    try {
      let loc = null;
      const mapsUrl = String(row.maps_url || '').trim();
      if (mapsUrl) {
        const { place } = await importPlaceFromGoogleMapsUrl({ url: mapsUrl });
        loc = googlePlaceToLocation(place, {
          providerId: providerId || null,
          cat: row.cat || row.category || defaultCategory || 'home',
        });
        if (row.title) loc.title = String(row.title).trim();
        if (row.address) loc.address = String(row.address).trim();
        if (row.phone) loc.phone = normalizePhone(row.phone);
        if (row.working_hours) {
          loc.workingHours = String(row.working_hours).trim();
          loc.schedule = { Графік: loc.workingHours };
        }
        loc.importSource = 'excel_maps_url';
        loc.importMeta = {
          ...(loc.importMeta || {}),
          source: 'excel_maps_url',
          mapsUrl,
          row: i + 1,
        };
      } else {
        loc = csvRowToLocation(row, defaultCategory);
        if (loc) {
          loc.providerId = providerId || null;
          loc.importSource = 'excel';
        }
      }
      if (!loc) {
        errors.push({ row: i + 1, error: 'Немає назви/координат або Google Maps посилання' });
        continue;
      }
      if (row.status === 'closed' || row.openstatus === 'closed') loc.openStatus = 'closed';
      locations.push(loc);
    } catch (err) {
      errors.push({ row: i + 1, error: err.message || 'Помилка рядка' });
    }
  }
  return { locations, errors };
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

async function searchGooglePlacesText({
  query,
  apiKey,
  lat,
  lng,
  bounds,
  maxResultCount = 8,
  radiusMeters,
} = {}) {
  const key = apiKey || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is not set');
  const q = String(query || '').trim();
  if (q.length < 2) throw new Error('Вкажіть назву або адресу місця');

  const body = {
    textQuery: q,
    languageCode: 'uk',
    regionCode: 'UA',
    maxResultCount: Math.min(20, Math.max(1, Number(maxResultCount) || 8)),
  };
  if (bounds && Number.isFinite(bounds.south) && Number.isFinite(bounds.west)) {
    body.locationRestriction = {
      rectangle: {
        low: { latitude: bounds.south, longitude: bounds.west },
        high: { latitude: bounds.north, longitude: bounds.east },
      },
    };
  } else if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const radius = Math.min(50000, Math.max(50, Number(radiusMeters) || 25000));
    body.locationBias = {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius,
      },
    };
  }

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.rating,places.userRatingCount,places.types,places.editorialSummary,places.googleMapsUri',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error?.message || `Places API HTTP ${res.status}`);
  }

  return (Array.isArray(json.places) ? json.places : [])
    .map((p) => {
      const plat = p.location?.latitude;
      const plng = p.location?.longitude;
      if (!Number.isFinite(plat) || !Number.isFinite(plng)) return null;
      const title = p.displayName?.text;
      if (!title) return null;
      return {
        placeId: p.id,
        title: String(title).trim(),
        address: p.formattedAddress || '',
        phone: normalizePhone(p.nationalPhoneNumber || ''),
        lat: plat,
        lng: plng,
        rating: Number(p.rating) || 0,
        reviewsCount: Number(p.userRatingCount) || 0,
        types: Array.isArray(p.types) ? p.types : [],
        summary: p.editorialSummary?.text || '',
        mapsUrl: p.googleMapsUri || '',
      };
    })
    .filter(Boolean);
}

function mapGoogleReviews(reviews) {
  if (!Array.isArray(reviews)) return [];
  return reviews
    .slice(0, 8)
    .map((rev) => {
      const rating = Math.max(1, Math.min(5, Number(rev.rating) || 5));
      const text = String(rev.text?.text || rev.originalText?.text || '').trim();
      const author = rev.authorAttribution?.displayName || 'Google';
      const relative = rev.relativePublishTimeDescription || '';
      return {
        rating,
        text: text || 'Відгук з Google Maps',
        author,
        date: relative || new Date().toISOString().slice(0, 10),
        source: 'google_maps',
      };
    })
    .filter((r) => r.text);
}

const GOOGLE_DAY_TO_SHORT = {
  monday: 'Пн',
  tuesday: 'Вт',
  wednesday: 'Ср',
  thursday: 'Чт',
  friday: 'Пт',
  saturday: 'Сб',
  sunday: 'Нд',
  понеділок: 'Пн',
  вівторок: 'Вт',
  середа: 'Ср',
  четвер: 'Чт',
  "п'ятниця": 'Пт',
  "пʼятниця": 'Пт',
  пятниця: 'Пт',
  субота: 'Сб',
  неділя: 'Нд',
  пн: 'Пн',
  вт: 'Вт',
  ср: 'Ср',
  чт: 'Чт',
  пт: 'Пт',
  сб: 'Сб',
  нд: 'Нд',
};

function normalizeScheduleDayLabel(raw) {
  const key = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return GOOGLE_DAY_TO_SHORT[key] || String(raw || '').trim();
}

function mapGoogleSchedule(weekdayDescriptions) {
  if (!Array.isArray(weekdayDescriptions)) return {};
  return weekdayDescriptions.reduce((schedule, rawLine) => {
    const line = String(rawLine || '').trim();
    const separator = line.indexOf(':');
    if (separator <= 0) return schedule;
    const day = normalizeScheduleDayLabel(line.slice(0, separator));
    let hours = line.slice(separator + 1).trim();
    if (!day || !hours) return schedule;
    if (/closed|вихідн|зачинен/i.test(hours)) hours = 'Вихідний';
    hours = hours.replace(/[–—]/g, '-').replace(/\s*-\s*/g, ' - ');
    schedule[day] = hours;
    return schedule;
  }, {});
}

async function fetchGooglePlaceDetails({ placeId, apiKey }) {
  const key = apiKey || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is not set');
  let id = String(placeId || '').trim();
  if (!id) throw new Error('placeId is required');
  if (id.startsWith('places/')) id = id.slice('places/'.length);

  const res = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?languageCode=uk`,
    {
    headers: {
      'X-Goog-Api-Key': key,
      'Accept-Language': 'uk',
      'X-Goog-FieldMask':
        'id,displayName,formattedAddress,location,nationalPhoneNumber,internationalPhoneNumber,rating,userRatingCount,regularOpeningHours,websiteUri,googleMapsUri,types,editorialSummary,reviews',
    },
    }
  );
  const p = await res.json();
  if (!res.ok) {
    throw new Error(p?.error?.message || `Places API HTTP ${res.status}`);
  }

  const lat = p.location?.latitude;
  const lng = p.location?.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('У місця немає координат');
  }

  const weekdayDescriptions = Array.isArray(p.regularOpeningHours?.weekdayDescriptions)
    ? p.regularOpeningHours.weekdayDescriptions
    : [];
  const schedule = mapGoogleSchedule(weekdayDescriptions);
  const hours = weekdayDescriptions.join('; ');

  const summary = p.editorialSummary?.text || '';
  const types = Array.isArray(p.types) ? p.types : [];
  const reviews = mapGoogleReviews(p.reviews);

  return {
    placeId: p.id || id,
    title: String(p.displayName?.text || '').trim(),
    address: p.formattedAddress || '',
    phone: normalizePhone(p.nationalPhoneNumber || p.internationalPhoneNumber || ''),
    lat,
    lng,
    rating: Number(p.rating) || 0,
    reviewsCount: Number(p.userRatingCount) || reviews.length || 0,
    workingHours: hours,
    schedule,
    website: p.websiteUri || '',
    mapsUrl: p.googleMapsUri || '',
    types,
    summary,
    reviews,
    text:
      summary ||
      (types.length ? `Тип: ${types.slice(0, 4).join(', ')}` : 'Імпортовано з Google Maps'),
  };
}

const BULK_GOOGLE_IMPORT_SOURCES = new Set(['city_gemini', 'region_gemini', 'google_places']);

function foldPlaceTitle(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-zа-яіїєґё0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasGoogleReviewTexts(loc) {
  return (Array.isArray(loc?.reviews) ? loc.reviews : []).some(
    (r) => r && r.source === 'google_maps' && String(r.text || '').trim()
  );
}

function locationNeedsGoogleReviews(loc) {
  if (!loc || loc.deletedAt) return false;
  if (hasGoogleReviewTexts(loc)) return false;
  const src = String(loc.importSource || loc.importMeta?.source || '');
  if (BULK_GOOGLE_IMPORT_SOURCES.has(src)) return true;
  if (src === 'google_maps_url' || src === 'telegram_ads') return false;
  if (String(loc.id || '').startsWith('loc-imp-')) return true;
  return Number(loc.reviewsCount) > 0 && !(Array.isArray(loc.reviews) && loc.reviews.length);
}

function storedGooglePlaceId(loc) {
  const raw = String(loc?.importMeta?.placeId || loc?.googlePlaceId || '').trim();
  if (!raw || raw.includes('|') || raw.startsWith('osm:')) return '';
  if (/^places\//.test(raw)) return raw.slice('places/'.length);
  if (raw.length < 10) return '';
  return raw;
}

function scoreGooglePlaceCandidate(loc, place) {
  const dist = haversineMeters(
    { lat: Number(loc.lat), lng: Number(loc.lng) },
    { lat: Number(place.lat), lng: Number(place.lng) }
  );
  if (!Number.isFinite(dist) || dist > 450) return -1;
  const tLoc = foldPlaceTitle(loc.title);
  const tPlace = foldPlaceTitle(place.title);
  let score = 0;
  if (tLoc && tPlace) {
    if (tLoc === tPlace) score += 80;
    else if (tLoc.includes(tPlace) || tPlace.includes(tLoc)) score += 55;
    else {
      const a = new Set(tLoc.split(' ').filter((w) => w.length > 2));
      const b = new Set(tPlace.split(' ').filter((w) => w.length > 2));
      let hit = 0;
      for (const w of a) if (b.has(w)) hit += 1;
      const den = Math.max(1, Math.min(a.size, b.size));
      score += (hit / den) * 40;
    }
  }
  const locPhone = normalizePhone(loc.phone || '');
  const placePhone = normalizePhone(place.phone || '');
  if (locPhone && placePhone && locPhone === placePhone) score += 50;
  score += Math.max(0, 25 - dist / 18);
  return score;
}

function applyGoogleDetailsToLocation(loc, details) {
  const native = (Array.isArray(loc.reviews) ? loc.reviews : []).filter(
    (r) => r && r.source !== 'google_maps'
  );
  const google = Array.isArray(details.reviews) ? details.reviews : [];
  loc.reviews = [...google, ...native].slice(0, 40);
  if (Number(details.rating) > 0) loc.rating = details.rating;
  if (Number(details.reviewsCount) > 0) loc.reviewsCount = details.reviewsCount;
  else if (google.length && !Number(loc.reviewsCount)) loc.reviewsCount = google.length;
  if (details.phone && !loc.phone) loc.phone = details.phone;
  if (details.address && !loc.address) loc.address = details.address;
  if (details.workingHours && !loc.workingHours) loc.workingHours = details.workingHours;
  if (details.schedule && Object.keys(details.schedule).length) {
    if (!loc.schedule || !Object.keys(loc.schedule).length) loc.schedule = details.schedule;
  }
  if (!loc.importMeta || typeof loc.importMeta !== 'object') loc.importMeta = {};
  if (details.placeId) {
    loc.importMeta.placeId = details.placeId;
    loc.googlePlaceId = details.placeId;
  }
  if (details.mapsUrl) loc.importMeta.mapsUrl = details.mapsUrl;
  return loc;
}

async function resolveGooglePlaceIdForLocation(loc, apiKey) {
  const stored = storedGooglePlaceId(loc);
  if (stored) return stored;
  const query = [loc.title, loc.address].filter(Boolean).join(', ');
  if (query.length < 2) return '';
  const found = await searchGooglePlacesText({
    query,
    apiKey,
    lat: loc.lat,
    lng: loc.lng,
    maxResultCount: 8,
    radiusMeters: 800,
  });
  let best = null;
  let bestScore = 42;
  for (const place of found) {
    const score = scoreGooglePlaceCandidate(loc, place);
    if (score > bestScore) {
      bestScore = score;
      best = place;
    }
  }
  return best?.placeId || '';
}

async function enrichLocationGoogleReviews(loc, { apiKey, force = false } = {}) {
  if (!loc) return { ok: false, skipped: true, reason: 'missing' };
  if (loc.deletedAt) return { ok: false, skipped: true, reason: 'trashed' };
  if (!force && hasGoogleReviewTexts(loc)) {
    return { ok: true, skipped: true, reason: 'already_has_reviews' };
  }
  try {
    const placeId = await resolveGooglePlaceIdForLocation(loc, apiKey);
    if (!placeId) return { ok: false, skipped: true, reason: 'place_not_found' };
    const details = await fetchGooglePlaceDetails({ placeId, apiKey });
    applyGoogleDetailsToLocation(loc, details);
    return {
      ok: true,
      skipped: false,
      placeId,
      reviewCount: (details.reviews || []).length,
      reviewsCount: loc.reviewsCount || 0,
    };
  } catch (err) {
    return { ok: false, skipped: false, error: err.message || 'places_failed' };
  }
}

function googlePlaceToLocation(place, { providerId, cat, subcategory, subcategories, prices } = {}) {
  const placeId = place.placeId || place.id;
  const subs = [];
  const multi = Array.isArray(subcategories)
    ? subcategories
    : subcategory
      ? [subcategory]
      : [];
  multi.forEach((s) => {
    const key = String(s || '').trim();
    if (key) subs.push(key);
  });
  if (!subs.length && Array.isArray(place.subcats)) subs.push(...place.subcats);

  const website = place.website || '';
  const baseText = place.text || place.summary || 'Імпортовано з Google Maps';
  const text = website ? `${baseText}\nСайт: ${website}` : baseText;

  return {
    id: makeLocationId(`ggl:${placeId || place.title}:${place.lat}:${place.lng}`),
    providerId: providerId || null,
    lat: place.lat,
    lng: place.lng,
    cat: cat || 'home',
    title: String(place.title || '').trim(),
    text,
    rating: Number(place.rating) || 0,
    reviewsCount: Number(place.reviewsCount) || (place.reviews || []).length || 0,
    openStatus: 'open',
    workingHours: place.workingHours || '',
    phone: normalizePhone(place.phone || ''),
    address: place.address || '',
    website,
    schedule:
      place.schedule && typeof place.schedule === 'object'
        ? place.schedule
        : place.workingHours
          ? { 'Графік': place.workingHours }
          : {},
    subcats: [...new Set(subs.filter(Boolean))],
    prices: prices && typeof prices === 'object' ? { ...prices } : {},
    reviews: Array.isArray(place.reviews) ? place.reviews : [],
    views: 0,
    importSource: 'google_maps_url',
    importMeta: {
      source: 'google_maps_url',
      placeId,
      mapsUrl: place.mapsUrl || place.sourceUrl || '',
      website,
      types: place.types || [],
      importedAt: new Date().toISOString(),
    },
  };
}

function parseGoogleMapsUrlParts(finalUrl) {
  const url = new URL(finalUrl);
  const href = url.href;
  const out = {
    finalUrl: href,
    title: '',
    lat: null,
    lng: null,
    query: '',
    placeId: '',
  };

  const placeMatch = href.match(/\/maps\/place\/([^/@]+)/i);
  if (placeMatch) {
    try {
      out.title = decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).trim();
    } catch (_) {
      out.title = placeMatch[1].replace(/\+/g, ' ').trim();
    }
  }

  const searchPath = href.match(/\/maps\/search\/([^/@?]+)/i);
  if (searchPath && !out.title) {
    const rawSeg = searchPath[1];
    // Skip junk like "?api=1&query=..." when path is empty and querystring holds data
    if (rawSeg && !rawSeg.startsWith('?')) {
      try {
        out.title = decodeURIComponent(rawSeg.replace(/\+/g, ' ')).trim();
      } catch (_) {
        out.title = rawSeg.replace(/\+/g, ' ').trim();
      }
    }
  }

  const atMatch = href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) {
    out.lat = Number(atMatch[1]);
    out.lng = Number(atMatch[2]);
  }

  const d3 = href.match(/!3d(-?\d+\.\d+)/);
  const d4 = href.match(/!4d(-?\d+\.\d+)/);
  if (d3 && d4) {
    out.lat = Number(d3[1]);
    out.lng = Number(d4[1]);
  }

  const q = url.searchParams.get('q') || url.searchParams.get('query') || '';
  if (q) out.query = q.trim();

  // q=50.45,30.52 or q=50.45,30.52(Name)
  const qCoord = String(out.query || '').match(
    /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*(?:\((.+)\))?\s*$/
  );
  if (qCoord) {
    out.lat = Number(qCoord[1]);
    out.lng = Number(qCoord[2]);
    if (qCoord[3] && !out.title) out.title = qCoord[3].trim();
  }

  const ll = url.searchParams.get('ll') || url.searchParams.get('center') || '';
  const llMatch = String(ll).match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
  if (llMatch && !Number.isFinite(out.lat)) {
    out.lat = Number(llMatch[1]);
    out.lng = Number(llMatch[2]);
  }

  const placeId =
    url.searchParams.get('place_id') ||
    url.searchParams.get('query_place_id') ||
    '';
  if (placeId) out.placeId = placeId;

  // /g/xxxxxxxx feature ids sometimes appear in the path
  const gMatch = href.match(/\/g\/([a-zA-Z0-9_]+)/);
  if (gMatch && !out.placeId) {
    out.featureId = `g/${gMatch[1]}`;
  }

  if (!out.title && out.query && !qCoord) {
    out.title = out.query.replace(/\+/g, ' ').trim();
  }

  // Clean noisy titles like "Name - Google Maps"
  if (out.title) {
    out.title = out.title
      .replace(/\s*[|–—-]\s*Google Maps\s*$/i, '')
      .replace(/\+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return out;
}

function enrichResolvedFromHtml(html, resolved) {
  const out = { ...resolved };
  const text = String(html || '');
  if (!text) return out;

  if (!out.title) {
    const og =
      text.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
      text.match(/content=["']([^"']+)["']\s+property=["']og:title["']/i);
    const titleTag = text.match(/<title>([^<]+)<\/title>/i);
    const raw = (og && og[1]) || (titleTag && titleTag[1]) || '';
    if (raw) {
      out.title = String(raw)
        .replace(/\s*[|–—-]\s*Google Maps\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  if (!Number.isFinite(out.lat) || !Number.isFinite(out.lng)) {
    const patterns = [
      /@(-?\d+\.\d{3,}),(-?\d+\.\d{3,})/,
      /!3d(-?\d+\.\d+)[^!]{0,80}!4d(-?\d+\.\d+)/,
      /null,null,(-?\d+\.\d{3,}),(-?\d+\.\d{3,})/,
      /"latitude"\s*:\s*(-?\d+\.\d+)\s*,\s*"longitude"\s*:\s*(-?\d+\.\d+)/i,
      /\[null,null,(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\]/,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (!m) continue;
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        out.lat = lat;
        out.lng = lng;
        break;
      }
    }
  }

  if (!out.placeId) {
    const pid = text.match(/"(ChIJ[\w-]{10,})"/);
    if (pid) out.placeId = pid[1];
  }

  const ogDesc =
    text.match(/property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
    text.match(/content=["']([^"']+)["']\s+property=["']og:description["']/i);
  if (ogDesc && ogDesc[1] && !out.addressHint) {
    out.addressHint = ogDesc[1].trim();
  }

  return out;
}

async function geocodeQueryUkraine(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return null;

  const variants = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s.length < 2) return;
    // Skip overly broad admin areas that geocode to a useless region centroid
    if (/^(київська|львівська|одеська|харківська|дніпровська)\s+область$/i.test(s)) return;
    if (/^(ukraine|україна)$/i.test(s)) return;
    if (!variants.includes(s)) variants.push(s);
  };

  // Prefer known towns early for local Mapfix geography
  const lower = q.toLowerCase();
  if (lower.includes('коцюб') || lower.includes('kots')) push('Коцюбинське');
  if (lower.includes('ірпін') || lower.includes('irpin')) push('Ірпінь');
  if (lower.includes('буча') || lower.includes('bucha')) push('Буча');
  if (lower.includes('господар') || lower.includes('hostomel')) push('Гостомель');

  push(q);
  push(q.replace(/,?\s*Україна\s*$/i, '').trim());
  // "Name, City, Region" → try city-like segments
  const parts = q.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    push(parts[parts.length - 2]);
    push(parts.slice(-2).join(', '));
    push(parts[parts.length - 1]);
  }
  if (lower.includes('київ') || lower.includes('kyiv') || lower.includes('kiev')) push('Київ');

  for (const variant of variants) {
    const url =
      'https://nominatim.openstreetmap.org/search?' +
      new URLSearchParams({
        q: /україн|ukraine|київ|львів|одес|харків|коцюб|ірпін|буча/i.test(variant)
          ? variant
          : `${variant}, Україна`,
        format: 'json',
        limit: '1',
        countrycodes: 'ua',
        addressdetails: '1',
      }).toString();
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'MapfixImport/1.0 (https://mapfix-wine.vercel.app)',
          Accept: 'application/json',
        },
      });
      if (!res.ok) continue;
      const json = await res.json();
      const hit = Array.isArray(json) ? json[0] : null;
      if (!hit) continue;
      const lat = Number(hit.lat);
      const lng = Number(hit.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (lat === 0 && lng === 0) continue;
      return {
        lat,
        lng,
        address: formatNominatimAddress(hit) || hit.display_name || '',
        displayName: hit.display_name || '',
        approximate: variant !== q,
        matchedQuery: variant,
      };
    } catch (_) {
      /* try next */
    }
    await sleep(200);
  }
  return null;
}

async function resolveGoogleMapsUrl(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) throw new Error('Вставте посилання Google Maps');
  let start;
  try {
    start = new URL(input);
  } catch (_) {
    throw new Error('Некоректне посилання. Приклад: https://maps.app.goo.gl/...');
  }

  const host = start.hostname.replace(/^www\./, '');
  const allowed =
    host === 'maps.app.goo.gl' ||
    host === 'goo.gl' ||
    host === 'g.page' ||
    host.endsWith('google.com') ||
    host.endsWith('google.com.ua');
  if (!allowed) {
    throw new Error('Підтримуються лише посилання Google Maps / maps.app.goo.gl');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // Follow redirects; some short links need GET + browser-like UA
    const res = await fetch(start.href, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8',
      },
    });
    const finalUrl = res.url || start.href;
    const html = await res.text().catch(() => '');
    let parts = parseGoogleMapsUrlParts(finalUrl);
    // Also parse the original short/share URL (sometimes has q= already)
    const fromInput = parseGoogleMapsUrlParts(start.href);
    if (!parts.title && fromInput.title) parts.title = fromInput.title;
    if (!parts.query && fromInput.query) parts.query = fromInput.query;
    if (!Number.isFinite(parts.lat) && Number.isFinite(fromInput.lat)) {
      parts.lat = fromInput.lat;
      parts.lng = fromInput.lng;
    }
    if (!parts.placeId && fromInput.placeId) parts.placeId = fromInput.placeId;
    parts = enrichResolvedFromHtml(html, parts);
    parts.htmlLength = html.length;
    return parts;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Таймаут при відкритті посилання Google Maps');
    }
    throw new Error(err.message || 'Не вдалося відкрити посилання Google Maps');
  } finally {
    clearTimeout(timer);
  }
}

async function buildPlaceWithoutPlacesApi(resolved, warning = '') {
  let title = String(resolved.title || resolved.query || '').trim();
  const toCoord = (v) => {
    if (v === null || v === undefined || v === '') return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  };
  let lat = toCoord(resolved.lat);
  let lng = toCoord(resolved.lng);
  // 0,0 is never a real Maps pin for our use-case (Number(null)===0 trap)
  if (lat === 0 && lng === 0) {
    lat = NaN;
    lng = NaN;
  }
  let address = String(resolved.addressHint || '').trim();
  const notes = [];
  if (warning) notes.push(warning);

  // Have name, missing coords → Nominatim forward geocode (no Google key needed)
  if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && title) {
    const geo = await geocodeQueryUkraine(title);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      if (!address) address = geo.address || '';
      notes.push(
        geo.approximate
          ? `Координати приблизні (знайдено «${geo.matchedQuery}» через OpenStreetMap) — перевірте точку на карті`
          : 'Координати визначено через OpenStreetMap (Nominatim)'
      );
    }
  }

  // Have coords, missing title → reverse geocode for a label
  if (Number.isFinite(lat) && Number.isFinite(lng) && !title) {
    try {
      const rev = await reverseGeocodeLatLng(lat, lng);
      title = rev.displayName?.split(',')[0]?.trim() || rev.address || `Точка ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      if (!address) address = rev.address || '';
      notes.push('Назву уточнено за координатами (OpenStreetMap)');
    } catch (_) {
      title = `Точка ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }
  }

  if (!title || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(
      'Не вдалося витягнути назву й координати з цього посилання. Спробуйте повне посилання з Google Maps (Share → Copy link), або відкрийте місце й скопіюйте URL з рядка браузера.'
    );
  }

  return {
    placeId: resolved.placeId || '',
    title: title.replace(/[-_]{2,}/g, ' ').replace(/\s+/g, ' ').trim(),
    address,
    phone: '',
    lat,
    lng,
    rating: 0,
    reviewsCount: 0,
    workingHours: '',
    schedule: {},
    website: '',
    mapsUrl: resolved.finalUrl,
    types: [],
    summary: '',
    reviews: [],
    text:
      notes.length > 0
        ? `Імпортовано з посилання Google Maps. ${notes.join('. ')}`
        : 'Імпортовано з посилання Google Maps',
    dataSource: 'google_maps_url',
    importWarning: notes.join('. ') || warning,
  };
}

/** @deprecated use buildPlaceWithoutPlacesApi — kept for callers expecting sync throw shape */
function googleMapsUrlFallbackPlace(resolved, warning = '') {
  if (!resolved.title || !Number.isFinite(resolved.lat) || !Number.isFinite(resolved.lng)) {
    throw new Error(
      'Не вдалося витягнути назву й координати з цього посилання. Спробуйте повне посилання з Google Maps.'
    );
  }
  return {
    placeId: '',
    title: resolved.title.replace(/[-+]/g, ' '),
    address: '',
    phone: '',
    lat: resolved.lat,
    lng: resolved.lng,
    rating: 0,
    reviewsCount: 0,
    workingHours: '',
    schedule: {},
    website: '',
    mapsUrl: resolved.finalUrl,
    types: [],
    summary: '',
    reviews: [],
    text: 'Імпортовано з посилання Google Maps',
    dataSource: 'google_maps_url',
    importWarning: warning,
  };
}

async function importPlaceFromGoogleMapsUrl({ url, apiKey }) {
  const key = apiKey || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  const resolved = await resolveGoogleMapsUrl(url);
  let place = null;

  if (!key) {
    place = await buildPlaceWithoutPlacesApi(resolved);
  } else {
    try {
      if (resolved.placeId) {
        place = await fetchGooglePlaceDetails({ placeId: resolved.placeId, apiKey: key });
      } else {
        const query =
          resolved.query ||
          resolved.title ||
          (Number.isFinite(resolved.lat) && Number.isFinite(resolved.lng)
            ? `${resolved.lat},${resolved.lng}`
            : '');
        if (!query) {
          throw new Error('Не вдалося витягти назву або координати з посилання');
        }

        const found = await searchGooglePlacesText({
          query,
          apiKey: key,
          lat: resolved.lat,
          lng: resolved.lng,
          maxResultCount: 5,
        });
        if (!found.length) {
          throw new Error('Google Places не знайшов заклад за цим посиланням');
        }

        let best = found[0];
        if (Number.isFinite(resolved.lat) && Number.isFinite(resolved.lng)) {
          let bestDist = Infinity;
          for (const item of found) {
            const d = haversineMeters(
              { lat: resolved.lat, lng: resolved.lng },
              { lat: item.lat, lng: item.lng }
            );
            if (d < bestDist) {
              bestDist = d;
              best = item;
            }
          }
        }

        place = best.placeId
          ? await fetchGooglePlaceDetails({ placeId: best.placeId, apiKey: key })
          : {
              ...best,
              website: '',
              mapsUrl: resolved.finalUrl,
              types: [],
              summary: '',
              reviews: [],
              text: 'Імпортовано з Google Maps',
            };
      }
    } catch (err) {
      console.warn('[google-maps-url] Places API fallback:', err.message);
      place = await buildPlaceWithoutPlacesApi(resolved, err.message);
    }
  }

  place.sourceUrl = url;
  place.mapsUrl = place.mapsUrl || resolved.finalUrl;
  place.resolvedTitle = resolved.title;
  place.dataSource = place.dataSource || (key ? 'google_places_api' : 'google_maps_url');
  return { place, resolved };
}

/** Official Mapfix spreadsheet columns (CSV / Excel). */
const PROVIDER_IMPORT_COLUMNS = [
  'maps_url',
  'title',
  'address',
  'phone',
  'working_hours',
  'lat',
  'lng',
  'cat',
  'text',
  'status',
];

const PROVIDER_IMPORT_TEMPLATE_CSV =
  'maps_url,title,address,phone,working_hours,lat,lng,cat,text,status\n' +
  'https://maps.app.goo.gl/example,,,,"",,,,rental,,\n' +
  ',"Оренда квартири","вул. Прикладна 1, Коцюбинське",+380991112233,"09:00 - 18:00",50.4905,30.3345,rental,Опис точки,open\n';

/**
 * Scan a drawn map rectangle for places matching Mapfix catalog
 * (categories, subcategories, services). Prefers Google Places Text Search
 * with locationRestriction; falls back to OSM Overpass.
 */
async function scanRegionPlacesRaw({ bounds, masterCatalog, apiKey, maxPerQuery = 10 }) {
  const region = normalizeRegionBounds(bounds);
  const key = apiKey || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  const byKey = new Map();
  const queries = buildCatalogSearchQueries(masterCatalog);
  let source = 'google_places';
  let queryCount = 0;
  const asCity = {
    id: 'region',
    name: region.label,
    bbox: region.bbox,
    center: region.center,
  };

  if (key && queries.length) {
    const limit = Math.min(queries.length, 50);
    for (let i = 0; i < limit; i++) {
      const q = queries[i];
      const textQuery = q.queryCore;
      try {
        const found = await searchGooglePlacesText({
          query: textQuery,
          apiKey: key,
          bounds: region,
          maxResultCount: Math.min(20, Math.max(3, Number(maxPerQuery) || 10)),
        });
        queryCount += 1;
        for (const p of found) {
          if (!pointInRegion(p.lat, p.lng, region)) continue;
          const dedupeKey = p.placeId || `${p.title}|${p.lat.toFixed(5)}|${p.lng.toFixed(5)}`;
          if (byKey.has(dedupeKey)) {
            const prev = byKey.get(dedupeKey);
            if (!prev.hintSub && q.subKey) {
              prev.hintCat = q.catKey;
              prev.hintSub = q.subKey;
            }
            continue;
          }
          byKey.set(dedupeKey, {
            ...p,
            types: p.types || [],
            text: p.summary || 'Знайдено на Google Maps',
            hintCat: q.catKey,
            hintSub: q.subKey,
            searchQuery: textQuery,
          });
        }
      } catch (err) {
        console.warn('[scanRegionPlacesRaw] Places query failed:', textQuery, err.message);
      }
      await sleep(120);
    }
  } else {
    source = 'osm';
    const catKeys = Object.keys(masterCatalog || {}).filter((k) => CATEGORY_OSM_FILTERS[k]);
    for (const cat of catKeys) {
      try {
        const meta = await fetchOsmPlaces({ city: asCity, category: cat });
        queryCount += 1;
        for (const loc of meta.locations || []) {
          if (!pointInRegion(loc.lat, loc.lng, region)) continue;
          const dedupeKey = `${loc.title}|${Number(loc.lat).toFixed(5)}|${Number(loc.lng).toFixed(5)}`;
          if (byKey.has(dedupeKey)) continue;
          byKey.set(dedupeKey, {
            placeId: loc.importMeta?.osmId || dedupeKey,
            title: loc.title,
            address: loc.address,
            phone: loc.phone,
            lat: loc.lat,
            lng: loc.lng,
            rating: loc.rating || 0,
            reviewsCount: loc.reviewsCount || 0,
            workingHours: loc.workingHours || '',
            types: [],
            text: loc.text || 'Знайдено в OpenStreetMap',
            hintCat: cat,
            hintSub: (loc.subcats || [])[0] || null,
          });
        }
      } catch (err) {
        console.warn('[scanRegionPlacesRaw] OSM category failed:', cat, err.message);
      }
    }
  }

  return {
    region,
    city: { name: region.label, id: 'region', center: region.center },
    source,
    queryCount,
    places: [...byKey.values()],
  };
}

async function scanCityPlacesRaw({ cityName, masterCatalog, apiKey, maxPerQuery = 8 }) {
  const city = await geocodeCityUkraine(cityName);
  const scan = await scanRegionPlacesRaw({
    bounds: boundsFromCity(city),
    masterCatalog,
    apiKey,
    maxPerQuery,
  });
  return {
    ...scan,
    city,
    region: { ...scan.region, label: city.name },
  };
}

function attachCatalogMatchToLocation(place, match, masterCatalog, scan) {
  const serviceNames = Array.isArray(match.services) && match.services.length
    ? match.services
    : match.service
      ? [match.service]
      : [];
  const prices = pricesFromCatalogServices(
    masterCatalog,
    match.category,
    match.subcategory,
    serviceNames
  );
  const loc = googlePlaceToLocation(place, {
    providerId: null,
    cat: match.category,
    subcategory: match.subcategory,
    prices,
  });
  const regionLabel = scan.region?.label || scan.city?.name || 'області';
  loc.importSource = 'region_gemini';
  loc.importMeta = {
    ...(loc.importMeta || {}),
    source: 'region_gemini',
    region: scan.region
      ? {
          south: scan.region.south,
          west: scan.region.west,
          north: scan.region.north,
          east: scan.region.east,
        }
      : null,
    city: scan.city?.name || regionLabel,
    cityId: scan.city?.id || 'region',
    dataSource: scan.source,
    aiSource: match.source,
    aiConfidence: match.confidence,
    services: Object.keys(prices),
    importedAt: new Date().toISOString(),
  };
  loc.text = loc.text || `Імпортовано з Google Maps (${regionLabel})`;
  return loc;
}

async function buildRegionImportCandidates({
  bounds,
  masterCatalog,
  classifyPlacesForImport,
  geminiApiKey,
  placesApiKey,
  maxPerQuery = 10,
  maxCandidates = 80,
}) {
  if (typeof classifyPlacesForImport !== 'function') {
    throw new Error('classifyPlacesForImport is required');
  }

  const scan = await scanRegionPlacesRaw({
    bounds,
    masterCatalog,
    apiKey: placesApiKey,
    maxPerQuery,
  });

  const classifications = await classifyPlacesForImport(scan.places, masterCatalog, {
    geminiApiKey,
  });

  const locations = [];
  let rejected = 0;
  for (let i = 0; i < scan.places.length; i++) {
    const place = scan.places[i];
    const match = classifications[i];
    if (!match?.category || !match?.subcategory) {
      rejected += 1;
      continue;
    }
    if (!masterCatalog?.[match.category]?.subcats?.[match.subcategory]) {
      rejected += 1;
      continue;
    }
    let detailed = place;
    if (place.placeId && scan.source !== 'osm') {
      try {
        const extra = await fetchGooglePlaceDetails({
          placeId: place.placeId,
          apiKey: placesApiKey,
        });
        detailed = { ...place, ...extra, reviews: extra.reviews || [] };
        await sleep(80);
      } catch (err) {
        console.warn('[buildRegionImportCandidates] details skip:', place.title, err.message);
      }
    }
    locations.push(attachCatalogMatchToLocation(detailed, match, masterCatalog, scan));
    if (locations.length >= maxCandidates) break;
  }

  return {
    region: scan.region,
    city: scan.city,
    source: scan.source,
    queryCount: scan.queryCount,
    scanned: scan.places.length,
    rejected,
    matched: locations.length,
    locations,
  };
}

async function buildCityImportCandidates({
  cityName,
  masterCatalog,
  classifyPlacesForImport,
  geminiApiKey,
  placesApiKey,
  maxPerQuery = 8,
  maxCandidates = 80,
}) {
  const city = await geocodeCityUkraine(cityName);
  const result = await buildRegionImportCandidates({
    bounds: boundsFromCity(city),
    masterCatalog,
    classifyPlacesForImport,
    geminiApiKey,
    placesApiKey,
    maxPerQuery,
    maxCandidates,
  });
  return {
    ...result,
    city,
    region: { ...result.region, label: city.name },
  };
}

function formatNominatimAddress(hit) {
  if (!hit || typeof hit !== 'object') return '';
  const a = hit.address || {};
  const road = [a.road || a.pedestrian || a.footway || a.path || a.residential || a.neighbourhood]
    .filter(Boolean)[0];
  const house = a.house_number || '';
  const streetPart = [road, house].filter(Boolean).join(', ');
  const locality =
    a.city || a.town || a.village || a.municipality || a.suburb || a.county || '';
  const parts = [streetPart, locality].filter(Boolean);
  if (parts.length) return parts.join(', ');
  return String(hit.display_name || '')
    .split(',')
    .slice(0, 3)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

async function reverseGeocodeLatLng(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    throw new Error('Некоректні координати');
  }
  if (la < -90 || la > 90 || lo < -180 || lo > 180) {
    throw new Error('Координати поза межами');
  }

  const url =
    'https://nominatim.openstreetmap.org/reverse?' +
    new URLSearchParams({
      format: 'jsonv2',
      lat: String(la),
      lon: String(lo),
      'accept-language': 'uk',
      addressdetails: '1',
      zoom: '18',
    }).toString();

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'MapfixReverseGeocode/1.0 (provider cabinet; contact@mapfix.local)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Не вдалося визначити адресу (HTTP ${res.status})`);
  const json = await res.json();
  const address = formatNominatimAddress(json);
  if (!address) throw new Error('Адресу для цієї точки не знайдено');
  return {
    address,
    displayName: json.display_name || address,
    lat: Number(json.lat) || la,
    lng: Number(json.lon) || lo,
  };
}

module.exports = {
  CITY_PRESETS,
  CATEGORY_OSM_FILTERS,
  resolveCity,
  geocodeCityUkraine,
  reverseGeocodeLatLng,
  fetchOsmPlaces,
  fetchGooglePlaces,
  searchGooglePlacesText,
  fetchGooglePlaceDetails,
  googlePlaceToLocation,
  resolveGoogleMapsUrl,
  importPlaceFromGoogleMapsUrl,
  importExcelRowsToLocations,
  loadLocationsFromFile,
  mergeLocations,
  parseCsv,
  csvRowToLocation,
  normalizePhone,
  scanCityPlacesRaw,
  scanRegionPlacesRaw,
  buildCityImportCandidates,
  buildRegionImportCandidates,
  normalizeRegionBounds,
  pricesFromCatalogServices,
  locationNeedsGoogleReviews,
  enrichLocationGoogleReviews,
  hasGoogleReviewTexts,
  PROVIDER_IMPORT_COLUMNS,
  PROVIDER_IMPORT_TEMPLATE_CSV,
};
