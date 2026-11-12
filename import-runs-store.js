'use strict';

const { getServiceRoleClient } = require('./supabaseClient.js');

const TABLE = 'import_runs';
const SERVICE_ROLE_ERROR = { message: 'SUPABASE_SERVICE_ROLE_KEY is not set' };

function serviceClient() {
  const client = getServiceRoleClient();
  if (!client) return { client: null, error: SERVICE_ROLE_ERROR };
  return { client, error: null };
}

async function getImportRun(id) {
  const { client, error: clientError } = serviceClient();
  if (!client) return { ok: false, error: clientError, row: null };
  const { data, error } = await client.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) return { ok: false, error, row: null };
  return { ok: true, row: data || null };
}

async function saveImportRun(row) {
  const { client, error: clientError } = serviceClient();
  if (!client) return { ok: false, error: clientError };
  const payload = {
    ...row,
    updated_at: new Date().toISOString(),
  };
  const { error } = await client.from(TABLE).upsert(payload, { onConflict: 'id' });
  if (error) return { ok: false, error };
  return { ok: true };
}

/**
 * Sets locations.google_place_id only. Other location columns stay untouched.
 */
async function writeGooglePlaceId(locationId, placeId) {
  const { client, error: clientError } = serviceClient();
  if (!client) return { ok: false, error: clientError, updated: 0 };
  const id = String(locationId || '').trim();
  const clean = String(placeId || '').replace(/^places\//, '').trim();
  if (!id || !clean) return { ok: false, error: { message: 'Немає place id' }, updated: 0 };
  const { data, error } = await client
    .from('locations')
    .update({ google_place_id: clean })
    .eq('id', id)
    .is('google_place_id', null)
    .select('id');
  if (error) return { ok: false, error, updated: 0 };
  return { ok: true, updated: (data || []).length };
}

module.exports = {
  getImportRun,
  saveImportRun,
  writeGooglePlaceId,
};
