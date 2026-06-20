'use strict';

const LOCAL_CONFIDENCE_THRESHOLD = 4;

function normalizeText(text) {
  return String(text)
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function localParseSearch(text, masterCatalog) {
  const query = normalizeText(text);
  if (!query) return { category: null, subcategory: null, service: null, confidence: 0, source: 'local' };

  const queryTokens = tokenize(query);
  const index = buildSearchIndex(masterCatalog);
  let best = { category: null, subcategory: null, service: null, confidence: 0, source: 'local' };

  for (const entry of index) {
    const score = scoreEntry(query, queryTokens, entry);
    if (score > best.confidence) {
      best = {
        category: entry.category,
        subcategory: entry.subcategory,
        service: entry.service,
        confidence: score,
        source: 'local',
      };
    }
  }

  return best;
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

async function geminiParseSearch(text, masterCatalog, apiKey) {
  const catalog = compactCatalogForPrompt(masterCatalog);
  const prompt = `Ти парсер голосового пошуку для українського каталогу послуг Mapfix.
Каталог (ключі category/subcategory — лише з цього JSON):
${JSON.stringify(catalog)}

Запит користувача: "${text}"

Поверни ТІЛЬКИ валідний JSON без markdown:
{"category":"ключ_категорії","subcategory":"ключ_підкатегорії або null","service":"назва послуги або null"}

Правила:
- category і subcategory — тільки існуючі ключі з каталогу
- якщо не впевнений — найближча відповідність за змістом
- service — точна назва з каталогу або null`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

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
            maxOutputTokens: 120,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const raw =
      data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
    const parsed = JSON.parse(raw);
    const validated = validateResult(parsed, masterCatalog);
    return { ...validated, confidence: 10, source: 'gemini', query: text };
  } finally {
    clearTimeout(timer);
  }
}

async function parseVoiceSearch(text, masterCatalog, options = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return { category: null, subcategory: null, service: null, confidence: 0, source: 'none', query: '' };
  }

  const local = localParseSearch(trimmed, masterCatalog);
  local.query = trimmed;

  if (local.confidence >= LOCAL_CONFIDENCE_THRESHOLD) {
    return {
      category: local.category,
      subcategory: local.subcategory,
      service: local.service,
      confidence: local.confidence,
      source: 'local',
      query: trimmed,
    };
  }

  const apiKey = options.geminiApiKey;
  if (apiKey) {
    try {
      const gemini = await geminiParseSearch(trimmed, masterCatalog, apiKey);
      if (gemini.category) return gemini;
    } catch (err) {
      console.warn('[search-ai] Gemini fallback:', err.message);
    }
  }

  if (local.category) {
    return {
      category: local.category,
      subcategory: local.subcategory,
      service: local.service,
      confidence: local.confidence,
      source: 'local',
      query: trimmed,
    };
  }

  return { category: null, subcategory: null, service: null, confidence: 0, source: 'none', query: trimmed };
}

module.exports = {
  parseVoiceSearch,
  localParseSearch,
  buildSearchIndex,
};
