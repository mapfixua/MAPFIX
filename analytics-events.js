'use strict';

/**
 * Per-event analytics log (table analytics_events, migration 020).
 * Every row = one action: who (user id / anonymous session), when, which card,
 * from which device and traffic source. Never stores phones, IPs or full UA.
 * Writes go through the service-role client; the table is not readable by anon.
 */
const { supabaseClient } = require('./supabaseClient.js');

const TABLE = process.env.SUPABASE_ANALYTICS_EVENTS_TABLE || 'analytics_events';

const CTA_TYPES = [
  'call',
  'chat',
  'directions',
  'map_focus',
  'share',
  'favorite',
  'order',
  'claim',
  'review',
  'report',
  'dive',
];

const OTHER_TYPES = ['view', 'page_view', 'search', 'login', 'register', 'donate', 'subscribe', 'support'];

const EVENT_TYPES = new Set([...CTA_TYPES, ...OTHER_TYPES]);

const LOCATION_TYPES = new Set([...CTA_TYPES, 'view']);

const BOT_RE =
  /bot|crawl|spider|slurp|lighthouse|headless|preview|facebookexternalhit|embedly|curl\/|wget|python-|node-fetch|axios|go-http|okhttp|vercel-screenshot/i;

const MAX_SCAN_ROWS = 10000;
const PAGE = 1000;

function clip(value, max) {
  const s = String(value == null ? '' : value).trim();
  return s ? s.slice(0, max) : null;
}

function cleanToken(value, max = 64) {
  const s = String(value == null ? '' : value)
    .trim()
    .replace(/[^\w.\-/:@ ]/g, '')
    .slice(0, max);
  return s || null;
}

function isMissingTable(error) {
  if (!error) return false;
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    String(error.message || '').includes('Could not find the table')
  );
}

/** Coarse device info from User-Agent; the raw UA is not stored. */
function parseDevice(ua) {
  const s = String(ua || '');
  if (!s) return { deviceType: null, os: null, browser: null };
  let deviceType = 'desktop';
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(s)) deviceType = 'tablet';
  else if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(s)) deviceType = 'mobile';

  let os = 'other';
  if (/Android/i.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod|iOS/i.test(s)) os = 'iOS';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/CrOS/i.test(s)) os = 'ChromeOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  let browser = 'other';
  if (/Telegram/i.test(s)) browser = 'Telegram';
  else if (/Viber/i.test(s)) browser = 'Viber';
  else if (/Instagram/i.test(s)) browser = 'Instagram';
  else if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(s)) browser = 'Facebook';
  else if (/TikTok|musical_ly|BytedanceWebview/i.test(s)) browser = 'TikTok';
  else if (/SamsungBrowser/i.test(s)) browser = 'Samsung';
  else if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/Firefox|FxiOS/i.test(s)) browser = 'Firefox';
  else if (/CriOS|Chrome\//i.test(s)) browser = 'Chrome';
  else if (/Safari/i.test(s)) browser = 'Safari';
  return { deviceType, os, browser };
}

/** Host of an external referrer (own site and empty → null). */
function referrerHost(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    let host = (u.hostname || '').toLowerCase().replace(/^www\./, '');
    if (u.protocol === 'android-app:') host = (u.hostname || u.host || '').toLowerCase();
    if (!host) return null;
    if (/(^|\.)mapfix\.com\.ua$|vercel\.app$|^localhost$|^127\./.test(host)) return null;
    return host.slice(0, 80);
  } catch {
    return null;
  }
}

function normalizeUtm(utm) {
  if (!utm || typeof utm !== 'object') return {};
  return {
    utm_source: cleanToken(utm.source || utm.utm_source, 48),
    utm_medium: cleanToken(utm.medium || utm.utm_medium, 48),
    utm_campaign: cleanToken(utm.campaign || utm.utm_campaign, 64),
  };
}

function safeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (Object.keys(out).length >= 8) break;
    const key = String(k).slice(0, 32);
    if (v == null) continue;
    if (typeof v === 'boolean' || typeof v === 'number') out[key] = v;
    else out[key] = String(v).slice(0, 140);
  }
  return out;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ error: { message: 'timeout' } }), ms)),
  ]);
}

/**
 * Record one event. Never throws; resolves quickly (timeout 1.5 s) so it can be
 * awaited inside request handlers (serverless functions may freeze after reply).
 */
