'use strict';

/**
 * Parse Telegram Desktop JSON exports / pasted craftsman ads and turn them
 * into Mapfix location candidates. Does not scrape Telegram groups.
 * Optional: store recent ads from groups the bot was added to.
 */

const crypto = require('crypto');
const {
  geocodeCityUkraine,
  normalizePhone,
  pricesFromCatalogServices,
} = require('./places-import.js');
const { classifyPlacesForImport, localRankSearch } = require('./search-ai.js');
const { loadAppState, saveAppState } = require('./app-state-store.js');

const INBOX_ID = 'telegram_group_ads';
const MAX_ADS = 80;
const MAX_INBOX = 150;
const MAX_TEXT = 4000;

const UA_CITIES = [
  'Петропавлівська Борщагівка',
  'Софіївська Борщагівка',
  'Івано-Франківськ',
  'Білгород-Дністровський',
  'Кам\'янське',
  'Біла Церква',
  'Кривий Ріг',
  'Кропивницький',
  'Чорноморськ',
  'Новомосковськ',
  'Хмельницький',
  'Запоріжжя',
  'Коцюбинське',
  'Гостомель',
  'Бориспіль',
  'Червоноград',
  'Мелітополь',
  'Кременчук',
  'Маріуполь',
  'Чернівці',
  'Тернопіль',
  'Вишгород',
  'Миколаїв',
  'Павлоград',
  'Бердянськ',
  'Енергодар',
  'Мукачево',
  'Дрогобич',
  'Коломия',
  'Переяслав',
  'Славутич',
  'Українка',
  'Васильків',
  'Вишневе',
  'Бровари',
  'Чернігів',
  'Харків',
  'Полтава',
  'Черкаси',
  'Житомир',
  'Херсон',
  'Вінниця',
  'Одеса',
  'Дніпро',
  'Львів',
  'Ірпінь',
  'Обухів',
  'Фастів',
  'Боярка',
  'Ніжин',
  'Прилуки',
  'Конотоп',
  'Шостка',
  'Охтирка',
  'Калуш',
  'Стрий',
  'Нікополь',
  'Ізмаїл',
  'Умань',
  'Сміла',
  'Луцьк',
  'Рівне',
  'Суми',
  'Буча',
  'Гатне',
  'Чабани',
  'Южне',
  'Київ',
];

const CITY_ALIASES = {
  києві: 'Київ',
  києва: 'Київ',
  києвом: 'Київ',
  киеве: 'Київ',
  киева: 'Київ',
  ірпені: 'Ірпінь',
  ірпеня: 'Ірпінь',
  ірпенем: 'Ірпінь',
  бучі: 'Буча',
  львові: 'Львів',
  львова: 'Львів',
  одесі: 'Одеса',
  одеси: 'Одеса',
  харкові: 'Харків',
  харкова: 'Харків',
  дніпрі: 'Дніпро',
  дніпра: 'Дніпро',
};

const geoCache = new Map();
let inboxMemory = null;
let inboxLoading = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeAdLocationId(seed) {
  const hash = crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 10);
  return `loc-tg-${hash}`;
}

function flattenTelegramText(text) {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) {
    return text
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  if (text && typeof text === 'object' && typeof text.text === 'string') return text.text;
  return '';
}

