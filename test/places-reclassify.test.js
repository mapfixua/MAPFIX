'use strict';

require('./env.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { geminiGenerateJson } = require('../search-ai.js');
const {
  suggestFromKeywords,
  withClassifierRetries,
  KEYWORD_DRAFT_CONFIDENCE,
  CONFIDENCE_REJECT_BELOW,
  isClassifierQuotaError,
  isClassifierTransientError,
} = require('../places-classify.js');
const { executeReclassifyChunk } = require('../places-reclassify.js');
const { selectPublishable } = require('../places-publish.js');

const catalog = {
  home: {
    name: 'Дім',
    subcats: {
      plumber: { name: 'Послуги сантехніка', items: [{ name: 'Усунення засмічення труб' }] },
      ac_climate: { name: 'Кондиціонери', items: [{ name: 'Чистка кондиціонера' }] },
    },
  },
  medical: {
    name: 'Медицина',
    subcats: { dentistry: { name: 'Стоматологія', items: [{ name: 'Огляд' }] } },
  },
  food: {
    name: 'Їжа',
    subcats: { bakery: { name: 'Випічка', items: [{ name: 'Хліб' }] } },
  },
  repair: {
    name: 'Ремонт',
    subcats: {
      phones: { name: 'Телефони', items: [{ name: 'Заміна екрана' }] },
      computers: { name: 'Компʼютери', items: [{ name: 'Чистка ноутбука' }] },
    },
  },
  pets: {
    name: 'Тварини',
    subcats: { vet: { name: 'Ветеринар', items: [{ name: 'Огляд' }] } },
  },
};

const accepted = {
  accepted: true,
  category: 'home',
  subcategory: 'plumber',
  services: ['Усунення засмічення труб'],
  confidence: 0.93,
  reasoning: 'сантехнік',
};

function quotaError() {
  const err = new Error('Gemini 429 (gemini-3.1-flash-lite): You exceeded your current quota');
  err.status = 429;
  err.code = 'classifier_quota';
  return err;
}

function needsRow(id, title) {
  return {
    id,
    place_id: `place-${id}`,
    wave: 'A',
    dedup_status: 'new',
    status: 'needs_classify',
    needs_review: true,
    proposed_title: title,
    proposed_cat: 'medical',
    proposed_subcats: ['dentistry'],
    proposed_lat: 50.451,
    proposed_lng: 30.525,
    raw_payload: {
      text: {
        placeId: `place-${id}`,
        title,
        hintCat: 'home',
        hintSub: 'plumber',
        types: ['plumber'],
        query: 'сантехнік',
      },
      details: {
        displayName: { text: title },
        formattedAddress: 'вул. Тестова, Київ',
        location: { latitude: 50.451, longitude: 30.525 },
        businessStatus: 'OPERATIONAL',
        types: ['plumber'],
        reviews: [{ rating: 5, text: { text: 'Виклик сантехніка' }, publishTime: '2026-10-01T00:00:00.000Z' }],
      },
    },
  };
}

test('keyword draft stays below the reject threshold and skips cafes', () => {
  const plumber = suggestFromKeywords({ title: 'Сантехнік на Подолі', types: ['plumber'] }, catalog);
  assert.equal(plumber.category, 'home');
  assert.equal(plumber.subcategory, 'plumber');
  assert.equal(plumber.source, 'keyword');
  assert.equal(plumber.confidence, KEYWORD_DRAFT_CONFIDENCE);
  assert.ok(plumber.confidence < CONFIDENCE_REJECT_BELOW);
  assert.equal(suggestFromKeywords({ title: 'Кафе Хліб', types: ['cafe', 'restaurant'] }, catalog), null);
  assert.equal(suggestFromKeywords({ title: 'Пекарня на Подолі', types: ['bakery'] }, catalog).subcategory, 'bakery');
});

test('quota is not retried and 503 or abort is retried twice', async () => {
  assert.equal(isClassifierQuotaError(quotaError()), true);
  assert.equal(isClassifierTransientError(quotaError()), false);
  const sleeps = [];
  let quotaCalls = 0;
  const quota = await withClassifierRetries(async () => {
    quotaCalls += 1;
    throw quotaError();
  }, { sleep: async (ms) => sleeps.push(ms) });
  assert.equal(quota.quota, true);
  assert.equal(quotaCalls, 1);
  assert.deepEqual(sleeps, []);

  let transientCalls = 0;
  const transient = await withClassifierRetries(async () => {
    transientCalls += 1;
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    throw err;
  }, { sleep: async () => {} });
  assert.equal(transient.ok, false);
  assert.equal(transient.quota, undefined);
  assert.equal(transientCalls, 3);

  const serviceUnavailable = new Error('Gemini 503 (gemini-3.1-flash-lite): unavailable');
  serviceUnavailable.status = 503;
  assert.equal(isClassifierTransientError(serviceUnavailable), true);
});

test('reclassify uses stored payload, never Google, and stops on 429', async () => {
  const updates = [];
  const seen = [];
  let classifyCalls = 0;
  const rows = [needsRow('a', 'Майстерня з payload'), needsRow('b', 'Друга майстерня'), needsRow('c', 'Третя')];
  const result = await executeReclassifyChunk({
    body: { wave: 'A', timeBudgetMs: 5000 },
    masterCatalog: catalog,
    sleep: async () => {},
    listCandidates: async ({ wave, afterId }) => {
      assert.equal(wave, 'A');
      return rows.filter((row) => !afterId || row.id > afterId);
    },
    updateCandidate: async (id, patch) => {
      updates.push({ id, patch });
      return { id, ...patch };
    },
    classify: async (place) => {
      classifyCalls += 1;
      seen.push(place.title);
      assert.equal(place.placeId, classifyCalls === 1 ? 'place-a' : 'place-b');
      assert.equal(place.reviews[0].text, 'Виклик сантехніка');
      assert.equal(place.hintCat, 'home');
      if (place.placeId === 'place-b') throw quotaError();
      return accepted;
    },
    verify: async () => ({
      decision: 'accept',
      category: 'home',
      subcategory: 'plumber',
      services: ['Усунення засмічення труб'],
      confidence: 0.91,
      reasoning: 'відгук про сантехніка',
    }),
  });
  assert.equal(result.googleCalls, 0);
  assert.equal(result.publishedLocations, 0);
  assert.equal(result.dryRun, true);
  assert.equal(result.stoppedReason, 'classifier_quota');
  assert.equal(result.done, false);
  assert.equal(result.reclassified, 1);
  assert.equal(classifyCalls, 2);
  assert.deepEqual(seen, ['Майстерня з payload', 'Друга майстерня']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'a');
  assert.equal(updates[0].patch.status, 'pending');
  assert.notEqual(updates[0].patch.status, 'approved');
  assert.notEqual(updates[0].patch.status, 'published');
  assert.deepEqual(result.nextCursor, { afterId: 'a' });

  const resumed = await executeReclassifyChunk({
    body: { wave: 'A', cursor: result.nextCursor, timeBudgetMs: 5000 },
    masterCatalog: catalog,
    sleep: async () => {},
    listCandidates: async ({ afterId }) => rows.filter((row) => !afterId || row.id > afterId),
    updateCandidate: async (id, patch) => {
      updates.push({ id, patch });
      return { id, ...patch };
    },
    classify: async (place) => {
      if (place.placeId === 'place-b') {
        const err = new Error('Gemini 503 (gemini-3.1-flash-lite): unavailable');
        err.status = 503;
        throw err;
      }
      return accepted;
    },
    verify: async () => ({ decision: 'accept', category: 'home', subcategory: 'plumber', confidence: 0.9, reasoning: 'ok' }),
  });
  assert.equal(resumed.stoppedReason, null);
  assert.equal(resumed.done, true);
  assert.equal(resumed.reclassified, 1);
  assert.equal(resumed.stillPending, 1);
  const failed = updates.find((item) => item.id === 'b');
  assert.equal(failed.patch.status, 'needs_classify');
  assert.equal(failed.patch.needs_review, true);
  assert.equal(failed.patch.reject_reason, null);
  assert.equal(failed.patch.classifier_confidence, null);
  assert.equal(failed.patch.proposed_cat, 'home');
  assert.notEqual(failed.patch.status, 'approved');
  const published = selectPublishable(
    [{ id: 'b', ...failed.patch, place_id: 'place-b', proposed_title: 'Друга', proposed_lat: 50.45, proposed_lng: 30.52 }],
    [],
    catalog
  );
  assert.equal(published.created.length, 0);
  assert.equal(published.skipped[0].reason, 'not_approved');
});

test('reclassify stops when the chunk clock runs out before the next row', async () => {
  let ticks = 0;
  const seen = [];
  const result = await executeReclassifyChunk({
    body: { wave: 'A', timeBudgetMs: 20000 },
    now: () => ticks,
    masterCatalog: catalog,
    sleep: async () => {},
    listCandidates: async () => [needsRow('a', 'Перша'), needsRow('b', 'Друга'), needsRow('c', 'Третя')],
    updateCandidate: async (id, patch) => ({ id, ...patch }),
    classify: async (place) => {
      seen.push(place.placeId);
      return accepted;
    },
    verify: async () => {
      ticks = 25000;
      return { decision: 'accept', category: 'home', subcategory: 'plumber', confidence: 0.9, reasoning: 'ok' };
    },
  });
  assert.deepEqual(seen, ['place-a']);
  assert.equal(result.stoppedReason, 'time_budget');
  assert.equal(result.done, false);
  assert.equal(result.reclassified, 1);
  assert.equal(result.publishedLocations, 0);
});

test('gemini daily quota is tagged and a limit:0 model can fall through', async () => {
  const original = global.fetch;
  try {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => 'You exceeded your current quota, please check your plan and billing details.',
        };
      }
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }),
      };
    };
    const parsed = await geminiGenerateJson('test-key', {
      prompt: 'x',
      models: ['gemini-3.5-flash', 'gemini-3.1-flash-lite'],
      timeoutMs: 1000,
    });
    assert.deepEqual(parsed, { ok: true });
    assert.equal(calls, 2);

    calls = 0;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({
          error: { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota' },
        }),
      };
    };
    await assert.rejects(
      () => geminiGenerateJson('test-key', {
        prompt: 'x',
        models: ['gemini-3.5-flash', 'gemini-3.1-flash-lite'],
        timeoutMs: 1000,
      }),
      (err) => err.code === 'classifier_quota' && err.status === 429
    );
    assert.equal(calls, 2);

    calls = 0;
    global.fetch = async () => {
      calls += 1;
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    await assert.rejects(
      () => geminiGenerateJson('test-key', {
        prompt: 'x',
        models: ['m1', 'm2', 'm3', 'm4'],
        timeoutMs: 1000,
        maxAborts: 2,
      }),
      (err) => err.name === 'AbortError'
    );
    assert.equal(calls, 2);
  } finally {
    global.fetch = original;
  }
});

test('migration 025 moves classify_error rows to needs_classify', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/025_import_candidates_needs_classify.sql'), 'utf8');
  const sync = fs.readFileSync(path.join(__dirname, '..', 'supabase/sync_database.sql'), 'utf8');
  for (const file of [sql, sync]) {
    assert.match(file, /needs_classify/);
    assert.match(file, /reject_reason = 'classify_error'/);
    assert.match(file, /status = 'needs_classify'/);
    assert.doesNotMatch(file, /status = 'approved'/);
    assert.doesNotMatch(file, /status = 'published'/);
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'places-reclassify.js'), 'utf8');
  assert.doesNotMatch(source, /places\.googleapis\.com/);
  assert.doesNotMatch(source, /searchText/);
  assert.match(source, /raw_payload|placeFromCandidateRow/);
});
