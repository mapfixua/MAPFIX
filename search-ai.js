'use strict';

const {
  buildSearchResponseSchema,
  buildImportBatchResponseSchema,
} = require('./catalog-taxonomy.js');
const { extractSearchArea } = require('./public/js/search-area.js');

function normalizeText(text) {
  return String(text)
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Розмовні запити → слова, які є в каталозі. Ключ збігається лише як ціле слово. */
const QUERY_SYNONYMS = {
  постригтися: ['стрижка', 'перукар', 'барбер', 'волосся'],
  постригтись: ['стрижка', 'перукар', 'барбер', 'волосся'],
  підстригтися: ['стрижка', 'перукар', 'барбер'],
  підстригтись: ['стрижка', 'перукар', 'барбер'],
  поголитися: ['борода', 'гоління', 'барбер'],
  манікюр: ['нігті', 'nails'],
  педикюр: ['нігті', 'nails'],
  шиномонтаж: ['шини', 'балансування', 'tyres'],
  сто: ['ремонт', 'авто', 'auto_repair'],
  автомийка: ['мийка', 'wash'],
  масаж: ['масаж', 'spa'],
  ветеринар: ['вет', 'тварини', 'pets'],
  ключі: ['ключі', 'замки', 'keys'],
  ноутбук: ['комп', 'ремонт', 'електронік'],
  'заміна масла': ['мастило', 'мастила'],
  'заміна мастил': ['мастило', 'мастила'],
  'заміна мастила': ['мастило', 'мастила'],
  масла: ['мастило', 'мастила', 'масло'],
  масло: ['мастило', 'мастила', 'масла'],
  мастила: ['мастило'],
  резина: ['шини', 'шина', 'шиномонтаж'],
  покришки: ['шини', 'шина', 'шиномонтаж'],
  'продаж шин': ['шини', 'шина', 'шиномонтаж'],
  техобслуговування: ['мастило', 'maintenance', 'то'],
  то: ['мастило', 'maintenance'],
};

const SYNONYM_PHRASES = Object.keys(QUERY_SYNONYMS).sort((a, b) => b.length - a.length);

function expandQueryTokens(text) {
  const base = tokenize(text);
  const extra = [];
  const norm = normalizeText(text);
  for (const phrase of SYNONYM_PHRASES) {
    if (containsWholePhrase(norm, phrase)) {
      extra.push(...QUERY_SYNONYMS[phrase].map(normalizeText));
    }
  }
  return [...new Set([...base, ...extra.filter(Boolean)])];
}

// 2.0/2.5 Flash часто недоступні новим ключам (limit:0 / 404). Актуальний Free: 3.5 Flash.
const GEMINI_MODELS = [
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];

/** Model-provided confidence in 0..1. Never invents a perfect score. */
function modelConfidence(raw) {
  if (typeof raw === 'number') {
    if (raw >= 0 && raw <= 1) return raw;
    if (raw > 1 && raw <= 10) return Math.round((raw / 10) * 1000) / 1000;
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const direct = Number(raw.confidence);
  if (Number.isFinite(direct)) {
    if (direct >= 0 && direct <= 1) return direct;
    if (direct > 1 && direct <= 10) return Math.round((direct / 10) * 1000) / 1000;
  }
  const score = Number(raw.score);
  if (Number.isFinite(score) && score > 0 && score <= 10) {
    return score <= 1 ? score : Math.round((score / 10) * 1000) / 1000;
  }
  return null;
}

function parseGeminiJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  return JSON.parse(cleaned || '{}');
}

/**
 * Shared Gemini JSON call. Tries the free-tier model list.
 * When a responseSchema is rejected by the API, retries the same model without it.
 */
async function geminiGenerateJson(
  apiKey,
  {
    prompt,
    schema,
    timeoutMs = 12000,
    maxOutputTokens = 800,
    temperature = 0.15,
    models = GEMINI_MODELS,
    maxAborts = 0,
    fetchImpl = null,
  } = {}
) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  let lastError = null;
  let quotaError = null;
  let aborts = 0;
  let stopAll = false;
  const abortLimit = Number.isFinite(Number(maxAborts)) && Number(maxAborts) > 0 ? Number(maxAborts) : 0;
  for (const model of models) {
    if (stopAll) break;
    const modes = schema ? ['schema', 'plain'] : ['plain'];
    let skipModel = false;
    for (const mode of modes) {
      if (skipModel || stopAll) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const generationConfig = {
          temperature,
          maxOutputTokens,
          responseMimeType: 'application/json',
        };
        if (mode === 'schema') generationConfig.responseSchema = schema;
        const doFetch = fetchImpl || fetch;
        const res = await doFetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig,
            }),
          }
        );
        if (!res.ok) {
          const errText = await res.text();
          const err = new Error(`Gemini ${res.status} (${model}): ${errText.slice(0, 180)}`);
          err.status = res.status;
          lastError = err;
          // limit:0 means this model is not on the free tier. A daily quota 429 is remembered
          // so a later free model can still answer, and the wave stops if none of them do.
          if (res.status === 429 && !/limit:\s*0/i.test(errText)) {
            err.code = 'classifier_quota';
            quotaError = err;
            skipModel = true;
            break;
          }
          if (mode === 'schema' && (res.status === 400 || /schema|enum|INVALID_ARGUMENT/i.test(errText))) {
            continue;
          }
          if (res.status === 429 || res.status === 404) {
            skipModel = true;
            break;
          }
          throw err;
        }
        const data = await res.json();
        const raw = (data?.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('').trim();
        return parseGeminiJson(raw);
      } catch (err) {
        lastError = err;
        if (err?.code === 'classifier_quota') {
          quotaError = err;
          skipModel = true;
          break;
        }
        const aborted = err?.name === 'AbortError' || /operation was aborted/i.test(String(err?.message || ''));
        if (aborted) {
          aborts += 1;
          if (abortLimit && aborts >= abortLimit) {
            stopAll = true;
            break;
          }
          skipModel = true;
          break;
        }
        if (mode === 'schema') continue;
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw quotaError || lastError || new Error('Gemini unavailable');
}

