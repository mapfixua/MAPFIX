'use strict';

require('./env.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runWave, buildWavePairs } = require('../places-v2.js');
const { createPlacesBudget } = require('../places-quota.js');
const { executeWaveChunk, executeBackfillChunk, executeWaveReset } = require('../places-chunk.js');
const { getServiceRoleClient } = require('../supabaseClient.js');
const { listImportCandidates } = require('../import-candidates-store.js');

const catalog = {
  home: {
    name: 'Дім',
    subcats: {
      plumber: { name: 'Послуги сантехніка', items: [{ name: 'Усунення засмічення труб' }] },
    },
  },
};

const plumber = { key: 'plumber', cat: 'home', sub: 'plumber', query: 'сантехнік' };

function tile(id) {
  return { south: 50.44, west: 30.5 + id / 1000, north: 50.46, east: 30.54 };
}

function place(placeId, lat = 50.451) {
  return {
    placeId,
    title: 'Майстерня Тепла Вода',
    phone: '+380671234567',
    lat,
    lng: 30.525,
    businessStatus: 'OPERATIONAL',
    reviewsCount: 6,
    types: ['plumber'],
  };
}

function details(placeId) {
  return {
    id: placeId,
    displayName: { text: 'Майстерня Тепла Вода' },
    formattedAddress: 'Київ',
    location: { latitude: 50.451, longitude: 30.525 },
    nationalPhoneNumber: '+380671234567',
    businessStatus: 'OPERATIONAL',
    userRatingCount: 6,
    rating: 4.8,
    types: ['plumber'],
    reviews: [{ rating: 5, text: { text: 'Швидко' }, publishTime: new Date().toISOString() }],
  };
}

const accepted = {
  accepted: true,
  category: 'home',
  subcategory: 'plumber',
  services: ['Усунення засмічення труб'],
  confidence: 0.92,
  reasoning: 'сантехнік',
};

function memoryRuns() {
  const rows = new Map();
  return {
    rows,
    async getRun(id) {
      const row = rows.get(id);
      return row ? JSON.parse(JSON.stringify(row)) : null;
    },
    async saveRun(row) {
      rows.set(row.id, JSON.parse(JSON.stringify(row)));
    },
  };
}

function budget(maxTextSearch, extra = {}) {
  return createPlacesBudget({
    maxTextSearch,
    maxDetails: extra.maxDetails ?? 20,
    minIntervalMs: 0,
    cache: extra.cache === true ? true : false,
    cacheStore: extra.cacheStore,
    ...extra,
  });
}

test('wave pairs are one text search per target per tile', () => {
  assert.equal(buildWavePairs([plumber, { query: 'пекарня' }], [tile(0), tile(1), tile(2)]).length, 6);
});

test('a chunk stops on the time budget and the next chunk resumes the cursor', async () => {
  let ticks = 0;
  const searches = [];
  const now = () => ticks;
  const first = await runWave({
    wave: 'A',
    tiles: [tile(0), tile(1), tile(2)],
    targets: [plumber],
    locations: [],
    masterCatalog: catalog,
    timeBudgetMs: 40,
    now,
    budget: budget(10),
    textSearch: async ({ bounds }) => {
      ticks += 10;
      searches.push(bounds.west);
      return [place(`p-${bounds.west}`)];
    },
    details: async ({ placeId }) => {
      ticks += 10;
      return details(placeId);
    },
    classify: async () => {
      ticks += 10;
      return accepted;
    },
    verify: async () => {
      ticks += 10;
      return { decision: 'accept', confidence: 0.9, reasoning: 'ok' };
    },
  });
  assert.equal(first.done, false);
  assert.equal(first.stoppedReason, 'time_budget');
  assert.equal(first.processed, 1);
  assert.deepEqual(first.nextCursor, { pairIndex: 1 });
  assert.equal(searches.length, 1);
  assert.equal(first.candidates.length, 1);

  ticks = 0;
  const second = await runWave({
    wave: 'A',
    tiles: [tile(0), tile(1), tile(2)],
    targets: [plumber],
    locations: [],
    masterCatalog: catalog,
    timeBudgetMs: 10_000,
    now,
    cursor: first.nextCursor,
    budget: budget(10),
    textSearch: async ({ bounds }) => {
      searches.push(bounds.west);
      return [place(`p-${bounds.west}`)];
    },
    details: async ({ placeId }) => details(placeId),
    classify: async () => accepted,
    verify: async () => ({ decision: 'accept', confidence: 0.9, reasoning: 'ok' }),
  });
  assert.equal(second.done, true);
  assert.equal(second.processed, 2);
  assert.equal(searches.length, 3);
  assert.deepEqual(second.candidates.map((row) => row.place_id), [`p-${tile(1).west}`, `p-${tile(2).west}`]);
});

test('an unfinished pair retries from cache instead of billing Text Search again', async () => {
  const cache = new Map();
  const cacheStore = {
    async get(key) {
      return cache.has(key) ? cache.get(key) : null;
    },
    async set(key, value) {
      cache.set(key, value);
    },
  };
  let ticks = 0;
  let searches = 0;
  const now = () => ticks;
  const shared = {
    wave: 'A',
    tiles: [tile(0)],
    targets: [plumber],
    locations: [],
    masterCatalog: catalog,
    timeBudgetMs: 30,
    now,
    textSearch: async () => {
      searches += 1;
      ticks += 100;
      return [place('p-cache')];
    },
    details: async ({ placeId }) => details(placeId),
    classify: async () => accepted,
    verify: async () => ({ decision: 'accept', confidence: 0.9, reasoning: 'ok' }),
  };
  const first = await runWave({ ...shared, budget: budget(5, { cache: true, cacheStore }) });
  assert.equal(first.processed, 0);
  assert.equal(first.nextCursor.pairIndex, 0);
  assert.equal(first.candidates.length, 0);
  assert.equal(searches, 1);

  ticks = 0;
  const second = await runWave({
    ...shared,
    timeBudgetMs: 10_000,
    budget: budget(5, { cache: true, cacheStore }),
  });
  assert.equal(searches, 1);
  assert.equal(second.done, true);
  assert.equal(second.candidates[0].place_id, 'p-cache');
  assert.equal(second.cost.cacheHits >= 1, true);
  assert.equal(second.cost.textSearchRequests, 0);
});

test('text search cap stops before another billable call', async () => {
  let calls = 0;
  const result = await runWave({
    wave: 'A',
    tiles: [tile(0), tile(1), tile(2), tile(3)],
    targets: [plumber],
    locations: [],
    masterCatalog: catalog,
    budget: budget(2),
    textSearch: async () => {
      calls += 1;
      return [];
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.stoppedReason, 'text_search_cap');
  assert.equal(result.processed, 2);
  assert.equal(result.done, false);
  assert.equal(result.nextCursor.pairIndex, 2);
});

test('staged place ids are not fetched again and still dedup later rows', async () => {
  const detailIds = [];
  const result = await runWave({
    wave: 'A',
    tiles: [tile(0)],
    targets: [plumber],
    locations: [],
    masterCatalog: catalog,
    knownPlaceIds: new Set(['p1']),
    batchSeed: [{
      id: 'staged:p1',
      place_id: 'p1',
      proposed_title: 'Майстерня Тепла Вода',
      proposed_phone: '+380671234567',
      proposed_lat: 50.451,
      proposed_lng: 30.525,
    }],
    budget: budget(5),
    textSearch: async () => [place('p1'), place('p2', 50.4511)],
    details: async ({ placeId }) => {
      detailIds.push(placeId);
      return details(placeId);
    },
    classify: async () => accepted,
    verify: async () => ({ decision: 'accept', confidence: 0.9, reasoning: 'ok' }),
  });
  assert.deepEqual(detailIds, ['p2']);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].place_id, 'p2');
  assert.equal(result.candidates[0].dedup_status, 'duplicate_of staged:p1');
});

test('query and tile window limit the pairs in one chunk', async () => {
  const queries = [];
  const result = await runWave({
    wave: 'A',
    query: 'сантехнік',
    tileStart: 0,
    tileCount: 1,
    locations: [],
    masterCatalog: catalog,
    budget: budget(5),
    textSearch: async ({ query }) => {
      queries.push(query);
      return [];
    },
  });
  assert.deepEqual(queries, ['сантехнік']);
  assert.equal(result.total, 1);
  assert.equal(result.done, true);
});

test('chunk runner keeps the 800 cap across resumes and skips staged place ids', async () => {
  const store = memoryRuns();
  const seenCaps = [];
  const upserted = [];
  let runCalls = 0;
  const base = {
    body: { wave: 'A', maxTextSearch: 5000, maxDetails: 9000 },
    cache: false,
    minIntervalMs: 0,
    getRun: store.getRun,
    saveRun: store.saveRun,
    listStaged: async () => [{ place_id: 'already', id: 'row-1', proposed_title: 'Вже', proposed_phone: '', proposed_lat: 50.45, proposed_lng: 30.52 }],
    upsertCandidates: async (rows) => {
      upserted.push(...rows.map((row) => row.place_id));
      return { ok: true, upserted: rows.length };
    },
    runWave: async (opts) => {
      runCalls += 1;
      seenCaps.push(opts.budget.maxTextSearch);
      assert.equal(opts.knownPlaceIds.has('already'), true);
      if (runCalls === 1) {
        await opts.onStage([
          { place_id: 'already', dedup_status: 'new' },
          { place_id: 'fresh', dedup_status: 'duplicate_of loc-1' },
        ]);
      }
      const used = runCalls === 1 ? 10 : 790;
      return {
        processed: 1,
        total: 4,
        done: false,
        stoppedReason: 'time_budget',
        nextCursor: { pairIndex: runCalls },
        counts: { skipped: {} },
        cost: { textSearchRequests: used, detailsRequests: 0, cacheHits: 0 },
      };
    },
  };
  const first = await executeWaveChunk(base);
  assert.equal(first.done, false);
  assert.equal(first.processed, 1);
  assert.deepEqual(first.nextCursor, { pairIndex: 1 });
  assert.equal(seenCaps[0], 800);
  assert.deepEqual(upserted, ['fresh']);
  assert.equal(first.counts.staged, 1);
  assert.equal(first.counts.byDedup['duplicate_of loc-1'], 1);
  assert.equal(first.counts.dedupBuckets.duplicate, 1);
  assert.equal(first.requests.maxTextSearch, 800);
  assert.equal(store.rows.get('wave:A').max_text_search, 800);

  const second = await executeWaveChunk(base);
  assert.equal(seenCaps[1], 790);
  assert.equal(second.requests.textSearch, 800);
  assert.equal(second.done, false);

  const third = await executeWaveChunk(base);
  assert.equal(runCalls, 2);
  assert.equal(third.done, true);
  assert.equal(third.stoppedReason, 'text_search_cap');
  assert.equal(third.requests.textSearch, 800);
});

test('a finished wave does not spend again until restart', async () => {
  const store = memoryRuns();
  let calls = 0;
  const options = {
    body: { wave: 'A' },
    cache: false,
    minIntervalMs: 0,
    getRun: store.getRun,
    saveRun: store.saveRun,
    listStaged: async () => [],
    runWave: async () => {
      calls += 1;
      return {
        processed: 2,
        total: 2,
        done: true,
        stoppedReason: null,
        nextCursor: null,
        counts: { skipped: {} },
        cost: { textSearchRequests: 2, detailsRequests: 1, cacheHits: 0 },
      };
    },
  };
  const done = await executeWaveChunk(options);
  assert.equal(done.done, true);
  assert.equal(done.processed, 2);
  const again = await executeWaveChunk(options);
  assert.equal(again.alreadyDone, true);
  assert.equal(calls, 1);
  const restarted = await executeWaveChunk({ ...options, body: { wave: 'A', restart: true } });
  assert.equal(restarted.done, true);
  assert.equal(calls, 2);
  assert.equal(store.rows.get('wave:A').text_search_used, 2);
});

test('a real wave chunk resumes inside the time budget and the next chunk hits the remaining cap', async () => {
  const store = memoryRuns();
  let ticks = 0;
  let searches = 0;
  let detailsCalls = 0;
  const now = () => ticks;
  const step = async (fn) => {
    ticks += 300;
    return fn();
  };
  const options = {
    body: { wave: 'A', maxTextSearch: 1, maxDetails: 5, timeBudgetMs: 1000 },
    now,
    cache: false,
    minIntervalMs: 0,
    locations: [],
    masterCatalog: catalog,
    getRun: store.getRun,
    saveRun: store.saveRun,
    listStaged: async () => [],
    upsertCandidates: async (rows) => ({ ok: true, upserted: rows.length }),
    textSearch: async () => step(() => {
      searches += 1;
      return [place(`p-${searches}`)];
    }),
    details: async ({ placeId }) => step(() => {
      detailsCalls += 1;
      return details(placeId);
    }),
    classify: async () => step(() => accepted),
    verify: async () => step(() => ({ decision: 'accept', confidence: 0.9, reasoning: 'ok' })),
  };
  const first = await executeWaveChunk(options);
  assert.equal(first.done, false);
  assert.equal(first.stoppedReason, 'time_budget');
  assert.equal(first.processed, 1);
  assert.equal(searches, 1);
  assert.equal(detailsCalls, 1);
  assert.equal(first.requests.textSearch, 1);
  assert.equal(first.total > 1, true);

  ticks = 0;
  const second = await executeWaveChunk(options);
  assert.equal(second.done, true);
  assert.equal(second.stoppedReason, 'text_search_cap');
  assert.equal(searches, 1);
  assert.equal(detailsCalls, 1);
  assert.equal(second.requests.textSearch, 1);
  assert.equal(second.requests.maxTextSearch, 1);
});

test('backfill dry-run is chunked, capped, and does not write place ids', async () => {
  const store = memoryRuns();
  const locations = [
    { id: 'l1', title: 'Майстерня', phone: '+380671234567', lat: 50.45, lng: 30.52 },
    { id: 'l2', title: 'Інша', phone: '+380501110000', lat: 50.46, lng: 30.53 },
  ];
  let searches = 0;
  let ticks = 0;
  const writes = [];
  const now = () => ticks;
  const options = {
    body: { timeBudgetMs: 1000, maxTextSearch: 500 },
    now,
    cache: false,
    minIntervalMs: 0,
    getRun: store.getRun,
    saveRun: store.saveRun,
    loadLocations: async () => locations,
    writePlaceId: async (id, placeId) => {
      writes.push({ id, placeId });
      return { ok: true, updated: 1 };
    },
    search: async (loc) => {
      searches += 1;
      ticks += 1500;
      if (loc.id !== 'l1') return [];
      return [{
        placeId: 'g-l1',
        title: 'Майстерня',
        phone: '+380671234567',
        lat: 50.4501,
        lng: 30.5201,
      }];
    },
  };
  const first = await executeBackfillChunk(options);
  assert.equal(first.dryRun, true);
  assert.equal(first.write, false);
  assert.equal(first.done, false);
  assert.equal(first.processed, 1);
  assert.deepEqual(first.nextCursor, { index: 1 });
  assert.equal(first.counts.confident, 1);
  assert.equal(writes.length, 0);
  assert.equal(store.rows.get('backfill:place-id:dry').text_search_used, 1);

  ticks = 0;
  const second = await executeBackfillChunk({ ...options, body: { timeBudgetMs: 20000 } });
  assert.equal(second.done, true);
  assert.equal(second.stoppedReason, null);
  assert.equal(searches, 2);
  assert.equal(writes.length, 0);
  assert.equal(second.counts.confident, 1);
  assert.equal(second.report.confident[0].placeId, 'g-l1');
  assert.equal(second.report.confident[0].phone, '***4567');
  assert.equal(second.report.locationIds, undefined);

  const capped = memoryRuns();
  let cappedSearches = 0;
  const cappedRun = await executeBackfillChunk({
    body: { maxTextSearch: 1, timeBudgetMs: 20000 },
    cache: false,
    minIntervalMs: 0,
    getRun: capped.getRun,
    saveRun: capped.saveRun,
    loadLocations: async () => locations,
    search: async () => {
      cappedSearches += 1;
      return [];
    },
  });
  assert.equal(cappedSearches, 1);
  assert.equal(cappedRun.done, true);
  assert.equal(cappedRun.stoppedReason, 'text_search_cap');
  assert.equal(cappedRun.requests.textSearch, 1);
  assert.equal(cappedRun.requests.maxTextSearch, 1);
});

test('backfill write updates only through the place id writer', async () => {
  const store = memoryRuns();
  const writes = [];
  const locations = [{ id: 'l1', title: 'Майстерня', phone: '+380671234567', lat: 50.45, lng: 30.52 }];
  const data = await executeBackfillChunk({
    body: { write: true },
    cache: false,
    minIntervalMs: 0,
    getRun: store.getRun,
    saveRun: store.saveRun,
    loadLocations: async () => locations,
    search: async () => [{
      placeId: 'g-l1',
      title: 'Майстерня',
      phone: '+380671234567',
      lat: 50.4501,
      lng: 30.5201,
    }],
    writePlaceId: async (id, placeId) => {
      writes.push({ id, placeId, columns: ['google_place_id'] });
      return { ok: true, updated: 1 };
    },
  });
  assert.equal(data.dryRun, false);
  assert.equal(data.done, true);
  assert.equal(data.counts.written, 1);
  assert.deepEqual(writes, [{ id: 'l1', placeId: 'g-l1', columns: ['google_place_id'] }]);
  assert.equal(store.rows.has('backfill:place-id:dry'), false);
});

test('places cache hits do not spend the text search cap', async () => {
  const cache = new Map();
  const cacheStore = {
    async get(key) {
      return cache.has(key) ? cache.get(key) : null;
    },
    async set(key, value) {
      cache.set(key, value);
    },
  };
  const placesBudget = createPlacesBudget({ maxTextSearch: 1, maxDetails: 1, minIntervalMs: 0, cacheStore });
  const first = await placesBudget.spend('text', 'tile-a', async () => [{ placeId: 'p1' }]);
  const second = await placesBudget.spend('text', 'tile-a', async () => {
    throw new Error('cache miss');
  });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(placesBudget.stats.textSearch, 1);
  assert.equal(placesBudget.stats.cacheHits, 1);
});

test('text search records the HTTP status and Google error without the API key', async () => {
  const apiKey = 'AIzaSyTestKeyValue1234567890';
  const secretUrl = `https://places.googleapis.com/v1/places:searchText?key=${apiKey}`;
  const googleMessage = `Requests are blocked. ${secretUrl} ${'x'.repeat(400)}`;
  const original = global.fetch;
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args);
  global.fetch = async (url, opts) => {
    assert.equal(String(url).includes('key='), false);
    assert.equal(String(url).includes(apiKey), false);
    assert.equal(opts.headers['X-Goog-Api-Key'], apiKey);
    return {
      ok: false,
      status: 403,
      json: async () => ({
        error: {
          code: 403,
          status: 'PERMISSION_DENIED',
          message: googleMessage,
        },
      }),
    };
  };
  try {
    const result = await runWave({
      apiKey,
      wave: 'A',
      tiles: [tile(0)],
      targets: [plumber],
      locations: [],
      masterCatalog: catalog,
      budget: budget(5),
    });
    assert.equal(result.counts.skipped.text_search_error, 1);
    assert.equal(result.counts.lastTextSearchHttpStatus, 403);
    assert.match(result.counts.lastTextSearchError, /HTTP 403/);
    assert.match(result.counts.lastTextSearchError, /PERMISSION_DENIED/);
    assert.match(result.counts.lastTextSearchError, /Requests are blocked/);
    assert.equal(result.counts.lastTextSearchError.length <= 300, true);
    assert.equal(result.counts.lastTextSearchError.includes(apiKey), false);
    assert.equal(result.counts.lastTextSearchError.includes('places.googleapis.com'), false);
    assert.equal(result.counts.lastTextSearchError.includes('key='), false);
    const line = logs.find((args) => args[0] === '[places-v2] text_search_error');
    assert.ok(line);
    assert.equal(line.length, 2);
    assert.match(line[1], /^403 /);
    assert.equal(line[1].includes(apiKey), false);
    assert.equal(line[1].includes('http'), false);
    assert.equal(line.slice(1).join(' '), result.counts.lastTextSearchError ? `403 ${result.counts.lastTextSearchError}` : line[1]);
  } finally {
    global.fetch = original;
    console.error = originalError;
  }
});

