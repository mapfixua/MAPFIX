'use strict';

/**
 * Product analytics for Mapfix (page views, search, live presence, daily KPIs).
 * Stored in catalog_snapshots via app-state-store — no new SQL required.
 */
const { loadAppState, saveAppState } = require('./app-state-store.js');

const STATE_ID = 'product_analytics';
const PRESENCE_TTL_MS = 90 * 1000;
const MAX_RECENT_SEARCHES = 300;
const MAX_SEARCH_KEYS = 400;
const MAX_PAGE_KEYS = 80;
const MAX_DAILY = 60;

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function emptyState() {
  return {
    pageViews: {},
    searchCounts: {},
    recentSearches: [],
    presence: {},
    totals: {
      pageViews: 0,
      searches: 0,
      heartbeats: 0,
      mapLoads: 0,
      locationOpens: 0,
      orders: 0,
      favorites: 0,
      logins: 0,
      registers: 0,
      claims: 0,
      supportTickets: 0,
      reports: 0,
      donateClicks: 0,
      subscribeClicks: 0,
    },
    daily: {},
  };
}

function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    pageViews: raw.pageViews && typeof raw.pageViews === 'object' ? raw.pageViews : {},
    searchCounts: raw.searchCounts && typeof raw.searchCounts === 'object' ? raw.searchCounts : {},
    recentSearches: Array.isArray(raw.recentSearches) ? raw.recentSearches : [],
    presence: raw.presence && typeof raw.presence === 'object' ? raw.presence : {},
    totals: { ...base.totals, ...(raw.totals || {}) },
    daily: raw.daily && typeof raw.daily === 'object' ? raw.daily : {},
  };
}

async function readState() {
  const remote = await loadAppState(STATE_ID, null);
  if (remote.ok && remote.value) return normalizeState(remote.value);
  return emptyState();
}

async function writeState(state) {
  const remote = await saveAppState(STATE_ID, state);
  if (!remote.ok && process.env.VERCEL && !remote.missing) {
    throw new Error('Не вдалося зберегти аналітику');
  }
  return remote;
}

function bumpDaily(state, field, n = 1) {
  const key = todayKey();
  if (!state.daily[key]) {
    state.daily[key] = {
      pageViews: 0,
      searches: 0,
      mapLoads: 0,
      locationOpens: 0,
      orders: 0,
      favorites: 0,
      logins: 0,
      registers: 0,
      uniqueSessions: {},
    };
  }
  const day = state.daily[key];
  day[field] = (Number(day[field]) || 0) + n;
  // prune old days
  const keys = Object.keys(state.daily).sort();
  while (keys.length > MAX_DAILY) {
    delete state.daily[keys.shift()];
  }
  return day;
}

function prunePresence(state, now = Date.now()) {
  for (const [sid, row] of Object.entries(state.presence || {})) {
    const at = new Date(row?.at || 0).getTime();
    if (!at || now - at > PRESENCE_TTL_MS) delete state.presence[sid];
  }
}

function trimCounts(map, maxKeys) {
  const entries = Object.entries(map || {});
  if (entries.length <= maxKeys) return map || {};
  entries.sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
  const out = {};
  for (const [k, v] of entries.slice(0, maxKeys)) out[k] = v;
  return out;
}

function normalizePath(path) {
  let p = String(path || '/').trim() || '/';
  if (!p.startsWith('/')) p = '/' + p;
  p = p.split('?')[0].split('#')[0];
  if (p.length > 120) p = p.slice(0, 120);
  const allowedPrefixes = ['/', '/admin', '/client', '/login', '/register', '/link-telegram', '/privacy', '/terms', '/cookies'];
  const ok = allowedPrefixes.some((a) => p === a || p === a + '.html' || p.startsWith(a + '/') || (a !== '/' && p.startsWith(a)));
  if (!ok && p !== '/') {
    if (p.endsWith('.html')) return p;
    return '/other';
  }
  return p;
}

