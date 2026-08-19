'use strict';

const { supabaseClient } = require('./supabaseClient.js');

const TABLE = process.env.SUPABASE_CATALOG_CLICKS_TABLE || 'catalog_clicks';

/** High-intent location CTA types (GBP / local marketplace style). */
const LOCATION_CLICK_TYPES = [
  'call',
  'directions',
  'map_focus',
  'share',
  'favorite',
  'order',
  'claim',
  'review',
  'report',
  'dive',
];

const LOCATION_CLICK_LABELS = {
  call: 'Дзвінки',
  directions: 'Маршрути',
  map_focus: 'На карті',
  share: 'Поділитись',
  favorite: 'В обране',
  order: 'Замовлення',
  claim: 'Забрати заклад',
  review: 'Відгуки',
  report: 'Скарги',
  dive: 'Детальніше',
};

const LOCATION_CLICK_ICONS = {
  call: '📞',
  directions: '🧭',
  map_focus: '🗺️',
  share: '↗',
  favorite: '☆',
  order: '🛒',
  claim: '🔑',
  review: '⭐',
  report: '⚑',
  dive: '🔎',
};

function isMissingTable(error) {
  if (!error) return false;
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    String(error.message || '').includes('Could not find the table')
  );
}

function categoryClickKey(categoryKey) {
  return `cat:${categoryKey}`;
}

function subcategoryClickKey(categoryKey, subcategoryKey) {
  return `sub:${categoryKey}:${subcategoryKey}`;
}

function serviceClickKey(categoryKey, subcategoryKey, serviceName) {
  return `svc:${categoryKey}:${subcategoryKey}:${String(serviceName || '').trim().toLowerCase()}`;
}

function locationClickKey(locationId, type) {
  const id = String(locationId || '').trim();
  const t = String(type || '').trim().toLowerCase();
  if (!id || !LOCATION_CLICK_TYPES.includes(t)) return null;
  return `loc:${t}:${id}`;
}

function parseLocationClickKey(clickKey) {
  const key = String(clickKey || '');
  if (!key.startsWith('loc:')) return null;
  const rest = key.slice(4);
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  const type = rest.slice(0, colon);
  const locationId = rest.slice(colon + 1);
  if (!LOCATION_CLICK_TYPES.includes(type) || !locationId) return null;
  return { type, locationId };
}

function emptyLocationClickStats() {
  const out = {};
  for (const t of LOCATION_CLICK_TYPES) out[t] = 0;
  return out;
}

function locationClickStatsFromMap(clicksMap, locationId) {
  const stats = emptyLocationClickStats();
  const id = String(locationId || '').trim();
  if (!id) return stats;
  for (const t of LOCATION_CLICK_TYPES) {
    stats[t] = Number(clicksMap[`loc:${t}:${id}`]) || 0;
  }
  return stats;
}

function summarizeLocationClicks(clicksMap, locations = []) {
  const byType = emptyLocationClickStats();
  const byLocation = new Map();
  const titleById = new Map(
    (locations || []).map((l) => [String(l.id), l.title || l.id])
  );

  for (const [key, raw] of Object.entries(clicksMap || {})) {
    const parsed = parseLocationClickKey(key);
    if (!parsed) continue;
    const n = Number(raw) || 0;
    if (!n) continue;
    byType[parsed.type] = (byType[parsed.type] || 0) + n;
    if (!byLocation.has(parsed.locationId)) {
      byLocation.set(parsed.locationId, {
        id: parsed.locationId,
        title: titleById.get(parsed.locationId) || parsed.locationId,
        ...emptyLocationClickStats(),
        total: 0,
      });
    }
    const row = byLocation.get(parsed.locationId);
    row[parsed.type] = (row[parsed.type] || 0) + n;
    row.total += n;
  }

  const topByCalls = [...byLocation.values()]
    .filter((r) => r.call > 0)
    .sort((a, b) => b.call - a.call || b.total - a.total)
    .slice(0, 25);

  const topByEngagement = [...byLocation.values()]
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || b.call - a.call)
    .slice(0, 25);

  return {
    byType,
    labels: LOCATION_CLICK_LABELS,
    icons: LOCATION_CLICK_ICONS,
    types: LOCATION_CLICK_TYPES,
    topByCalls,
    topByEngagement,
    totalCtaClicks: Object.values(byType).reduce((s, n) => s + (Number(n) || 0), 0),
  };
}

async function fetchCatalogClicksMap() {
  const { data, error } = await supabaseClient.from(TABLE).select('click_key, clicks');
  if (error) {
    if (isMissingTable(error)) return { ok: false, missing: true, clicks: {} };
    return { ok: false, clicks: {}, error };
  }
  const clicks = {};
  for (const row of data || []) {
    if (row?.click_key) clicks[row.click_key] = Number(row.clicks) || 0;
  }
  return { ok: true, clicks };
}

async function incrementCatalogClick(clickKey) {
  if (!clickKey) return { ok: false, error: new Error('clickKey required') };

  const { data: existing, error: readErr } = await supabaseClient
    .from(TABLE)
    .select('clicks')
    .eq('click_key', clickKey)
    .maybeSingle();

  if (readErr) {
    if (isMissingTable(readErr)) return { ok: false, missing: true, error: readErr };
    return { ok: false, error: readErr };
  }

  const next = (Number(existing?.clicks) || 0) + 1;
  const { error: writeErr } = await supabaseClient.from(TABLE).upsert(
    {
      click_key: clickKey,
      clicks: next,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'click_key' }
  );

  if (writeErr) {
    if (isMissingTable(writeErr)) return { ok: false, missing: true, error: writeErr };
    return { ok: false, error: writeErr };
  }

  return { ok: true, clicks: next, clickKey };
}

module.exports = {
  LOCATION_CLICK_TYPES,
  LOCATION_CLICK_LABELS,
  LOCATION_CLICK_ICONS,
  categoryClickKey,
  subcategoryClickKey,
  serviceClickKey,
  locationClickKey,
  parseLocationClickKey,
  emptyLocationClickStats,
  locationClickStatsFromMap,
  summarizeLocationClicks,
  fetchCatalogClicksMap,
  incrementCatalogClick,
};