test('three identical text search errors stop the wave before the remaining pairs', async () => {
  const store = memoryRuns();
  let calls = 0;
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args);
  try {
    const result = await executeWaveChunk({
      body: { wave: 'A', timeBudgetMs: 20000 },
      cache: false,
      minIntervalMs: 0,
      locations: [],
      masterCatalog: catalog,
      getRun: store.getRun,
      saveRun: store.saveRun,
      listStaged: async () => [],
      textSearch: async () => {
        calls += 1;
        const error = new Error('HTTP 403 PERMISSION_DENIED blocked https://maps.googleapis.com/maps?key=AIzaSyBreakerKey1234567890');
        error.status = 403;
        throw error;
      },
    });
    assert.equal(calls, 3);
    assert.equal(result.done, false);
    assert.equal(result.stoppedReason, 'text_search_error');
    assert.equal(result.total > 3, true);
    assert.deepEqual(result.nextCursor, { pairIndex: 0 });
    assert.equal(result.counts.skipped.text_search_error, 3);
    assert.equal(result.counts.lastTextSearchHttpStatus, 403);
    assert.match(result.counts.lastTextSearchError, /PERMISSION_DENIED/);
    assert.equal(result.counts.lastTextSearchError.includes('AIzaSyBreakerKey1234567890'), false);
    assert.equal(result.counts.lastTextSearchError.includes('http'), false);
    const row = store.rows.get('wave:A');
    assert.equal(row.status, 'running');
    assert.notEqual(row.status, 'done');
    assert.deepEqual(row.cursor, { pairIndex: 0 });
    assert.equal(row.counts.lastTextSearchError, result.counts.lastTextSearchError);
    assert.equal(row.counts.lastTextSearchHttpStatus, 403);
    assert.equal(row.counts.stoppedReason, 'text_search_error');
    assert.equal(row.text_search_used, 3);
    assert.equal(logs.length, 3);
    for (const args of logs) {
      assert.equal(args[0], '[places-v2] text_search_error');
      assert.equal(args.join(' ').includes('AIzaSyBreakerKey1234567890'), false);
      assert.equal(args.join(' ').includes('http'), false);
    }
  } finally {
    console.error = originalError;
  }
});