async function trackPageView({ path, sid, role }) {
  const state = await readState();
  const p = normalizePath(path);
  state.pageViews[p] = (Number(state.pageViews[p]) || 0) + 1;
  state.pageViews = trimCounts(state.pageViews, MAX_PAGE_KEYS);
  state.totals.pageViews = (Number(state.totals.pageViews) || 0) + 1;
  const day = bumpDaily(state, 'pageViews');
  if (sid) day.uniqueSessions[String(sid).slice(0, 64)] = true;
  if (p === '/' || p === '/index.html') {
    state.totals.mapLoads = (Number(state.totals.mapLoads) || 0) + 1;
    bumpDaily(state, 'mapLoads');
  }
  if (sid) {
    state.presence[String(sid).slice(0, 64)] = {
      at: new Date().toISOString(),
      path: p,
      role: role || '',
    };
  }
  prunePresence(state);
  await writeState(state);
  return { ok: true, path: p };
}

async function trackSearch({ query, source, sid, matched }) {
  const q = String(query || '').trim().slice(0, 120);
  if (q.length < 2) return { ok: false, skipped: true };
  const state = await readState();
  const key = q.toLowerCase();
  state.searchCounts[key] = (Number(state.searchCounts[key]) || 0) + 1;
  state.searchCounts = trimCounts(state.searchCounts, MAX_SEARCH_KEYS);
  state.recentSearches.unshift({
    q,
    source: source || 'search',
    matched: Boolean(matched),
    sid: sid ? String(sid).slice(0, 64) : null,
    at: new Date().toISOString(),
  });
  state.recentSearches = state.recentSearches.slice(0, MAX_RECENT_SEARCHES);
  state.totals.searches = (Number(state.totals.searches) || 0) + 1;
  bumpDaily(state, 'searches');
  await writeState(state);
  return { ok: true };
}

async function heartbeat({ sid, path, role }) {
  if (!sid) return { ok: false, skipped: true };
  const state = await readState();
  prunePresence(state);
  state.presence[String(sid).slice(0, 64)] = {
    at: new Date().toISOString(),
    path: normalizePath(path),
    role: role || '',
  };
  state.totals.heartbeats = (Number(state.totals.heartbeats) || 0) + 1;
  await writeState(state);
  return { ok: true, online: Object.keys(state.presence).length };
}

async function bumpTotal(field, n = 1) {
  const allowed = new Set(Object.keys(emptyState().totals));
  if (!allowed.has(field)) return { ok: false };
  const state = await readState();
  state.totals[field] = (Number(state.totals[field]) || 0) + n;
  if (['orders', 'favorites', 'logins', 'registers', 'locationOpens', 'mapLoads'].includes(field)) {
    bumpDaily(state, field, n);
  }
  await writeState(state);
  return { ok: true };
}

