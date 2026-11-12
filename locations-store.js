'use strict';

const { supabaseClient } = require('./supabaseClient.js');
const {
  overlayLocations,
  syncLocationPrices,
  syncUserReviews,
} = require('./relational-store.js');

const LOCATIONS_TABLE = process.env.SUPABASE_LOCATIONS_TABLE || 'locations';

function toDbRow(loc) {
  return {
    id: loc.id,
    provider_id: loc.providerId || null,
    lat: loc.lat,
    lng: loc.lng,
    cat: loc.cat,
    title: loc.title,
    text: loc.text || '',
    rating: loc.rating ?? 0,
    reviews_count: loc.reviewsCount ?? 0,
    open_status: loc.openStatus || 'open',
    working_hours: loc.workingHours || '',
    phone: loc.phone || '',
    address: loc.address || '',
    schedule: loc.schedule || {},
    subcats: loc.subcats || [],
    custom_subcats: Array.isArray(loc.customSubcats) ? loc.customSubcats : [],
    prices: loc.prices || {},
    reviews: loc.reviews || [],
    views: Number(loc.views) || 0,
    photos: Array.isArray(loc.photos) ? loc.photos : [],
    import_source: loc.importSource || loc.importMeta?.source || null,
    claimed_at: loc.claimedAt || null,
    deleted_at: loc.deletedAt || null,
    deleted_reason: loc.deletedReason || null,
    google_place_id: loc.googlePlaceId ? String(loc.googlePlaceId).replace(/^places\//, '') : null,
    business_status: loc.businessStatus || null,
    last_review_at: loc.lastReviewAt || null,
    review_dates: Array.isArray(loc.reviewDates) ? loc.reviewDates : [],
    updated_at: new Date().toISOString(),
  };
}

function fromDbRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    providerId: row.provider_id || null,
    lat: Number(row.lat),
    lng: Number(row.lng),
    cat: row.cat,
    title: row.title,
    text: row.text || '',
    rating: Number(row.rating) || 0,
    reviewsCount: Number(row.reviews_count) || 0,
    openStatus: row.open_status || 'open',
    workingHours: row.working_hours || '',
    phone: row.phone || '',
    address: row.address || '',
    schedule: row.schedule || {},
    subcats: row.subcats || [],
    customSubcats: Array.isArray(row.custom_subcats) ? row.custom_subcats : [],
    prices: row.prices || {},
    reviews: row.reviews || [],
    views: Number(row.views) || 0,
    photos: Array.isArray(row.photos) ? row.photos : [],
    importSource: row.import_source || null,
    claimedAt: row.claimed_at || null,
    deletedAt: row.deleted_at || null,
    deletedReason: row.deleted_reason || null,
    googlePlaceId: row.google_place_id || null,
    businessStatus: row.business_status || null,
    lastReviewAt: row.last_review_at || null,
    reviewDates: Array.isArray(row.review_dates) ? row.review_dates : [],
    updatedAt: row.updated_at || null,
    createdAt: row.created_at || null,
  };
}

async function fetchLocationsFromSupabase() {
  const { data, error } = await supabaseClient.from(LOCATIONS_TABLE).select('*');
  if (error) {
    if (String(error.message).includes('Could not find the table') || error.code === '42P01') {
      return { ok: false, missing: true, locations: [], error };
    }
    return { ok: false, locations: [], error };
  }
  const locations = (data || []).map(fromDbRow).filter(Boolean);
  try {
    return { ok: true, locations: await overlayLocations(locations) };
  } catch (overlayError) {
    console.warn('[locations] overlay skipped:', overlayError.message);
    return { ok: true, locations };
  }
}

async function fetchLocationSitemapRows() {
  const attempts = ['id,title,updated_at,deleted_at', 'id,title,deleted_at', 'id,title', 'id,updated_at,deleted_at', 'id'];
  let data;
  let error;
  for (const columns of attempts) {
    ({ data, error } = await supabaseClient.from(LOCATIONS_TABLE).select(columns).limit(5000));
    if (!error) break;
  }
  if (error) return { ok: false, rows: [], error };
  return {
    ok: true,
    rows: (data || [])
      .map((row) => ({
        id: row.id,
        title: row.title || '',
        lastmod: String(row.updated_at || '').slice(0, 10),
        deletedAt: row.deleted_at || null,
      }))
      .filter((row) => row.id),
  };
}

async function upsertLocationsToSupabase(locations) {
  if (!Array.isArray(locations) || locations.length === 0) {
    return { ok: true, count: 0 };
  }
  let rows = locations.map(toDbRow);
  let { error } = await supabaseClient.from(LOCATIONS_TABLE).upsert(rows, { onConflict: 'id' });

  // Drop optional columns gradually if migration not applied yet
  const stripMatchers = [
    [/google_place_id|business_status|last_review_at|review_dates/i, (r) => {
      const { google_place_id, business_status, last_review_at, review_dates, ...rest } = r;
      return rest;
    }],
    [/claimed_at/i, (r) => {
      const { claimed_at, ...rest } = r;
      return rest;
    }],
    [/deleted_at|deleted_reason/i, (r) => {
      const { deleted_at, deleted_reason, ...rest } = r;
      return rest;
    }],
    [/photos/i, (r) => {
      const { photos, ...rest } = r;
      return rest;
    }],
    [/views/i, (r) => {
      const { views, ...rest } = r;
      return rest;
    }],
  ];

  for (const [re, stripFn] of stripMatchers) {
    if (error && re.test(String(error.message || ''))) {
      rows = rows.map(stripFn);
      ({ error } = await supabaseClient.from(LOCATIONS_TABLE).upsert(rows, { onConflict: 'id' }));
    }
  }

  if (error) {
    return { ok: false, error };
  }
  const synced = await syncLocationPrices(locations);
  if (!synced.ok) {
    console.warn('[locations] price table:', synced.error?.message || synced.error);
  }
  const reviews = await syncUserReviews(locations);
  if (!reviews.ok) {
    console.warn('[locations] review table:', reviews.error?.message || reviews.error);
  }
  return { ok: true, count: rows.length };
}

async function deleteLocationsFromSupabase(ids) {
  const list = (Array.isArray(ids) ? ids : []).map((id) => String(id)).filter(Boolean);
  if (!list.length) return { ok: true, count: 0 };
  const { error } = await supabaseClient.from(LOCATIONS_TABLE).delete().in('id', list);
  if (error) return { ok: false, error };
  return { ok: true, count: list.length };
}

async function syncAllLocationsToSupabase(locations) {
  return upsertLocationsToSupabase(locations);
}

module.exports = {
  LOCATIONS_TABLE,
  fetchLocationsFromSupabase,
  fetchLocationSitemapRows,
  upsertLocationsToSupabase,
  deleteLocationsFromSupabase,
  syncAllLocationsToSupabase,
  toDbRow,
  fromDbRow,
};
