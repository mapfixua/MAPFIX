'use strict';

/**
 * Daily rollups for the admin statistics screen.
 * History is read from analytics_daily / analytics_search_daily / analytics_location_daily.
 * Today (and yesterday, until the cron has rolled it) is aggregated in Postgres
 * from analytics_events for that Kyiv day only. The Node process does not scan
 * the journal. The workbook is built here as JSON; SheetJS in the browser writes the file.
 */
const { supabaseClient } = require('./supabaseClient.js');
const analyticsEvents = require('./analytics-events.js');
const dims = require('./analytics-dimensions.js');

const PURGE_LIMIT = 5000;
const ROLLUP_BUDGET_MS = 20000;
const MAX_PURGE_BATCHES = 8;

function isMissingRpc(error) {
  if (!error) return false;
  const msg = String(error.message || error);
  return (
    error.code === 'PGRST202' ||
    error.code === '42883' ||
    error.missing === true ||
    /could not find the function|does not exist|schema cache/i.test(msg)
  );
}

async function defaultRpc(name, args) {
  const { data, error } = await supabaseClient.rpc(name, args || {});
  if (error) {
    const err = new Error(error.message || name);
    err.code = error.code;
    err.missing = isMissingRpc(error);
    throw err;
  }
  return data;
}

function sanitizeFilters(query = {}) {
  const district = String(query.district || '').trim();
  const category = String(query.category || '').trim();
  const source = String(query.source || '').trim().slice(0, dims.SOURCE_MAX || 120);
  const device = String(query.device || '').trim();
  return {
    district: !district || district === dims.UNKNOWN_TOKEN || dims.DISTRICT_KEYS.includes(district) ? district : '',
    category:
      !category || category === dims.UNKNOWN_TOKEN || /^[a-z0-9_-]{1,48}$/.test(category) ? category : '',
    source: !source || source === dims.UNKNOWN_TOKEN || /^[\w .+\-/]{1,120}$/.test(source) ? source : '',
    device: ['', dims.UNKNOWN_TOKEN, 'mobile', 'tablet', 'desktop'].includes(device) ? device : '',
  };
}

function resolveRange(query = {}) {
  let parsed = analyticsEvents.parseRange(query);
  if (!parsed.fromDay || !parsed.toDay) parsed = analyticsEvents.parseRange({ range: '7d' });
  let fromDay = parsed.fromDay;
  const toDay = parsed.toDay;
  if (dims.inclusiveDays(fromDay, toDay) > 366) fromDay = dims.shiftDay(toDay, -365);
  return { key: parsed.key, fromDay, toDay };
}

