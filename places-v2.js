'use strict';

const { getWave, looksLikeBakery } = require('./places-waves.js');
const { coveringTiles, pointInAllowedArea, allowedAreaId } = require('./places-geo.js');
const { classifyDedup, placeIdOf } = require('./places-dedup.js');
const { mapPlacesReviews, summarizeReviewDates } = require('./places-reviews.js');
const { createPlacesBudget, PlacesQuotaError } = require('./places-quota.js');
const { classifyPlace, verifyPlace, gateClassification } = require('./places-classify.js');
const { normalizePhone } = require('./phone-normalize.js');

const TEXT_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.nationalPhoneNumber',
  'places.businessStatus',
  'places.types',
  'places.userRatingCount',
].join(',');

const DETAILS_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'nationalPhoneNumber',
  'internationalPhoneNumber',
  'businessStatus',
  'userRatingCount',
  'rating',
  'regularOpeningHours.weekdayDescriptions',
  'types',
  'reviews.publishTime',
  'reviews.rating',
  'reviews.text',
  'reviews.relativePublishTimeDescription',
  'reviews.authorAttribution',
].join(',');

function passesListingFilters(place) {
  if (!place) return { ok: false, reason: 'empty' };
  if (String(place.businessStatus || '').toUpperCase() !== 'OPERATIONAL') {
    return { ok: false, reason: 'not_operational' };
  }
  if (!pointInAllowedArea(place.lat, place.lng)) {
    return { ok: false, reason: 'outside_polygon' };
  }
  if (!(Number(place.reviewsCount) >= 1)) {
    return { ok: false, reason: 'no_ratings' };
  }
  return { ok: true, reason: null };
}

function textPlaceFromApi(p) {
  const lat = p.location?.latitude;
  const lng = p.location?.longitude;
  const title = p.displayName?.text;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !title || !p.id) return null;
  return {
    placeId: String(p.id).replace(/^places\//, ''),
    title: String(title).trim(),
    address: p.formattedAddress || '',
    phone: normalizePhone(p.nationalPhoneNumber || ''),
    lat,
    lng,
    rating: 0,
    reviewsCount: Number(p.userRatingCount) || 0,
    businessStatus: p.businessStatus || '',
    types: Array.isArray(p.types) ? p.types : [],
  };
}

async function defaultTextSearch({ query, bounds, apiKey, pageSize = 20 }) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': TEXT_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: query,
      languageCode: 'uk',
      regionCode: 'UA',
      maxResultCount: Math.min(20, Math.max(1, pageSize)),
      locationRestriction: {
        rectangle: {
          low: { latitude: bounds.south, longitude: bounds.west },
          high: { latitude: bounds.north, longitude: bounds.east },
        },
      },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json?.error?.message || `Places text search HTTP ${res.status}`;
    throw new Error(message.slice(0, 240));
  }
  return (Array.isArray(json.places) ? json.places : []).map(textPlaceFromApi).filter(Boolean);
}

