'use strict';

const { titlesMatch, foldTitle, haversineMeters, placeIdOf } = require('./places-dedup.js');
const { normalizePhone } = require('./phone-normalize.js');

/**
 * Conservative place-id match for rows that already exist.
 * A match is confident only when distance is small and phone/title agree,
 * and a second candidate is not almost as close.
 */
function chooseBackfillMatch(location, places) {
  const phone = normalizePhone(location?.phone || '');
  const scored = [];
  for (const place of places || []) {
    const placeId = placeIdOf(place);
    if (!placeId) continue;
    const distance = haversineMeters(location, place);
    if (!Number.isFinite(distance) || distance > 80) continue;
    const placePhone = normalizePhone(place.phone || '');
    if (phone && placePhone && phone !== placePhone) continue;
    const titleEqual = foldTitle(location.title) && foldTitle(location.title) === foldTitle(place.title);
    const fuzzy = titlesMatch(location.title, place.title);
    let confident = false;
    let reason = '';
    if (phone && placePhone && phone === placePhone && distance <= 80) {
      confident = true;
      reason = 'phone_and_near';
    } else if (titleEqual && distance <= 40) {
      confident = true;
      reason = 'exact_title_near';
    } else if (fuzzy && distance <= 25 && (!phone || !placePhone || phone === placePhone)) {
      confident = true;
      reason = 'fuzzy_title_very_near';
    }
    if (!confident) continue;
    scored.push({ placeId, distance, reason, title: place.title || '' });
  }
  scored.sort((a, b) => a.distance - b.distance);
  if (!scored.length) return { confident: false, reason: 'no_match' };
  if (scored.length > 1 && scored[1].distance - scored[0].distance < 15) {
    return { confident: false, reason: 'ambiguous', candidates: scored.slice(0, 3) };
  }
  return { confident: true, ...scored[0] };
}

const BACKFILL_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.businessStatus';

async function searchBackfillCandidates(location, apiKey, fetchImpl = fetch) {
  const body = {
    textQuery: String(location?.title || '').trim(),
    languageCode: 'uk',
    regionCode: 'UA',
    maxResultCount: 5,
  };
  if (Number.isFinite(Number(location?.lat)) && Number.isFinite(Number(location?.lng))) {
    body.locationBias = {
      circle: {
        center: { latitude: Number(location.lat), longitude: Number(location.lng) },
        radius: 200,
      },
    };
  }
  const res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': BACKFILL_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(String(message).slice(0, 200));
  }
  return (json.places || [])
    .map((p) => ({
      placeId: p.id,
      title: p.displayName?.text || '',
      phone: normalizePhone(p.nationalPhoneNumber || ''),
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      businessStatus: p.businessStatus || '',
    }))
    .filter((p) => p.placeId && p.title);
}

module.exports = {
  chooseBackfillMatch,
  searchBackfillCandidates,
  BACKFILL_FIELD_MASK,
};
