'use strict';

const { supabaseClient } = require('./supabaseClient.js');

const CATALOG_TABLE = process.env.SUPABASE_CATALOG_TABLE || 'catalog_snapshots';
const CATALOG_ROW_ID = 'master';

async function fetchCatalogFromSupabase() {
  const { data, error } = await supabaseClient
    .from(CATALOG_TABLE)
    .select('master_catalog, updated_at')
    .eq('id', CATALOG_ROW_ID)
    .maybeSingle();

  if (error) {
    if (
      String(error.message).includes('Could not find the table') ||
      error.code === '42P01' ||
      error.code === 'PGRST205'
    ) {
      return { ok: false, missing: true, catalog: null, error };
    }
    return { ok: false, catalog: null, error };
  }

  const catalog = data?.master_catalog;
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return { ok: true, empty: true, catalog: null };
  }

  return { ok: true, catalog, updatedAt: data.updated_at || null };
}

async function upsertCatalogToSupabase(masterCatalog) {
  if (!masterCatalog || typeof masterCatalog !== 'object') {
    return { ok: false, error: new Error('masterCatalog is required') };
  }

  const row = {
    id: CATALOG_ROW_ID,
    master_catalog: masterCatalog,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabaseClient.from(CATALOG_TABLE).upsert(row, { onConflict: 'id' });
  if (error) {
    if (
      String(error.message).includes('Could not find the table') ||
      error.code === '42P01' ||
      error.code === 'PGRST205'
    ) {
      return { ok: false, missing: true, error };
    }
    return { ok: false, error };
  }
  return { ok: true };
}

/**
 * Base (data.json) + overlay (Supabase). Overlay wins on same service names;
 * seeded categories/subcats/services from base remain available after deploys.
 */
function mergeCatalog(base, overlay) {
  const result = {};
  const baseObj = base && typeof base === 'object' ? base : {};
  const overObj = overlay && typeof overlay === 'object' ? overlay : {};

  function mergeSubcats(baseSubs, overSubs) {
    const out = { ...(baseSubs || {}) };
    for (const [subKey, oSub] of Object.entries(overSubs || {})) {
      const bSub = out[subKey];
      if (!bSub) {
        out[subKey] = oSub;
        continue;
      }
      const byName = new Map();
      (Array.isArray(bSub.items) ? bSub.items : []).forEach((item) => {
        if (item?.name) byName.set(String(item.name).toLowerCase(), item);
      });
      (Array.isArray(oSub.items) ? oSub.items : []).forEach((item) => {
        if (item?.name) byName.set(String(item.name).toLowerCase(), item);
      });
      out[subKey] = {
        ...bSub,
        ...oSub,
        name: oSub.name || bSub.name,
        tags: [...new Set([...(bSub.tags || []), ...(oSub.tags || [])])],
        items: [...byName.values()],
      };
    }
    return out;
  }

  for (const key of new Set([...Object.keys(baseObj), ...Object.keys(overObj)])) {
    const b = baseObj[key];
    const o = overObj[key];
    if (!o) {
      result[key] = b;
      continue;
    }
    if (!b) {
      result[key] = o;
      continue;
    }
    result[key] = {
      ...b,
      ...o,
      name: o.name || b.name,
      icon: o.icon || b.icon,
      subcats: mergeSubcats(b.subcats, o.subcats),
    };
  }
  return result;
}

module.exports = {
  CATALOG_TABLE,
  fetchCatalogFromSupabase,
  upsertCatalogToSupabase,
  mergeCatalog,
};
