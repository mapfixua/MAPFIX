'use strict';

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

const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-flash'];

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

Поверни ТІЛЬКИ валідний JSON без markdown:
{"matches":[{"type":"service|subcategory|category","category":"ключ","subcategory":"ключ_або_null","service":"точна_назва_або_null","score":1-10}]}

Правила:
- до 8 найбільш релевантних matches, від найкращого до гіршого
- category/subcategory — ТІЛЬКИ існуючі ключі з каталогу
- service — ТІЛЬКИ точна назва з services у відповідній підкатегорії, або null
- type=service лише якщо є і subcategory, і service
- type=subcategory якщо є subcategory без конкретної послуги
- type=category якщо підходить лише категорія
- враховуй синоніми й розмовні формулювання українською (напр. "постригтись" → перукарня/стрижка)
- якщо нічого не підходить — {"matches":[]}`;

  let lastError = null;

  for (const model of GEMINI_MODELS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.15,
              maxOutputTokens: 700,
              responseMimeType: 'application/json',
            },
          }),
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        lastError = new Error(`Gemini ${res.status} (${model}): ${errText.slice(0, 200)}`);
        if (res.status === 429 || res.status === 404) continue;
        throw lastError;
      }

      const data = await res.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
      const parsed = JSON.parse(raw);
      const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
      const suggestions = [];

      for (const m of matches) {
        const validated = validateResult(
          {
            category: m.category,
            subcategory: m.subcategory,
            service: m.service,
          },
          masterCatalog
        );
        if (!validated.category) continue;

        let type = String(m.type || '').toLowerCase();
        if (validated.service && validated.subcategory) type = 'service';
        else if (validated.subcategory) type = 'subcategory';
        else type = 'category';

        const item = toSuggestion(
          {
            category: validated.category,
            subcategory: validated.subcategory,
            service: validated.service,
          },
          Number(m.score) || 8,
          'gemini'
        );
        item.type = type;
        suggestions.push(item);
      }

      return enrichSuggestions(dedupeSuggestions(suggestions), masterCatalog);
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') continue;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('Gemini unavailable');
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
    confidence: best.score || 10,
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
          confidence: best.score || gemini.confidence || 10,
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
      out[i] = {
        category: local.category,
        subcategory: local.subcategory,
        service: local.service || null,
        confidence: local.confidence,
        source: 'local',
      };
    } else {
      needGemini.push({ i, place, query, local });
    }
  }

  const apiKey = options.geminiApiKey;
  if (apiKey && needGemini.length) {
    const catalog = compactCatalogForPrompt(masterCatalog);
    const chunkSize = 12;
    for (let offset = 0; offset < needGemini.length; offset += chunkSize) {
      const chunk = needGemini.slice(offset, offset + chunkSize);
      const lines = chunk
        .map(
          (row, idx) =>
            `${idx}. ${row.place?.title || '—'} | ${row.place?.address || ''} | ${(row.place?.types || []).slice(0, 4).join(', ')}`
        )
        .join('\n');
      const prompt = `Ти класифікатор закладів для українського каталогу послуг Mapfix.
Каталог (лише ці ключі category/subcategory):
${JSON.stringify(catalog)}

Заклади:
${lines}

Поверни ТІЛЬКИ JSON:
{"matches":[{"i":0,"category":"ключ_або_null","subcategory":"ключ_або_null"}]}

Правила:
- i — індекс рядка в списку вище (0..${chunk.length - 1})
- category/subcategory — ТІЛЬКИ ключі з каталогу
- якщо заклад НЕ надає послуг з каталогу (магазин продуктів, аптека, банк, АЗС без СТО, кафе/ресторан, школа загальна без курсів тощо) — category: null
- якщо впевнений у категорії, але не в підкатегорії — subcategory: null (такі відсіємо)
- потрібна і category, і subcategory для прийняття`;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        let data;
        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: controller.signal,
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                  temperature: 0.1,
                  maxOutputTokens: 1200,
                  responseMimeType: 'application/json',
                },
              }),
            }
          );
          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
          }
          data = await res.json();
        } finally {
          clearTimeout(timer);
        }

        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
        const parsed = JSON.parse(raw);
        const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
        for (const m of matches) {
          const idxInChunk = Number(m.i);
          if (!Number.isInteger(idxInChunk) || idxInChunk < 0 || idxInChunk >= chunk.length) continue;
          const validated = validateResult(
            { category: m.category, subcategory: m.subcategory, service: null },
            masterCatalog
          );
          const globalIdx = chunk[idxInChunk].i;
          if (validated.category && validated.subcategory) {
            out[globalIdx] = {
              ...validated,
              confidence: 10,
              source: 'gemini',
            };
          } else {
            out[globalIdx] = null;
          }
        }
      } catch (err) {
        console.warn('[search-ai] classifyPlacesForImport chunk:', err.message);
        // Fallback: accept strong local matches from this chunk
        for (const row of chunk) {
          if (out[row.i]) continue;
          if (row.local?.category && row.local?.subcategory && row.local.confidence >= 4) {
            out[row.i] = {
              category: row.local.category,
              subcategory: row.local.subcategory,
              service: row.local.service || null,
              confidence: row.local.confidence,
              source: 'local_fallback',
            };
          }
        }
      }
    }
  } else {
    for (const row of needGemini) {
      if (row.local?.category && row.local?.subcategory && row.local.confidence >= 4) {
        out[row.i] = {
          category: row.local.category,
          subcategory: row.local.subcategory,
          service: row.local.service || null,
          confidence: row.local.confidence,
          source: 'local',
        };
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
};
