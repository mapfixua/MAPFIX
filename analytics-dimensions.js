'use strict';

/**
 * Pure helpers for admin statistics (wave 1).
 * District comes from the card on the server (seo.primaryDistrict). The client
 * never supplies it. Search phrases in exports are clipped to 80 characters.
 * Sheets list explicit columns only — no user id, session, phone, or IP.
 */
const seo = require('./seo.js');

const DISTRICT_KEYS = ['sviatoshyn', 'borshchahivka', 'akademmistechko', 'kotsiubynske', 'kyiv'];
const UNKNOWN_LABEL = 'невідомо';
const UNKNOWN_TOKEN = '__unknown__';

const DISTRICT_LABELS = {
  sviatoshyn: 'Святошин',
  borshchahivka: 'Борщагівка',
  akademmistechko: 'Академмістечко',
  kotsiubynske: 'Коцюбинське',
  kyiv: 'Київ',
};

const DEVICE_LABELS = {
  mobile: 'телефон',
  tablet: 'планшет',
  desktop: 'комп’ютер',
};

const QUERY_MAX = 80;
const SOURCE_MAX = 120;

const DELTA_KEYS = [
  'sessions',
  'mapLoads',
  'searches',
  'zeroSearches',
  'zeroShare',
  'impressions',
  'views',
  'calls',
  'chats',
  'directions',
  'favorites',
  'shares',
  'orders',
  'callRate',
  'contacts',
];

function clipQuery(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .slice(0, QUERY_MAX);
}

function cardCategory(loc) {
  const cat = String(loc?.cat || '')
    .trim()
    .toLowerCase()
    .slice(0, 48);
  if (!/^[a-z0-9_-]+$/.test(cat)) return null;
  return cat;
}

/** Null when there is no card. A card outside the four districts is "kyiv". */
function cardDistrict(loc) {
  if (!loc || typeof loc !== 'object') return null;
  return seo.primaryDistrict(loc);
}

function pathDimensions(path) {
  const pathOnly = String(path || '')
    .trim()
    .split('?')[0]
    .split('#')[0];
  if (!pathOnly) return {};
  const out = {};
  if (pathOnly === '/kotsyubynske' || pathOnly.startsWith('/kotsyubynske/')) {
    out.district = 'kotsiubynske';
  }
  let landing = null;
  try {
    landing = seo.parseLanding({ pathname: pathOnly, catalog: {} });
  } catch (_) {
    landing = null;
  }
  if (landing?.area && DISTRICT_KEYS.includes(landing.area)) out.district = landing.area;
  if (landing?.cat) {
    const cat = cardCategory({ cat: landing.cat });
    if (cat) out.category = cat;
  }
  if (landing?.loc) out.locationId = String(landing.loc).slice(0, 80);
  return out;
}

/** Same packing as analytics_event_source() in migration 024. */
function sourceKey(row) {
  const source = String(row?.utm_source || '').trim();
  if (source) {
    return [source, String(row.utm_medium || '').trim(), String(row.utm_campaign || '').trim()]
      .filter(Boolean)
      .join(' / ')
      .slice(0, SOURCE_MAX);
  }
  const host = String(row?.referrer_host || '').trim();
  if (host) return host.slice(0, SOURCE_MAX);
  return 'direct';
}

function deviceKey(value) {
  const s = String(value || '')
    .trim()
    .toLowerCase();
  if (s === 'mobile' || s === 'tablet' || s === 'desktop') return s;
  return '';
}

function isZeroSearch(row) {
  const count = row?.result_count;
  if (count === 0) return true;
  if (typeof count === 'number' && count > 0) return false;
  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
  if (meta.zero === 1 || meta.zero === '1' || meta.zero === true) return true;
  if (meta.matched === false || meta.matched === 'false' || meta.matched === 0 || meta.matched === '0') return true;
  return false;
}

function districtLabel(key) {
  if (key == null || key === '') return UNKNOWN_LABEL;
  return DISTRICT_LABELS[key] || UNKNOWN_LABEL;
}

function deviceLabel(key) {
  if (key == null || key === '') return UNKNOWN_LABEL;
  return DEVICE_LABELS[key] || UNKNOWN_LABEL;
}

function sourceLabel(key) {
  if (!key || key === 'direct') return 'прямий';
  return String(key);
}

function categoryLabel(key, catalog) {
  if (key == null || key === '') return UNKNOWN_LABEL;
  const name = catalog?.[key]?.name;
  return name ? String(name) : String(key);
}