function tokenize(text) {
  return normalizeText(text)
    .split(' ')
    .filter((w) => w.length > 1);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsWholePhrase(text, phrase) {
  if (!text || !phrase) return false;
  const re = new RegExp(`(?:^|\\s)${escapeRegExp(phrase)}(?=\\s|$)`, 'u');
  return re.test(text);
}

/**
 * Light Ukrainian stem: drop one inflection, then keep the first 5 letters.
 * масла/масло → масл, мастила/мастило → масти, шин/шини/шина → шин.
 */
const UK_SUFFIXES = [
  'ами',
  'ями',
  'ові',
  'еві',
  'ому',
  'ему',
  'ого',
  'ою',
  'ею',
  'ах',
  'ях',
  'ів',
  'їв',
  'ам',
  'ям',
  'ий',
  'ій',
  'ої',
  'а',
  'я',
  'у',
  'ю',
  'і',
  'и',
  'е',
  'о',
  'ь',
];

function stemUk(word) {
  let w = normalizeText(word);
  if (!w || w.length <= 3) return w;
  for (const suffix of UK_SUFFIXES) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      w = w.slice(0, w.length - suffix.length);
      break;
    }
  }
  return w.slice(0, 5);
}

function wordsOf(text) {
  return String(text || '')
    .split(/[\s-]+/)
    .filter(Boolean);
}

/** Tail after a >=5 letter prefix may only be an ending, not an arbitrary word («свято»+«шин»). */
const INFLECTION_TAIL = /^(а|я|у|ю|і|и|е|о|ом|ем|ою|ею|ах|ях|ів|їв|ам|ям|ами|ями|ові|еві|ого|ому|ему|ий|ій|ої|ь|ти|ся|сь)?$/;

function isMorphPrefix(word, phrase) {
  if (!word || !phrase || phrase.length < 5 || word === phrase) return false;
  if (!word.startsWith(phrase)) return false;
  return INFLECTION_TAIL.test(word.slice(phrase.length));
}

/** 'word' = whole word/phrase, 'prefix' = long phrase at the start of a word plus an ending. */
function phraseFoundIn(haystack, needle) {
  if (!haystack || !needle || haystack === needle) return null;
  if (containsWholePhrase(haystack, needle)) return 'word';
  if (needle.length >= 5 && wordsOf(haystack).some((word) => isMorphPrefix(word, needle))) return 'prefix';
  return null;
}

function stemsEqual(a, b) {
  if (!a || !b || a === b) return false;
  const left = stemUk(a);
  const right = stemUk(b);
  return Boolean(left && right && left.length >= 3 && left === right);
}

