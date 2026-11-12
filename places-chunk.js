'use strict';

const { runWave } = require('./places-v2.js');
const { getWave } = require('./places-waves.js');
const { createPlacesBudget, DEFAULT_MAX_TEXT_SEARCH, DEFAULT_MAX_DETAILS, PlacesQuotaError } = require('./places-quota.js');
const { chooseBackfillMatch } = require('./places-backfill.js');

const CHUNK_TIME_BUDGET_MS = 40_000;
const MAX_CHUNK_BUDGET_MS = 45_000;
const HARD_MAX_TEXT_SEARCH = DEFAULT_MAX_TEXT_SEARCH;
const HARD_MAX_DETAILS = DEFAULT_MAX_DETAILS;
const BACKFILL_MAX_TEXT = 500;

function clampBudget(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return CHUNK_TIME_BUDGET_MS;
  return Math.min(MAX_CHUNK_BUDGET_MS, Math.max(1000, Math.floor(n)));
}

function boundedInt(value, fallback, hardMax) {
  const n = Number(value);
  const chosen = Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  return Math.min(hardMax, Math.max(0, chosen));
}

function waveRunId({ wave, query, tileStart, tileCount, hasTile }) {
  const parts = [`wave:${String(wave || 'A').trim().toUpperCase()}`];
  if (query) parts.push(`q:${String(query).trim()}`);
  if (hasTile) parts.push(`tiles:${tileStart ?? 0}:${tileCount ?? 'all'}`);
  return parts.join(':');
}

function backfillRunId(write) {
  return write ? 'backfill:place-id:write' : 'backfill:place-id:dry';
}

function summarizeDedup(byDedup) {
  const buckets = { new: 0, duplicate: 0, branch: 0, deleted: 0, claimed: 0, other: 0 };
  for (const [key, count] of Object.entries(byDedup || {})) {
    const n = Number(count) || 0;
    if (key === 'new') buckets.new += n;
    else if (key.startsWith('duplicate_of ')) buckets.duplicate += n;
    else if (key.startsWith('possible_branch_of ')) buckets.branch += n;
    else if (key.startsWith('matches_deleted ')) buckets.deleted += n;
    else if (key.startsWith('matches_claimed ')) buckets.claimed += n;
    else buckets.other += n;
  }
  return buckets;
}

function emptyWaveCounts(total) {
  return {
    pairsProcessed: 0,
    pairsTotal: total || 0,
    staged: 0,
    byDedup: {},
    dedupBuckets: summarizeDedup({}),
    skipped: {},
    textSearch: 0,
    details: 0,
    cacheHits: 0,
    stoppedReason: null,
  };
}

function tallyDedup(rows) {
  const byDedup = {};
  for (const row of rows || []) {
    const key = row?.dedup_status || 'unknown';
    byDedup[key] = (byDedup[key] || 0) + 1;
  }
  return byDedup;
}

function mergeCounts(prev, chunk, total) {
  const base = prev && typeof prev === 'object' ? prev : emptyWaveCounts(total);
  const byDedup = { ...(base.byDedup || {}) };
  for (const [key, n] of Object.entries(chunk.byDedup || {})) {
    byDedup[key] = (byDedup[key] || 0) + n;
  }
  const skipped = { ...(base.skipped || {}) };
  for (const [key, n] of Object.entries(chunk.skipped || {})) {
    skipped[key] = (skipped[key] || 0) + n;
  }
  return {
    pairsProcessed: (base.pairsProcessed || 0) + (chunk.pairsProcessed || 0),
    pairsTotal: total || chunk.pairsTotal || base.pairsTotal || 0,
    staged: (base.staged || 0) + (chunk.staged || 0),
    byDedup,
    dedupBuckets: summarizeDedup(byDedup),
    skipped,
    textSearch: (base.textSearch || 0) + (chunk.textSearch || 0),
    details: (base.details || 0) + (chunk.details || 0),
    cacheHits: (base.cacheHits || 0) + (chunk.cacheHits || 0),
    stoppedReason: chunk.stoppedReason || null,
  };
}

function lockActive(row, nowMs) {
  if (!row?.locked_until) return false;
  const until = Date.parse(row.locked_until);
  return Number.isFinite(until) && until > nowMs;
}