function rpcArgs(range, filters) {
  return {
    p_from: range.fromDay,
    p_to: range.toDay,
    p_district: filters.district || '',
    p_category: filters.category || '',
    p_source: filters.source || '',
    p_device: filters.device || '',
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function placeList(rows, kind, catalog) {
  return asArray(rows)
    .map((row) => {
      const metrics = dims.withRates(row);
      const key = row.key || '';
      return {
        ...metrics,
        key,
        label: kind === 'category' ? dims.categoryLabel(key, catalog) : dims.districtLabel(key),
        kind,
      };
    })
    .sort((a, b) => b.contacts - a.contacts || b.views - a.views || a.label.localeCompare(b.label, 'uk'));
}

function sourceList(rows) {
  return asArray(rows)
    .map((row) => {
      const contacts = dims.num(row.calls) + dims.num(row.chats) + dims.num(row.directions);
      return {
        key: row.key || '',
        label: dims.sourceLabel(row.key),
        views: dims.num(row.views),
        calls: dims.num(row.calls),
        chats: dims.num(row.chats),
        directions: dims.num(row.directions),
        contacts,
        conversion: dims.rate(contacts, row.views),
      };
    })
    .filter((row) => row.views || row.contacts || row.key)
    .sort((a, b) => b.contacts - a.contacts || b.views - a.views || a.label.localeCompare(b.label, 'uk'));
}

function searchList(rows) {
  return asArray(rows)
    .map((row) => {
      const events = dims.num(row.events);
      const zeroEvents = dims.num(row.zeroEvents);
      return {
        q: dims.clipQuery(row.q),
        district: row.district || '',
        districtLabel: dims.districtLabel(row.district),
        events,
        zeroEvents,
        zeroShare: dims.rate(zeroEvents, events),
      };
    })
    .filter((row) => row.q)
    .sort((a, b) => b.events - a.events || a.q.localeCompare(b.q, 'uk'));
}

function cardMatches(loc, filters) {
  const district = dims.cardDistrict(loc);
  const category = dims.cardCategory(loc);
  if (filters.district === dims.UNKNOWN_TOKEN) return false;
  if (filters.district && district !== filters.district) return false;
  if (filters.category === dims.UNKNOWN_TOKEN) return !category;
  if (filters.category && category !== filters.category) return false;
  return true;
}

function buildMasters(locations, locationRows, reports, catalog, filters, now) {
  const byId = new Map(asArray(locationRows).map((row) => [String(row.id), row]));
  const stale = dims.openStalePhoneByLocation(reports);
  const rows = [];
  for (const loc of locations || []) {
    if (!loc || !loc.id || !cardMatches(loc, filters)) continue;
    const metrics = byId.get(String(loc.id)) || {};
    const quality = dims.masterQuality(loc, stale.get(String(loc.id)) || 0, now);
    const views = dims.num(metrics.views);
    const calls = dims.num(metrics.calls);
    const chats = dims.num(metrics.chats);
    const directions = dims.num(metrics.directions);
    const contacts = calls + chats + directions;
    const category = dims.cardCategory(loc);
    const district = dims.cardDistrict(loc);
    rows.push({
      id: String(loc.id),
      title: loc.title || String(loc.id),
      category: category || '',
      categoryLabel: dims.categoryLabel(category, catalog),
      district: district || '',
      districtLabel: dims.districtLabel(district),
      ...quality,
      impressions: dims.num(metrics.impressions),
      views,
      calls,
      chats,
      directions,
      favorites: dims.num(metrics.favorites),
      orders: dims.num(metrics.orders),
      contacts,
      callRate: dims.rate(calls, views),
      viewsWithoutContact: contacts === 0 ? views : 0,
    });
  }
  rows.sort((a, b) => b.contacts - a.contacts || b.views - a.views || a.title.localeCompare(b.title, 'uk'));
  return rows;
}

function mapOptions(options, catalog) {
  const raw = options && typeof options === 'object' ? options : {};
  return {
    districts: asArray(raw.districts),
    categories: asArray(raw.categories).map((key) => ({
      key: key || '',
      label: dims.categoryLabel(key, catalog),
    })),
    sources: asArray(raw.sources),
    devices: asArray(raw.devices),
  };
}

function emptySpan() {
  return {
    partial: false,
    totals: {},
    days: [],
    districts: [],
    categories: [],
    sources: [],
    devices: [],
    searches: [],
    locations: [],
    options: { districts: [], categories: [], sources: [], devices: [] },
  };
}

/**
 * Turn one dashboard payload plus the card list into the screen and the workbook.
 * Call rate is calls / card opens inside this same payload, never lifetime views.
 */
function assembleStatistics({
  current,
  previous,
  range,
  filters,
  locations,
  reports,
  catalog,
  missing = false,
  now = new Date(),
} = {}) {
  const cur = current || emptySpan();
  const prev = previous || emptySpan();
  const period = dims.withRates(cur.totals);
  const previousPeriod = dims.withRates(prev.totals);
  const delta = dims.deltaMap(period, previousPeriod);
  const daily = dims.fillDays(range.fromDay, range.toDay, asArray(cur.days)).map((row) => dims.dayRow(row));
  const districts = placeList(cur.districts, 'district', catalog);
  const categories = placeList(cur.categories, 'category', catalog);
  const sources = sourceList(cur.sources);
  const devices = asArray(cur.devices).map((row) => ({
    key: row.key || '',
    label: dims.deviceLabel(row.key),
    sessions: dims.num(row.sessions),
    views: dims.num(row.views),
    calls: dims.num(row.calls),
    chats: dims.num(row.chats),
    directions: dims.num(row.directions),
    contacts: dims.num(row.calls) + dims.num(row.chats) + dims.num(row.directions),
  }));
  const searches = searchList(cur.searches);
  const masters = buildMasters(locations, cur.locations, reports, catalog, filters, now);
  const exportSheets = dims.buildExportSheets({
    days: daily,
    districts,
    categories,
    sources,
    searches,
    masters,
  });
  const previousWindow = dims.previousWindow(range.fromDay, range.toDay);
  const compare = dims.compareLabel(previousWindow.fromDay, previousWindow.toDay);
  let hint =
    'Стрілка — зміна проти попереднього вікна тієї ж довжини (' +
    compare +
    '). Call rate = дзвінки / відкриття карток за обраний період. Сьогодні читається з журналу, попередні дні — зі зведень.';
  if (missing) {
    hint =
      'Таблиці зведень ще немає. Застосуйте міграцію 024_analytics_district_category_rollups.sql, потім npm run analytics:backfill. Онлайн працює як раніше.';
  } else if (cur.partial) {
    hint =
      'Частину днів ще не зведено. Після міграції 024 виконайте npm run analytics:backfill — повторний запуск безпечний. ' +
      hint;
  }
  return {
    filters: {
      range: range.key,
      fromDay: range.fromDay,
      toDay: range.toDay,
      previousFrom: previousWindow.fromDay,
      previousTo: previousWindow.toDay,
      district: filters.district || '',
      category: filters.category || '',
      source: filters.source || '',
      device: filters.device || '',
    },
    compareLabel: compare,
    hint,
    rollupsMissing: Boolean(missing),
    historyPartial: Boolean(cur.partial),
    period,
    previous: previousPeriod,
    delta,
    daily,
    districts,
    categories,
    sources,
    devices,
    searchesTop: searches.slice(0, 40),
    zeroSearches: searches.filter((row) => row.zeroEvents > 0).slice(0, 40),
    topLocations: masters.slice(0, 25).map((row) => ({
      id: row.id,
      title: row.title,
      call: row.calls,
      directions: row.directions,
      views: row.views,
      callRate: row.callRate,
      contacts: row.contacts,
      cat: row.category,
    })),
    exportSheets,
    filterOptions: mapOptions(cur.options, catalog),
  };
}

async function loadSpan(range, filters, rpc) {
  const data = await rpc('analytics_dashboard', rpcArgs(range, filters));
  if (data && data.error) throw new Error(data.error);
  return data || emptySpan();
}

async function buildAdminTraffic({ query, locations, reports, catalog, rpc, now } = {}) {
  const call = rpc || defaultRpc;
  const range = resolveRange(query || {});
  const filters = sanitizeFilters(query || {});
  const previous = dims.previousWindow(range.fromDay, range.toDay);
  try {
    const [current, prevSpan] = await Promise.all([
      loadSpan(range, filters, call),
      loadSpan({ key: 'previous', fromDay: previous.fromDay, toDay: previous.toDay }, filters, call),
    ]);
    return assembleStatistics({
      current,
      previous: prevSpan,
      range,
      filters,
      locations,
      reports,
      catalog,
      now,
    });
  } catch (err) {
    if (err.missing || isMissingRpc(err)) {
      return assembleStatistics({
        current: emptySpan(),
        previous: emptySpan(),
        range,
        filters,
        locations,
        reports,
        catalog,
        missing: true,
        now,
      });
    }
    console.warn('[analytics rollup]', err.message);
    return assembleStatistics({
      current: emptySpan(),
      previous: emptySpan(),
      range,
      filters,
      locations,
      reports,
      catalog,
      missing: true,
      now,
    });
  }
}

/**
 * Cron step: roll up yesterday (replace, so a repeat is safe) and delete old raw
 * rows in batches of 5000 until the time budget or a short batch. Today is not rolled.
 */
async function runCronStep({ rpc, today, budgetMs = ROLLUP_BUDGET_MS, maxBatches = MAX_PURGE_BATCHES } = {}) {
  const call = rpc || defaultRpc;
  const day = today || analyticsEvents.kyivDayKey();
  const yesterday = dims.shiftDay(day, -1);
  const started = Date.now();
  let rolled;
  try {
    rolled = await call('analytics_rollup_day', { p_day: yesterday });
  } catch (err) {
    if (err.missing || isMissingRpc(err)) return { ok: false, missing: true, day: yesterday };
    return { ok: false, day: yesterday, error: err.message || String(err) };
  }
  const purged = { impressions: 0, events: 0, batches: 0 };
  while (Date.now() - started < budgetMs && purged.batches < maxBatches) {
    let batch;
    try {
      batch = await call('analytics_purge_raw', { p_limit: PURGE_LIMIT });
    } catch (err) {
      if (err.missing || isMissingRpc(err)) break;
      return { ok: false, day: yesterday, rolled, purged, error: err.message || String(err) };
    }
    const impressions = dims.num(batch?.impressions);
    const events = dims.num(batch?.events);
    purged.impressions += impressions;
    purged.events += events;
    purged.batches += 1;
    if (impressions + events < PURGE_LIMIT) break;
  }
  return {
    ok: true,
    day: yesterday,
    rolled,
    purged,
    elapsedMs: Date.now() - started,
  };
}

module.exports = {
  PURGE_LIMIT,
  ROLLUP_BUDGET_MS,
  isMissingRpc,
  sanitizeFilters,
  resolveRange,
  assembleStatistics,
  buildAdminTraffic,
  buildMasters,
  runCronStep,
  emptySpan,
};