function rate(part, whole) {
  const w = Number(whole) || 0;
  const p = Number(part) || 0;
  if (w <= 0) return 0;
  return Math.round((p / w) * 1000) / 10;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function shiftDay(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
}

function inclusiveDays(fromDay, toDay) {
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

/** The window of the same length immediately before fromDay. */
function previousWindow(fromDay, toDay) {
  const days = Math.max(1, inclusiveDays(fromDay, toDay));
  const prevTo = shiftDay(fromDay, -1);
  const prevFrom = shiftDay(prevTo, -(days - 1));
  return { fromDay: prevFrom, toDay: prevTo, days };
}

function listDays(fromDay, toDay, today) {
  const out = [];
  if (!fromDay || !toDay || fromDay > toDay) return out;
  let d = fromDay;
  for (let i = 0; i < 4000 && d <= toDay; i++) {
    if (!today || d < today) out.push(d);
    d = shiftDay(d, 1);
  }
  return out;
}

/**
 * Arrow vs the previous window. Both zeros stay hidden.
 * Previous zero and a positive current is "нове" (no fake percent).
 */
function delta(current, previous) {
  const c = num(current);
  const p = num(previous);
  if (c === 0 && p === 0) return { dir: 'flat', pct: 0, show: false };
  if (p === 0) return { dir: c > 0 ? 'up' : 'down', pct: null, show: true, label: 'нове' };
  const pct = Math.round(((c - p) / Math.abs(p)) * 1000) / 10;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  return { dir, pct, show: true };
}

function deltaMap(current, previous, keys = DELTA_KEYS) {
  const out = {};
  for (const key of keys) out[key] = delta(current?.[key], previous?.[key]);
  return out;
}

function withRates(counts) {
  const views = num(counts?.views);
  const calls = num(counts?.calls);
  const searches = num(counts?.searches);
  const zeroSearches = num(counts?.zeroSearches);
  const contacts = num(counts?.calls) + num(counts?.chats) + num(counts?.directions);
  return {
    sessions: num(counts?.sessions),
    pageViews: num(counts?.pageViews),
    mapLoads: num(counts?.mapLoads),
    searches,
    zeroSearches,
    zeroShare: rate(zeroSearches, searches),
    impressions: num(counts?.impressions),
    views,
    calls,
    chats: num(counts?.chats),
    directions: num(counts?.directions),
    favorites: num(counts?.favorites),
    shares: num(counts?.shares),
    orders: num(counts?.orders),
    dives: num(counts?.dives),
    mapFocus: num(counts?.mapFocus),
    claims: num(counts?.claims),
    reviews: num(counts?.reviews),
    reports: num(counts?.reports),
    logins: num(counts?.logins),
    registers: num(counts?.registers),
    contacts,
    callRate: rate(calls, views),
  };
}

function hasSchedule(loc) {
  const schedule = loc?.schedule;
  if (schedule && typeof schedule === 'object' && !Array.isArray(schedule) && Object.keys(schedule).length) return true;
  return Boolean(String(loc?.workingHours || '').trim());
}

function masterQuality(loc, stalePhoneCount, now = new Date()) {
  const photos = Array.isArray(loc?.photos) ? loc.photos.length : 0;
  const priceCount = loc?.prices && typeof loc.prices === 'object' ? Object.keys(loc.prices).length : 0;
  const stamps = [loc?.updatedAt, loc?.lastReviewAt]
    .map((value) => Date.parse(value || ''))
    .filter((n) => Number.isFinite(n));
  const freshnessDays = stamps.length
    ? Math.max(0, Math.floor((now.getTime() - Math.max(...stamps)) / 86400000))
    : '';
  const updatedOn = stamps.length ? new Date(Math.max(...stamps)).toISOString().slice(0, 10) : '';
  return {
    hasPhoto: photos > 0 ? 'так' : 'ні',
    photoCount: photos,
    hasPrice: priceCount > 0 ? 'так' : 'ні',
    priceCount,
    hasSchedule: hasSchedule(loc) ? 'так' : 'ні',
    claimed: loc?.providerId ? 'так' : 'ні',
    updatedOn,
    freshnessDays,
    stalePhone: num(stalePhoneCount),
  };
}

function openStalePhoneByLocation(reports) {
  const out = new Map();
  for (const report of reports || []) {
    if (!report || report.reason !== 'stale_phone') continue;
    if (report.status !== 'new' && report.status !== 'reviewing') continue;
    const id = String(report.locationId || '');
    if (!id) continue;
    out.set(id, (out.get(id) || 0) + 1);
  }
  return out;
}

function splitSource(key) {
  if (!key || key === 'direct') {
    return { label: 'прямий', utmSource: '', utmMedium: '', utmCampaign: '' };
  }
  const parts = String(key).split(' / ');
  return {
    label: String(key),
    utmSource: parts[0] || '',
    utmMedium: parts[1] || '',
    utmCampaign: parts.slice(2).join(' / '),
  };
}

function emptyDay(day) {
  return withRates({ day });
}

function fillDays(fromDay, toDay, rows) {
  const byDay = new Map((rows || []).map((row) => [row.day, row]));
  const out = [];
  if (!fromDay || !toDay) return out;
  let d = fromDay;
  for (let i = 0; i < 400 && d <= toDay; i++) {
    const row = byDay.get(d);
    out.push(row ? { ...withRates(row), day: d, callRate: rate(row.calls, row.views) } : { ...emptyDay(d), day: d });
    d = shiftDay(d, 1);
  }
  return out;
}

function dayRow(row) {
  const metrics = withRates(row);
  return {
    day: row.day,
    sessions: metrics.sessions,
    searches: metrics.searches,
    zeroSearches: metrics.zeroSearches,
    impressions: metrics.impressions,
    views: metrics.views,
    calls: metrics.calls,
    chats: metrics.chats,
    directions: metrics.directions,
    favorites: metrics.favorites,
    orders: metrics.orders,
    callRate: metrics.callRate,
  };
}

/**
 * Workbook rows for the browser. SheetJS builds the file there.
 * Columns are explicit so user ids and long phrases cannot leak in.
 */
function buildExportSheets({ days, districts, categories, sources, searches, masters } = {}) {
  const kpi = (days || []).map((row) => ({
    День: row.day,
    Сесії: num(row.sessions),
    Пошуки: num(row.searches),
    'Пошуки без результату': num(row.zeroSearches),
    Покази: num(row.impressions),
    Відкриття: num(row.views),
    Дзвінки: num(row.calls),
    Чат: num(row.chats),
    Маршрути: num(row.directions),
    Обране: num(row.favorites),
    Замовлення: num(row.orders),
    'Call rate %': num(row.callRate),
  }));

  const placeRows = (rows) =>
    (rows || []).map((row) => ({
      [row.kind === 'category' ? 'Категорія' : 'Район']: row.label,
      Сесії: num(row.sessions),
      Пошуки: num(row.searches),
      'Без результату': num(row.zeroSearches),
      Відкриття: num(row.views),
      Дзвінки: num(row.calls),
      Чат: num(row.chats),
      Маршрути: num(row.directions),
      Контакти: num(row.contacts),
      'Call rate %': num(row.callRate),
    }));

  const sourceRows = (sources || []).map((row) => {
    const parts = splitSource(row.key);
    const contacts = num(row.contacts != null ? row.contacts : num(row.calls) + num(row.chats) + num(row.directions));
    return {
      Джерело: parts.label,
      'UTM source': parts.utmSource,
      'UTM medium': parts.utmMedium,
      'UTM campaign': parts.utmCampaign,
      Відкриття: num(row.views),
      Дзвінки: num(row.calls),
      Чат: num(row.chats),
      Маршрути: num(row.directions),
      Контакти: contacts,
      'Конверсія контактів %': rate(contacts, row.views),
    };
  });

  const searchRows = (searches || []).map((row) => {
    const events = num(row.events);
    const zeroEvents = num(row.zeroEvents);
    return {
      Фраза: clipQuery(row.q),
      Район: row.districtLabel || districtLabel(row.district),
      Кількість: events,
      'Без результату': zeroEvents,
      'Частка без результату %': rate(zeroEvents, events),
    };
  });

  const masterRows = (masters || []).map((row) => ({
    ID: row.id,
    Назва: row.title,
    Категорія: row.categoryLabel || row.category || UNKNOWN_LABEL,
    Район: row.districtLabel || districtLabel(row.district),
    Фото: row.hasPhoto,
    'Позицій прайсу': num(row.priceCount),
    Графік: row.hasSchedule,
    'Є власник': row.claimed,
    Оновлено: row.updatedOn || '',
    'Свіжість, днів': row.freshnessDays === 0 ? 0 : row.freshnessDays || '',
    'Скарги «номер неактуальний»': num(row.stalePhone),
    Покази: num(row.impressions),
    Відкриття: num(row.views),
    Контакти: num(row.contacts),
    'Відкриття без контакту': num(row.viewsWithoutContact),
  }));

  return [
    { name: 'KPI', rows: kpi },
    { name: 'Райони', rows: placeRows(districts) },
    { name: 'Категорії', rows: placeRows((categories || []).map((row) => ({ ...row, kind: 'category' }))) },
    { name: 'Джерела', rows: sourceRows },
    { name: 'Пошук', rows: searchRows },
    { name: 'Картки', rows: masterRows },
  ];
}

function compareLabel(fromDay, toDay) {
  const fmt = (ymd) => {
    const [y, m, d] = String(ymd || '').split('-');
    return d && m && y ? `${d}.${m}.${y}` : ymd;
  };
  if (!fromDay || !toDay) return '';
  return `${fmt(fromDay)} — ${fmt(toDay)}`;
}

module.exports = {
  DISTRICT_KEYS,
  DISTRICT_LABELS,
  UNKNOWN_LABEL,
  UNKNOWN_TOKEN,
  QUERY_MAX,
  DELTA_KEYS,
  clipQuery,
  cardCategory,
  cardDistrict,
  pathDimensions,
  sourceKey,
  deviceKey,
  isZeroSearch,
  districtLabel,
  deviceLabel,
  sourceLabel,
  categoryLabel,
  rate,
  num,
  shiftDay,
  inclusiveDays,
  previousWindow,
  listDays,
  delta,
  deltaMap,
  withRates,
  masterQuality,
  openStalePhoneByLocation,
  hasSchedule,
  splitSource,
  fillDays,
  dayRow,
  buildExportSheets,
  compareLabel,
};