function extractPhones(text) {
  const raw = String(text || '');
  const seen = new Set();
  const out = [];
  const re =
    /(?:\+?38[\s\-.]?)?(?:\(?0\d{2}\)?[\s\-.]?|0\d{2}[\s\-.]?)\d{3}[\s\-.]?\d{2}[\s\-.]?\d{2}|\+?380\d{9}/g;
  let m;
  while ((m = re.exec(raw))) {
    const normalized = normalizePhone(m[0]);
    if (!normalized || normalized.length < 12) continue;
    if (!normalized.startsWith('+380')) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractUsername(text, fallback) {
  const fromFallback = String(fallback || '')
    .replace(/^@/, '')
    .trim();
  const tme = String(text || '').match(/t\.me\/([A-Za-z0-9_]{5,32})/i);
  if (tme) return tme[1];
  const at = String(text || '').match(/(?:^|[^\w])@([A-Za-z0-9_]{5,32})\b/);
  if (at) return at[1];
  if (/^[A-Za-z0-9_]{5,32}$/.test(fromFallback)) return fromFallback;
  return '';
}

function extractLinks(text) {
  const raw = String(text || '');
  const re = /https?:\/\/[^\s<>"']+/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(raw))) {
    const url = m[0].replace(/[).,;]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out.slice(0, 5);
}

function extractCity(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const labeled = raw.match(
    /(?:^|[^\p{L}])(?:м\.|місто|смт|селище|с\.|село)\s+([А-ЯІЇЄҐ][\p{L}'’\-]+(?:\s+[А-ЯІЇЄҐа-яіїєґ'’\-]+){0,3})/u
  );
  if (labeled) {
    const name = labeled[1].trim().replace(/[.,;:]+$/, '');
    if (name.length >= 3) return name;
  }
  for (const [alias, city] of Object.entries(CITY_ALIASES)) {
    if (lower.includes(alias)) return city;
  }
  for (const city of UA_CITIES) {
    if (lower.includes(city.toLowerCase())) return city;
  }
  return '';
}

function extractAddress(text) {
  const raw = String(text || '');
  const m = raw.match(
    /(?:вул\.|вулиця|просп\.|проспект|бул\.|бульвар|пров\.|провулок|площа|пл\.)\s+[А-ЯІЇЄҐа-яіїєґ0-9'’.\-\s]{2,48}/i
  );
  return m ? m[0].trim().replace(/[.,;]+$/, '') : '';
}

function inferTitle(ad) {
  const from = String(ad.from || '').trim();
  if (from && from.length >= 2 && from.length <= 80 && !/^deleted/i.test(from)) {
    return from.slice(0, 80);
  }
  const lines = String(ad.text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const line = lines.find((l) => {
    if (l.length < 3 || l.length > 80) return false;
    if (extractPhones(l).length && l.length < 20) return false;
    if (/^https?:\/\//i.test(l)) return false;
    if (/^@/.test(l)) return false;
    return /[\p{L}]/u.test(l);
  });
  if (line) return line.slice(0, 80);
  const named = String(ad.text || '').match(
    /(?:мене\s+звати|я\s+)\s*([А-ЯІЇЄҐ][а-яіїєґ'’]+(?:\s+[А-ЯІЇЄҐ][а-яіїєґ'’]+)?)/i
  );
  if (named) return named[1].trim();
  return (lines[0] || 'Майстер з Telegram').slice(0, 60);
}

function looksLikeServiceAd(text) {
  const raw = String(text || '').trim();
  if (raw.length < 20) return false;
  if (/^\/\w+/.test(raw)) return false;
  if (/^\d{4,8}$/.test(raw)) return false;
  if (!/[\p{L}]{4,}/u.test(raw)) return false;
  const phones = extractPhones(raw);
  if (phones.length) return true;
  return raw.length >= 40;
}

function extractMessagesFromExport(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) {
    if (parsed.every((m) => m && (m.text != null || m.message || typeof m === 'string'))) {
      return parsed;
    }
    return parsed.flatMap((item) => extractMessagesFromExport(item));
  }
  if (typeof parsed !== 'object') return [];
  if (Array.isArray(parsed.messages)) return parsed.messages;
  if (Array.isArray(parsed.chats)) {
    return parsed.chats.flatMap((chat) => extractMessagesFromExport(chat));
  }
  if (parsed.message || parsed.text) return [parsed];
  return [];
}

function normalizeRawMessage(raw, index) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    return {
      messageId: `paste-${index}`,
      from: '',
      username: extractUsername(text),
      date: '',
      text: text.slice(0, MAX_TEXT),
    };
  }
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || 'message');
  if (type && type !== 'message') return null;
  const text = flattenTelegramText(raw.text || raw.message || raw.caption || '').trim();
  if (!text) return null;
  const from =
    raw.from ||
    raw.author ||
    [raw.from_name, raw.first_name, raw.last_name].filter(Boolean).join(' ') ||
    '';
  const username = extractUsername(
    text,
    raw.username || raw.from_username || (typeof raw.from_id === 'string' ? raw.from_id : '')
  );
  return {
    messageId: raw.id || raw.message_id || `msg-${index}`,
    from: String(from).trim(),
    username,
    date: raw.date || raw.date_unixtime || '',
    chatTitle: raw.chatTitle || raw.chat_title || '',
    text: text.slice(0, MAX_TEXT),
  };
}

