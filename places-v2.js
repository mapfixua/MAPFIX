'use strict';

const { getWave, looksLikeBakery } = require('./places-waves.js');
const { coveringTiles, pointInAllowedArea, allowedAreaId } = require('./places-geo.js');
const { classifyDedup, placeIdOf } = require('./places-dedup.js');
const { mapPlacesReviews, summarizeReviewDates } = require('./places-reviews.js');
const { createPlacesBudget, PlacesQuotaError, searchTextFailureKind } = require('./places-quota.js');
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

// Identical transient failures (HTTP 5xx and other non-quota errors) stop after three.
// HTTP 429 RESOURCE_EXHAUSTED and HTTP 403 billing/permission stop on the first response.
const TEXT_SEARCH_ERROR_BREAKER = 3;
const TEXT_SEARCH_MESSAGE_LIMIT = 300;

function textSearchHttpStatus(err) {
  const value = Number(err?.status ?? err?.httpStatus);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function sanitizeTextSearchMessage(message, secret) {
  let text = String(message || '');
  const key = String(secret || '');
  if (key.length >= 8) text = text.split(key).join('[redacted]');
  text = text
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/AIza[0-9A-Za-z\-_]{8,}/g, '[redacted]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]');
  return text.slice(0, TEXT_SEARCH_MESSAGE_LIMIT);
}