async function logEvent(req, { type, locationId = null, meta = null, sid, utm, ref, path, user } = {}) {
  try {
    const t = String(type || '').trim().toLowerCase();
    if (!EVENT_TYPES.has(t)) return { ok: false, skipped: 'type' };
    const ua = req?.headers?.['user-agent'] || '';
    if (BOT_RE.test(ua)) return { ok: false, skipped: 'bot' };
    const body = req?.body && typeof req.body === 'object' ? req.body : {};
    const who = user || req?.authUser || null;
    const device = parseDevice(ua);
    const row = {
      event_type: t,
      location_id: locationId ? clip(locationId, 80) : null,
      user_id: who?.id ? String(who.id).slice(0, 64) : null,
      user_role: who?.role ? String(who.role).slice(0, 16) : null,
      session_id: cleanToken(sid !== undefined ? sid : body.sid, 64),
      path: clip(path !== undefined ? path : body.path, 160),
      referrer_host: referrerHost(ref !== undefined ? ref : body.ref),
      ...normalizeUtm(utm !== undefined ? utm : body.utm),
      device_type: device.deviceType,
      os: device.os,
      browser: device.browser,
      meta: safeMeta(meta),
    };
    const { error } = await withTimeout(supabaseClient.from(TABLE).insert(row), 1500);
    if (error) {
      if (!isMissingTable(error)) console.warn('[analytics-events] insert', error.message);
      return { ok: false, missing: isMissingTable(error) };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[analytics-events] log', err.message);
    return { ok: false };
  }
}

/* ---------- Kyiv-time ranges ---------- */

function kyivDayKey(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return new Date(date).toISOString().slice(0, 10);
  }
}

function kyivOffsetMs(date) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)) {
    parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of 00:00 Kyiv time on YYYY-MM-DD. */
function kyivDayStart(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - kyivOffsetMs(new Date(guess));
  const off2 = kyivOffsetMs(new Date(t));
  if (guess - off2 !== t) t = guess - off2;
  return new Date(t);
}

function shiftDay(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** range=today|yesterday|7d|30d|90d|all or from/to=YYYY-MM-DD (Kyiv days, inclusive). */
function parseRange(query = {}) {
  const today = kyivDayKey();
  let fromDay = null;
  let toDay = null;
  let key = String(query.range || '').trim() || 'all';
  if (YMD_RE.test(String(query.from || '')) || YMD_RE.test(String(query.to || ''))) {
    key = 'custom';
    fromDay = YMD_RE.test(String(query.from || '')) ? String(query.from) : null;
    toDay = YMD_RE.test(String(query.to || '')) ? String(query.to) : today;
    if (fromDay && toDay < fromDay) [fromDay, toDay] = [toDay, fromDay];
  } else if (key === 'today') {
    fromDay = today;
    toDay = today;
  } else if (key === 'yesterday') {
    fromDay = shiftDay(today, -1);
    toDay = fromDay;
  } else if (/^\d{1,3}d$/.test(key)) {
    const n = Math.min(366, Math.max(1, parseInt(key, 10)));
    fromDay = shiftDay(today, -(n - 1));
    toDay = today;
  } else {
    key = 'all';
  }
  return {
    key,
    fromDay,
    toDay,
    from: fromDay ? kyivDayStart(fromDay).toISOString() : null,
    to: toDay ? kyivDayStart(shiftDay(toDay, 1)).toISOString() : null,
  };
}

/* ---------- Reading ---------- */

function resolveTypes(raw) {
  const parts = String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out = new Set();
  for (const p of parts) {
    if (p === 'all') return null;
    if (p === 'cta') CTA_TYPES.forEach((t) => out.add(t));
    else if (p === 'location') LOCATION_TYPES.forEach((t) => out.add(t));
    else if (EVENT_TYPES.has(p)) out.add(p);
  }
  return out.size ? [...out] : null;
}

async function fetchEvents({ types = null, from = null, to = null, locationId = null, userId = null, sessionIds = null, maxRows = MAX_SCAN_ROWS } = {}) {
  const rows = [];
  let truncated = false;
  for (let offset = 0; offset < maxRows; offset += PAGE) {
    let q = supabaseClient.from(TABLE).select('*');
    if (types && types.length) q = types.length === 1 ? q.eq('event_type', types[0]) : q.in('event_type', types);
    if (from) q = q.gte('created_at', from);
    if (to) q = q.lt('created_at', to);
    if (locationId) q = q.eq('location_id', locationId);
    if (userId) q = q.eq('user_id', userId);
    if (sessionIds) q = q.in('session_id', sessionIds);
    const { data, error } = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + PAGE - 1);
    if (error) {
      if (isMissingTable(error)) return { ok: false, missing: true, rows: [] };
      return { ok: false, error, rows };
    }
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
    if (offset + PAGE >= maxRows) truncated = true;
  }
  return { ok: true, rows, truncated };
}

/* ---------- Aggregation ---------- */

const SOURCE_NAMES = [
  [/google\./, 'Google'],
  [/(^|\.)facebook\.com$|^fb\.|^m\.facebook/, 'Facebook'],
  [/instagram/, 'Instagram'],
  [/telegram|^t\.me$/, 'Telegram'],
  [/viber/, 'Viber'],
  [/tiktok/, 'TikTok'],
  [/^t\.co$|twitter|^x\.com$/, 'X'],
  [/bing\./, 'Bing'],
  [/yandex|duckduckgo/, 'Пошуковик'],
];

function sourceLabel(row) {
  if (!row) return null;
  if (row.utm_source) return [row.utm_source, row.utm_medium, row.utm_campaign].filter(Boolean).join(' / ');
  if (row.referrer_host) {
    for (const [re, name] of SOURCE_NAMES) if (re.test(row.referrer_host)) return name;
    return row.referrer_host;
  }
  return null;
}

function deviceLabel(row) {
  if (!row || !row.device_type) return null;
  const type = { mobile: 'телефон', tablet: 'планшет', desktop: 'комп’ютер' }[row.device_type] || row.device_type;
  return [type, row.os, row.browser].filter((x) => x && x !== 'other').join(' · ');
}

function maskLogin(login) {
  const s = String(login || '');
  const digits = s.replace(/\D/g, '');
  if (/^\+?[\d\s()-]{8,}$/.test(s) && digits.length >= 9) {
    return `${s.startsWith('+') ? '+' : ''}${digits.slice(0, 3)}•••${digits.slice(-2)}`;
  }
  return s;
}

function countInto(map, key, n = 1) {
  if (key == null || key === '') return;
  map.set(key, (map.get(key) || 0) + n);
}

function topList(map, limit = 30) {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit);
}

