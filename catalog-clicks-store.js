'use strict';

const { supabaseClient } = require('./supabaseClient.js');

const TABLE = process.env.SUPABASE_CATALOG_CLICKS_TABLE || 'catalog_clicks';

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
  categoryClickKey,
  subcategoryClickKey,
  serviceClickKey,
  fetchCatalogClicksMap,
  incrementCatalogClick,
};
