'use strict';

/**
 * Live rows for orders, favorites, reports, user reviews, and price lists.
 * The map still receives prices and reviews on the location object; those
 * fields are filled from these tables when the rows exist.
 */

const { supabaseClient } = require('./supabaseClient.js');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asUuid(value) {
  const id = String(value || '').trim();
  return UUID_RE.test(id) ? id : null;
}

function priceAmount(label) {
  const match = String(label || '')
    .replace(/\s/g, '')
    .match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const n = Number(match[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function contactMode(value) {
  return ['call', 'message', 'any'].includes(value) ? value : 'any';
}

async function selectAll(table, columns) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseClient
      .from(table)
      .select(columns)
      .range(from, from + pageSize - 1);
    if (error) return { ok: false, error, rows: [] };
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return { ok: true, rows };
}

function orderFromRow(row) {
  return {
    id: row.id,
    clientId: row.client_id || null,
    providerId: row.provider_id || null,
    locationId: row.location_id || '',
    serviceId: row.location_id && row.service_name ? `${row.location_id}::${row.service_name}` : '',
    serviceName: row.service_name || '',
    price: row.price_label || '',
    preferredAt: row.preferred_at || null,
    note: row.note || null,
    contactMode: row.contact_mode || 'any',
    status: row.status || 'Очікує',
    providerNote: row.provider_note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function orderToRow(order) {
  const id = asUuid(order.id);
  if (!id || !String(order.serviceName || '').trim()) return null;
  return {
    id,
    client_id: asUuid(order.clientId),
    provider_id: asUuid(order.providerId),
    location_id: order.locationId ? String(order.locationId) : null,
    service_name: String(order.serviceName).trim().slice(0, 300),
    price_label: String(order.price || '').slice(0, 80),
    preferred_at: order.preferredAt ? String(order.preferredAt).slice(0, 80) : null,
    note: order.note ? String(order.note).slice(0, 1000) : null,
    contact_mode: contactMode(order.contactMode),
    status: String(order.status || 'Очікує').slice(0, 40),
    provider_note: String(order.providerNote || '').slice(0, 1000),
    created_at: order.createdAt || new Date().toISOString(),
    updated_at: order.updatedAt || new Date().toISOString(),
  };
}

async function readOrderRows() {
  const remote = await selectAll(
    'service_orders',
    'id, client_id, provider_id, location_id, service_name, price_label, preferred_at, note, contact_mode, status, provider_note, created_at, updated_at'
  );
  if (!remote.ok) return remote;
  return { ok: true, rows: remote.rows.map(orderFromRow) };
}

async function knownIds(table) {
  const remote = await selectAll(table, 'id');
  if (!remote.ok) return null;
  return new Set(remote.rows.map((row) => row.id));
}

async function writeOrderRows(orders) {
  const rows = (orders || []).map(orderToRow).filter(Boolean);
  if (!rows.length) return { ok: true, count: 0 };
  const userIds = await knownIds('users');
  const locationIds = await knownIds('locations');
  for (const row of rows) {
    if (userIds && row.client_id && !userIds.has(row.client_id)) row.client_id = null;
    if (userIds && row.provider_id && !userIds.has(row.provider_id)) row.provider_id = null;
    if (locationIds && row.location_id && !locationIds.has(row.location_id)) row.location_id = null;
  }
  const { error } = await supabaseClient.from('service_orders').upsert(rows, { onConflict: 'id' });
  if (error) return { ok: false, error };
  return { ok: true, count: rows.length };
}

function favoriteFromRow(row) {
  return {
    clientId: row.client_id,
    locationId: row.location_id,
    addedAt: row.added_at,
  };
}

async function readFavoriteRows() {
  const remote = await selectAll('client_favorites', 'client_id, location_id, added_at');
  if (!remote.ok) return remote;
  return { ok: true, rows: remote.rows.map(favoriteFromRow) };
}

async function writeFavoriteRows(favorites) {
  const userIds = await knownIds('users');
  const locationIds = await knownIds('locations');
  const rows = (favorites || [])
    .map((item) => {
      const clientId = asUuid(item.clientId);
      const locationId = String(item.locationId || '').trim();
      if (!clientId || !locationId) return null;
      if (userIds && !userIds.has(clientId)) return null;
      if (locationIds && !locationIds.has(locationId)) return null;
      return {
        client_id: clientId,
        location_id: locationId,
        added_at: item.addedAt || new Date().toISOString(),
      };
    })
    .filter(Boolean);
  if (rows.length) {
    const { error } = await supabaseClient
      .from('client_favorites')
      .upsert(rows, { onConflict: 'client_id,location_id' });
    if (error) return { ok: false, error };
  }
  const existing = await selectAll('client_favorites', 'client_id, location_id');
  if (!existing.ok) return { ok: true, count: rows.length };
  const keep = new Set(rows.map((row) => `${row.client_id}|${row.location_id}`));
  const stale = existing.rows.filter((row) => !keep.has(`${row.client_id}|${row.location_id}`));
  for (const row of stale) {
    await supabaseClient
      .from('client_favorites')
      .delete()
      .eq('client_id', row.client_id)
      .eq('location_id', row.location_id);
  }
  return { ok: true, count: rows.length };
}

function reportFromRow(row) {
  return {
    id: row.id,
    reporterId: row.reporter_id || null,
    reporterLogin: row.reporter_login || '',
    contact: row.contact || '',
    locationId: row.location_id || '',
    locationTitle: row.location_title || '',
    reason: row.reason || '',
    message: row.message || '',
    page: row.page || '',
    status: row.status || 'new',
    adminNote: row.admin_note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function reportToRow(report) {
  const id = asUuid(report.id);
  if (!id || !String(report.message || '').trim()) return null;
  return {
    id,
    reporter_id: asUuid(report.reporterId),
    reporter_login: String(report.reporterLogin || '').slice(0, 120),
    contact: String(report.contact || '').slice(0, 120),
    location_id: String(report.locationId || '').slice(0, 200),
    location_title: String(report.locationTitle || '').slice(0, 200),
    reason: String(report.reason || '').slice(0, 40),
    message: String(report.message).slice(0, 2000),
    page: String(report.page || '').slice(0, 200),
    status: ['new', 'reviewing', 'resolved', 'rejected'].includes(report.status) ? report.status : 'new',
    admin_note: String(report.adminNote || '').slice(0, 2000),
    created_at: report.createdAt || new Date().toISOString(),
    updated_at: report.updatedAt || new Date().toISOString(),
  };
}

async function readReportRows() {
  const remote = await selectAll(
    'moderation_reports',
    'id, reporter_id, reporter_login, contact, location_id, location_title, reason, message, page, status, admin_note, created_at, updated_at'
  );
  if (!remote.ok) return remote;
  return {
    ok: true,
    rows: remote.rows
      .map(reportFromRow)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  };
}

async function writeReportRows(reports) {
  const rows = (reports || []).map(reportToRow).filter(Boolean);
  if (!rows.length) return { ok: true, count: 0 };
  const userIds = await knownIds('users');
  if (userIds) {
    for (const row of rows) {
      if (row.reporter_id && !userIds.has(row.reporter_id)) row.reporter_id = null;
    }
  }
  const { error } = await supabaseClient.from('moderation_reports').upsert(rows, { onConflict: 'id' });
  if (error) return { ok: false, error };
  return { ok: true, count: rows.length };
}

function reviewFromRow(row) {
  const created = row.created_at ? new Date(row.created_at) : new Date();
  const date = Number.isNaN(created.getTime())
    ? ''
    : `${String(created.getDate()).padStart(2, '0')}.${String(created.getMonth() + 1).padStart(2, '0')}.${created.getFullYear()}`;
  return {
    id: row.id,
    text: row.body || '',
    rating: Number(row.rating) || 5,
    date,
    userId: row.user_id || null,
    userLogin: row.user_login || '',
    createdAt: row.created_at,
  };
}

async function insertLocationReview(review, locationId) {
  const id = asUuid(review.id);
  const body = String(review.text || review.body || '').trim();
  if (!id || !locationId || body.length < 3) return { ok: false, skipped: true };
  const row = {
    id,
    location_id: String(locationId),
    user_id: asUuid(review.userId),
    user_login: String(review.userLogin || '').slice(0, 120),
    rating: Math.max(1, Math.min(5, Number(review.rating) || 5)),
    body: body.slice(0, 1000),
    created_at: review.createdAt || new Date().toISOString(),
  };
  const { error } = await supabaseClient.from('location_reviews').upsert(row, { onConflict: 'id' });
  if (error) return { ok: false, error };
  return { ok: true };
}

async function loadReviewMap() {
  const remote = await selectAll(
    'location_reviews',
    'id, location_id, user_id, user_login, rating, body, created_at'
  );
  if (!remote.ok) return remote;
  const byLocation = new Map();
  for (const row of remote.rows) {
    const list = byLocation.get(row.location_id) || [];
    list.push(reviewFromRow(row));
    byLocation.set(row.location_id, list);
  }
  return { ok: true, byLocation };
}

function mergeReviews(location, extra) {
  const current = Array.isArray(location.reviews) ? location.reviews : [];
  const seen = new Set(current.map((item) => item && item.id).filter(Boolean));
  const merged = current.slice();
  for (const review of extra || []) {
    if (review.id && seen.has(review.id)) continue;
    merged.unshift(review);
  }
  merged.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return merged.slice(0, 40);
}

async function loadPriceMap() {
  const remote = await selectAll(
    'location_services',
    'location_id, name, price_label, is_active'
  );
  if (!remote.ok) return remote;
  const byLocation = new Map();
  for (const row of remote.rows) {
    if (row.is_active === false) continue;
    const prices = byLocation.get(row.location_id) || {};
    if (row.name) prices[row.name] = row.price_label || '';
    byLocation.set(row.location_id, prices);
  }
  return { ok: true, byLocation };
}

function serviceRowsForLocation(loc) {
  const prices = loc && loc.prices && typeof loc.prices === 'object' ? loc.prices : {};
  return Object.entries(prices)
    .map(([name, label], index) => {
      const serviceName = String(name || '').trim();
      if (!serviceName || !loc.id) return null;
      return {
        location_id: String(loc.id),
        category_key: String(loc.cat || ''),
        subcategory_key: '',
        name: serviceName.slice(0, 300),
        duration_minutes: 60,
        price_amount: priceAmount(label),
        currency: 'UAH',
        price_label: String(label || '').slice(0, 80),
        is_active: true,
        sort_order: index,
      };
    })
    .filter(Boolean);
}

let priceSyncBlocked = false;

async function syncLocationPrices(locations) {
  if (priceSyncBlocked) return { ok: false, skipped: true };
  const list = (locations || []).filter((loc) => loc && loc.id);
  if (!list.length) return { ok: true, count: 0 };
  let count = 0;
  for (const loc of list) {
    const rows = serviceRowsForLocation(loc);
    if (rows.length) {
      const { error } = await supabaseClient
        .from('location_services')
        .upsert(rows, { onConflict: 'location_id,name' });
      if (error) {
        if (/row-level security/i.test(String(error.message || ''))) priceSyncBlocked = true;
        return { ok: false, error };
      }
      count += rows.length;
    }
    const existing = await supabaseClient
      .from('location_services')
      .select('id, name')
      .eq('location_id', String(loc.id));
    if (existing.error) return { ok: false, error: existing.error };
    const keep = new Set(rows.map((row) => row.name));
    const staleIds = (existing.data || []).filter((row) => !keep.has(row.name)).map((row) => row.id);
    if (staleIds.length) {
      const { error: deleteError } = await supabaseClient.from('location_services').delete().in('id', staleIds);
      if (deleteError) return { ok: false, error: deleteError };
    }
  }
  return { ok: true, count };
}

async function syncUserReviews(locations) {
  const userIds = await knownIds('users');
  const locationIds = await knownIds('locations');
  const rows = [];
  for (const loc of locations || []) {
    if (locationIds && !locationIds.has(String(loc.id))) continue;
    for (const review of Array.isArray(loc.reviews) ? loc.reviews : []) {
      if (!review || !review.userId) continue;
      const id = asUuid(review.id);
      const body = String(review.text || '').trim();
      if (!id || body.length < 3) continue;
      rows.push({
        id,
        location_id: String(loc.id),
        user_id: userIds && asUuid(review.userId) && !userIds.has(asUuid(review.userId))
          ? null
          : asUuid(review.userId),
        user_login: String(review.userLogin || '').slice(0, 120),
        rating: Math.max(1, Math.min(5, Number(review.rating) || 5)),
        body: body.slice(0, 1000),
        created_at: review.createdAt || new Date().toISOString(),
      });
    }
  }
  if (!rows.length) return { ok: true, count: 0 };
  const { error } = await supabaseClient.from('location_reviews').upsert(rows, { onConflict: 'id' });
  if (error) return { ok: false, error };
  return { ok: true, count: rows.length };
}

async function overlayLocations(locations) {
  if (!Array.isArray(locations) || !locations.length) return locations;
  const [prices, reviews] = await Promise.all([loadPriceMap(), loadReviewMap()]);
  if (!prices.ok && !reviews.ok) return locations;
  return locations.map((loc) => {
    const next = { ...loc };
    const priceList = prices.ok ? prices.byLocation.get(loc.id) : null;
    if (priceList && Object.keys(priceList).length) next.prices = priceList;
    const extra = reviews.ok ? reviews.byLocation.get(loc.id) : null;
    if (extra && extra.length) {
      next.reviews = mergeReviews(loc, extra);
      const rated = next.reviews.filter((item) => Number(item.rating) > 0);
      if (rated.length) {
        const total = rated.reduce((sum, item) => sum + Number(item.rating), 0);
        next.reviewsCount = Math.max(Number(loc.reviewsCount) || 0, next.reviews.length);
        next.rating = Math.round((total / rated.length) * 10) / 10;
      }
    }
    return next;
  });
}

let backfillStarted = false;

async function backfillRelationalTables() {
  if (backfillStarted) return;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  backfillStarted = true;
  const { readOrders, readFavorites } = require('./kv-store.js');
  const { listReports } = require('./reports.js');
  const { fetchLocationsFromSupabase } = require('./locations-store.js');
  await readOrders();
  await readFavorites();
  await listReports();
  const remote = await fetchLocationsFromSupabase();
  if (!remote.ok) {
    console.warn('[backfill] locations:', remote.error?.message || remote.error);
    return;
  }
  const prices = await syncLocationPrices(remote.locations);
  if (!prices.ok && !prices.skipped) {
    console.warn('[backfill] prices:', prices.error?.message || prices.error);
  }
  const reviews = await syncUserReviews(remote.locations);
  if (!reviews.ok) {
    console.warn('[backfill] reviews:', reviews.error?.message || reviews.error);
  } else {
    console.log(
      `[backfill] прайсів: ${prices.count || 0}, відгуків клієнтів: ${reviews.count || 0}`
    );
  }
}

module.exports = {
  readOrderRows,
  writeOrderRows,
  readFavoriteRows,
  writeFavoriteRows,
  readReportRows,
  writeReportRows,
  insertLocationReview,
  syncLocationPrices,
  syncUserReviews,
  overlayLocations,
  backfillRelationalTables,
};