function uniqueNorm(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const n = normalizeText(raw);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function buildSearchIndex(masterCatalog) {
  const entries = [];
  for (const [catKey, cat] of Object.entries(masterCatalog || {})) {
    const catName = categoryLabelPlain(cat.name || '');
    const labels = uniqueNorm([catKey, catName]);
    entries.push({
      category: catKey,
      subcategory: null,
      service: null,
      labels,
      phrases: uniqueNorm([...labels, ...tokenize(catName)]),
      weight: 1,
    });

    for (const [subKey, sub] of Object.entries(cat.subcats || {})) {
      const subName = sub.name || '';
      const tags = sub.tags || [];
      const itemNames = (sub.items || []).map((i) => i.name || '');
      const labels = uniqueNorm([subKey, subName, ...tags, ...itemNames]);
      const phrases = uniqueNorm([
        ...labels,
        ...tokenize(subName),
        ...tags.flatMap((tag) => tokenize(tag)),
        ...itemNames.flatMap((name) => tokenize(name)),
      ]);
      entries.push({
        category: catKey,
        subcategory: subKey,
        service: null,
        labels,
        phrases,
        weight: 2,
      });

      (sub.items || []).forEach((item) => {
        const itemName = item.name || '';
        const itemLabels = uniqueNorm([itemName]);
        entries.push({
          category: catKey,
          subcategory: subKey,
          service: item.name,
          labels: itemLabels,
          phrases: uniqueNorm([...itemLabels, ...tokenize(itemName)]),
          weight: 3,
        });
      });
    }
  }
  return entries;
}

function scoreEntry(query, queryTokens, entry) {
  let score = 0;
  let exact = false;
  const q = query;
  const weight = entry.weight;

  if ((entry.labels || []).includes(q)) {
    score += 8 * weight;
    exact = true;
  }

  for (const phrase of entry.phrases) {
    if (!phrase || phrase === q || phrase.length < 3) continue;
    const inQuery = phraseFoundIn(q, phrase);
    if (inQuery === 'word') score += 4 * weight;
    else if (inQuery === 'prefix') score += 3 * weight;
    const queryInPhrase = phraseFoundIn(phrase, q);
    if (queryInPhrase === 'word') score += 3 * weight;
    else if (queryInPhrase === 'prefix') score += 2 * weight;
  }

  for (const token of queryTokens) {
    if (token.length < 3) continue;
    let added = 0;
    const cap = 3 * weight;
    for (const phrase of entry.phrases) {
      if (!phrase || added >= cap) break;
      let gain = 0;
      if (phrase === token || wordsOf(phrase).includes(token)) gain = 2 * weight;
      else if (wordsOf(phrase).some((word) => stemsEqual(token, word))) gain = 2 * weight;
      else if (phraseFoundIn(phrase, token) === 'word') gain = 1 * weight;
      else if (phraseFoundIn(token, phrase) === 'prefix') gain = 1 * weight;
      if (!gain) continue;
      const take = Math.min(gain, cap - added);
      score += take;
      added += take;
    }
  }

  return { score, exact };
}

function suggestionType(entry) {
  if (entry.service) return 'service';
  if (entry.subcategory) return 'subcategory';
  return 'category';
}

function toSuggestion(entry, score, source) {
  return {
    type: suggestionType(entry),
    category: entry.category,
    subcategory: entry.subcategory || null,
    service: entry.service || null,
    score: Number(score) || 0,
    source: source || 'local',
  };
}

function localRankSearch(text, masterCatalog, limit = 8) {
  const query = normalizeText(text);
  if (!query) return [];

  const queryTokens = expandQueryTokens(query);
  const index = buildSearchIndex(masterCatalog);
  const scored = [];

  for (const entry of index) {
    const { score, exact } = scoreEntry(query, queryTokens, entry);
    if (score <= 0) continue;
    const suggestion = toSuggestion(entry, score, 'local');
    suggestion.exact = exact;
    scored.push(suggestion);
  }

  scored.sort((a, b) => b.score - a.score || String(a.service || '').localeCompare(String(b.service || ''), 'uk'));
  return dedupeSuggestions(scored).slice(0, limit);
}

function localParseSearch(text, masterCatalog) {
  const ranked = localRankSearch(text, masterCatalog, 1);
  if (!ranked.length) {
    return { category: null, subcategory: null, service: null, confidence: 0, source: 'local' };
  }
  const best = ranked[0];
  return {
    category: best.category,
    subcategory: best.subcategory,
    service: best.service,
    confidence: best.score,
    source: 'local',
  };
}

function suggestionKey(item) {
  return [item.type, item.category, item.subcategory || '', item.service || ''].join('|');
}

function dedupeSuggestions(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    if (!item?.category) continue;
    const key = suggestionKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function compactCatalogForPrompt(masterCatalog) {
  const out = {};
  for (const [catKey, cat] of Object.entries(masterCatalog || {})) {
    out[catKey] = { name: cat.name, subcats: {} };
    for (const [subKey, sub] of Object.entries(cat.subcats || {})) {
      out[catKey].subcats[subKey] = {
        name: sub.name,
        tags: sub.tags || [],
        services: (sub.items || []).map((i) => i.name),
      };
    }
  }
  return out;
}

function matchCatalogServices(masterCatalog, category, subcategory, rawServices) {
  const items = masterCatalog?.[category]?.subcats?.[subcategory]?.items || [];
  if (!items.length) return [];
  const incoming = Array.isArray(rawServices)
    ? rawServices
    : rawServices
      ? [rawServices]
      : [];
  const found = [];
  const seen = new Set();
  for (const raw of incoming) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const exact = items.find((i) => i.name === name);
    const fuzzy = exact || items.find((i) => String(i.name).toLowerCase() === name.toLowerCase());
    if (fuzzy && !seen.has(fuzzy.name)) {
      seen.add(fuzzy.name);
      found.push(fuzzy.name);
    }
  }
  return found.slice(0, 8);
}

function classificationFromMatch(validated, services, source, confidence) {
  if (!validated.category || !validated.subcategory) return null;
  return {
    category: validated.category,
    subcategory: validated.subcategory,
    service: services[0] || validated.service || null,
    services,
    confidence,
    source,
  };
}

function validateResult(result, masterCatalog) {
  if (!result?.category || !masterCatalog[result.category]) {
    return { category: null, subcategory: null, service: null };
  }
  const cat = masterCatalog[result.category];
  let subcategory = result.subcategory || null;
  if (subcategory && !cat.subcats?.[subcategory]) subcategory = null;

  let service = result.service || null;
  if (service && subcategory) {
    const items = cat.subcats[subcategory].items || [];
    const found = items.find((i) => i.name === service);
    service = found ? found.name : null;
  } else {
    service = null;
  }

  return { category: result.category, subcategory, service };
}

function labelForSuggestion(item, masterCatalog) {
  const cat = masterCatalog?.[item.category];
  if (!cat) return '';
  if (item.type === 'category') return categoryLabelPlain(cat.name) || item.category;
  const sub = item.subcategory ? cat.subcats?.[item.subcategory] : null;
  if (item.type === 'subcategory') return sub?.name || item.subcategory;
  return item.service || '';
}

function categoryLabelPlain(name) {
  return String(name || '')
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\s]+/u, '')
    .trim() || name;
}

