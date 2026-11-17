'use strict';

require('./env.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadMasterCatalog, loadFullData } = require('../catalog-data.js');
const events = require('../analytics-events.js');
const {
  parseVoiceSearch,
  localRankSearch,
  extractSearchArea,
  countSearchMatches,
  relaxUnpricedService,
  clearSearchCache,
  stemUk,
} = require('../search-ai.js');

const catalog = loadMasterCatalog();
const locations = loadFullData().mockLocations.filter((loc) => loc && !loc.deletedAt);

function visibleCount(selection) {
  return countSearchMatches(locations, catalog, selection);
}

test('ukrainian stems group oil and tyre word forms', () => {
  assert.equal(stemUk('масла'), stemUk('масло'));
  assert.equal(stemUk('мастила'), stemUk('мастило'));
  assert.notEqual(stemUk('свято'), stemUk('святошин'));
  assert.equal(stemUk('шин'), stemUk('шини'));
  assert.equal(stemUk('шини'), stemUk('шина'));
});

test('district aliases are whole words and leave the service text', () => {
  assert.deepEqual(extractSearchArea('Святошин'), { area: 'sviatoshyn', rest: '' });
  assert.deepEqual(extractSearchArea('Святошино'), { area: 'sviatoshyn', rest: '' });
  assert.deepEqual(extractSearchArea('на Святошині'), { area: 'sviatoshyn', rest: '' });
  assert.deepEqual(extractSearchArea('СТО Святошин'), { area: 'sviatoshyn', rest: 'сто' });
  assert.deepEqual(extractSearchArea('шиномонтаж на Святошині'), { area: 'sviatoshyn', rest: 'шиномонтаж' });
  assert.equal(extractSearchArea('Борщагівці').area, 'borshchahivka');
  assert.equal(extractSearchArea('Академмістечко').area, 'akademmistechko');
  assert.equal(extractSearchArea('у Коцюбинському').area, 'kotsiubynske');
  assert.equal(extractSearchArea('sviatoshyn').area, 'sviatoshyn');
  assert.equal(extractSearchArea('борщагівська').area, null);
});

test('catalog lists продаж шин on auto.tyres', () => {
  const tyres = catalog.auto.subcats.tyres;
  assert.ok(tyres.tags.includes('продаж шин'));
  assert.ok(tyres.items.some((item) => item.name === 'Продаж шин (нові/БВ)'));
});

test('заміна масла, продаж шин, Святошин and an unpriced service', async () => {
  clearSearchCache();
  const oil = await parseVoiceSearch('заміна масла', catalog, {});
  assert.equal(oil.category, 'auto');
  assert.equal(oil.subcategory, 'maintenance');
  assert.notEqual(oil.category, 'rental');
  const oilRelaxed = relaxUnpricedService(oil, locations);
  const oilCount = visibleCount({
    category: oilRelaxed.category,
    subcategory: oilRelaxed.subcategory,
    service: oilRelaxed.service,
    area: oilRelaxed.area,
  });
  assert.equal(oilRelaxed.service, null);
  assert.ok(oilCount > 0, 'oil change should list maintenance cards');

  const tyres = await parseVoiceSearch('Продаж шин', catalog, {});
  assert.equal(tyres.category, 'auto');
  assert.equal(tyres.subcategory, 'tyres');
  assert.notEqual(tyres.service, 'Зберігання шин (сезон)');
  const tyreCount = visibleCount({
    category: 'auto',
    subcategory: 'tyres',
    service: 'Продаж шин (нові/БВ)',
  });
  assert.ok(tyreCount > 0);

  const district = await parseVoiceSearch('Святошин', catalog, {});
  assert.equal(district.area, 'sviatoshyn');
  assert.equal(district.areaOnly, true);
  assert.equal(district.category, null);
  assert.notEqual(district.category, 'rental');
  assert.equal(localRankSearch('Святошин', catalog, 3).some((item) => item.category === 'rental'), false);
  const areaCount = visibleCount({ area: 'sviatoshyn' });
  assert.ok(areaCount > 0);

  const sto = await parseVoiceSearch('СТО Святошин', catalog, {});
  assert.equal(sto.area, 'sviatoshyn');
  assert.equal(sto.category, 'auto');
  assert.equal(sto.subcategory, 'auto_repair');

  const unpricedName = 'Заміна мастила у двигуні + фільтр';
  const priced = locations.filter(
    (loc) => loc.prices && Object.prototype.hasOwnProperty.call(loc.prices, unpricedName)
  ).length;
  assert.equal(priced, 0);
  const kept = visibleCount({
    category: 'auto',
    subcategory: 'maintenance',
    service: unpricedName,
  });
  assert.ok(kept > 0, 'subcategory cards count even when the service has no prices');
  const dropped = relaxUnpricedService(
    { category: 'auto', subcategory: 'maintenance', service: unpricedName, suggestions: [] },
    locations
  );
  assert.equal(dropped.service, null);
});

test('exact local hits skip Gemini, weak hits call it once and then use the cache', async () => {
  clearSearchCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    matches: [
                      {
                        type: 'subcategory',
                        category: 'auto',
                        subcategory: 'tyres',
                        service: 'Продаж шин (нові/БВ)',
                        score: 8,
                        confidence: 0.82,
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      }),
      text: async () => '',
    };
  };

  calls = 0;
  const exact = await parseVoiceSearch('Продаж шин', catalog, { geminiApiKey: 'test-key', fetchImpl });
  assert.equal(exact.router, 'local');
  assert.equal(exact.subcategory, 'tyres');
  assert.equal(calls, 0);

  calls = 0;
  const bare = await parseVoiceSearch('Святошин', catalog, { geminiApiKey: 'test-key', fetchImpl });
  assert.equal(bare.area, 'sviatoshyn');
  assert.equal(bare.category, null);
  assert.equal(calls, 0);

  calls = 0;
  const first = await parseVoiceSearch('резина', catalog, { geminiApiKey: 'test-key', fetchImpl });
  assert.equal(first.router, 'gemini');
  assert.equal(first.subcategory, 'tyres');
  assert.equal(calls, 1);
  const second = await parseVoiceSearch('резина на Святошині', catalog, { geminiApiKey: 'test-key', fetchImpl });
  assert.equal(second.router, 'cache');
  assert.equal(second.area, 'sviatoshyn');
  assert.equal(second.subcategory, 'tyres');
  assert.equal(calls, 1);

  clearSearchCache();
  let failures = 0;
  const failing = async () => {
    failures += 1;
    return { ok: false, status: 500, text: async () => 'down', json: async () => ({}) };
  };
  const fallback = await parseVoiceSearch('резина', catalog, { geminiApiKey: 'test-key', fetchImpl: failing });
  assert.equal(fallback.router, 'local');
  assert.equal(fallback.subcategory, 'tyres');
  assert.ok(failures >= 1);
});

