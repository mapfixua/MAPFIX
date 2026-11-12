'use strict';

require('./env.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const events = require('../analytics-events.js');
const dims = require('../analytics-dimensions.js');
const rollups = require('../analytics-rollups.js');
const { daysToRoll } = require('../scripts/backfill-analytics-rollups.js');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function between(source, start, end) {
  const i = source.indexOf(start);
  assert.ok(i >= 0, `missing ${start}`);
  const j = source.indexOf(end, i + start.length);
  assert.ok(j > i, `missing ${end}`);
  return source.slice(i, j);
}

test('a card event gets the server district and category; the client value is ignored', async () => {
  events.setLocationResolver(null);
  const prepared = events.prepareEventRow(
    {
      headers: { 'user-agent': 'Mozilla/5.0' },
      body: { district: 'borshchahivka', category: 'food', path: '/kyiv/borshchahivka/food' },
    },
    {
      type: 'call',
      locationId: 'loc-1',
      path: '/kyiv/borshchahivka/food',
      meta: { district: 'hack', category: 'hack' },
    }
  );
  assert.equal(prepared.ok, true);
  assert.equal(prepared.row.district, undefined);
  assert.equal(prepared.row.meta.district, undefined);
  assert.equal(prepared.row.meta.category, undefined);
  const row = await events.attachDimensions(prepared.row, {
    location: {
      id: 'loc-1',
      title: 'Сантехнік',
      cat: 'home',
      address: 'просп. Перемоги, Святошин',
      lat: 50.45,
      lng: 30.52,
    },
  });
  assert.equal(row.district, 'sviatoshyn');
  assert.equal(row.category, 'home');
  assert.equal(row.meta.district, undefined);
});

test('an event without a card does not throw and stays unknown', async () => {
  events.setLocationResolver(async () => {
    throw new Error('lookup failed');
  });
  const row = await events.attachDimensions({ event_type: 'login', path: '/login', meta: {} }, {});
  assert.equal(row.district, undefined);
  assert.equal(row.category, undefined);
  assert.equal(dims.districtLabel(null), 'невідомо');
  assert.equal(dims.districtLabel(''), 'невідомо');
  assert.equal(dims.districtLabel('kyiv'), 'Київ');
  events.setLocationResolver(null);
});

test('a district landing is labelled from the path when there is no card', async () => {
  events.setLocationResolver(null);
  const row = await events.attachDimensions({ event_type: 'page_view', path: '/kyiv/sviatoshyn/beauty' }, {});
  assert.equal(row.district, 'sviatoshyn');
  assert.equal(row.category, 'beauty');
});

test('the resolver supplies the card when the handler did not', async () => {
  events.setLocationResolver(async (id) => {
    assert.equal(id, 'loc-9');
    return { id, cat: 'auto', address: 'Коцюбинське, вул. Пономарьова 5', lat: 50.49, lng: 30.33 };
  });
  const row = await events.attachDimensions({ event_type: 'view', location_id: 'loc-9', path: '/p/loc-9' }, {});
  assert.equal(row.district, 'kotsiubynske');
  assert.equal(row.category, 'auto');
  events.setLocationResolver(null);
});

test('a point outside the four districts is Kyiv', () => {
  assert.equal(dims.cardDistrict({ address: 'Хрещатик 1', lat: 50.45, lng: 30.523, cat: 'food' }), 'kyiv');
  assert.equal(dims.cardDistrict(null), null);
});

test('call rate uses opens in the same period, and the previous window has the same length', () => {
  const period = dims.withRates({ views: 10, calls: 2, searches: 4, zeroSearches: 1 });
  assert.equal(period.callRate, 20);
  assert.equal(period.zeroShare, 25);
  const lifetimeViews = 1000;
  assert.notEqual(period.callRate, dims.rate(2, lifetimeViews));
  const previous = dims.withRates({ views: 10, calls: 1, searches: 4, zeroSearches: 0 });
  const deltas = dims.deltaMap(period, previous);
  assert.equal(deltas.calls.show, true);
  assert.equal(deltas.calls.dir, 'up');
  assert.equal(deltas.calls.pct, 100);
  assert.equal(deltas.views.show, true);
  assert.equal(deltas.views.dir, 'flat');
  assert.equal(deltas.views.pct, 0);
  const window = dims.previousWindow('2026-11-06', '2026-11-12');
  assert.equal(window.days, 7);
  assert.equal(window.fromDay, '2026-10-30');
  assert.equal(window.toDay, '2026-11-05');
});

test('zero against zero hides the arrow; a new metric is marked new', () => {
  assert.equal(dims.delta(0, 0).show, false);
  const fresh = dims.delta(3, 0);
  assert.equal(fresh.show, true);
  assert.equal(fresh.pct, null);
  assert.equal(fresh.dir, 'up');
});

test('the workbook has six sheets, every master, quality, conversion, and no user id or long phrase', () => {
  const longPhrase = 'сантехнік ' + 'а'.repeat(100);
  const masters = [];
  for (let i = 0; i < 30; i += 1) {
    masters.push({
      id: `loc-${i}`,
      title: `Майстер ${i}`,
      categoryLabel: 'Дім',
      districtLabel: i % 2 ? 'Святошин' : 'невідомо',
      hasPhoto: i % 2 ? 'так' : 'ні',
      priceCount: i % 3 === 0 ? 2 : 0,
      hasSchedule: 'так',
      claimed: i % 4 === 0 ? 'так' : 'ні',
      updatedOn: '2026-08-01',
      freshnessDays: 100,
      stalePhone: i === 1 ? 2 : 0,
      impressions: 0,
      views: 5,
      contacts: i,
      viewsWithoutContact: i === 0 ? 5 : 0,
      userId: 'user-SECRET-should-not-export',
    });
  }
  const sheets = dims.buildExportSheets({
    days: [
      {
        day: '2026-11-12',
        sessions: 4,
        searches: 3,
        zeroSearches: 1,
        impressions: 0,
        views: 8,
        calls: 2,
        chats: 1,
        directions: 1,
        favorites: 0,
        orders: 0,
        callRate: 25,
      },
    ],
    districts: [
      {
        kind: 'district',
        label: 'невідомо',
        sessions: 1,
        searches: 1,
        zeroSearches: 1,
        views: 2,
        calls: 0,
        chats: 0,
        directions: 0,
        contacts: 0,
        callRate: 0,
      },
    ],
    categories: [
      {
        kind: 'category',
        label: 'Дім',
        sessions: 2,
        searches: 0,
        zeroSearches: 0,
        views: 4,
        calls: 1,
        chats: 0,
        directions: 0,
        contacts: 1,
        callRate: 25,
      },
    ],
    sources: [{ key: 'meta / cpc / spring', views: 8, calls: 2, chats: 1, directions: 1 }],
    searches: [{ q: longPhrase, district: '', events: 3, zeroEvents: 1 }],
    masters,
  });
  assert.deepEqual(
    sheets.map((sheet) => sheet.name),
    ['KPI', 'Райони', 'Категорії', 'Джерела', 'Пошук', 'Картки']
  );
  assert.equal(sheets[0].rows[0]['Call rate %'], 25);
  assert.equal(sheets[0].rows[0]['Пошуки без результату'], 1);
  assert.equal(sheets[1].rows[0]['Район'], 'невідомо');
  assert.equal(sheets[3].rows[0]['UTM source'], 'meta');
  assert.equal(sheets[3].rows[0]['UTM medium'], 'cpc');
  assert.equal(sheets[3].rows[0]['Конверсія контактів %'], 50);
  assert.equal(sheets[4].rows[0]['Фраза'].length, 80);
  assert.equal(sheets[4].rows[0]['Фраза'].includes('а'.repeat(40)), true);
  assert.equal(sheets[5].rows.length, 30);
  assert.equal(sheets[5].rows[1]['Скарги «номер неактуальний»'], 2);
  assert.equal(sheets[5].rows[0]['Фото'], 'ні');
  assert.equal(sheets[5].rows[0]['Графік'], 'так');
  assert.equal(sheets[5].rows[0]['Є власник'], 'так');
  assert.equal(sheets[5].rows[0]['Свіжість, днів'], 100);
  const blob = JSON.stringify(sheets);
  assert.equal(blob.includes('user-SECRET-should-not-export'), false);
  assert.equal(blob.includes(longPhrase), false);
  assert.equal(blob.includes('userId'), false);
});

test('screen assembly keeps every master and the period call rate', () => {
  const locations = [];
  for (let i = 0; i < 30; i += 1) {
    locations.push({
      id: `loc-${i}`,
      title: `Майстер ${i}`,
      cat: 'home',
      address: 'Святошин',
      lat: 50.4574,
      lng: 30.3553,
      providerId: i === 0 ? 'prov-1' : '',
      photos: i % 2 ? [{ url: 'a' }] : [],
      prices: i % 3 === 0 ? { a: 1 } : {},
      schedule: { 'Пн-Пт': '09:00-18:00' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }
  const report = rollups.assembleStatistics({
    range: { key: '7d', fromDay: '2026-11-06', toDay: '2026-11-12' },
    filters: { district: '', category: '', source: '', device: '' },
    locations,
    reports: [
      { locationId: 'loc-1', reason: 'stale_phone', status: 'new' },
      { locationId: 'loc-1', reason: 'stale_phone', status: 'resolved' },
      { locationId: 'loc-2', reason: 'location', status: 'new' },
    ],
    catalog: { home: { name: 'Дім' } },
    now: new Date('2026-11-12T12:00:00.000Z'),
    current: {
      partial: false,
      totals: { views: 10, calls: 2, chats: 1, directions: 0, searches: 4, zeroSearches: 1, sessions: 6 },
      days: [{ day: '2026-11-12', views: 10, calls: 2, chats: 1, searches: 4, zeroSearches: 1, sessions: 6 }],
      districts: [{ key: 'sviatoshyn', views: 10, calls: 2, chats: 1, directions: 0, searches: 1, sessions: 4 }],
      categories: [],
      sources: [{ key: 'meta / cpc', views: 10, calls: 2, chats: 1, directions: 0 }],
      devices: [],
      searches: [{ q: 'сантехнік', district: 'sviatoshyn', events: 4, zeroEvents: 1 }],
      locations: [{ id: 'loc-1', views: 10, calls: 2, chats: 0, directions: 0, impressions: 0 }],
      options: { districts: ['sviatoshyn', ''], categories: ['home'], sources: ['direct'], devices: ['mobile'] },
    },
    previous: { totals: { views: 10, calls: 1, chats: 0, directions: 0, searches: 4, zeroSearches: 0, sessions: 5 } },
  });
  assert.equal(report.period.callRate, 20);
  assert.equal(report.delta.calls.pct, 100);
  assert.equal(report.topLocations.length, 25);
  const cards = report.exportSheets.find((sheet) => sheet.name === 'Картки');
  assert.equal(cards.rows.length, 30);
  const flagged = cards.rows.find((row) => row.ID === 'loc-1');
  assert.equal(flagged['Скарги «номер неактуальний»'], 1);
  assert.equal(flagged['Фото'], 'так');
  assert.equal(flagged['Позицій прайсу'], 0);
  assert.equal(flagged['Графік'], 'так');
  assert.equal(flagged.Район, 'Святошин');
  assert.equal(report.filters.previousFrom, '2026-10-30');
  const filtered = rollups.assembleStatistics({
    range: { key: '7d', fromDay: '2026-11-06', toDay: '2026-11-12' },
    filters: { district: 'kyiv', category: '', source: '', device: '' },
    locations,
    reports: [],
    catalog: {},
    current: { totals: { views: 0, calls: 0 }, locations: [] },
    previous: { totals: {} },
  });
  assert.equal(filtered.exportSheets.find((sheet) => sheet.name === 'Картки').rows.length, 0);
});

test('cron rolls yesterday only, in batches of 5000, and stops on a short batch', async () => {
  const calls = [];
  const result = await rollups.runCronStep({
    today: '2026-11-12',
    budgetMs: 5000,
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'analytics_purge_raw') return { impressions: 0, events: 10 };
      return { ok: true, day: args.p_day };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.day, '2026-11-11');
  assert.deepEqual(calls[0], ['analytics_rollup_day', { p_day: '2026-11-11' }]);
  assert.equal(calls.filter((row) => row[0] === 'analytics_rollup_day').length, 1);
  assert.equal(calls[1][1].p_limit, 5000);
  assert.equal(result.purged.batches, 1);
  const missing = await rollups.runCronStep({
    today: '2026-11-12',
    rpc: async () => {
      const err = new Error('Could not find the function public.analytics_rollup_day');
      err.missing = true;
      throw err;
    },
  });
  assert.equal(missing.missing, true);
});

test('backfill lists closed days and skips today', () => {
  const days = daysToRoll({ from: '2026-11-10', to: '2026-11-12', today: '2026-11-12' });
  assert.deepEqual(days, ['2026-11-10', '2026-11-11']);
});

test('migration 024 adds the columns and rollups without rewriting old events', () => {
  const sql = read('supabase/migrations/024_analytics_district_category_rollups.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS district text/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS category text/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.analytics_daily/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.analytics_search_daily/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.analytics_location_daily/);
  assert.match(sql, /DELETE FROM public\.analytics_daily WHERE day = p_day/);
  assert.match(sql, /analytics_purge_raw/);
  assert.match(sql, /LEAST\(GREATEST\(COALESCE\(p_limit, 5000\), 1\), 5000\)/);
  assert.match(sql, /v_today - 180/);
  assert.match(sql, /v_today - 14/);
  assert.match(sql, /p_day >= v_today/);
  assert.equal(/UPDATE\s+public\.analytics_events/i.test(sql), false);
  const vercel = JSON.parse(read('vercel.json'));
  assert.equal(vercel.builds[0].config.maxDuration, 60);
  assert.equal(vercel.crons[0].path, '/api/ops/hourly');
  assert.equal(vercel.crons[0].schedule, '0 6 * * *');
});

test('the statistics route does not scan the event journal, and heartbeat does not rewrite totals', () => {
  const server = read('server.js');
  const route = between(server, "app.get('/api/admin/analytics'", "app.get('/api/admin/analytics/events'");
  assert.equal(route.includes('fetchEvents'), false);
  assert.equal(route.includes('buildAdminTraffic'), true);
  assert.equal(route.includes('runCronStep') || server.includes('runCronStep'), true);
  const cron = between(server, "app.get('/api/ops/hourly'", "app.get('/api/ops/health'");
  assert.equal(cron.includes('runCronStep'), true);
  const analyticsJs = read('analytics.js');
  const heartbeat = between(analyticsJs, 'async function heartbeat', 'async function bumpTotal');
  assert.equal(heartbeat.includes('product_analytics'), false);
  assert.equal(heartbeat.includes('writeState'), false);
  assert.equal(heartbeat.includes('readState'), false);
  assert.equal(heartbeat.includes('touchPresence'), true);
  const admin = read('public/admin.html');
  assert.equal(admin.includes('Завантажити Excel'), true);
  assert.equal(admin.includes('id="analyticsDistrict"'), true);
  assert.equal(admin.includes('id="analyticsCategory"'), true);
  assert.equal(admin.includes('id="analyticsSource"'), true);
  assert.equal(admin.includes('analyticsDeltaHtml'), true);
  assert.equal(admin.includes('Call rate = дзвінки / відкриття карток за той самий період'), true);
  assert.equal(read('public/admin-stats-export.js').includes('XLSX'), true);
  assert.equal(read('public/js/mapfix-app.js').includes('admin-stats-export'), false);
});
