'use strict';

require('./env.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const events = require('../analytics-events.js');

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

test('session hash is 32 hex and hides the browser id', () => {
  const prev = process.env.ANALYTICS_SESSION_PEPPER;
  process.env.ANALYTICS_SESSION_PEPPER = 'pepper-a';
  const raw = '11111111-2222-4333-8444-555555555555';
  const hashed = events.hashSessionId(raw);
  assert.match(hashed, /^[0-9a-f]{32}$/);
  assert.notEqual(hashed, raw);
  assert.equal(events.hashSessionId(raw), hashed);
  process.env.ANALYTICS_SESSION_PEPPER = 'pepper-b';
  assert.notEqual(events.hashSessionId(raw), hashed);
  assert.equal(events.hashSessionId(''), null);
  assert.equal(events.hashSessionId('   '), null);
  if (prev === undefined) delete process.env.ANALYTICS_SESSION_PEPPER;
  else process.env.ANALYTICS_SESSION_PEPPER = prev;
});

test('new events keep the ad network and drop raw click ids, phones, and the session uuid', () => {
  process.env.ANALYTICS_SESSION_PEPPER = 'wave0-test-pepper';
  const rawSid = 'sid-RAW-uuid-9f3c';
  const prepared = events.prepareEventRow(
    { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }, body: {} },
    {
      type: 'call',
      locationId: 'loc-1',
      sid: rawSid,
      utm: {
        source: 'tiktok',
        medium: 'cpc',
        ttclid: 'tt-RAW-click-77',
        fbclid: 'fb-RAW-click-77',
        yclid: 'yc-RAW-click-77',
      },
      meta: { phone: '+380501112233', ip: '203.0.113.8', fbclid: 'fb-RAW-click-77' },
    }
  );
  assert.equal(prepared.ok, true);
  const blob = JSON.stringify(prepared.row);
  assert.equal(prepared.row.meta.click_net, 'meta');
  assert.equal(prepared.row.session_id, events.hashSessionId(rawSid));
  assert.equal(prepared.row.meta.fbclid, undefined);
  assert.equal(prepared.row.meta.ttclid, undefined);
  assert.equal(prepared.row.meta.yclid, undefined);
  assert.equal(prepared.row.meta.phone, undefined);
  assert.equal(prepared.row.meta.ip, undefined);
  for (const secret of ['tt-RAW-click-77', 'fb-RAW-click-77', 'yc-RAW-click-77', rawSid, '+380501112233', '203.0.113.8']) {
    assert.equal(blob.includes(secret), false, secret);
  }
  assert.equal(prepared.row.device_type, 'mobile');
  assert.doesNotMatch(blob, /iPhone/);

  const tiktok = events.attributionMeta({ ttclid: 'tt-only' });
  const yandex = events.attributionMeta({ yclid: 'yc-only' });
  const google = events.attributionMeta({ gclid: 'g-only' });
  assert.deepEqual(tiktok, { click_net: 'tiktok' });
  assert.deepEqual(yandex, { click_net: 'yandex' });
  assert.deepEqual(google, { click_net: 'google' });
});

test('search meta records result_count and a zero flag without a new event type', () => {
  const zero = events.buildSearchMeta({ query: '  Нічого такого  ', source: 'map', resultCount: 0 });
  assert.equal(zero.source, 'map');
  assert.equal(zero.resultCount, 0);
  assert.equal(zero.meta.matched, false);
  assert.equal(zero.meta.zero, 1);
  assert.equal(zero.meta.result_count, 0);
  assert.equal(zero.meta.q, 'Нічого такого');

  const hits = events.buildSearchMeta({ query: 'сантехнік', source: 'ai_gemini', resultCount: 4, engine: 'gemini' });
  assert.equal(hits.source, 'ai');
  assert.equal(hits.meta.source, 'ai');
  assert.equal(hits.meta.engine, 'gemini');
  assert.equal(hits.meta.matched, true);
  assert.equal(hits.meta.zero, undefined);
  assert.equal(hits.resultCount, 4);

  assert.equal(events.normalizeSearchSource('suggest'), 'suggest');
  assert.equal(events.normalizeSearchSource('catalog'), 'catalog');
  assert.equal(events.normalizeReportReason('stale_phone'), 'stale_phone');
  assert.equal(events.normalizeReportReason('location'), 'location');
  assert.equal(events.normalizeReportReason('call me +380501112233'), null);

  const row = events.prepareEventRow(
    { headers: { 'user-agent': 'Mozilla/5.0' }, body: { sid: 'browser-sid' } },
    { type: 'search', meta: zero.meta, resultCount: zero.resultCount }
  );
  assert.equal(row.row.event_type, 'search');
  assert.equal(row.row.result_count, 0);
  assert.equal(row.row.meta.zero, 1);
  assert.equal(events.EVENT_TYPES.has('catalog_click'), true);
});

test('admin role and /admin paths stay out of public KPIs', () => {
  assert.equal(events.isAdminTraffic({ path: '/admin', role: 'provider' }), true);
  assert.equal(events.isAdminTraffic({ path: '/admin/locations', role: 'guest' }), true);
  assert.equal(events.isAdminTraffic({ path: '/p/abc', role: 'admin' }), true);
  assert.equal(events.isAdminTraffic({ path: '/', role: 'client' }), false);
  assert.equal(events.isAdminTraffic({ path: '/kyiv/sviatoshyn', role: '' }), false);
  assert.equal(
    events.isAdminEventRow({ path: '/p/abc', user_role: 'client' }),
    false
  );
  assert.equal(events.isAdminEventRow({ path: '/admin', user_role: 'guest' }), true);
});