function topEntries(map, limit = 20) {
  return Object.entries(map || {})
    .map(([key, count]) => ({ key, count: Number(count) || 0 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function parseCatalogClicks(clicksMap, masterCatalog) {
  const categories = [];
  const subcategories = [];
  const services = [];
  for (const [key, count] of Object.entries(clicksMap || {})) {
    const n = Number(count) || 0;
    if (!n) continue;
    if (key.startsWith('cat:')) {
      const catKey = key.slice(4);
      categories.push({
        key: catKey,
        name: masterCatalog?.[catKey]?.name || catKey,
        count: n,
      });
    } else if (key.startsWith('sub:')) {
      const parts = key.split(':');
      const catKey = parts[1];
      const subKey = parts.slice(2).join(':');
      subcategories.push({
        key: `${catKey}/${subKey}`,
        catKey,
        subKey,
        name: masterCatalog?.[catKey]?.subcats?.[subKey]?.name || subKey,
        catName: masterCatalog?.[catKey]?.name || catKey,
        count: n,
      });
    } else if (key.startsWith('svc:')) {
      const rest = key.slice(4);
      const first = rest.indexOf(':');
      const second = rest.indexOf(':', first + 1);
      if (first < 0 || second < 0) continue;
      const catKey = rest.slice(0, first);
      const subKey = rest.slice(first + 1, second);
      const serviceName = rest.slice(second + 1);
      services.push({
        key,
        catKey,
        subKey,
        name: serviceName,
        catName: masterCatalog?.[catKey]?.name || catKey,
        subName: masterCatalog?.[catKey]?.subcats?.[subKey]?.name || subKey,
        count: n,
      });
    }
  }
  categories.sort((a, b) => b.count - a.count);
  subcategories.sort((a, b) => b.count - a.count);
  services.sort((a, b) => b.count - a.count);
  return {
    categories: categories.slice(0, 30),
    subcategories: subcategories.slice(0, 40),
    services: services.slice(0, 50),
  };
}

async function buildAdminReport({
  catalogClicks = {},
  masterCatalog = {},
  locations = [],
  ordersTotal = 0,
  usersTotal = 0,
  providersCount = 0,
  clientsCount = 0,
  billingStats = null,
}) {
  const state = await readState();
  prunePresence(state);
  // persist prune occasionally without blocking response hard — best-effort
  writeState(state).catch(() => {});

  const online = Object.values(state.presence || {});
  const onlineByPath = {};
  for (const row of online) {
    const p = row.path || '/';
    onlineByPath[p] = (onlineByPath[p] || 0) + 1;
  }

  const funnel = parseCatalogClicks(catalogClicks, masterCatalog);
  const locationViews = [...locations]
    .map((l) => ({
      id: l.id,
      title: l.title,
      views: Number(l.views) || 0,
      cat: l.cat,
    }))
    .filter((l) => l.views > 0)
    .sort((a, b) => b.views - a.views)
    .slice(0, 25);

  const totalLocViews = locations.reduce((s, l) => s + (Number(l.views) || 0), 0);
  const withPhotos = locations.filter((l) => Array.isArray(l.photos) && l.photos.length).length;
  const withPrices = locations.filter((l) => Object.keys(l.prices || {}).length).length;
  const claimed = locations.filter((l) => l.providerId).length;

  const dailySeries = Object.keys(state.daily || {})
    .sort()
    .slice(-14)
    .map((day) => {
      const d = state.daily[day] || {};
      return {
        day,
        pageViews: d.pageViews || 0,
        searches: d.searches || 0,
        mapLoads: d.mapLoads || 0,
        locationOpens: d.locationOpens || 0,
        orders: d.orders || 0,
        favorites: d.favorites || 0,
        logins: d.logins || 0,
        uniqueSessions: d.uniqueSessions ? Object.keys(d.uniqueSessions).length : 0,
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    live: {
      onlineNow: online.length,
      byPath: onlineByPath,
      sessions: online.map((s) => ({
        path: s.path,
        role: s.role || 'guest',
        at: s.at,
      })),
    },
    kpis: {
      usersTotal,
      providersCount,
      clientsCount,
      locationsTotal: locations.length,
      locationsClaimed: claimed,
      locationsWithPhotos: withPhotos,
      locationsWithPrices: withPrices,
      locationCardViews: totalLocViews,
      ordersTotal,
      pageViewsTotal: state.totals.pageViews || 0,
      searchesTotal: state.totals.searches || 0,
      mapLoadsTotal: state.totals.mapLoads || 0,
      locationOpensTracked: state.totals.locationOpens || 0,
      favoritesTotal: state.totals.favorites || 0,
      loginsTotal: state.totals.logins || 0,
      registersTotal: state.totals.registers || 0,
      donateClicks: billingStats?.donateClicks ?? state.totals.donateClicks ?? 0,
      subscribeClicks: billingStats?.subscribeClicks ?? state.totals.subscribeClicks ?? 0,
      activePaid: billingStats?.activePaid ?? 0,
    },
    pages: topEntries(state.pageViews, 30),
    searchesTop: topEntries(state.searchCounts, 40),
    recentSearches: (state.recentSearches || []).slice(0, 50),
    catalogFunnel: funnel,
    topLocations: locationViews,
    daily: dailySeries,
    totals: state.totals,
  };
}

module.exports = {
  PRESENCE_TTL_MS,
  trackPageView,
  trackSearch,
  heartbeat,
  bumpTotal,
  buildAdminReport,
  readState,
};