function requestsOf(row) {
  return {
    textSearch: row?.text_search_used || 0,
    details: row?.details_used || 0,
    maxTextSearch: row?.max_text_search ?? HARD_MAX_TEXT_SEARCH,
    maxDetails: row?.max_details ?? HARD_MAX_DETAILS,
    cacheHits: row?.counts?.cacheHits || 0,
  };
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return '';
  return `***${digits.slice(-4)}`;
}

function wavePayload(fields) {
  return {
    ok: true,
    dryRun: true,
    publishedLocations: 0,
    done: Boolean(fields.done),
    busy: Boolean(fields.busy),
    alreadyDone: Boolean(fields.alreadyDone),
    processed: fields.processed || 0,
    total: fields.total || 0,
    nextCursor: fields.nextCursor || null,
    counts: fields.counts || emptyWaveCounts(fields.total),
    requests: fields.requests || {},
    stoppedReason: fields.stoppedReason || null,
    staged: fields.counts?.staged || 0,
    wave: fields.wave,
  };
}

async function executeWaveChunk(options = {}) {
  const body = options.body || {};
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  const nowMs = nowFn();
  const waveDef = getWave(body.wave || 'A');
  const query = body.query ? String(body.query).trim() : '';
  const hasTile = body.tileStart != null || body.tileCount != null;
  const tileStart = hasTile ? Number(body.tileStart) || 0 : null;
  const tileCount = hasTile && body.tileCount != null ? Number(body.tileCount) : null;
  const runId = waveRunId({ wave: waveDef.id, query, tileStart, tileCount, hasTile });
  const timeBudgetMs = clampBudget(body.timeBudgetMs);
  const maxText = boundedInt(body.maxTextSearch, HARD_MAX_TEXT_SEARCH, HARD_MAX_TEXT_SEARCH);
  const maxDetails = boundedInt(body.maxDetails, HARD_MAX_DETAILS, HARD_MAX_DETAILS);
  const existing = await options.getRun(runId);

  if (existing && lockActive(existing, nowMs)) {
    return wavePayload({
      busy: true,
      processed: existing.counts?.pairsProcessed || 0,
      total: existing.counts?.pairsTotal || 0,
      nextCursor: existing.cursor || null,
      counts: existing.counts,
      requests: requestsOf(existing),
      wave: waveDef.id,
    });
  }

  if (existing && existing.status === 'done' && !body.restart) {
    return wavePayload({
      done: true,
      alreadyDone: true,
      processed: existing.counts?.pairsProcessed || 0,
      total: existing.counts?.pairsTotal || 0,
      nextCursor: null,
      counts: existing.counts,
      requests: requestsOf(existing),
      stoppedReason: existing.counts?.stoppedReason || null,
      wave: waveDef.id,
    });
  }

  const restart = Boolean(body.restart) || !existing;
  let run = restart
    ? {
        id: runId,
        kind: 'wave',
        wave: waveDef.id,
        query: query || null,
        status: 'running',
        cursor: { pairIndex: 0 },
        counts: emptyWaveCounts(0),
        report: {},
        text_search_used: 0,
        details_used: 0,
        max_text_search: maxText,
        max_details: maxDetails,
        locked_until: null,
        created_at: new Date(nowMs).toISOString(),
      }
    : {
        ...existing,
        max_text_search: existing.max_text_search ?? maxText,
        max_details: existing.max_details ?? maxDetails,
      };

  run.status = 'running';
  run.locked_until = new Date(nowMs + timeBudgetMs + 15_000).toISOString();
  await options.saveRun(run);

  const remainingText = Math.max(0, (run.max_text_search || 0) - (run.text_search_used || 0));
  const remainingDetails = Math.max(0, (run.max_details || 0) - (run.details_used || 0));
  const budget = options.budget || createPlacesBudget({
    maxTextSearch: remainingText,
    maxDetails: remainingDetails,
    minIntervalMs: options.minIntervalMs,
    cacheStore: options.cacheStore || null,
    cache: options.cache === false ? false : Boolean(options.cacheStore),
  });

  try {
    if (remainingText <= 0 || remainingDetails <= 0) {
      const stoppedReason = remainingText <= 0 ? 'text_search_cap' : 'details_cap';
      run.status = 'done';
      run.locked_until = null;
      run.counts = { ...(run.counts || emptyWaveCounts(0)), stoppedReason };
      await options.saveRun(run);
      return wavePayload({
        done: true,
        processed: run.counts.pairsProcessed || 0,
        total: run.counts.pairsTotal || 0,
        counts: run.counts,
        requests: requestsOf(run),
        stoppedReason,
        wave: waveDef.id,
      });
    }

    const stagedRows = options.listStaged ? await options.listStaged(waveDef.id) : [];
    const already = new Set((stagedRows || []).map((row) => row.place_id).filter(Boolean));
    const accepted = [];
    const runner = options.runWave || runWave;
    const result = await runner({
      wave: waveDef.id,
      query: query || undefined,
      tileStart: hasTile ? tileStart : undefined,
      tileCount: hasTile ? tileCount : undefined,
      cursor: restart ? { pairIndex: 0 } : (run.cursor || { pairIndex: 0 }),
      timeBudgetMs,
      now: nowFn,
      locations: options.locations || [],
      masterCatalog: options.masterCatalog || {},
      knownPlaceIds: already,
      batchSeed: stagedRows || [],
      apiKey: options.apiKey,
      geminiApiKey: options.geminiApiKey,
      budget,
      minIntervalMs: options.minIntervalMs,
      textSearch: options.textSearch,
      details: options.details,
      classify: options.classify,
      verify: options.verify,
      onStage: async (chunk) => {
        const fresh = [];
        for (const row of chunk || []) {
          if (!row?.place_id || already.has(row.place_id)) continue;
          already.add(row.place_id);
          fresh.push(row);
          accepted.push(row);
        }
        if (!fresh.length || !options.upsertCandidates) return;
        const saved = await options.upsertCandidates(fresh);
        if (!saved || saved.ok === false) {
          throw new Error(saved?.error?.message || 'Не вдалося записати import_candidates');
        }
      },
    });

    const textUsedNow = Math.max(result.cost?.textSearchRequests || 0, budget.stats?.textSearch || 0);
    const detailsUsedNow = Math.max(result.cost?.detailsRequests || 0, budget.stats?.details || 0);
    const cacheHitsNow = Math.max(result.cost?.cacheHits || 0, budget.stats?.cacheHits || 0);
    const counts = mergeCounts(restart ? null : run.counts, {
      pairsProcessed: result.processed || 0,
      byDedup: tallyDedup(accepted),
      staged: accepted.length,
      skipped: result.counts?.skipped || {},
      textSearch: textUsedNow,
      details: detailsUsedNow,
      cacheHits: cacheHitsNow,
      stoppedReason: result.stoppedReason || null,
    }, result.total);
    const textUsed = (restart ? 0 : run.text_search_used || 0) + textUsedNow;
    const detailsUsed = (restart ? 0 : run.details_used || 0) + detailsUsedNow;
    const capStop = result.stoppedReason === 'text_search_cap' || result.stoppedReason === 'details_cap';
    const done = Boolean(result.done) || capStop;
    run = {
      ...run,
      status: done ? 'done' : 'running',
      cursor: done ? { pairIndex: result.total || counts.pairsProcessed } : (result.nextCursor || run.cursor),
      counts,
      text_search_used: textUsed,
      details_used: detailsUsed,
      locked_until: null,
    };
    await options.saveRun(run);
    return wavePayload({
      done,
      processed: counts.pairsProcessed,
      total: result.total || counts.pairsTotal,
      nextCursor: done ? null : result.nextCursor,
      counts,
      requests: {
        textSearch: textUsed,
        details: detailsUsed,
        maxTextSearch: run.max_text_search,
        maxDetails: run.max_details,
        cacheHits: counts.cacheHits,
      },
      stoppedReason: result.stoppedReason,
      wave: waveDef.id,
    });
  } catch (err) {
    run.text_search_used = (restart ? 0 : existing?.text_search_used || 0) + (budget.stats?.textSearch || 0);
    run.details_used = (restart ? 0 : existing?.details_used || 0) + (budget.stats?.details || 0);
    run.locked_until = null;
    run.status = 'running';
    try {
      await options.saveRun(run);
    } catch (_) {
      /* surface the original error */
    }
    throw err;
  }
}

