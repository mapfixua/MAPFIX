'use strict';

const { placeFromCandidateRow } = require('./places-v2.js');
const {
  classifyPlace,
  verifyPlace,
  gateClassification,
  withClassifierRetries,
  unclassifiedFields,
} = require('./places-classify.js');

const RECLASSIFY_TIME_BUDGET_MS = 40_000;
const RECLASSIFY_MAX_BUDGET_MS = 45_000;
const RECLASSIFY_PAGE = 8;

function clampBudget(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return RECLASSIFY_TIME_BUDGET_MS;
  return Math.min(RECLASSIFY_MAX_BUDGET_MS, Math.max(1000, Math.floor(n)));
}

function targetFromRow(row, place) {
  const subs = Array.isArray(row?.proposed_subcats) ? row.proposed_subcats : [];
  const cat = place?.hintCat || row?.proposed_cat || null;
  const sub = place?.hintSub || subs[0] || null;
  if (!cat || !sub) return null;
  return { cat, sub };
}

/**
 * Re-run Gemini on needs_classify rows using only raw_payload.
 * No Text Search and no Place Details. Stops on classifier 429.
 * A finished classification is pending or rejected, never approved or published.
 */
async function executeReclassifyChunk(options = {}) {
  const body = options.body || {};
  const wave = body.wave ? String(body.wave).trim().toUpperCase() : undefined;
  const afterId = body.cursor?.afterId || body.afterId || null;
  const timeBudgetMs = clampBudget(body.timeBudgetMs);
  const pageLimit = Math.min(RECLASSIFY_PAGE, Math.max(1, Number(body.limit) || RECLASSIFY_PAGE));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const deadline = started + timeBudgetMs;
  const masterCatalog = options.masterCatalog || {};
  const geminiKey = options.geminiApiKey || process.env.GEMINI_API_KEY || '';
  const classify = options.classify || ((place, catalog, callOpts) => classifyPlace(place, catalog, geminiKey, callOpts));
  const verify = options.verify || ((place, proposal, catalog, callOpts) =>
    verifyPlace(place, proposal, catalog, geminiKey, callOpts));
  if (typeof options.listCandidates !== 'function') {
    throw new Error('listCandidates is required');
  }
  if (typeof options.updateCandidate !== 'function') {
    throw new Error('updateCandidate is required');
  }

  const listed = await options.listCandidates({ wave, afterId: afterId || null, limit: pageLimit });
  if (listed && listed.ok === false) {
    throw new Error(listed.error?.message || 'Не вдалося прочитати чергу');
  }
  const rows = Array.isArray(listed) ? listed : (listed?.rows || []);

  let processed = 0;
  let reclassified = 0;
  let stillPending = 0;
  let stoppedReason = null;
  let lastId = afterId || null;

  for (const row of rows) {
    if (!row?.id) continue;
    if (now() >= deadline) {
      stoppedReason = 'time_budget';
      break;
    }
    const place = placeFromCandidateRow(row);
    const target = targetFromRow(row, place);
    const classified = await withClassifierRetries(
      (opts) => classify(place, masterCatalog, opts),
      { sleep, now, deadlineAt: deadline }
    );
    if (classified.quota) {
      stoppedReason = 'classifier_quota';
      break;
    }
    if (!classified.ok) {
      await options.updateCandidate(row.id, unclassifiedFields({
        place,
        masterCatalog,
        target,
        dedupStatus: row.dedup_status,
        error: classified.error,
        classifier: null,
      }));
      stillPending += 1;
      processed += 1;
      lastId = row.id;
      if (classified.deferred || now() >= deadline) {
        stoppedReason = 'time_budget';
        break;
      }
      continue;
    }

    if (now() >= deadline) {
      stoppedReason = 'time_budget';
      break;
    }
    const verified = await withClassifierRetries(
      (opts) => verify(place, classified.value, masterCatalog, opts),
      { sleep, now, deadlineAt: deadline }
    );
    if (verified.quota) {
      stoppedReason = 'classifier_quota';
      break;
    }
    if (!verified.ok) {
      await options.updateCandidate(row.id, unclassifiedFields({
        place,
        masterCatalog,
        target,
        dedupStatus: row.dedup_status,
        error: verified.error,
        classifier: classified.value,
      }));
      stillPending += 1;
      processed += 1;
      lastId = row.id;
      if (verified.deferred || now() >= deadline) {
        stoppedReason = 'time_budget';
        break;
      }
      continue;
    }

    const gate = gateClassification({
      classifier: classified.value,
      verification: verified.value,
      target,
    });
    let status = gate.status === 'rejected' ? 'rejected' : 'pending';
    let needsReview = Boolean(gate.needsReview);
    const dedup = String(row.dedup_status || '');
    if (dedup && dedup !== 'new') needsReview = true;
    await options.updateCandidate(row.id, {
      status,
      needs_review: needsReview,
      reject_reason: status === 'rejected' ? gate.reason : null,
      proposed_cat: classified.value.category || row.proposed_cat || null,
      proposed_subcats: classified.value.subcategory ? [classified.value.subcategory] : (row.proposed_subcats || []),
      proposed_services: classified.value.services || [],
      classifier_confidence: gate.confidence,
      classifier_reasoning: String(classified.value.reasoning || '').slice(0, 500),
      verification: verified.value,
    });
    reclassified += 1;
    processed += 1;
    lastId = row.id;
  }

  const finishedPage = !stoppedReason && processed >= rows.length && rows.length < pageLimit;
  const done = finishedPage || (!stoppedReason && rows.length === 0);
  return {
    ok: true,
    dryRun: true,
    publishedLocations: 0,
    googleCalls: 0,
    wave: wave || null,
    processed,
    reclassified,
    stillPending,
    stoppedReason,
    done,
    nextCursor: done ? null : { afterId: lastId },
  };
}

module.exports = {
  RECLASSIFY_TIME_BUDGET_MS,
  RECLASSIFY_MAX_BUDGET_MS,
  RECLASSIFY_PAGE,
  executeReclassifyChunk,
};