test('stale-phone dedupe key is session hash plus card, never an IP', () => {
  process.env.ANALYTICS_SESSION_PEPPER = 'wave0-test-pepper';
  const hash = events.hashSessionId('visitor-1');
  assert.equal(events.stalePhoneDedupeKey(hash, 'loc-9'), `${hash}|loc-9`);
  assert.equal(events.stalePhoneDedupeKey('203.0.113.5', 'loc-9'), '');
  assert.equal(events.stalePhoneDedupeKey('11111111-2222-4333-8444-555555555555', 'loc-9'), '');
  assert.equal(events.stalePhoneDedupeKey('', 'loc-9'), '');
});

test('orders and favorites are counted once, from the card click', () => {
  const server = read('server.js');
  const orders = between(server, "app.post('/api/orders'", "app.get('/api/client/dashboard'");
  const favorites = between(server, "app.post('/api/client/favorites'", "app.delete('/api/client/favorites/");
  assert.equal(orders.includes("bumpTotal('orders')"), false);
  assert.equal(favorites.includes("bumpTotal('favorites')"), false);
  assert.match(orders, /writeOrders\(orders\)/);
  const clickMap = between(server, 'const LOCATION_CLICK_TOTAL_FIELD', "app.post('/api/locations/:id/click'");
  assert.match(clickMap, /order:\s*'orders'/);
  assert.match(clickMap, /favorite:\s*'favorites'/);
  assert.match(clickMap, /map_focus:\s*'mapFocusClicks'/);
  assert.equal(server.includes('function clientIp'), false);
  assert.match(server, /stalePhoneDedupeKey/);
  assert.match(server, /stage: 'success'/);
  assert.match(server, /logClaimStage\([\s\S]{0,80}'mismatch'\)/);
  assert.match(server, /logClaimStage\([\s\S]{0,80}'success'\)/);
  assert.match(read('routes/auth.js'), /bumpTotal\(field\)/);
  assert.match(read('routes/auth.js'), /telegram_otp/);
});

test('the map wires focus, search counts, and catalog clicks without storing raw click ids', () => {
  const app = read('public/js/mapfix-app.js');
  const client = read('public/mf-analytics.js');
  assert.match(app, /trackLocationClick\(loc\.id, 'map_focus'\)/);
  assert.match(app, /logAnalyticsSearch\(State\.locationSearchQuery, 'map', results\.length\)/);
  assert.match(app, /logAnalyticsSearch\(item\.label, 'suggest', 1\)/);
  assert.match(app, /logAnalyticsSearch\(item\.label, 'suggest', countCatalogMatches/);
  assert.match(app, /logAnalyticsSearch\(\s*transcript,\s*'ai'/);
  assert.match(app, /logAnalyticsSearch\(label, 'catalog', 0\)/);
  assert.match(app, /deferSearchLog/);
  assert.equal(app.includes("trackLocationClick(locationId, 'report')"), false);
  assert.match(client, /result_count/);
  assert.match(client, /ttclid/);
  assert.match(client, /yclid/);
  assert.match(read('public/privacy.html'), /хеш/);
  assert.match(read('public/cookies.html'), /TikTok/);
  assert.match(read('supabase/migrations/023_analytics_result_count.sql'), /result_count smallint/);
  assert.doesNotMatch(read('supabase/migrations/023_analytics_result_count.sql'), /UPDATE public\.analytics_events/i);
});

test('the browser still sends ttclid and yclid so the server can label the network', () => {
  const posts = [];
  const windowObj = {
    location: new URL('https://www.mapfix.com.ua/?ttclid=tt-live&yclid=yc-live'),
    crypto: { randomUUID: () => 'browser-sid-raw' },
    navigator: { sendBeacon: () => false },
    matchMedia: () => ({ matches: false }),
  };
  const sandbox = {
    localStorage: memoryStore(),
    sessionStorage: memoryStore(),
    window: windowObj,
    document: { referrer: '', addEventListener() {} },
    navigator: windowObj.navigator,
    crypto: windowObj.crypto,
    Blob,
    URL,
    URLSearchParams,
    fetch: (url, opts) => {
      posts.push({ url: String(url), body: opts && opts.body });
      return Promise.resolve({ ok: true });
    },
    setInterval: () => 0,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/mf-analytics.js'), sandbox, { filename: 'mf-analytics.js' });
  sandbox.window.MapfixAnalytics.search('шини', 'map', false, 0);
  const search = posts.filter((row) => row.url === '/api/analytics/search').map((row) => JSON.parse(row.body));
  assert.equal(search.length, 1);
  assert.equal(search[0].result_count, 0);
  assert.equal(search[0].matched, false);
  assert.equal(search[0].source, 'map');
  assert.equal(search[0].utm.ttclid, 'tt-live');
  assert.equal(search[0].utm.yclid, 'yc-live');
  assert.equal(search[0].sid, 'browser-sid-raw');

  const stored = events.prepareEventRow(
    { headers: { 'user-agent': 'Mozilla/5.0' }, body: search[0] },
    { type: 'search', meta: events.buildSearchMeta({ query: search[0].query, source: search[0].source, resultCount: search[0].result_count }).meta, resultCount: 0 }
  );
  const blob = JSON.stringify(stored.row);
  assert.equal(stored.row.meta.click_net, 'tiktok');
  assert.equal(blob.includes('tt-live'), false);
  assert.equal(blob.includes('yc-live'), false);
  assert.equal(blob.includes('browser-sid-raw'), false);
  assert.equal(stored.row.session_id, events.hashSessionId('browser-sid-raw'));
});

function memoryStore() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(String(key), String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}