function backfillCounts(run) {
  const report = run?.report || {};
  return {
    scanned: run?.cursor?.index || 0,
    confident: (report.confident || []).length,
    skipped: (report.skipped || []).length,
    written: report.written || 0,
    textSearch: run?.text_search_used || 0,
    details: 0,
  };
}

function publicReport(report) {
  if (!report) return null;
  return {
    confident: report.confident || [],
    skipped: report.skipped || [],
    written: report.written || 0,
    confidentCount: (report.confident || []).length,
    skippedCount: (report.skipped || []).length,
  };
}

function backfillPayload(fields) {
  return {
    ok: true,
    dryRun: !fields.write,
    done: Boolean(fields.done),
    busy: Boolean(fields.busy),
    alreadyDone: Boolean(fields.alreadyDone),
    processed: fields.processed || 0,
    total: fields.total || 0,
    nextCursor: fields.nextCursor || null,
    counts: fields.counts || {},
    requests: fields.requests || {},
    stoppedReason: fields.stoppedReason || null,
    report: fields.report || null,
    write: Boolean(fields.write),
  };
}

function activeWithoutPlaceId(locations) {
  return (locations || []).filter((loc) => loc && !loc.deletedAt && !loc.googlePlaceId && loc.id);
}

async function executeBackfillChunk(options = {}) {
  const body = options.body || {};
  const write = body.write === true;
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  const nowMs = nowFn();
  const runId = backfillRunId(write);
  const timeBudgetMs = clampBudget(body.timeBudgetMs);
  const maxText = boundedInt(body.maxTextSearch, BACKFILL_MAX_TEXT, BACKFILL_MAX_TEXT);
  const existing = await options.getRun(runId);

  if (existing && lockActive(existing, nowMs)) {
    return backfillPayload({
      busy: true,
      write,
      processed: existing.cursor?.index || 0,
      total: existing.report?.locationIds?.length || 0,
      nextCursor: existing.cursor || null,
      counts: backfillCounts(existing),
      requests: {
        textSearch: existing.text_search_used || 0,
        details: 0,
        maxTextSearch: existing.max_text_search || maxText,
        maxDetails: 0,
      },
    });
  }

  if (existing && existing.status === 'done' && !body.restart) {
    return backfillPayload({
      done: true,
      alreadyDone: true,
      write,
      processed: existing.cursor?.index || existing.report?.locationIds?.length || 0,
      total: existing.report?.locationIds?.length || 0,
      counts: backfillCounts(existing),
      requests: {
        textSearch: existing.text_search_used || 0,
        details: 0,
        maxTextSearch: existing.max_text_search || maxText,
        maxDetails: 0,
        cacheHits: existing.counts?.cacheHits || 0,
      },
      stoppedReason: existing.counts?.stoppedReason || null,
      report: publicReport(existing.report),
    });
  }

  const restart = Boolean(body.restart) || !existing;
  const locations = await options.loadLocations();
  let run = restart
    ? {
        id: runId,
        kind: 'backfill',
        wave: null,
        query: null,
        status: 'running',
        cursor: { index: 0 },
        counts: {},
        report: {
          locationIds: activeWithoutPlaceId(locations).map((loc) => loc.id),
          confident: [],
          skipped: [],
          written: 0,
        },
        text_search_used: 0,
        details_used: 0,
        max_text_search: maxText,
        max_details: 0,
        locked_until: null,
        created_at: new Date(nowMs).toISOString(),
      }
    : { ...existing };

  if (!Array.isArray(run.report?.locationIds)) {
    run.report = {
      locationIds: activeWithoutPlaceId(locations).map((loc) => loc.id),
      confident: [],
      skipped: [],
      written: 0,
    };
  }

  run.status = 'running';
  run.locked_until = new Date(nowMs + timeBudgetMs + 15_000).toISOString();
  await options.saveRun(run);

  const ids = run.report.locationIds;
  const start = restart ? 0 : Math.max(0, Number(run.cursor?.index) || 0);
  const byId = new Map((locations || []).map((loc) => [loc.id, loc]));
  const remainingText = Math.max(0, (run.max_text_search || maxText) - (run.text_search_used || 0));
  const budget = options.budget || createPlacesBudget({
    maxTextSearch: remainingText,
    maxDetails: 0,
    minIntervalMs: options.minIntervalMs,
    cacheStore: options.cacheStore || null,
    cache: options.cache === false ? false : Boolean(options.cacheStore),
  });
  const startedAt = nowFn();
  const overTime = () => nowFn() - startedAt >= timeBudgetMs;
  let index = start;
  let stoppedReason = null;
  const freshConfident = [];
  const freshSkipped = [];
  let writtenNow = 0;

  try {
    if (remainingText <= 0 && start < ids.length) {
      stoppedReason = 'text_search_cap';
    } else {
      for (; index < ids.length; index += 1) {
        if (overTime()) {
          stoppedReason = 'time_budget';
          break;
        }
        if ((run.text_search_used || 0) + (budget.stats.textSearch || 0) >= (run.max_text_search || maxText)) {
          stoppedReason = 'text_search_cap';
          break;
        }
        const loc = byId.get(ids[index]);
        if (!loc) {
          freshSkipped.push({ id: ids[index], reason: 'missing' });
          continue;
        }
        if (loc.googlePlaceId) {
          freshSkipped.push({ id: loc.id, title: loc.title, reason: 'has_place_id' });
          continue;
        }
        if (overTime()) {
          stoppedReason = 'time_budget';
          break;
        }
        let places = [];
        try {
          const spent = await budget.spend('text', `backfill:${loc.id}:${loc.title}`, () => options.search(loc));
          places = spent.value || [];
        } catch (err) {
          if (err instanceof PlacesQuotaError || err.code === 'cap') {
            stoppedReason = 'text_search_cap';
            break;
          }
          freshSkipped.push({ id: loc.id, title: loc.title, reason: 'search_error' });
          continue;
        }
        const match = chooseBackfillMatch(loc, places);
        const entry = {
          id: loc.id,
          title: loc.title,
          phone: maskPhone(loc.phone),
          reason: match.reason,
          placeId: match.placeId || null,
          distanceMeters: Number.isFinite(match.distance) ? Math.round(match.distance) : null,
        };
        if (!match.confident) {
          freshSkipped.push(entry);
          continue;
        }
        if (write) {
          if (!options.writePlaceId) throw new Error('Запис place id не налаштовано');
          const saved = await options.writePlaceId(loc.id, match.placeId);
          if (!saved || saved.ok === false) {
            entry.writeError = saved?.error?.message || 'Не вдалося записати google_place_id';
          } else if (saved.updated) {
            writtenNow += 1;
          }
        }
        freshConfident.push(entry);
      }
    }
  } catch (err) {
    run.text_search_used = (restart ? 0 : existing?.text_search_used || 0) + (budget.stats.textSearch || 0);
    run.locked_until = null;
    run.status = 'running';
    try {
      await options.saveRun(run);
    } catch (_) {
      /* keep the original error */
    }
    throw err;
  }

  const done = index >= ids.length || stoppedReason === 'text_search_cap';
  const report = {
    locationIds: ids,
    confident: [...(restart ? [] : run.report.confident || []), ...freshConfident],
    skipped: [...(restart ? [] : run.report.skipped || []), ...freshSkipped],
    written: (restart ? 0 : run.report.written || 0) + writtenNow,
  };
  const textUsed = (restart ? 0 : run.text_search_used || 0) + (budget.stats.textSearch || 0);
  run = {
    ...run,
    status: done ? 'done' : 'running',
    cursor: { index },
    report,
    counts: {
      cacheHits: (restart ? 0 : run.counts?.cacheHits || 0) + (budget.stats.cacheHits || 0),
      stoppedReason,
    },
    text_search_used: textUsed,
    details_used: 0,
    locked_until: null,
  };
  await options.saveRun(run);
  return backfillPayload({
    done,
    write,
    processed: index,
    total: ids.length,
    nextCursor: done ? null : { index },
    counts: backfillCounts(run),
    requests: {
      textSearch: textUsed,
      details: 0,
      maxTextSearch: run.max_text_search,
      maxDetails: 0,
      cacheHits: run.counts.cacheHits || 0,
    },
    stoppedReason,
    report: done ? publicReport(report) : null,
  });
}

module.exports = {
  CHUNK_TIME_BUDGET_MS,
  MAX_CHUNK_BUDGET_MS,
  HARD_MAX_TEXT_SEARCH,
  HARD_MAX_DETAILS,
  BACKFILL_MAX_TEXT,
  waveRunId,
  backfillRunId,
  summarizeDedup,
  mergeCounts,
  executeWaveChunk,
  executeBackfillChunk,
};
