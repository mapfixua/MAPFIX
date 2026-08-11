'use strict';

const { supabaseClient } = require('./supabaseClient.js');
const { loadAppState, saveAppState } = require('./app-state-store.js');

const TABLE = process.env.SUPABASE_PROVIDER_PROFILES_TABLE || 'provider_profiles';
const OVERLAY_STATE_ID = 'provider_profiles_overlay';

function isMissingTable(error) {
  if (!error) return false;
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    String(error.message || '').includes('Could not find the table')
  );
}

function rowToProfile(row) {
  if (!row) return null;
  return {
    companyName: row.company_name || '',
    phone: row.phone || '',
    serviceCategories: Array.isArray(row.service_categories) ? row.service_categories : [],
    serviceSubcategories: Array.isArray(row.service_subcategories)
      ? row.service_subcategories
      : [],
    customSubcategories: Array.isArray(row.custom_subcategories) ? row.custom_subcategories : [],
    createdAt: row.created_at || null,
  };
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    companyName: String(profile.companyName || '').trim(),
    phone: String(profile.phone || '').trim(),
    serviceCategories: Array.isArray(profile.serviceCategories) ? profile.serviceCategories : [],
    serviceSubcategories: Array.isArray(profile.serviceSubcategories)
      ? profile.serviceSubcategories
      : [],
    customSubcategories: Array.isArray(profile.customSubcategories)
      ? profile.customSubcategories
      : [],
    createdAt: profile.createdAt || null,
  };
}

async function loadProfilesOverlay() {
  const remote = await loadAppState(OVERLAY_STATE_ID, {});
  if (!remote.ok || !remote.value || typeof remote.value !== 'object' || Array.isArray(remote.value)) {
    return {};
  }
  const out = {};
  for (const [userId, profile] of Object.entries(remote.value)) {
    const normalized = normalizeProfile(profile);
    if (userId && normalized) out[userId] = normalized;
  }
  return out;
}

async function saveProfileOverlay(userId, profile) {
  const current = await loadProfilesOverlay();
  current[userId] = normalizeProfile(profile);
  return saveAppState(OVERLAY_STATE_ID, current);
}

async function fetchProviderProfilesMap() {
  const profiles = {};
  let tableOk = false;
  let missing = false;
  let tableError = null;

  const { data, error } = await supabaseClient.from(TABLE).select('*');
  if (error) {
    missing = isMissingTable(error);
    tableError = error;
    if (!missing) {
      console.warn('[provider-profiles] select:', error.message);
    }
  } else {
    tableOk = true;
    for (const row of data || []) {
      if (row?.user_id) profiles[row.user_id] = rowToProfile(row);
    }
  }

  // Overlay wins: latest company-name edits when table RLS blocks writes.
  try {
    const overlay = await loadProfilesOverlay();
    Object.assign(profiles, overlay);
  } catch (err) {
    console.warn('[provider-profiles] overlay load:', err.message);
  }

  if (tableOk || Object.keys(profiles).length) {
    return { ok: true, profiles, tableOk, missing };
  }
  return { ok: false, missing, profiles: {}, error: tableError };
}

async function upsertProviderProfile(userId, profile) {
  if (!userId || !profile) return { ok: false, error: new Error('userId and profile required') };
  const normalized = normalizeProfile(profile);
  const row = {
    user_id: userId,
    company_name: normalized.companyName,
    phone: normalized.phone,
    service_categories: normalized.serviceCategories,
    service_subcategories: normalized.serviceSubcategories,
    custom_subcategories: normalized.customSubcategories,
    updated_at: new Date().toISOString(),
  };
  if (normalized.createdAt) row.created_at = normalized.createdAt;

  const { error } = await supabaseClient.from(TABLE).upsert(row, { onConflict: 'user_id' });
  if (!error) {
    // Keep overlay in sync so reads stay consistent if table later lags.
    try {
      await saveProfileOverlay(userId, normalized);
    } catch (_) {}
    return { ok: true, via: 'table' };
  }

  if (isMissingTable(error)) {
    const overlay = await saveProfileOverlay(userId, normalized);
    if (overlay.ok) return { ok: true, via: 'overlay', missing: true };
    return { ok: false, missing: true, error: overlay.error || error };
  }

  // Fallback: some projects miss upsert grants — try update then insert.
  const { data: existing, error: selectErr } = await supabaseClient
    .from(TABLE)
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (!selectErr && existing?.user_id) {
    const { error: updateErr } = await supabaseClient.from(TABLE).update(row).eq('user_id', userId);
    if (!updateErr) {
      try {
        await saveProfileOverlay(userId, normalized);
      } catch (_) {}
      return { ok: true, via: 'table-update' };
    }
  } else if (!selectErr && !existing) {
    const { error: insertErr } = await supabaseClient.from(TABLE).insert(row);
    if (!insertErr) {
      try {
        await saveProfileOverlay(userId, normalized);
      } catch (_) {}
      return { ok: true, via: 'table-insert' };
    }
  }

  // Last resort for Vercel: catalog_snapshots overlay (same store as orders).
  const overlay = await saveProfileOverlay(userId, normalized);
  if (overlay.ok) {
    console.warn(
      '[provider-profiles] table write failed, saved via overlay:',
      error.message || error
    );
    return { ok: true, via: 'overlay' };
  }

  return { ok: false, error: overlay.error || error };
}

module.exports = {
  fetchProviderProfilesMap,
  upsertProviderProfile,
};