function placesTextSearchFailure(res, json, apiKey) {
  const httpStatus = Number(res?.status) || 0;
  const googleStatus = String(json?.error?.status || '').trim();
  const googleMessage = String(json?.error?.message || '').trim();
  const parts = [];
  if (httpStatus) parts.push(`HTTP ${httpStatus}`);
  if (googleStatus) parts.push(googleStatus);
  if (googleMessage) parts.push(googleMessage);
  const message = sanitizeTextSearchMessage(
    parts.join(' ') || `Places text search HTTP ${httpStatus || 'error'}`,
    apiKey
  );
  const error = new Error(message);
  error.status = httpStatus || null;
  error.googleStatus = googleStatus.slice(0, 80);
  return error;
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
  if (!res.ok) throw placesTextSearchFailure(res, json, apiKey);
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

function buildWavePairs(targets, tiles) {
  const pairs = [];
  const targetList = Array.isArray(targets) ? targets : [];
  const tileList = Array.isArray(tiles) ? tiles : [];
  for (let targetIndex = 0; targetIndex < targetList.length; targetIndex += 1) {
    for (let tileIndex = 0; tileIndex < tileList.length; tileIndex += 1) {
      pairs.push({ targetIndex, tileIndex });
    }
  }
  return pairs;
}

function filterTargets(targets, query) {
  if (!query) return targets;
  const needle = String(query).trim().toLowerCase();
  return targets.filter((target) => {
    const text = String(target.query || '').trim().toLowerCase();
    const key = String(target.key || '').trim().toLowerCase();
    return text === needle || key === needle;
  });
}

function sliceTiles(tiles, tileStart, tileCount) {
  if (tileStart == null && tileCount == null) return tiles;
  const start = Math.max(0, Number(tileStart) || 0);
  const count = tileCount == null || tileCount === '' ? tiles.length : Math.max(0, Number(tileCount) || 0);
  return tiles.slice(start, start + count);
}

function isQuotaError(err) {
  return err instanceof PlacesQuotaError || err?.code === 'cap';
}

/**
 * Dry-run a wave into staging rows. Never inserts into `locations`.
 * Network callers are injectable so tests do not hit Google.
 *
 * A chunk passes `cursor.pairIndex`, `timeBudgetMs`, and `now`. The clock is
 * checked before every network call. An unfinished pair keeps the same cursor
 * so the next chunk can continue it (Places responses should be cached).
 */
async function runWave(options = {}) {
  const plan = planWave(options.wave || 'A', {
    stepLat: options.stepLat,
    stepLng: options.stepLng,
  });
  if (Array.isArray(options.targets) && options.targets.length) {
    plan.waveDef = { ...plan.waveDef, targets: options.targets };
  }
  if (options.query) {
    const filtered = filterTargets(plan.waveDef.targets, options.query);
    if (!filtered.length) {
      throw new Error(`Немає цілі хвилі для запиту «${String(options.query).slice(0, 80)}»`);
    }
    plan.waveDef = { ...plan.waveDef, targets: filtered };
  }
  if (Array.isArray(options.tiles) && options.tiles.length) {
    plan.tiles = options.tiles;
  }
  plan.tiles = sliceTiles(plan.tiles, options.tileStart, options.tileCount);
  plan.tileCount = plan.tiles.length;
  plan.plannedTextSearch = plan.tiles.length * plan.waveDef.targets.length;
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
    lastTextSearchError: null,
    lastTextSearchHttpStatus: null,
  };
  const bump = (reason) => {
    counts.skipped[reason] = (counts.skipped[reason] || 0) + 1;
  };

  const seen = new Set();
  const knownPlaceIds = options.knownPlaceIds instanceof Set
    ? options.knownPlaceIds
    : new Set(options.knownPlaceIds || []);
  const batch = (Array.isArray(options.batchSeed) ? options.batchSeed : []).map((row) => ({
    id: row.id || `staged:${row.place_id || row.placeId || ''}`,
    placeId: row.place_id || row.placeId,
    title: row.title || row.proposed_title,
    phone: row.phone || row.proposed_phone,
    lat: row.lat ?? row.proposed_lat,
    lng: row.lng ?? row.proposed_lng,
  }));
  const staged = [];
  let stoppedReason = null;
  const pairs = buildWavePairs(wave.targets, plan.tiles);
  const startPair = Math.max(0, Math.min(pairs.length, Number(options.cursor?.pairIndex ?? options.pairStart ?? 0) || 0));
  const budgetMs = Number(options.timeBudgetMs);
  const hasBudget = Number.isFinite(budgetMs) && budgetMs > 0;
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  const startedAt = nowFn();

  function overTime() {
    if (!hasBudget) return false;
    return nowFn() - startedAt >= budgetMs;
  }

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

  let pairCursor = startPair;
  let processedPairs = 0;
  let textErrorStreak = 0;
  let textErrorSignature = '';
  let textErrorStart = startPair;

  async function consumePlace(place, target, tile) {
    if (!place?.placeId || seen.has(place.placeId) || knownPlaceIds.has(place.placeId)) return 'ok';
    seen.add(place.placeId);
    counts.unique += 1;
    const listing = passesListingFilters(place);
    if (!listing.ok) {
      bump(listing.reason);
      return 'ok';
    }
    if (target.bakeryOnly && !looksLikeBakery(place)) {
      bump('not_bakery');
      return 'ok';
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
      return 'ok';
    }

    if (overTime()) return 'time';
    let detailed = enriched;
    try {
      const cacheKey = `details:${enriched.placeId}:${DETAILS_FIELD_MASK}`;
      const spent = await budget.spend('details', cacheKey, () =>
        detailsFetch({ placeId: enriched.placeId, apiKey })
      );
      detailed = detailsToPlace(enriched, spent.value);
    } catch (err) {
      if (isQuotaError(err)) {
        stoppedReason = 'details_cap';
        return 'cap';
      }
      bump('details_error');
      return 'ok';
    }

    const again = passesListingFilters(detailed);
    if (!again.ok) {
      bump(again.reason);
      return 'ok';
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
      return 'ok';
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
      return 'ok';
    }

    if (overTime()) return 'time';
    let classifier;
    try {
      classifier = await classify(detailed, masterCatalog);
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
      return 'ok';
    }

    if (overTime()) return 'time';
    let verification;
    try {
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
      return 'ok';
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
    return 'ok';
  }

  try {
    if (!apiKey && !options.textSearch) {
      throw new Error('GOOGLE_PLACES_API_KEY is not set');
    }
    for (let pairIndex = startPair; pairIndex < pairs.length; pairIndex += 1) {
      if (overTime()) {
        stoppedReason = 'time_budget';
        pairCursor = pairIndex;
        break;
      }
      const target = wave.targets[pairs[pairIndex].targetIndex];
      const tile = plan.tiles[pairs[pairIndex].tileIndex];
      let found = [];
      let pairIncomplete = false;
      try {
        const cacheKey = JSON.stringify({ q: target.query, tile, mask: TEXT_FIELD_MASK });
        const spent = await budget.spend('text', cacheKey, () =>
          textSearch({ query: target.query, bounds: tile, apiKey, target })
        );
        found = Array.isArray(spent.value) ? spent.value : [];
        textErrorStreak = 0;
        textErrorSignature = '';
      } catch (err) {
        if (isQuotaError(err)) {
          stoppedReason = 'text_search_cap';
          pairIncomplete = true;
        } else {
          const status = textSearchHttpStatus(err);
          const message = sanitizeTextSearchMessage(err?.message, apiKey);
          console.error('[places-v2] text_search_error', (status == null ? '' : String(status)) + ' ' + message);
          const fatal = searchTextFailureKind(err);
          if (fatal) {
            counts.lastTextSearchError = message || (status ? `HTTP ${status}` : fatal);
            counts.lastTextSearchHttpStatus = status;
            stoppedReason = fatal;
            pairIncomplete = true;
            bump(fatal);
          } else {
            if (counts.lastTextSearchError == null) {
              counts.lastTextSearchError = message || (status ? `HTTP ${status}` : 'text_search_error');
              counts.lastTextSearchHttpStatus = status;
            }
            const signature = `${status == null ? '' : status}\n${message}`;
            if (signature === textErrorSignature) textErrorStreak += 1;
            else {
              textErrorSignature = signature;
              textErrorStreak = 1;
              textErrorStart = pairIndex;
            }
            bump('text_search_error');
            if (textErrorStreak >= TEXT_SEARCH_ERROR_BREAKER) {
              stoppedReason = 'text_search_error';
              pairCursor = textErrorStart;
              processedPairs = Math.max(0, textErrorStart - startPair);
              break;
            }
            found = [];
          }
        }
      }
      if (!pairIncomplete) {
        counts.textHits += found.length;
        for (const place of found) {
          const outcome = await consumePlace(place, target, tile);
          if (outcome === 'time') {
            stoppedReason = 'time_budget';
            pairIncomplete = true;
            break;
          }
          if (outcome === 'cap') {
            pairIncomplete = true;
            break;
          }
        }
      }
      if (pairIncomplete) {
        pairCursor = pairIndex;
        break;
      }
      processedPairs += 1;
      pairCursor = pairIndex + 1;
    }
  } catch (err) {
    if (isQuotaError(err)) {
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
  const finished = pairCursor >= pairs.length;
  console.log(
    `[places-v2] wave ${wave.id} pairs=${processedPairs}/${pairs.length} cursor=${pairCursor} text=${cost.textSearchRequests} details=${cost.detailsRequests} cacheHits=${cost.cacheHits} staged=${counts.staged} estUsdIfUncapped=${cost.estimatedUsdIfFreeTierExhausted}`
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
    processed: processedPairs,
    total: pairs.length,
    done: finished,
    nextCursor: finished ? null : { pairIndex: pairCursor },
  };
}

module.exports = {
  TEXT_FIELD_MASK,
  DETAILS_FIELD_MASK,
  passesListingFilters,
  planWave,
  buildWavePairs,
  runWave,
  candidateRow,
  placeIdOf,
};
