'use strict';

const { supabaseClient } = require('./supabaseClient.js');

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
    prices: loc.prices || {},
    reviews: loc.reviews || [],
    views: Number(loc.views) || 0,
    photos: Array.isArray(loc.photos) ? loc.photos : [],
    import_source: loc.importSource || loc.importMeta?.source || null,
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
    prices: row.prices || {},
    reviews: row.reviews || [],
    views: Number(row.views) || 0,
    photos: Array.isArray(row.photos) ? row.photos : [],
    importSource: row.import_source || null,
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
  return {
    ok: true,
    locations: (data || []).map(fromDbRow).filter(Boolean),
  };
}

async function upsertLocationsToSupabase(locations) {
  if (!Array.isArray(locations) || locations.length === 0) {
    return { ok: true, count: 0 };
  }
  const rows = locations.map(toDbRow);
  let { error } = await supabaseClient.from(LOCATIONS_TABLE).upsert(rows, { onConflict: 'id' });
  if (error && /photos/i.test(String(error.message || ''))) {
    const withoutPhotos = rows.map(({ photos, ...rest }) => rest);
    ({ error } = await supabaseClient
      .from(LOCATIONS_TABLE)
      .upsert(withoutPhotos, { onConflict: 'id' }));
  }
  if (error && /views/i.test(String(error.message || ''))) {
    const withoutViews = rows.map(({ views, photos, ...rest }) => rest);
    ({ error } = await supabaseClient
      .from(LOCATIONS_TABLE)
      .upsert(withoutViews, { onConflict: 'id' }));
  }
  if (error) {
    return { ok: false, error };
  }
  return { ok: true, count: rows.length };
}

async function syncAllLocationsToSupabase(locations) {
  return upsertLocationsToSupabase(locations);
}

module.exports = {
  LOCATIONS_TABLE,
  fetchLocationsFromSupabase,
  upsertLocationsToSupabase,
  syncAllLocationsToSupabase,
  toDbRow,
  fromDbRow,
};
