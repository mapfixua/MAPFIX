'use strict';

const { getServiceRoleClient } = require('./supabaseClient.js');

const TABLE = 'import_candidates';
const SERVICE_ROLE_ERROR = { message: 'SUPABASE_SERVICE_ROLE_KEY is not set' };

function serviceClient() {
  const client = getServiceRoleClient();
  if (!client) return { client: null, error: SERVICE_ROLE_ERROR };
  return { client, error: null };
}

function rowFromCandidate(candidate) {
  return {
    place_id: candidate.place_id,
    wave: candidate.wave,
    raw_payload: candidate.raw_payload || {},
    proposed_cat: candidate.proposed_cat || null,
    proposed_subcats: candidate.proposed_subcats || [],
    proposed_services: candidate.proposed_services || [],
    proposed_title: candidate.proposed_title || '',
    proposed_phone: candidate.proposed_phone || '',
    proposed_address: candidate.proposed_address || '',
    proposed_lat: candidate.proposed_lat,
    proposed_lng: candidate.proposed_lng,
    proposed_working_hours: candidate.proposed_working_hours || '',
    classifier_confidence: candidate.classifier_confidence,
    classifier_reasoning: candidate.classifier_reasoning || '',
    verification: candidate.verification || null,
    dedup_status: candidate.dedup_status,
    business_status: candidate.business_status || null,
    review_dates: candidate.review_dates || [],
    last_review_at: candidate.last_review_at || null,
    status: candidate.status || 'pending',
    needs_review: Boolean(candidate.needs_review),
    reject_reason: candidate.reject_reason || null,
    updated_at: new Date().toISOString(),
  };
}

async function upsertImportCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return { ok: true, upserted: 0, kept: 0 };
  let upserted = 0;
  let kept = 0;
  for (const candidate of list) {
    const { client, error: clientError } = serviceClient();
    if (!client) return { ok: false, error: clientError, upserted, kept };
    const { data: existing, error: readError } = await client
      .from(TABLE)
      .select('id,status')
      .eq('place_id', candidate.place_id)
      .eq('wave', candidate.wave)
      .maybeSingle();
    if (readError) return { ok: false, error: readError, upserted, kept };
    if (existing && (existing.status === 'approved' || existing.status === 'published')) {
      kept += 1;
      continue;
    }
    const payload = rowFromCandidate(candidate);
    if (existing) {
      const { error } = await client.from(TABLE).update(payload).eq('id', existing.id);
      if (error) return { ok: false, error, upserted, kept };
    } else {
      const { error } = await client.from(TABLE).insert(payload);
      if (error) return { ok: false, error, upserted, kept };
    }
    upserted += 1;
  }
  return { ok: true, upserted, kept };
}

async function listImportCandidates({ wave, status, limit = 200 } = {}) {
  const { client, error: clientError } = serviceClient();
  if (!client) return { ok: false, error: clientError, rows: [] };
  let query = client.from(TABLE).select('*').order('created_at', { ascending: false }).limit(Math.min(500, Math.max(1, limit)));
  if (wave) query = query.eq('wave', wave);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return { ok: false, error, rows: [] };
  return { ok: true, rows: data || [] };
}

async function listStagedForDedup(wave) {
  const { client, error: clientError } = serviceClient();
  if (!client) return { ok: false, error: clientError, rows: [] };
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; from < 20000; from += pageSize) {
    const { data, error } = await client
      .from(TABLE)
      .select('id,place_id,proposed_title,proposed_phone,proposed_lat,proposed_lng,dedup_status,status')
      .eq('wave', wave)
      .range(from, from + pageSize - 1);
    if (error) return { ok: false, error, rows };
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return { ok: true, rows };
}

async function getImportCandidate(id) {
  const { client, error: clientError } = serviceClient();
  if (!client) return { ok: false, error: clientError, row: null };
  const { data, error } = await client.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) return { ok: false, error, row: null };
  return { ok: true, row: data };
}

async function updateImportCandidate(id, patch) {
  const { client, error: clientError } = serviceClient();
  if (!client) return { ok: false, error: clientError, row: null };
  const { data, error } = await client
    .from(TABLE)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) return { ok: false, error, row: null };
  return { ok: true, row: data };
}

function approvable(row) {
  if (!row || row.status !== 'pending') return false;
  const dedup = String(row.dedup_status || '');
  return dedup === 'new' || dedup.startsWith('possible_branch_of ');
}

async function bulkApproveImportCandidates({ wave, ids } = {}) {
  const listed = await listImportCandidates({ wave, status: 'pending', limit: 500 });
  if (!listed.ok) return listed;
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  const targets = listed.rows.filter((row) => {
    if (wanted && !wanted.has(String(row.id))) return false;
    if (wanted) return approvable(row);
    return approvable(row) && !row.needs_review && String(row.dedup_status) === 'new';
  });
  let approved = 0;
  for (const row of targets) {
    const updated = await updateImportCandidate(row.id, { status: 'approved' });
    if (!updated.ok) return { ok: false, error: updated.error, approved };
    approved += 1;
  }
  return { ok: true, approved, considered: listed.rows.length };
}

module.exports = {
  upsertImportCandidates,
  listImportCandidates,
  listStagedForDedup,
  getImportCandidate,
  updateImportCandidate,
  bulkApproveImportCandidates,
  approvable,
};
