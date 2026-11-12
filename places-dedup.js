'use strict';

const { normalizePhone } = require('./phone-normalize.js');

const PHONE_NEAR_METERS = 100;
const TITLE_NEAR_METERS = 100;

const LEGAL_TOKENS = new Set([
  'тов',
  'фоп',
  'пп',
  'прат',
  'пат',
  'ат',
  'тзов',
  'llc',
  'ltd',
  'inc',
  'gmbh',
  'corp',
  'чп',
  'спд',
  'флп',
  'іп',
  'ооо',
  'зао',
  'оао',
  'ip',
  'fop',
]);

const CYR_TO_LAT = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'h',
  ґ: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  є: 'ie',
  ж: 'zh',
  з: 'z',
  и: 'y',
  і: 'i',
  ї: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ь: '',
  ъ: '',
  ы: 'y',
  э: 'e',
  ю: 'iu',
  я: 'ia',
};

function haversineMeters(a, b) {
  const lat1 = Number(a?.lat);
  const lng1 = Number(a?.lng);
  const lat2 = Number(b?.lat);
  const lng2 = Number(b?.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Infinity;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function transliterate(text) {
  let out = '';
  const lower = String(text || '').toLowerCase().replace(/ё/g, 'е');
  for (const ch of lower) {
    if (CYR_TO_LAT[ch] !== undefined) out += CYR_TO_LAT[ch];
    else out += ch;
  }
  return out;
}

function foldTitle(raw) {
  const folded = transliterate(raw)
    .replace(/['’`ʼ"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = folded.split(' ').filter((token) => token && !LEGAL_TOKENS.has(token));
  return tokens.join(' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  if (Math.abs(a.length - b.length) > 8) return Math.abs(a.length - b.length);
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function titlesMatch(a, b) {
  const left = foldTitle(a);
  const right = foldTitle(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = Math.min(left.length, right.length);
  const longerLen = Math.max(left.length, right.length);
  if (shorter >= 6 && shorter / longerLen >= 0.7 && (left.includes(right) || right.includes(left))) {
    return true;
  }
  const ta = left.split(' ').filter(Boolean);
  const tb = right.split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return false;
  const smaller = ta.length <= tb.length ? ta : tb;
  const larger = ta.length <= tb.length ? tb : ta;
  if (smaller.length / larger.length < 0.7) return false;
  const used = new Set();
  for (const token of smaller) {
    const idx = larger.findIndex((other, index) => !used.has(index) && tokensClose(token, other));
    if (idx === -1) return false;
    used.add(idx);
  }
  return smaller.some((token) => token.length >= 4);
}

function tokensClose(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5) return false;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length) >= 0.84;
}

function placeIdOf(row) {
  const raw = String(row?.googlePlaceId || row?.google_place_id || row?.placeId || row?.place_id || '').trim();
  if (!raw || raw.startsWith('osm:')) return '';
  return raw.replace(/^places\//, '');
}

function isDeletedRow(row) {
  return Boolean(row && (row.deletedAt || row.deleted_at));
}

function isClaimedRow(row) {
  if (!row || isDeletedRow(row)) return false;
  return Boolean(row.claimedAt || row.claimed_at || row.providerId || row.provider_id);
}

function statusForMatch(kind, row) {
  const id = String(row?.id || '');
  if (isDeletedRow(row)) return { status: `matches_deleted ${id}`, matchId: id, kind: 'deleted' };
  if (isClaimedRow(row)) return { status: `matches_claimed ${id}`, matchId: id, kind: 'claimed' };
  if (kind === 'branch') return { status: `possible_branch_of ${id}`, matchId: id, kind: 'branch' };
  return { status: `duplicate_of ${id}`, matchId: id, kind: 'duplicate' };
}

/**
 * Strict dedup of one candidate against every locations row (active, deleted,
 * claimed) and earlier rows from the same import batch.
 *
 * Order:
 *  (a) same google_place_id
 *  (b) same phone AND distance < 100 m → duplicate
 *      (same phone AND fuzzy title AND distance < 100 m is also a duplicate)
 *  (c) same phone AND distance > 100 m → possible branch, even if titles match
 *  (d) fuzzy title within 100 m → duplicate
 *  (e) a deleted match is matches_deleted, never an auto-restore
 *  (f) a claimed / provider-owned match is matches_claimed, never an overwrite
 */
function classifyDedup(candidate, locations, { batch = [] } = {}) {
  const rows = [];
  for (const loc of locations || []) {
    if (loc) rows.push(loc);
  }
  for (const earlier of batch || []) {
    if (!earlier) continue;
    rows.push({
      id: earlier.id || `batch:${placeIdOf(earlier) || earlier.title || 'row'}`,
      title: earlier.title || earlier.proposed_title,
      phone: earlier.phone || earlier.proposed_phone,
      lat: earlier.lat ?? earlier.proposed_lat,
      lng: earlier.lng ?? earlier.proposed_lng,
      googlePlaceId: placeIdOf(earlier),
      deletedAt: null,
      claimedAt: null,
      providerId: null,
    });
  }

  const candId = placeIdOf(candidate);
  const candPhone = normalizePhone(candidate.phone || candidate.proposed_phone || '');
  const candTitle = candidate.title || candidate.proposed_title || '';
  const candPoint = {
    lat: Number(candidate.lat ?? candidate.proposed_lat),
    lng: Number(candidate.lng ?? candidate.proposed_lng),
  };

  let best = null;
  const rank = { place_id: 4, phone_near: 3, title_near: 2, phone_far: 1 };

  function consider(kind, row, distance) {
    const weight = rank[kind] || 0;
    if (!best || weight > best.weight || (weight === best.weight && distance < best.distance)) {
      best = { kind, row, distance, weight };
    }
  }

  for (const row of rows) {
    const distance = haversineMeters(candPoint, row);
    const rowPlace = placeIdOf(row);
    if (candId && rowPlace && candId === rowPlace) {
      consider('place_id', row, distance);
      continue;
    }
    const rowPhone = normalizePhone(row.phone || '');
    const samePhone = Boolean(candPhone && rowPhone && candPhone === rowPhone);
    const fuzzy = titlesMatch(candTitle, row.title);
    if (samePhone && Number.isFinite(distance) && distance < PHONE_NEAR_METERS) {
      consider('phone_near', row, distance);
      continue;
    }
    if (samePhone && (!Number.isFinite(distance) || distance >= PHONE_NEAR_METERS)) {
      consider('phone_far', row, distance);
      continue;
    }
    if (fuzzy && Number.isFinite(distance) && distance <= TITLE_NEAR_METERS) {
      consider('title_near', row, distance);
    }
  }

  if (!best) {
    return { status: 'new', matchId: null, kind: 'new', distanceMeters: null };
  }
  const mappedKind = best.kind === 'phone_far' ? 'branch' : 'duplicate';
  const mapped = statusForMatch(mappedKind, best.row);
  return {
    status: mapped.status,
    matchId: mapped.matchId,
    kind: mapped.kind,
    distanceMeters: Number.isFinite(best.distance) ? Math.round(best.distance) : null,
    via: best.kind,
  };
}

module.exports = {
  PHONE_NEAR_METERS,
  TITLE_NEAR_METERS,
  haversineMeters,
  foldTitle,
  titlesMatch,
  placeIdOf,
  isDeletedRow,
  isClaimedRow,
  classifyDedup,
};
