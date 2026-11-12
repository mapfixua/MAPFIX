'use strict';

const crypto = require('crypto');
const { pricesFromCatalogServices } = require('./places-import.js');
const { mapPlacesReviews } = require('./places-reviews.js');
const { classifyDedup } = require('./places-dedup.js');

function locationIdForPlace(placeId) {
  const hash = crypto.createHash('sha1').update(`places_v2:${placeId}`).digest('hex').slice(0, 8);
  return `loc-imp-${hash}`;
}

function publishBlockReason(row) {
  if (!row) return 'missing';
  if (row.status !== 'approved') return 'not_approved';
  const dedup = String(row.dedup_status || '');
  if (dedup === 'new' || dedup.startsWith('possible_branch_of ')) return null;
  if (dedup.startsWith('matches_deleted ')) return 'deleted_not_restored';
  if (dedup.startsWith('matches_claimed ')) return 'claimed_not_overwritten';
  if (dedup.startsWith('duplicate_of ')) return 'duplicate';
  return 'dedup';
}

function buildLocationFromCandidate(row, masterCatalog) {
  const placeId = String(row.place_id || '').replace(/^places\//, '');
  const cat = row.proposed_cat || 'home';
  const sub = Array.isArray(row.proposed_subcats) ? row.proposed_subcats[0] : null;
  const services = Array.isArray(row.proposed_services) ? row.proposed_services : [];
  const prices = pricesFromCatalogServices(masterCatalog, cat, sub, services);
  const rawReviews = row.raw_payload?.details?.reviews || [];
  const reviews = mapPlacesReviews(rawReviews);
  const details = row.raw_payload?.details || {};
  const textSnap = row.raw_payload?.text || {};
  return {
    id: locationIdForPlace(placeId),
    providerId: null,
    lat: Number(row.proposed_lat),
    lng: Number(row.proposed_lng),
    cat,
    title: String(row.proposed_title || '').trim() || 'Заклад',
    text: 'Імпортовано з Google Maps (Київ / Коцюбинське).',
    rating: Number(details.rating || textSnap.rating) || 0,
    reviewsCount: Number(details.userRatingCount || textSnap.reviewsCount) || reviews.length || 0,
    openStatus: 'open',
    workingHours: row.proposed_working_hours || '',
    phone: row.proposed_phone || '',
    address: row.proposed_address || '',
    schedule: {},
    subcats: sub ? [sub] : [],
    prices,
    reviews,
    views: 0,
    importSource: 'places_v2',
    googlePlaceId: placeId,
    businessStatus: row.business_status || details.businessStatus || 'OPERATIONAL',
    lastReviewAt: row.last_review_at || null,
    reviewDates: Array.isArray(row.review_dates) ? row.review_dates : [],
  };
}

/**
 * Decide which approved staging rows may become locations.
 * Re-checks dedup against the live set, including deleted and claimed rows.
 * Does not restore deleted cards and does not overwrite claimed ones.
 */
function selectPublishable(rows, locations, masterCatalog) {
  const created = [];
  const skipped = [];
  const seenIds = new Set((locations || []).map((loc) => loc.id));
  const seenPlaces = new Set(
    (locations || []).map((loc) => String(loc.googlePlaceId || '').trim()).filter(Boolean)
  );
  for (const row of rows || []) {
    const blocked = publishBlockReason(row);
    if (blocked) {
      skipped.push({ id: row.id, placeId: row.place_id, reason: blocked });
      continue;
    }
    const live = classifyDedup(
      {
        placeId: row.place_id,
        googlePlaceId: row.place_id,
        title: row.proposed_title,
        phone: row.proposed_phone,
        lat: row.proposed_lat,
        lng: row.proposed_lng,
      },
      locations
    );
    const allowBranch =
      String(row.dedup_status).startsWith('possible_branch_of ') &&
      (live.status === 'new' || live.status.startsWith('possible_branch_of '));
    if (!(live.status === 'new' || allowBranch)) {
      skipped.push({ id: row.id, placeId: row.place_id, reason: live.status });
      continue;
    }
    if (seenPlaces.has(String(row.place_id))) {
      skipped.push({ id: row.id, placeId: row.place_id, reason: 'place_id_exists' });
      continue;
    }
    const loc = buildLocationFromCandidate(row, masterCatalog);
    if (seenIds.has(loc.id)) {
      skipped.push({ id: row.id, placeId: row.place_id, reason: 'id_exists' });
      continue;
    }
    if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng) || !loc.googlePlaceId) {
      skipped.push({ id: row.id, placeId: row.place_id, reason: 'incomplete' });
      continue;
    }
    seenIds.add(loc.id);
    seenPlaces.add(loc.googlePlaceId);
    created.push({ candidateId: row.id, location: loc });
  }
  return { created, skipped };
}

module.exports = {
  locationIdForPlace,
  publishBlockReason,
  buildLocationFromCandidate,
  selectPublishable,
};