function enrichSuggestions(items, masterCatalog) {
  return (items || []).map((item) => ({
    ...item,
    label: item.label || labelForSuggestion(item, masterCatalog),
  }));
}

async function geminiRankSearch(text, masterCatalog, apiKey, fetchImpl) {
  const catalog = compactCatalogForPrompt(masterCatalog);
  const prompt = `Ти семантичний пошук по каталогу послуг Mapfix (Україна).
Каталог (ключі category/subcategory і точні назви services — лише з цього JSON):
${JSON.stringify(catalog)}

Запит користувача (район, якщо був, уже прибрано): "${text}"

Райони Києва — це НЕ категорії каталогу: Святошин (sviatoshyn), Борщагівка (borshchahivka), Академмістечко (akademmistechko), Коцюбинське (kotsiubynske). «Святошин» не є орендою для свят. Якщо в запиті лишилась лише назва району — {"matches":[]}.

Поверни JSON за схемою. category, subcategory і service — лише значення з enums схеми (це ключі каталогу і точні назви послуг).

Правила:
- до 8 найбільш релевантних matches, від найкращого до гіршого
- type=service лише якщо є і subcategory, і service саме цієї підкатегорії
- type=subcategory якщо є subcategory без конкретної послуги (service тоді будь-який id з тієї підкатегорії — його відкинемо)
- type=category якщо підходить лише категорія
- score — релевантність 1–10
- confidence — впевненість від 0 до 1 саме для цього match; не став 1 без сильного збігу
- синоніми: масло/масла/заміна масла → заміна мастила (auto/maintenance); ТО/техобслуговування → планове ТО (auto/maintenance); резина/покришки/продаж шин → шини (auto/tyres); постригтись → перукарня/стрижка
- якщо нічого не підходить — {"matches":[]}`;

  const parsed = await geminiGenerateJson(apiKey, {
    prompt,
    schema: buildSearchResponseSchema(masterCatalog),
    timeoutMs: 7000,
    maxOutputTokens: 900,
    temperature: 0.15,
    fetchImpl,
  });
  const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
  const suggestions = [];

  for (const m of matches) {
    const confidence = modelConfidence(m);
    if (confidence == null) continue;
    const validated = validateResult(
      {
        category: m.category,
        subcategory: m.type === 'category' ? null : m.subcategory,
        service: m.type === 'service' ? m.service : null,
      },
      masterCatalog
    );
    if (!validated.category) continue;

    let type = String(m.type || '').toLowerCase();
    if (validated.service && validated.subcategory) type = 'service';
    else if (validated.subcategory) type = 'subcategory';
    else type = 'category';

    const rankScore = Number(m.score);
    const item = toSuggestion(
      {
        category: validated.category,
        subcategory: validated.subcategory,
        service: validated.service,
      },
      Number.isFinite(rankScore) && rankScore > 0 ? rankScore : confidence,
      'gemini'
    );
    item.type = type;
    item.confidence = confidence;
    suggestions.push(item);
  }

  return enrichSuggestions(dedupeSuggestions(suggestions), masterCatalog);
}