async function defaultDetails({ placeId, apiKey }) {
  const id = String(placeId || '').replace(/^places\//, '');
  const res = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?languageCode=uk`,
    {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': DETAILS_FIELD_MASK,
      },
    }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json?.error?.message || `Places details HTTP ${res.status}`;
    throw new Error(message.slice(0, 240));
  }
  return json;
}

function detailsToPlace(base, payload) {
  const reviews = mapPlacesReviews(payload?.reviews);
  const dates = summarizeReviewDates(reviews);
  const hours = Array.isArray(payload?.regularOpeningHours?.weekdayDescriptions)
    ? payload.regularOpeningHours.weekdayDescriptions.join('; ')
    : '';
  return {
    ...base,
    title: payload?.displayName?.text || base.title,
    address: payload?.formattedAddress || base.address,
    phone: normalizePhone(payload?.nationalPhoneNumber || payload?.internationalPhoneNumber || base.phone || ''),
    lat: Number.isFinite(payload?.location?.latitude) ? payload.location.latitude : base.lat,
    lng: Number.isFinite(payload?.location?.longitude) ? payload.location.longitude : base.lng,
    rating: Number(payload?.rating) || base.rating || 0,
    reviewsCount: Number(payload?.userRatingCount) || base.reviewsCount || 0,
    businessStatus: payload?.businessStatus || base.businessStatus,
    types: Array.isArray(payload?.types) && payload.types.length ? payload.types : base.types,
    workingHours: hours,
    reviews,
    reviewDates: dates.reviewDates,
    lastReviewAt: dates.lastReviewAt,
    freshReviews: dates.fresh,
    rawDetails: payload,
  };
}

function candidateRow(wave, place, extra) {
  return {
    place_id: place.placeId,
    wave: wave.id,
    raw_payload: {
      text: {
        placeId: place.placeId,
        title: place.title,
        address: place.address,
        phone: place.phone,
        lat: place.lat,
        lng: place.lng,
        businessStatus: place.businessStatus,
        types: place.types,
        reviewsCount: place.reviewsCount,
        rating: place.rating,
        query: place.searchQuery,
        tile: place.tile || null,
      },
      details: place.rawDetails || null,
    },
    proposed_cat: extra.proposed_cat || null,
    proposed_subcats: extra.proposed_subcats || [],
    proposed_services: extra.proposed_services || [],
    proposed_title: place.title || '',
    proposed_phone: place.phone || '',
    proposed_address: place.address || '',
    proposed_lat: place.lat,
    proposed_lng: place.lng,
    proposed_working_hours: place.workingHours || '',
    classifier_confidence: extra.classifier_confidence ?? null,
    classifier_reasoning: extra.classifier_reasoning || '',
    verification: extra.verification || null,
    dedup_status: extra.dedup_status,
    business_status: place.businessStatus || null,
    review_dates: place.reviewDates || [],
    last_review_at: place.lastReviewAt || null,
    status: extra.status,
    needs_review: Boolean(extra.needs_review),
    reject_reason: extra.reject_reason || null,
  };
}

function planWave(waveName, tileOptions) {
  const wave = getWave(waveName);
  const tiles = coveringTiles(tileOptions);
  return {
    wave: wave.id,
    label: wave.label,
    targets: wave.targets.map((t) => ({ key: t.key, cat: t.cat, sub: t.sub, query: t.query })),
    tileCount: tiles.length,
    plannedTextSearch: tiles.length * wave.targets.length,
    tiles,
    waveDef: wave,
  };
}

/**
 * Dry-run a wave into staging rows. Never inserts into `locations`.
 * Network callers are injectable so tests do not hit Google.
 */
async function runWave(options = {}) {
  const plan = planWave(options.wave || 'A', {
    stepLat: options.stepLat,
    stepLng: options.stepLng,
  });
  if (Array.isArray(options.targets) && options.targets.length) {
    plan.waveDef = { ...plan.waveDef, targets: options.targets };
  }
  if (Array.isArray(options.tiles) && options.tiles.length) {
    plan.tiles = options.tiles;
    plan.tileCount = options.tiles.length;
    plan.plannedTextSearch = options.tiles.length * plan.waveDef.targets.length;
  }
  const wave = plan.waveDef;
  const apiKey = options.apiKey || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
  const geminiKey = options.geminiApiKey || process.env.GEMINI_API_KEY || '';
  const budget = options.budget || createPlacesBudget(options);
  const textSearch = options.textSearch || ((args) => defaultTextSearch({ ...args, apiKey }));
  const detailsFetch = options.details || ((args) => defaultDetails({ ...args, apiKey }));
  const classify = options.classify || ((place, catalog) => classifyPlace(place, catalog, geminiKey));
  const verify = options.verify || ((place, proposal, catalog) => verifyPlace(place, proposal, catalog, geminiKey));
  const locations = Array.isArray(options.locations) ? options.locations : [];
  const masterCatalog = options.masterCatalog || {};
  const onStage = typeof options.onStage === 'function' ? options.onStage : null;

  const counts = {
    tiles: plan.tileCount,
    plannedTextSearch: plan.plannedTextSearch,
    textHits: 0,
    unique: 0,
    skipped: {},
    staged: 0,
    pending: 0,
    pendingReview: 0,
    rejected: 0,
  };
  const bump = (reason) => {
    counts.skipped[reason] = (counts.skipped[reason] || 0) + 1;
  };

  const seen = new Map();
  const batch = [];
  const staged = [];
  let stoppedReason = null;

  async function flush(row) {
    staged.push(row);
    counts.staged += 1;
    if (row.status === 'pending' && row.needs_review) counts.pendingReview += 1;
    else if (row.status === 'pending') counts.pending += 1;
    else if (row.status === 'rejected') counts.rejected += 1;
    batch.push({
      id: `batch:${row.place_id}`,
      placeId: row.place_id,
      title: row.proposed_title,
      phone: row.proposed_phone,
      lat: row.proposed_lat,
      lng: row.proposed_lng,
    });
    if (onStage && staged.length % 20 === 0) await onStage(staged.slice(-20));
  }

  try {
    if (!apiKey && !options.textSearch) {
      throw new Error('GOOGLE_PLACES_API_KEY is not set');
    }
    for (const target of wave.targets) {
      for (const tile of plan.tiles) {
        let found = [];
        try {
          const cacheKey = JSON.stringify({ q: target.query, tile, mask: TEXT_FIELD_MASK });
          const spent = await budget.spend('text', cacheKey, () =>
            textSearch({ query: target.query, bounds: tile, apiKey, target })
          );
          found = Array.isArray(spent.value) ? spent.value : [];
        } catch (err) {
          if (err instanceof PlacesQuotaError || err.code === 'cap') {
            stoppedReason = 'text_search_cap';
            break;
          }
          bump('text_search_error');
          continue;
        }
        counts.textHits += found.length;
        for (const place of found) {
          if (!place?.placeId || seen.has(place.placeId)) continue;
          seen.set(place.placeId, true);
          counts.unique += 1;
          const listing = passesListingFilters(place);
          if (!listing.ok) {
            bump(listing.reason);
            continue;
          }
          if (target.bakeryOnly && !looksLikeBakery(place)) {
            bump('not_bakery');
            continue;
          }
          const area = allowedAreaId(place.lat, place.lng);
          const enriched = {
            ...place,
            searchQuery: target.query,
            hintCat: target.cat,
            hintSub: target.sub,
            tile: { ...tile, area },
          };
          const preDedup = classifyDedup(
            { ...enriched, googlePlaceId: enriched.placeId },
            locations,
            { batch }
          );
          const exactId = preDedup.via === 'place_id';
          if (exactId && preDedup.status !== 'new') {
            await flush(
              candidateRow(wave, enriched, {
                dedup_status: preDedup.status,
                status: 'pending',
                needs_review: true,
                reject_reason: null,
                proposed_cat: target.cat,
                proposed_subcats: [target.sub],
              })
            );
            continue;
          }

          let detailed = enriched;
          try {
            const cacheKey = `details:${enriched.placeId}:${DETAILS_FIELD_MASK}`;
            const spent = await budget.spend('details', cacheKey, () =>
              detailsFetch({ placeId: enriched.placeId, apiKey })
            );
            detailed = detailsToPlace(enriched, spent.value);
          } catch (err) {
            if (err instanceof PlacesQuotaError || err.code === 'cap') {
              stoppedReason = 'details_cap';
              break;
            }
            bump('details_error');
            continue;
          }

          const again = passesListingFilters(detailed);
          if (!again.ok) {
            bump(again.reason);
            continue;
          }
          if (!detailed.freshReviews) {
            await flush(
              candidateRow(wave, detailed, {
                dedup_status: preDedup.status,
                status: 'rejected',
                needs_review: false,
                reject_reason: 'stale_reviews',
                proposed_cat: target.cat,
                proposed_subcats: [target.sub],
              })
            );
            continue;
          }

          const dedup = classifyDedup(
            { ...detailed, googlePlaceId: detailed.placeId },
            locations,
            { batch }
          );

          if (!geminiKey && !options.classify) {
            await flush(
              candidateRow(wave, detailed, {
                dedup_status: dedup.status,
                status: 'rejected',
                needs_review: false,
                reject_reason: 'no_gemini_key',
                proposed_cat: target.cat,
                proposed_subcats: [target.sub],
              })
            );
            continue;
          }

          let classifier;
          let verification;
          try {
            classifier = await classify(detailed, masterCatalog);
            verification = await verify(detailed, classifier, masterCatalog);
          } catch (err) {
            bump('classify_error');
            await flush(
              candidateRow(wave, detailed, {
                dedup_status: dedup.status,
                status: 'rejected',
                needs_review: false,
                reject_reason: 'classify_error',
                classifier_reasoning: String(err.message || '').slice(0, 240),
                proposed_cat: target.cat,
                proposed_subcats: [target.sub],
              })
            );
            continue;
          }

          const gate = gateClassification({ classifier, verification, target });
          const dedupBlocks = dedup.status !== 'new' && !String(dedup.status).startsWith('possible_branch_of ');
          let status = gate.status;
          let needsReview = gate.needsReview;
          if (dedup.status !== 'new') needsReview = true;
          if (status === 'pending' && dedupBlocks) {
            status = 'pending';
          }
          await flush(
            candidateRow(wave, detailed, {
              dedup_status: dedup.status,
              status,
              needs_review: needsReview || gate.needsReview,
              reject_reason: status === 'rejected' ? gate.reason : null,
              proposed_cat: classifier.category || target.cat,
              proposed_subcats: classifier.subcategory ? [classifier.subcategory] : [target.sub],
              proposed_services: classifier.services || [],
              classifier_confidence: gate.confidence,
              classifier_reasoning: classifier.reasoning || '',
              verification,
            })
          );
        }
        if (stoppedReason) break;
      }
      if (stoppedReason) break;
    }
  } catch (err) {
    if (err instanceof PlacesQuotaError || err.code === 'cap') {
      stoppedReason = stoppedReason || 'cap';
    } else {
      throw err;
    }
  }

  if (onStage) {
    const remainder = staged.length % 20;
    if (remainder) await onStage(staged.slice(-remainder));
    else if (!staged.length) await onStage([]);
  }

  const cost = budget.estimateCost();
  console.log(
    `[places-v2] wave ${wave.id} text=${cost.textSearchRequests} details=${cost.detailsRequests} cacheHits=${cost.cacheHits} staged=${counts.staged} estUsdIfUncapped=${cost.estimatedUsdIfFreeTierExhausted}`
  );

  return {
    ok: true,
    dryRun: true,
    publishedLocations: 0,
    wave: wave.id,
    label: wave.label,
    stoppedReason,
    counts,
    cost,
    candidates: staged,
  };
}

module.exports = {
  TEXT_FIELD_MASK,
  DETAILS_FIELD_MASK,
  passesListingFilters,
  planWave,
  runWave,
  candidateRow,
  placeIdOf,
};
