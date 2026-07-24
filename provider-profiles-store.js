'use strict';

const { supabaseClient } = require('./supabaseClient.js');

const TABLE = process.env.SUPABASE_PROVIDER_PROFILES_TABLE || 'provider_profiles';

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

async function fetchProviderProfilesMap() {
  const { data, error } = await supabaseClient.from(TABLE).select('*');
  if (error) {
    if (isMissingTable(error)) return { ok: false, missing: true, profiles: {} };
    return { ok: false, profiles: {}, error };
  }
  const profiles = {};
  for (const row of data || []) {
    if (row?.user_id) profiles[row.user_id] = rowToProfile(row);
  }
  return { ok: true, profiles };
}

async function upsertProviderProfile(userId, profile) {
  if (!userId || !profile) return { ok: false, error: new Error('userId and profile required') };
  const row = {
    user_id: userId,
    company_name: String(profile.companyName || '').trim(),
    phone: String(profile.phone || '').trim(),
    service_categories: Array.isArray(profile.serviceCategories) ? profile.serviceCategories : [],
    service_subcategories: Array.isArray(profile.serviceSubcategories)
      ? profile.serviceSubcategories
      : [],
    custom_subcategories: Array.isArray(profile.customSubcategories)
      ? profile.customSubcategories
      : [],
    updated_at: new Date().toISOString(),
  };
  if (profile.createdAt) row.created_at = profile.createdAt;

  const { error } = await supabaseClient.from(TABLE).upsert(row, { onConflict: 'user_id' });
  if (error) {
    if (isMissingTable(error)) return { ok: false, missing: true, error };
    return { ok: false, error };
  }
  return { ok: true };
}

module.exports = {
  fetchProviderProfilesMap,
  upsertProviderProfile,
};
