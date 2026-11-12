'use strict';

const {
  buildSearchResponseSchema,
  buildImportBatchResponseSchema,
} = require('./catalog-taxonomy.js');

function normalizeText(text) {
  return String(text)
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Розмовні запити → слова, які є в каталозі */
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
};

function expandQueryTokens(text) {
  const base = tokenize(text);
  const extra = [];
  const norm = normalizeText(text);
  for (const [phrase, words] of Object.entries(QUERY_SYNONYMS)) {
    if (norm.includes(phrase) || base.includes(phrase)) {
      extra.push(...words.map(normalizeText));
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
  { prompt, schema, timeoutMs = 12000, maxOutputTokens = 800, temperature = 0.15, models = GEMINI_MODELS } = {}
) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  let lastError = null;
  for (const model of models) {
    const modes = schema ? ['schema', 'plain'] : ['plain'];
    let skipModel = false;
    for (const mode of modes) {
      if (skipModel) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const generationConfig = {
          temperature,
          maxOutputTokens,
          responseMimeType: 'application/json',
        };
        if (mode === 'schema') generationConfig.responseSchema = schema;
        const res = await fetch(
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
        if (err.name === 'AbortError') {
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
  throw lastError || new Error('Gemini unavailable');
}

function tokenize(text) {
  return normalizeText(text)
    .split(' ')
    .filter((w) => w.length > 1);
}

function buildSearchIndex(masterCatalog) {
  const entries = [];
  for (const [catKey, cat] of Object.entries(masterCatalog || {})) {
    const catName = normalizeText(cat.name || '');
    entries.push({
      category: catKey,
      subcategory: null,
      service: null,
      phrases: [catKey, catName, ...tokenize(catName)],
      weight: 1,
    });

    for (const [subKey, sub] of Object.entries(cat.subcats || {})) {
      const subName = normalizeText(sub.name || '');
      const tags = (sub.tags || []).map(normalizeText);
      const items = (sub.items || []).map((i) => normalizeText(i.name || ''));

      entries.push({
        category: catKey,
        subcategory: subKey,
        service: null,
        phrases: [subKey, subName, ...tokenize(subName), ...tags, ...items],
        weight: 2,
      });

      (sub.items || []).forEach((item) => {
        const itemName = normalizeText(item.name || '');
        entries.push({
          category: catKey,
          subcategory: subKey,
          service: item.name,
          phrases: [itemName, ...tokenize(itemName)],
          weight: 3,
        });
      });
    }
  }
  return entries;
}

function scoreEntry(query, queryTokens, entry) {
  let score = 0;
  const q = query;

  for (const phrase of entry.phrases) {
    if (!phrase) continue;
    if (phrase === q) score += 8 * entry.weight;
    else if (q.includes(phrase) && phrase.length >= 3) score += 4 * entry.weight;
    else if (phrase.includes(q) && q.length >= 3) score += 3 * entry.weight;
  }

  for (const token of queryTokens) {
    if (token.length < 3) continue;
    for (const phrase of entry.phrases) {
      if (!phrase) continue;
      if (phrase === token) score += 2 * entry.weight;
      else if (phrase.includes(token)) score += 1 * entry.weight;
      else if (token.includes(phrase) && phrase.length >= 4) score += 1 * entry.weight;
    }
  }

  return score;
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
    const score = scoreEntry(query, queryTokens, entry);
    if (score <= 0) continue;
    scored.push(toSuggestion(entry, score, 'local'));
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

async function geminiRankSearch(text, masterCatalog, apiKey) {
  const catalog = compactCatalogForPrompt(masterCatalog);
  const prompt = `Ти семантичний пошук по каталогу послуг Mapfix (Україна).
Каталог (ключі category/subcategory і точні назви services — лише з цього JSON):
${JSON.stringify(catalog)}

Запит користувача: "${text}"

Поверни JSON за схемою. category, subcategory і service — лише значення з enums схеми (це ключі каталогу і точні назви послуг).

Правила:
- до 8 найбільш релевантних matches, від найкращого до гіршого
- type=service лише якщо є і subcategory, і service саме цієї підкатегорії
- type=subcategory якщо є subcategory без конкретної послуги (service тоді будь-який id з тієї підкатегорії — його відкинемо)
- type=category якщо підходить лише категорія
- score — релевантність 1–10
- confidence — впевненість від 0 до 1 саме для цього match; не став 1 без сильного збігу
- враховуй синоніми й розмовні формулювання українською (напр. "постригтись" → перукарня/стрижка)
- якщо нічого не підходить — {"matches":[]}`;

  const parsed = await geminiGenerateJson(apiKey, {
    prompt,
    schema: buildSearchResponseSchema(masterCatalog),
    timeoutMs: 7000,
    maxOutputTokens: 900,
    temperature: 0.15,
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

async function geminiParseSearch(text, masterCatalog, apiKey) {
  const ranked = await geminiRankSearch(text, masterCatalog, apiKey);
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

async function parseVoiceSearch(text, masterCatalog, options = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return {
      category: null,
      subcategory: null,
      service: null,
      confidence: 0,
      source: 'none',
      query: '',
      suggestions: [],
    };
  }

  const localSuggestions = enrichSuggestions(localRankSearch(trimmed, masterCatalog, 8), masterCatalog);
  const local = localSuggestions[0]
    ? {
        category: localSuggestions[0].category,
        subcategory: localSuggestions[0].subcategory,
        service: localSuggestions[0].service,
        confidence: localSuggestions[0].score,
        source: 'local',
        query: trimmed,
        suggestions: localSuggestions,
      }
    : {
        category: null,
        subcategory: null,
        service: null,
        confidence: 0,
        source: 'local',
        query: trimmed,
        suggestions: [],
      };

  const apiKey = options.geminiApiKey;
  if (apiKey) {
    try {
      const gemini = await geminiParseSearch(trimmed, masterCatalog, apiKey);
      if (gemini.suggestions?.length) {
        // Gemini першим, локальні як доповнення
        const merged = enrichSuggestions(
          dedupeSuggestions([...(gemini.suggestions || []), ...localSuggestions]),
          masterCatalog
        );
        const best = merged[0];
        return {
          category: best.category,
          subcategory: best.subcategory,
          service: best.service,
          confidence: Number.isFinite(gemini.confidence) ? gemini.confidence : modelConfidence(best),
          source: 'gemini',
          query: trimmed,
          suggestions: merged.slice(0, 8),
        };
      }
    } catch (err) {
      console.warn('[search-ai] Gemini fallback:', err.message);
    }
  }

  if (local.category) return local;

  return {
    category: null,
    subcategory: null,
    service: null,
    confidence: 0,
    source: 'none',
    query: trimmed,
    suggestions: [],
  };
}

async function suggestCatalogForPlace(place, masterCatalog, options = {}) {
  const title = String(place?.title || '').trim();
  const address = String(place?.address || '').trim();
  const types = Array.isArray(place?.types) ? place.types.join(', ') : '';
  const summary = String(place?.summary || place?.text || '').trim();
  const query = [title, types, summary, address].filter(Boolean).join(' — ');
  const result = await parseVoiceSearch(query, masterCatalog, options);
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
  GEMINI_MODELS,
  modelConfidence,
  geminiGenerateJson,
  buildSearchResponseSchema,
  buildImportBatchResponseSchema,
};