function dayRange(fromDay, toDay) {
  const out = [];
  if (!fromDay || !toDay) return out;
  let d = fromDay;
  for (let i = 0; i < 400 && d <= toDay; i++) {
    out.push(d);
    d = shiftDay(d, 1);
  }
  return out;
}

/**
 * @param rows analytics_events rows (newest first)
 * @param ctx { locations, users, profiles, catalog, sessionSources, range, limit, offset }
 */
function buildDrill(rows, ctx = {}) {
  const {
    locations = [],
    users = [],
    profiles = {},
    catalog = {},
    sessionSources = new Map(),
    range = { key: 'all' },
    limit = 50,
    offset = 0,
  } = ctx;
  const locById = new Map(locations.map((l) => [String(l.id), l]));
  const userById = new Map(users.map((u) => [String(u.id), u]));

  const userInfo = (id, role) => {
    if (!id) return null;
    const u = userById.get(String(id));
    const company = profiles?.[id]?.companyName || '';
    return {
      id: String(id),
      name: company || maskLogin(u?.login) || 'користувач',
      role: u?.role || role || '',
    };
  };

  const locInfo = (id) => {
    if (!id) return null;
    const l = locById.get(String(id));
    const catName = l ? catalog?.[l.cat]?.name || l.cat || '' : '';
    return {
      id: String(id),
      title: l?.title || String(id),
      catName,
      address: l?.address || '',
      exists: Boolean(l),
      deleted: Boolean(l && l.deletedAt),
    };
  };

  const byType = new Map();
  const byDay = new Map();
  const byLoc = new Map();
  const byDevice = new Map();
  const bySource = new Map();
  const byPath = new Map();
  const byQuery = new Map();
  const byUser = new Map();
  const sessions = new Set();
  const loggedUsers = new Set();
  let loggedIn = 0;
  let legacy = 0;

  const sourceFor = (r) => sourceLabel(r) || sessionSources.get(r.session_id) || null;

  for (const r of rows) {
    countInto(byType, r.event_type);
    const day = kyivDayKey(new Date(r.created_at));
    countInto(byDay, day);
    if (r.legacy) legacy += 1;
    if (r.session_id) sessions.add(r.session_id);
    if (r.user_id) {
      loggedIn += 1;
      loggedUsers.add(r.user_id);
      countInto(byUser, r.user_id);
    }
    countInto(byDevice, deviceLabel(r) || (r.legacy ? 'невідомо (старі дані)' : 'невідомо'));
    countInto(bySource, sourceFor(r) || (r.legacy ? 'невідомо (старі дані)' : 'прямий / невідомо'));
    if (r.event_type === 'page_view' && r.path) countInto(byPath, r.path);
    if (r.event_type === 'search' && r.meta?.q) countInto(byQuery, String(r.meta.q).toLowerCase());
    if (r.location_id) {
      const id = String(r.location_id);
      if (!byLoc.has(id)) byLoc.set(id, { count: 0, byType: {} });
      const b = byLoc.get(id);
      b.count += 1;
      b.byType[r.event_type] = (b.byType[r.event_type] || 0) + 1;
    }
  }

  let days = [];
  const firstDay = range.fromDay || (rows.length ? kyivDayKey(new Date(rows[rows.length - 1].created_at)) : null);
  const lastDay = range.toDay || (rows.length ? kyivDayKey() : null);
  if (firstDay && lastDay) {
    const span = dayRange(firstDay, lastDay);
    days = (span.length <= 366 ? span : span.slice(-366)).map((d) => ({ day: d, count: byDay.get(d) || 0 }));
  }

  const byLocation = [...byLoc.entries()]
    .map(([id, b]) => {
      const info = locInfo(id);
      const l = locById.get(id);
      return { ...info, count: b.count, byType: b.byType, viewsAllTime: Number(l?.views) || 0 };
    })
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, 200);

  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const events = rows.slice(off, off + lim).map((r) => ({
    id: r.id,
    at: r.created_at,
    type: r.event_type,
    location: locInfo(r.location_id),
    user: userInfo(r.user_id, r.user_role),
    role: r.user_role || (r.user_id ? '' : 'guest'),
    session: r.session_id ? String(r.session_id).slice(0, 8) : null,
    device: deviceLabel(r),
    source: sourceFor(r),
    path: r.path || null,
    meta: r.meta || {},
    legacy: Boolean(r.legacy),
  }));

  return {
    range,
    total: rows.length,
    legacyCount: legacy,
    uniqueSessions: sessions.size,
    loggedInEvents: loggedIn,
    uniqueUsers: loggedUsers.size,
    byType: Object.fromEntries(byType),
    byDay: days,
    byLocation,
    byDevice: topList(byDevice, 20),
    bySource: topList(bySource, 20),
    byPath: topList(byPath, 30),
    byQuery: topList(byQuery, 40),
    byUser: topList(byUser, 30).map((x) => ({ ...userInfo(x.key), count: x.count })),
    events,
    offset: off,
    limit: lim,
    hasMore: off + lim < rows.length,
  };
}