async function geminiParseSearch(text, masterCatalog, apiKey, fetchImpl) {
  const ranked = await geminiRankSearch(text, masterCatalog, apiKey, fetchImpl);
  if (!ranked.length) {
    return { category: null, subcategory: null, service: null, confidence: 0, source: 'gemini', query: text, suggestions: [] };
  }
  const best = ranked[0];
  return {
    category: best.category,
    subcategory: best.subcategory,
    service: best.service,
    confidence: Number.isFinite(best.confidence) ? best.confidence : modelConfidence(best),
    source: 'gemini',
    query: text,
    suggestions: ranked,
  };
}

function sameBranch(a, b) {
  return a?.category === b?.category && (a?.subcategory || null) === (b?.subcategory || null);
}

/** Exact catalog name/tag, or a wide gap over every other branch. */
function localRouteIsConfident(suggestions) {
  if (!suggestions?.length) return false;
  const best = suggestions[0];
  const branchExact = suggestions.some((item) => sameBranch(item, best) && item.exact);
  const rival = suggestions.find((item) => !sameBranch(item, best));
  if (branchExact && best.score >= 8) {
    if (!rival) return true;
    if (best.score >= rival.score * 1.35) return true;
  }
  if (best.score >= 24 && (!rival || best.score >= rival.score * 1.8)) return true;
  return false;
}

const SEARCH_CACHE_MAX = 300;
const SEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SEARCH_CACHE_FALLBACK_TTL_MS = 10 * 60 * 1000;
const searchResultCache = new Map();

function searchCacheKey(query, mode) {
  return `${mode}\n${normalizeText(query)}`;
}

function readSearchCache(key) {
  const hit = searchResultCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    searchResultCache.delete(key);
    return null;
  }
  searchResultCache.delete(key);
  searchResultCache.set(key, hit);
  return hit.value;
}

function writeSearchCache(key, value, ttlMs) {
  if (searchResultCache.has(key)) searchResultCache.delete(key);
  searchResultCache.set(key, { exp: Date.now() + ttlMs, value });
  while (searchResultCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchResultCache.keys().next().value;
    searchResultCache.delete(oldest);
  }
}

function clearSearchCache() {
  searchResultCache.clear();
}

function localResultFrom(queryText, masterCatalog) {
  const localSuggestions = enrichSuggestions(localRankSearch(queryText, masterCatalog, 8), masterCatalog);
  if (!localSuggestions.length) {
    return {
      category: null,
      subcategory: null,
      service: null,
      confidence: 0,
      source: 'local',
      query: queryText,
      suggestions: [],
    };
  }
  const best = localSuggestions[0];
  return {
    category: best.category,
    subcategory: best.subcategory,
    service: best.service,
    confidence: best.score,
    source: 'local',
    query: queryText,
    suggestions: localSuggestions,
  };
}