function splitPastedAds(raw) {
  const text = String(raw || '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return [];
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const msgs = extractMessagesFromExport(parsed);
      if (msgs.length) return msgs;
    } catch (_) {
      /* treat as plain text */
    }
  }
  const bySep = text
    .split(/\n{2,}|^\s*[-–—*_=]{3,}\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
  if (bySep.length >= 2) return bySep;
  return [text];
}

function parseTelegramAdsPayload({ text, messages } = {}) {
  let rawList = [];
  if (Array.isArray(messages) && messages.length) {
    rawList = messages;
  } else {
    rawList = splitPastedAds(text);
  }
  const ads = [];
  const seen = new Set();
  for (let i = 0; i < rawList.length; i++) {
    const msg = normalizeRawMessage(rawList[i], i);
    if (!msg || !looksLikeServiceAd(msg.text)) continue;
    const phones = extractPhones(msg.text);
    const city = extractCity(msg.text);
    const address = extractAddress(msg.text);
    const username = msg.username || extractUsername(msg.text);
    const links = extractLinks(msg.text);
    const title = inferTitle({ ...msg, username });
    const key = `${phones[0] || ''}|${title}|${msg.text.slice(0, 80)}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ads.push({
      messageId: msg.messageId,
      from: msg.from,
      username,
      date: msg.date,
      chatTitle: msg.chatTitle || '',
      text: msg.text,
      title,
      phone: phones[0] || '',
      phones,
      city,
      address,
      links,
    });
    if (ads.length >= MAX_ADS) break;
  }
  return ads;
}

function enrichAdServices(ad, match, masterCatalog) {
  const cat = match?.category;
  const sub = match?.subcategory;
  if (!cat || !sub) return [];
  const found = [];
  const seen = new Set();
  const add = (name) => {
    const n = String(name || '').trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    found.push(n);
  };
  (match.services || []).forEach(add);
  if (match.service) add(match.service);

  const ranked = localRankSearch(ad.text, masterCatalog, 16);
  for (const row of ranked) {
    if (row.type === 'service' && row.category === cat && row.subcategory === sub) {
      add(row.service);
    }
  }

  const items = masterCatalog?.[cat]?.subcats?.[sub]?.items || [];
  const q = String(ad.text || '').toLowerCase();
  for (const item of items) {
    const name = String(item.name || '').trim();
    if (name.length >= 6 && q.includes(name.toLowerCase())) add(name);
  }
  return found.slice(0, 8);
}

function geocodeResultCoords(hit) {
  if (!hit) return null;
  const lat = Number(hit.center?.lat ?? hit.lat);
  const lng = Number(hit.center?.lng ?? hit.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    address: hit.name || '',
    cityName: hit.name || '',
  };
}

async function geocodeLocalityCached(query) {
  const key = String(query || '')
    .trim()
    .toLowerCase();
  if (key.length < 2) return null;
  if (geoCache.has(key)) return geoCache.get(key);
  try {
    const hit = await geocodeCityUkraine(query);
    const result = geocodeResultCoords(hit);
    geoCache.set(key, result);
    await sleep(1100);
    return result;
  } catch {
    geoCache.set(key, null);
    return null;
  }
}

async function geocodeAd(ad) {
  const queries = [];
  if (ad.address && ad.city) queries.push(`${ad.address}, ${ad.city}`);
  if (ad.address) queries.push(ad.address);
  if (ad.city) queries.push(ad.city);
  for (const q of queries) {
    const hit = await geocodeLocalityCached(q);
    if (hit) {
      return {
        ...hit,
        address: ad.address ? `${ad.address}${ad.city ? `, ${ad.city}` : ''}` : hit.address || ad.city,
      };
    }
  }
  return null;
}

function buildAdText(ad) {
  const lines = ['Оголошення з Telegram'];
  if (ad.chatTitle) lines.push(`Група: ${ad.chatTitle}`);
  if (ad.username) lines.push(`Telegram: @${ad.username}`);
  if (ad.links[0]) lines.push(ad.links[0]);
  else if (ad.username) lines.push(`https://t.me/${ad.username}`);
  lines.push('');
  lines.push(ad.text);
  return lines.join('\n').slice(0, 2500);
}

function adToLocation(ad, match, geo, masterCatalog) {
  const services = enrichAdServices(ad, match, masterCatalog);
  const prices = pricesFromCatalogServices(masterCatalog, match.category, match.subcategory, services);
  const lat = geo?.lat;
  const lng = geo?.lng;
  const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
  const seed = `tg:${ad.phone || ''}:${ad.username || ''}:${ad.messageId}:${ad.title}`;
  const address = ad.address
    ? `${ad.address}${ad.city ? `, ${ad.city}` : ''}`
    : geo?.address || ad.city || '';
  return {
    id: makeAdLocationId(seed),
    providerId: null,
    lat: hasCoords ? Number(lat) : null,
    lng: hasCoords ? Number(lng) : null,
    cat: match.category,
    title: ad.title,
    text: buildAdText(ad),
    rating: 0,
    reviewsCount: 0,
    openStatus: 'open',
    workingHours: '',
    phone: ad.phone || '',
    address,
    website: ad.links[0] || (ad.username ? `https://t.me/${ad.username}` : ''),
    schedule: {},
    subcats: [match.subcategory],
    prices,
    reviews: [],
    views: 0,
    importSource: 'telegram_ads',
    importMeta: {
      source: 'telegram_ads',
      telegramUsername: ad.username || '',
      chatTitle: ad.chatTitle || '',
      messageId: ad.messageId,
      city: ad.city || geo?.cityName || '',
      services,
      aiSource: match.source,
      aiConfidence: match.confidence,
      importedAt: new Date().toISOString(),
    },
    needsCoords: !hasCoords,
    matchedServices: services,
  };
}

function hasCoords(loc) {
  return Number.isFinite(Number(loc?.lat)) && Number.isFinite(Number(loc?.lng));
}

async function buildTelegramImportCandidates({ ads, masterCatalog, geminiApiKey }) {
  const list = Array.isArray(ads) ? ads.slice(0, MAX_ADS) : [];
  const places = list.map((ad) => ({
    title: `${ad.title} — ${ad.text}`.slice(0, 320),
    address: [ad.address, ad.city].filter(Boolean).join(', '),
    text: ad.text,
    summary: ad.text.slice(0, 400),
    types: ad.username ? ['telegram'] : [],
  }));

  const classifications = await classifyPlacesForImport(places, masterCatalog, {
    geminiApiKey,
  });

  const locations = [];
  let rejected = 0;
  const pendingGeo = [];

  for (let i = 0; i < list.length; i++) {
    const ad = list[i];
    const match = classifications[i];
    if (!match?.category || !match?.subcategory) {
      rejected += 1;
      continue;
    }
    if (!masterCatalog?.[match.category]?.subcats?.[match.subcategory]) {
      rejected += 1;
      continue;
    }
    pendingGeo.push({ ad, match });
  }

  for (const row of pendingGeo) {
    const geo = await geocodeAd(row.ad);
    locations.push(adToLocation(row.ad, row.match, geo, masterCatalog));
  }

  return {
    scanned: list.length,
    rejected,
    matched: locations.length,
    locations,
  };
}

function sanitizeTelegramLocationsForWrite(locations, catalog) {
  return (locations || [])
    .filter((l) => l && String(l.title || '').trim() && hasCoords(l))
    .filter((l) => catalog[l.cat]?.subcats && (l.subcats || []).some((s) => catalog[l.cat].subcats[s]))
    .map((l) => {
      const subcats = (Array.isArray(l.subcats) ? l.subcats : [])
        .map((s) => String(s || '').trim())
        .filter((s) => catalog[l.cat]?.subcats?.[s]);
      const sub = subcats[0];
      const serviceNames =
        Array.isArray(l.matchedServices) && l.matchedServices.length
          ? l.matchedServices
          : Object.keys(l.prices || {});
      const fromCatalog = pricesFromCatalogServices(catalog, l.cat, sub, serviceNames);
      const prices = { ...fromCatalog };
      if (l.prices && typeof l.prices === 'object') {
        for (const [name, price] of Object.entries(l.prices)) {
          if (name && price) prices[name] = price;
        }
      }
      const { needsCoords, matchedServices, importMeta, ...rest } = l;
      return {
        ...rest,
        lat: Number(l.lat),
        lng: Number(l.lng),
        providerId: null,
        importSource: 'telegram_ads',
        subcats,
        prices,
        importMeta: {
          ...(importMeta || {}),
          source: 'telegram_ads',
          services: Object.keys(prices),
          importedAt: new Date().toISOString(),
        },
      };
    })
    .filter((l) => l.subcats.length > 0);
}

async function getInbox() {
  if (Array.isArray(inboxMemory)) return inboxMemory;
  if (inboxLoading) return inboxLoading;
  inboxLoading = (async () => {
    try {
      const remote = await loadAppState(INBOX_ID, { items: [] });
      const items = Array.isArray(remote.value?.items)
        ? remote.value.items
        : Array.isArray(remote.value)
          ? remote.value
          : [];
      inboxMemory = items;
    } catch {
      inboxMemory = [];
    }
    return inboxMemory;
  })();
  try {
    return await inboxLoading;
  } finally {
    inboxLoading = null;
  }
}

async function saveInbox(items) {
  inboxMemory = Array.isArray(items) ? items.slice(0, MAX_INBOX) : [];
  try {
    await saveAppState(INBOX_ID, { items: inboxMemory });
  } catch (err) {
    console.warn('[telegram-ads] inbox persist:', err.message);
  }
  return inboxMemory;
}

async function listGroupAdsInbox() {
  const items = await getInbox();
  return items.slice(0, MAX_INBOX);
}

async function clearGroupAdsInbox() {
  await saveInbox([]);
  return { ok: true, count: 0 };
}

function ingestGroupMessage(ctx) {
  const chatType = ctx?.chat?.type;
  if (chatType !== 'group' && chatType !== 'supergroup') return;
  if (ctx.from?.is_bot) return;
  const text = String(ctx.message?.text || ctx.message?.caption || '').trim();
  if (!looksLikeServiceAd(text)) return;

  const username = ctx.from?.username || extractUsername(text);
  const entry = {
    id: `${ctx.chat?.id}:${ctx.message?.message_id}`,
    chatId: ctx.chat?.id,
    chatTitle: ctx.chat?.title || '',
    messageId: ctx.message?.message_id,
    from: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || username,
    username: username || '',
    date: ctx.message?.date
      ? new Date(Number(ctx.message.date) * 1000).toISOString()
      : new Date().toISOString(),
    text: text.slice(0, MAX_TEXT),
    capturedAt: new Date().toISOString(),
  };

  Promise.resolve()
    .then(async () => {
      const list = await getInbox();
      if (list.some((item) => item.id === entry.id)) return;
      list.unshift(entry);
      await saveInbox(list);
    })
    .catch((err) => {
      console.warn('[telegram-ads] ingest:', err.message);
    });
}

module.exports = {
  parseTelegramAdsPayload,
  buildTelegramImportCandidates,
  sanitizeTelegramLocationsForWrite,
  ingestGroupMessage,
  listGroupAdsInbox,
  clearGroupAdsInbox,
  looksLikeServiceAd,
  extractPhones,
  flattenTelegramText,
};
