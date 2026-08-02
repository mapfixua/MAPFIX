'use strict';

/**
 * Persist arbitrary JSON blobs in catalog_snapshots (service_role).
 * Avoids needing new tables when migrations cannot be applied from CLI.
 */
const { supabaseClient } = require('./supabaseClient.js');

const TABLE = process.env.SUPABASE_CATALOG_TABLE || 'catalog_snapshots';

async function loadAppState(id, fallback) {
  try {
    const { data, error } = await supabaseClient
      .from(TABLE)
      .select('master_catalog')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      if (
        String(error.message).includes('Could not find the table') ||
        error.code === '42P01' ||
        error.code === 'PGRST205'
      ) {
        return { ok: false, missing: true, value: fallback, error };
      }
      return { ok: false, value: fallback, error };
    }
    if (!data?.master_catalog) return { ok: true, empty: true, value: fallback };
    return { ok: true, value: data.master_catalog };
  } catch (error) {
    return { ok: false, value: fallback, error };
  }
}

async function saveAppState(id, value) {
  const row = {
    id,
    master_catalog: value,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseClient.from(TABLE).upsert(row, { onConflict: 'id' });
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

module.exports = {
  loadAppState,
  saveAppState,
};