function withArea(result, area, trimmed, router) {
  return {
    ...result,
    area: area || result.area || null,
    query: trimmed,
    router: router || result.router || (result.source === 'gemini' ? 'gemini' : 'local'),
    areaOnly: Boolean(result.areaOnly),
  };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** Same centres and radii as MAPFIX_AREAS / seo.js. */
const SEARCH_AREA_GEO = {
  sviatoshyn: { lat: 50.4574, lng: 30.3553, radiusKm: 2, re: /святошин/i },
  borshchahivka: { lat: 50.4378, lng: 30.338, radiusKm: 3.5, re: /борщагів(?:к|ц)/i },
  akademmistechko: { lat: 50.4655, lng: 30.355, radiusKm: 1.5, re: /академмістеч/i },
  kotsiubynske: { lat: 50.4906, lng: 30.3347, radiusKm: 3, re: /коцюбин/i },
};
const SEARCH_AREA_ORDER = ['sviatoshyn', 'borshchahivka', 'akademmistechko', 'kotsiubynske'];

function locationInSearchArea(loc, areaKey) {
  const selected = SEARCH_AREA_GEO[areaKey];
  if (!selected) return true;
  const address = String(loc?.address || '');
  const named = [];
  const inRadius = [];
  for (const key of SEARCH_AREA_ORDER) {
    const area = SEARCH_AREA_GEO[key];
    if (area.re.test(address)) named.push(key);
    const lat = Number(loc?.lat);
    const lng = Number(loc?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const distance = haversineKm(area.lat, area.lng, lat, lng);
    if (distance <= area.radiusKm) inRadius.push({ key, distance });
  }
  inRadius.sort((a, b) => a.distance - b.distance);
  const hits = new Set(named);
  if (inRadius.length) hits.add(inRadius[0].key);
  return hits.has(areaKey);
}

function locationOffersPrice(loc, serviceName) {
  return Boolean(loc?.prices && Object.prototype.hasOwnProperty.call(loc.prices, serviceName));
}

function locationInSubcategory(loc, catalog, category, subcategory) {
  if (!subcategory) return true;
  const subs = Array.isArray(loc?.subcats) ? loc.subcats : [];
  if (subs.includes(subcategory)) return true;
  const items = catalog?.[category]?.subcats?.[subcategory]?.items || [];
  return items.some((srv) => srv?.name && locationOffersPrice(loc, srv.name));
}

/** Exact price, or any card already in the subcategory (imported cards often have empty prices). */
function locationMatchesServiceSelection(loc, service, subcategory) {
  if (!service) return true;
  if (locationOffersPrice(loc, service)) return true;
  if (subcategory && Array.isArray(loc?.subcats) && loc.subcats.includes(subcategory)) return true;
  return false;
}

function countSearchMatches(locations, catalog, selection = {}) {
  const category = selection.category || null;
  const subcategory = selection.subcategory || null;
  const service = selection.service || null;
  const area = selection.area || null;
  return (locations || []).filter((loc) => {
    if (!loc || loc.deletedAt) return false;
    if (area && !locationInSearchArea(loc, area)) return false;
    if (category && loc.cat !== category) return false;
    if (subcategory && !locationInSubcategory(loc, catalog, category, subcategory)) return false;
    if (!locationMatchesServiceSelection(loc, service, subcategory)) return false;
    return true;
  }).length;
}

function countPricedService(locations, serviceName) {
  if (!serviceName) return 0;
  return (locations || []).filter((loc) => loc && !loc.deletedAt && locationOffersPrice(loc, serviceName)).length;
}

/** A service nobody priced should not narrow the list; the subcategory still has cards. */
function relaxUnpricedService(result, locations) {
  if (!result?.service) return result;
  if (countPricedService(locations, result.service) > 0) return result;
  return {
    ...result,
    service: null,
    suggestions: (result.suggestions || []).map((item) => {
      if (item?.service !== result.service) return item;
      return { ...item, service: null, type: item.subcategory ? 'subcategory' : item.type };
    }),
  };
}

async function parseVoiceSearch(text, masterCatalog, options = {}) {
  const trimmed = String(text || '').trim();
  const empty = {
    category: null,
    subcategory: null,
    service: null,
    confidence: 0,
    source: 'none',
    router: 'local',
    query: trimmed,
    area: null,
    areaOnly: false,
    suggestions: [],
  };
  if (!trimmed) return empty;

  const { area, rest } = extractSearchArea(trimmed);
  const queryText = String(rest || '').trim();
  if (!queryText) {
    return withArea(
      {
        category: null,
        subcategory: null,
        service: null,
        confidence: area ? 1 : 0,
        source: 'local',
        suggestions: [],
        areaOnly: Boolean(area),
      },
      area,
      trimmed,
      'local'
    );
  }

  const mode = options.routing === 'legacy' ? 'legacy' : 'ai-first';
  const cacheOn = options.cache !== false;
  const key = searchCacheKey(queryText, mode);
  if (cacheOn) {
    const cached = readSearchCache(key);
    if (cached) return withArea(cached, area, trimmed, 'cache');
  }

  const local = localResultFrom(queryText, masterCatalog);
  const apiKey = options.geminiApiKey;
  const confident = mode === 'ai-first' && localRouteIsConfident(local.suggestions);
  if (confident && local.category) {
    const result = withArea(local, area, trimmed, 'local');
    return result;
  }

  if (apiKey) {
    try {
      const gemini = await geminiParseSearch(queryText, masterCatalog, apiKey, options.fetchImpl);
      if (gemini.suggestions?.length) {
        const merged = enrichSuggestions(
          dedupeSuggestions([...(gemini.suggestions || []), ...local.suggestions]),
          masterCatalog
        );
        const best = merged[0];
        const result = withArea(
          {
            category: best.category,
            subcategory: best.subcategory,
            service: best.service,
            confidence: Number.isFinite(gemini.confidence) ? gemini.confidence : modelConfidence(best),
            source: 'gemini',
            suggestions: merged.slice(0, 8),
          },
          area,
          trimmed,
          'gemini'
        );
        if (cacheOn) {
          writeSearchCache(
            key,
            {
              category: result.category,
              subcategory: result.subcategory,
              service: result.service,
              confidence: result.confidence,
              source: 'gemini',
              suggestions: result.suggestions,
            },
            SEARCH_CACHE_TTL_MS
          );
        }
        return result;
      }
    } catch (err) {
      console.warn('[search-ai] Gemini fallback:', err.message);
    }
  }

  if (local.category) {
    const result = withArea(local, area, trimmed, 'local');
    if (cacheOn && apiKey) {
      writeSearchCache(
        key,
        {
          category: result.category,
          subcategory: result.subcategory,
          service: result.service,
          confidence: result.confidence,
          source: 'local',
          suggestions: result.suggestions,
        },
        SEARCH_CACHE_FALLBACK_TTL_MS
      );
    }
    return result;
  }

  return withArea(empty, area, trimmed, 'local');
}

async function suggestCatalogForPlace(place, masterCatalog, options = {}) {
  const title = String(place?.title || '').trim();
  const address = String(place?.address || '').trim();
  const types = Array.isArray(place?.types) ? place.types.join(', ') : '';
  const summary = String(place?.summary || place?.text || '').trim();
  const query = [title, types, summary, address].filter(Boolean).join(' — ');
  const result = await parseVoiceSearch(query, masterCatalog, {
    ...options,
    routing: options.routing || 'legacy',
  });
  return {
    category: result.category,
    subcategory: result.subcategory,
    service: result.service,
    confidence: result.confidence,
    source: result.source,
    query,
  };
}

/**
 * Batch-classify places for city import. Returns only matches that fit masterCatalog.
 * Gemini may set category=null to reject grocery/bank/restaurant/etc.
 */
async function classifyPlacesForImport(places, masterCatalog, options = {}) {
  const list = Array.isArray(places) ? places : [];
  const out = new Array(list.length).fill(null);
  const needGemini = [];

  for (let i = 0; i < list.length; i++) {
    const place = list[i];
    const query = [place?.title, place?.types?.join?.(', '), place?.summary || place?.text, place?.address]
      .filter(Boolean)
      .join(' — ');
    const local = localParseSearch(query, masterCatalog);
    if (local.category && local.subcategory && local.confidence >= 6) {
      const services = matchCatalogServices(
        masterCatalog,
        local.category,
        local.subcategory,
        local.service ? [local.service] : []
      );
      out[i] = classificationFromMatch(
        { category: local.category, subcategory: local.subcategory, service: local.service || null },
        services,
        'local',
        local.confidence
      );
    } else {
      needGemini.push({ i, place, query, local });
    }
  }

  const apiKey = options.geminiApiKey;
  if (apiKey && needGemini.length) {
    const catalog = compactCatalogForPrompt(masterCatalog);
    const chunkSize = 10;
    for (let offset = 0; offset < needGemini.length; offset += chunkSize) {
      const chunk = needGemini.slice(offset, offset + chunkSize);
      const lines = chunk
        .map((row, idx) => {
          const hint =
            row.place?.hintCat || row.place?.hintSub
              ? `hint:${row.place.hintCat || ''}/${row.place.hintSub || ''}`
              : '';
          return `${idx}. ${row.place?.title || '—'} | ${row.place?.address || ''} | ${(row.place?.types || []).slice(0, 4).join(', ')} | ${hint}`;
        })
        .join('\n');
      const prompt = `Ти класифікатор закладів для українського каталогу послуг Mapfix.
Каталог (ключі category/subcategory і точні назви services):
${JSON.stringify(catalog)}

Заклади:
${lines}

Поверни JSON за схемою. category, subcategory і services — лише enums схеми.

Правила:
- i — індекс рядка в списку вище (0..${chunk.length - 1})
- accepted=false якщо заклад НЕ надає послуг з каталогу (магазин продуктів, аптека, банк, АЗС без СТО, кафе/ресторан, школа загальна без курсів)
- accepted=true лише коли є і category, і subcategory
- services — точні назви послуг цієї підкатегорії (0–6). Порожній масив, якщо конкретні послуги неясні
- confidence — число від 0 до 1, наскільки впевнений саме в цій відповіді
- hint: можна врахувати як підказку пошуку, але не копіюй сліпо, якщо тип закладу інший`;

      try {
        const parsed = await geminiGenerateJson(apiKey, {
          prompt,
          schema: buildImportBatchResponseSchema(masterCatalog),
          timeoutMs: 25000,
          maxOutputTokens: 2000,
          temperature: 0.1,
        });
        const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
        for (const m of matches) {
          if (m.accepted === false) continue;
          const idxInChunk = Number(m.i);
          if (!Number.isInteger(idxInChunk) || idxInChunk < 0 || idxInChunk >= chunk.length) continue;
          const validated = validateResult(
            { category: m.category, subcategory: m.subcategory, service: null },
            masterCatalog
          );
          const globalIdx = chunk[idxInChunk].i;
          const services = matchCatalogServices(
            masterCatalog,
            validated.category,
            validated.subcategory,
            m.services || m.service
          );
          const confidence = modelConfidence(m);
          out[globalIdx] = classificationFromMatch(
            validated,
            services,
            'gemini',
            confidence == null ? 0 : confidence
          );
        }
      } catch (err) {
        console.warn('[search-ai] classifyPlacesForImport chunk:', err.message);
        for (const row of chunk) {
          if (out[row.i]) continue;
          if (row.local?.category && row.local?.subcategory && row.local.confidence >= 4) {
            const services = matchCatalogServices(
              masterCatalog,
              row.local.category,
              row.local.subcategory,
              row.local.service ? [row.local.service] : []
            );
            out[row.i] = classificationFromMatch(
              {
                category: row.local.category,
                subcategory: row.local.subcategory,
                service: row.local.service || null,
              },
              services,
              'local_fallback',
              row.local.confidence
            );
          }
        }
      }
    }
  } else {
    for (const row of needGemini) {
      if (row.local?.category && row.local?.subcategory && row.local.confidence >= 4) {
        const services = matchCatalogServices(
          masterCatalog,
          row.local.category,
          row.local.subcategory,
          row.local.service ? [row.local.service] : []
        );
        out[row.i] = classificationFromMatch(
          {
            category: row.local.category,
            subcategory: row.local.subcategory,
            service: row.local.service || null,
          },
          services,
          'local',
          row.local.confidence
        );
      }
    }
  }

  return out;
}

module.exports = {
  parseVoiceSearch,
  suggestCatalogForPlace,
  classifyPlacesForImport,
  localParseSearch,
  localRankSearch,
  buildSearchIndex,
  matchCatalogServices,
  extractSearchArea,
  countSearchMatches,
  relaxUnpricedService,
  clearSearchCache,
  stemUk,
  GEMINI_MODELS,
  modelConfidence,
  geminiGenerateJson,
  buildSearchResponseSchema,
  buildImportBatchResponseSchema,
};