test('the breaker rewinds only the consecutive identical errors', async () => {
  let calls = 0;
  const result = await runWave({
    wave: 'A',
    tiles: [tile(0), tile(1), tile(2), tile(3), tile(4), tile(5)],
    targets: [plumber],
    locations: [],
    masterCatalog: catalog,
    budget: budget(10),
    textSearch: async () => {
      const index = calls;
      calls += 1;
      if (index === 0) return [];
      const error = new Error(index === 1 ? 'other' : 'same');
      error.status = 400;
      throw error;
    },
  });
  assert.equal(calls, 5);
  assert.equal(result.stoppedReason, 'text_search_error');
  assert.equal(result.done, false);
  assert.equal(result.processed, 2);
  assert.deepEqual(result.nextCursor, { pairIndex: 2 });
  assert.equal(result.counts.lastTextSearchError, 'other');
  assert.equal(result.counts.lastTextSearchHttpStatus, 400);
  assert.equal(result.counts.skipped.text_search_error, 4);
});

test('different text search errors do not trip the breaker and keep the first one', async () => {
  let calls = 0;
  const result = await runWave({
    wave: 'A',
    tiles: [tile(0), tile(1), tile(2)],
    targets: [plumber],
    locations: [],
    masterCatalog: catalog,
    budget: budget(5),
    textSearch: async () => {
      calls += 1;
      const error = new Error(`fail-${calls}`);
      error.status = 500;
      throw error;
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.done, true);
  assert.equal(result.stoppedReason, null);
  assert.equal(result.counts.skipped.text_search_error, 3);
  assert.equal(result.counts.lastTextSearchError, 'fail-1');
  assert.equal(result.counts.lastTextSearchHttpStatus, 500);
});

function erroredWaveRow(extra = {}) {
  return {
    id: 'wave:A',
    kind: 'wave',
    wave: 'A',
    status: 'done',
    cursor: { pairIndex: 4 },
    counts: {
      pairsProcessed: 4,
      pairsTotal: 4,
      staged: 0,
      byDedup: {},
      skipped: { text_search_error: 4 },
      textSearch: 4,
      details: 0,
      cacheHits: 0,
      stoppedReason: null,
      lastTextSearchError: 'HTTP 403 PERMISSION_DENIED blocked',
      lastTextSearchHttpStatus: 403,
    },
    text_search_used: 4,
    details_used: 0,
    max_text_search: 800,
    max_details: 800,
    report: {},
    ...extra,
  };
}

test('a finished wave whose pairs all errored resets and retries on the next run', async () => {
  const store = memoryRuns();
  await store.saveRun(erroredWaveRow());
  let cursor = null;
  const result = await executeWaveChunk({
    body: { wave: 'A' },
    cache: false,
    minIntervalMs: 0,
    getRun: store.getRun,
    saveRun: store.saveRun,
    listStaged: async () => [],
    runWave: async (opts) => {
      cursor = opts.cursor;
      return {
        processed: 1,
        total: 4,
        done: false,
        stoppedReason: 'time_budget',
        nextCursor: { pairIndex: 1 },
        counts: { skipped: {} },
        cost: { textSearchRequests: 1, detailsRequests: 0, cacheHits: 0 },
      };
    },
  });
  assert.equal(result.alreadyDone, false);
  assert.equal(result.done, false);
  assert.deepEqual(cursor, { pairIndex: 0 });
  const row = store.rows.get('wave:A');
  assert.equal(row.status, 'running');
  assert.equal(row.text_search_used, 5);
  assert.equal(row.counts.pairsProcessed, 1);
  assert.equal(row.counts.lastTextSearchError, 'HTTP 403 PERMISSION_DENIED blocked');
  assert.equal(row.counts.lastTextSearchHttpStatus, 403);
});

test('reset rewinds a text_search_error run and the next run retries those pairs', async () => {
  const store = memoryRuns();
  await store.saveRun(erroredWaveRow({
    status: 'running',
    cursor: { pairIndex: 2 },
    text_search_used: 5,
    details_used: 1,
    counts: {
      pairsProcessed: 2,
      pairsTotal: 10,
      staged: 1,
      byDedup: {},
      skipped: { text_search_error: 3 },
      stoppedReason: 'text_search_error',
      lastTextSearchError: 'HTTP 403 PERMISSION_DENIED blocked',
      lastTextSearchHttpStatus: 403,
    },
  }));
  const reset = await executeWaveReset({
    body: { wave: 'A' },
    getRun: store.getRun,
    saveRun: store.saveRun,
  });
  assert.equal(reset.ok, true);
  assert.equal(reset.reset, true);
  assert.equal(reset.done, false);
  assert.equal(reset.stoppedReason, null);
  let row = store.rows.get('wave:A');
  assert.equal(row.status, 'running');
  assert.deepEqual(row.cursor, { pairIndex: 0 });
  assert.equal(row.counts.stoppedReason, null);
  assert.equal(row.counts.pairsProcessed, 0);
  assert.equal(row.counts.staged, 0);
  assert.equal(row.text_search_used, 5);
  assert.equal(row.details_used, 1);
  assert.equal(row.counts.lastTextSearchHttpStatus, 403);

  let cursor = null;
  const again = await executeWaveChunk({
    body: { wave: 'A' },
    cache: false,
    minIntervalMs: 0,
    getRun: store.getRun,
    saveRun: store.saveRun,
    listStaged: async () => [],
    runWave: async (opts) => {
      cursor = opts.cursor;
      return {
        processed: 1,
        total: 10,
        done: false,
        stoppedReason: null,
        nextCursor: { pairIndex: 1 },
        counts: { skipped: {} },
        cost: { textSearchRequests: 1, detailsRequests: 0, cacheHits: 0 },
      };
    },
  });
  assert.deepEqual(cursor, { pairIndex: 0 });
  assert.equal(again.done, false);
  assert.equal(store.rows.get('wave:A').text_search_used, 6);
  assert.equal(store.rows.get('wave:A').status, 'running');
});

test('reset refuses a wave that is not a text search failure', async () => {
  const store = memoryRuns();
  await store.saveRun(erroredWaveRow({
    counts: {
      pairsProcessed: 4,
      pairsTotal: 4,
      staged: 2,
      byDedup: {},
      skipped: { text_search_error: 1 },
      stoppedReason: null,
    },
  }));
  const denied = await executeWaveReset({
    body: { wave: 'A' },
    getRun: store.getRun,
    saveRun: store.saveRun,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 409);
  assert.equal(store.rows.get('wave:A').cursor.pairIndex, 4);
  assert.equal(store.rows.get('wave:A').text_search_used, 4);
});

test('admin import panel shows the text search error and offers a wave A reset', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/admin.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public/admin-places-v2.js'), 'utf8');
  assert.match(html, /id="placesV2ResetWave"/);
  assert.match(html, /Скинути хвилю A/);
  assert.match(html, /id="placesV2RunError"/);
  assert.match(js, /lastTextSearchError/);
  assert.match(js, /lastTextSearchHttpStatus/);
  assert.match(js, /stoppedReason === 'text_search_error'/);
  assert.match(js, /\/api\/admin\/places-v2\/reset-wave/);
});

test('import queue refuses the anon key', async () => {
  const previous = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_ANON_KEY = 'anon-only';
  try {
    assert.equal(getServiceRoleClient(), null);
    const listed = await listImportCandidates({ wave: 'A' });
    assert.equal(listed.ok, false);
    assert.match(listed.error.message, /SUPABASE_SERVICE_ROLE_KEY is not set/);
  } finally {
    if (previous) process.env.SUPABASE_SERVICE_ROLE_KEY = previous;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

test('migration 022 removes anon access and adds the progress tables', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/022_places_import_chunks_and_rls.sql'), 'utf8');
  const previous = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/021_places_import_v2.sql'), 'utf8');
  const sync = fs.readFileSync(path.join(__dirname, '..', 'supabase/sync_database.sql'), 'utf8');
  for (const file of [sql, previous, sync]) {
    assert.match(file, /REVOKE ALL ON TABLE public\.import_candidates FROM PUBLIC, anon, authenticated/);
    assert.doesNotMatch(file, /CREATE POLICY "import_candidates_select_all"/);
    assert.doesNotMatch(file, /TO anon/);
    assert.doesNotMatch(file, /TO authenticated/);
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.import_runs/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.places_response_cache/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.import_runs FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.places_response_cache FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /TO service_role/);
});