test('search analytics stores the visible count plus service, subcategory, area and router', () => {
  const built = events.buildSearchMeta({
    query: 'заміна масла',
    source: 'ai',
    resultCount: 6,
    router: 'local',
    subcategory: 'maintenance',
    area: 'sviatoshyn',
    service: 'Заміна мастила у двигуні + фільтр',
  });
  assert.equal(built.meta.result_count, 6);
  assert.equal(built.meta.matched, true);
  assert.equal(built.meta.router, 'local');
  assert.equal(built.meta.engine, 'catalog');
  assert.equal(built.meta.subcategory, 'maintenance');
  assert.equal(built.meta.area, 'sviatoshyn');
  assert.equal(built.meta.service, 'Заміна мастила у двигуні + фільтр');
  assert.equal(built.meta.zero, undefined);

  const row = events.prepareEventRow(
    { headers: { 'user-agent': 'Mozilla/5.0' }, body: {} },
    { type: 'search', meta: built.meta, resultCount: built.resultCount }
  );
  assert.equal(row.row.meta.area, 'sviatoshyn');
  assert.equal(row.row.meta.router, 'local');
  assert.equal(row.row.result_count, 6);

  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'mapfix-app.js'), 'utf8');
  const searchFn = app.slice(app.indexOf('async function runAiSearch'), app.indexOf('function startVoiceSearch'));
  assert.match(searchFn, /countVisibleMatches\(\)/);
  assert.doesNotMatch(searchFn, /countCatalogMatches\(/);
  assert.match(searchFn, /relaxEmptyService:\s*true/);
  assert.match(searchFn, /extractSearchArea/);
  assert.match(app, /function countVisibleMatches\(\)[\s\S]*locationMatchesMapFilter/);
  const inputFn = app.slice(app.indexOf("searchInput.addEventListener('input'"), app.indexOf("searchInput.addEventListener('blur'"));
  assert.doesNotMatch(inputFn, /runAiSearch/);
});