/** First known traffic source per session (from page_view rows). */
async function sessionSourcesFor(sessionIds, to) {
  const out = new Map();
  const ids = [...new Set(sessionIds.filter(Boolean))].slice(0, 300);
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    let q = supabaseClient
      .from(TABLE)
      .select('session_id, utm_source, utm_medium, utm_campaign, referrer_host, created_at')
      .eq('event_type', 'page_view')
      .in('session_id', chunk)
      .or('utm_source.not.is.null,referrer_host.not.is.null');
    if (to) q = q.lt('created_at', to);
    const { data, error } = await q.order('created_at', { ascending: true }).limit(1000);
    if (error) break;
    for (const r of data || []) {
      if (!out.has(r.session_id)) {
        const label = sourceLabel(r);
        if (label) out.set(r.session_id, label);
      }
    }
  }
  return out;
}

module.exports = {
  TABLE,
  CTA_TYPES,
  OTHER_TYPES,
  EVENT_TYPES,
  LOCATION_TYPES,
  parseDevice,
  referrerHost,
  logEvent,
  parseRange,
  resolveTypes,
  fetchEvents,
  buildDrill,
  sessionSourcesFor,
  sourceLabel,
  deviceLabel,
  maskLogin,
  kyivDayKey,
  kyivDayStart,
};
