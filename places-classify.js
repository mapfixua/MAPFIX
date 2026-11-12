'use strict';

const {
  buildClassifyResponseSchema,
  buildVerifyResponseSchema,
  collectTaxonomy,
} = require('./catalog-taxonomy.js');
const { GEMINI_MODELS, geminiGenerateJson, modelConfidence, matchCatalogServices } = require('./search-ai.js');
const { looksLikeBakery } = require('./places-waves.js');

const CONFIDENCE_REJECT_BELOW = 0.55;
const CONFIDENCE_AUTO_STAGE = 0.8;
const KEYWORD_DRAFT_CONFIDENCE = 0.5;
const CLASSIFIER_ATTEMPTS = 3;
const CLASSIFIER_BACKOFF_MS = [400, 1200];

const KEYWORD_HINTS = [
  { cat: 'home', sub: 'plumber', types: ['plumber'], words: [/сантех/i, /plumber/i] },
  { cat: 'home', sub: 'ac_climate', types: [], words: [/кондиціонер/i] },
  { cat: 'medical', sub: 'dentistry', types: ['dentist', 'dental_clinic'], words: [/стомат/i, /dentist/i] },
  { cat: 'repair', sub: 'phones', types: [], words: [/ремонт\s+телефон/i, /phone\s+repair/i] },
  { cat: 'repair', sub: 'computers', types: [], words: [/ремонт\s+комп/i, /ремонт\s+ноутбук/i] },
  { cat: 'pets', sub: 'vet', types: ['veterinary_care'], words: [/ветеринар/i, /ветклін/i] },
  { cat: 'food', sub: 'bakery', types: ['bakery'], words: [/пекар/i, /bakery/i] },
];

function servicesFor(masterCatalog, category, subcategory, rawServices) {
  return matchCatalogServices(masterCatalog, category, subcategory, rawServices);
}

function normalizeProposal(raw, masterCatalog) {
  const tax = collectTaxonomy(masterCatalog);
  const category = tax.categories.includes(raw?.category) ? raw.category : null;
  const subcategory =
    category && tax.subcategories.includes(raw?.subcategory) && masterCatalog?.[category]?.subcats?.[raw.subcategory]
      ? raw.subcategory
      : null;
  const services = subcategory ? servicesFor(masterCatalog, category, subcategory, raw?.services) : [];
  return {
    accepted: raw?.accepted !== false && Boolean(category && subcategory),
    category,
    subcategory,
    services,
    confidence: modelConfidence(raw),
    reasoning: String(raw?.reasoning || '').slice(0, 500),
  };
}

function classifierHttpStatus(err) {
  const value = Number(err?.status ?? err?.httpStatus);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function classifierErrorText(err) {
  return String(err?.message || '')
    .replace(/AIza[0-9A-Za-z\-_]{8,}/g, '[redacted]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 240);
}

function isClassifierQuotaError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'classifier_quota') return true;
  const message = String(err.message || '');
  if (/exceeded your current quota/i.test(message)) return true;
  if (classifierHttpStatus(err) === 429) return true;
  if (/RESOURCE_EXHAUSTED/i.test(message)) return true;
  return false;
}

function isClassifierTransientError(err) {
  if (!err || isClassifierQuotaError(err)) return false;
  const status = classifierHttpStatus(err);
  if (status === 502 || status === 503 || status === 504) return true;
  const message = String(err.message || '');
  if (err.name === 'AbortError' || /operation was aborted/i.test(message)) return true;
  if (/\b503\b/.test(message) && /gemini|unavailable/i.test(message)) return true;
  return false;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 503 and timeouts are retried twice (three attempts) with a short backoff.
 * Daily quota (HTTP 429) is not retried. `deferred` means the clock ran out
 * before another attempt, so the caller should resume later.
 */
async function withClassifierRetries(fn, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || CLASSIFIER_ATTEMPTS);
  const backoff = Array.isArray(options.backoffMs) ? options.backoffMs : CLASSIFIER_BACKOFF_MS;
  const sleep = options.sleep || defaultSleep;
  const now = options.now || (() => Date.now());
  const deadline = Number.isFinite(options.deadlineAt) ? options.deadlineAt : null;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (deadline != null && now() >= deadline) {
      return { ok: false, deferred: true, error: lastError };
    }
    try {
      const remaining = deadline == null ? 20000 : Math.max(0, deadline - now());
      const timeoutMs = deadline == null ? 20000 : Math.min(20000, Math.max(1000, remaining));
      const value = await fn({ timeoutMs, attempt });
      return { ok: true, value };
    } catch (err) {
      lastError = err;
      if (isClassifierQuotaError(err)) return { ok: false, quota: true, error: err };
      if (!isClassifierTransientError(err)) return { ok: false, error: err };
      const left = deadline == null ? Number.POSITIVE_INFINITY : deadline - now();
      if (attempt >= attempts - 1 || left <= 0) {
        return { ok: false, transient: true, error: err };
      }
      const wait = backoff[attempt] ?? backoff[backoff.length - 1] ?? 1200;
      if (deadline != null && left < wait) {
        return { ok: false, deferred: true, transient: true, error: err };
      }
      await sleep(wait);
    }
  }
  return { ok: false, error: lastError };
}

function catalogHasSub(masterCatalog, cat, sub) {
  return Boolean(cat && sub && masterCatalog?.[cat]?.subcats?.[sub]);
}

/**
 * Cheap draft from Google types and title keywords. Confidence stays under the
 * reject threshold. Callers must not approve or publish from this alone.
 */
function suggestFromKeywords(place, masterCatalog) {
  const types = new Set((place?.types || []).map((item) => String(item || '').toLowerCase()));
  const title = `${place?.title || ''} ${place?.searchQuery || ''}`;
  for (const hint of KEYWORD_HINTS) {
    if (!catalogHasSub(masterCatalog, hint.cat, hint.sub)) continue;
    if (hint.sub === 'bakery') {
      if (!looksLikeBakery(place)) continue;
    } else {
      const typeHit = hint.types.some((type) => types.has(type));
      const wordHit = hint.words.some((pattern) => pattern.test(title));
      if (!typeHit && !wordHit) continue;
    }
    return {
      accepted: true,
      category: hint.cat,
      subcategory: hint.sub,
      services: [],
      confidence: KEYWORD_DRAFT_CONFIDENCE,
      reasoning: 'Чернетка за типом Google або ключовими словами. Потрібна класифікація Gemini.',
      source: 'keyword',
    };
  }
  return null;
}

function unclassifiedFields({ place, masterCatalog, target, dedupStatus, error, classifier }) {
  const suggestion = classifier?.category ? null : suggestFromKeywords(place, masterCatalog);
  const category = classifier?.category || suggestion?.category || target?.cat || null;
  const subcategory = classifier?.subcategory || suggestion?.subcategory || target?.sub || null;
  const reasoning = [
    suggestion && !classifier?.category ? suggestion.reasoning : '',
    classifierErrorText(error),
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 240);
  return {
    dedup_status: dedupStatus,
    status: 'needs_classify',
    needs_review: true,
    reject_reason: null,
    proposed_cat: category,
    proposed_subcats: subcategory ? [subcategory] : [],
    proposed_services: Array.isArray(classifier?.services) ? classifier.services : [],
    classifier_confidence: null,
    classifier_reasoning: reasoning,
    verification: null,
  };
}

async function classifyPlace(place, masterCatalog, apiKey, options = {}) {
  const taxHint = collectTaxonomy(masterCatalog);
  const schema = buildClassifyResponseSchema(masterCatalog);
  const prompt = `Ти класифікатор закладів для каталогу послуг Mapfix (Україна).
Обери category, subcategory і services ЛИШЕ з enums у JSON-схемі відповіді.
Ключі категорій: ${taxHint.categories.join(', ')}.

Заклад:
назва: ${place.title || ''}
адреса: ${place.address || ''}
типи Google: ${(place.types || []).slice(0, 8).join(', ')}
підказка хвилі: ${place.hintCat || ''}/${place.hintSub || ''}

Правила:
- accepted=false якщо це не послуга з каталогу (продуктовий магазин, аптека, банк, АЗС, кафе, ресторан, загальна школа)
- пекарня (випічка/хліб) — food/bakery; кафе і ресторани — accepted=false
- стоматологія — medical/dentistry; сантехнік — home/plumber; кондиціонери — home/ac_climate
- ремонт телефонів — repair/phones; ремонт компʼютерів — repair/computers; ветклініка — pets/vet
- services — точні id послуг цієї підкатегорії (0–6), не вигадуй нових
- confidence — число від 0 до 1, наскільки впевнений; не завищуй
- reasoning — одне коротке речення українською`;

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000;
  const parsed = await geminiGenerateJson(apiKey, {
    prompt,
    schema,
    timeoutMs,
    maxOutputTokens: 700,
    temperature: 0.1,
    models: GEMINI_MODELS,
    maxAborts: options.maxAborts ?? 1,
  });
  return normalizeProposal(parsed, masterCatalog);
}

async function verifyPlace(place, proposal, masterCatalog, apiKey, options = {}) {
  const schema = buildVerifyResponseSchema(masterCatalog);
  const reviews = (place.reviews || [])
    .slice(0, 3)
    .map((r) => String(r.text || '').slice(0, 180))
    .filter(Boolean)
    .join(' | ');
  const prompt = `Перевір класифікацію закладу для каталогу Mapfix.
Порівняй запропоновані category/subcategory/services з назвою, типами Google і уривком відгуків.
Enums у схемі — єдині допустимі ключі.

Заклад: ${place.title || ''}
Адреса: ${place.address || ''}
Типи Google: ${(place.types || []).slice(0, 8).join(', ')}
Статус: ${place.businessStatus || ''}
Відгуки: ${reviews || 'немає тексту'}

Запропоновано:
category=${proposal.category}
subcategory=${proposal.subcategory}
services=${(proposal.services || []).join('; ')}

decision:
- accept — категорія і послуги відповідають закладу
- reject — тип суперечить (кафе/ресторан замість пекарні, магазин, аптека, банк) або послуги чужі
- unsure — схоже, але доказів мало
confidence від 0 до 1. reasoning — одне коротке речення.`;

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000;
  const parsed = await geminiGenerateJson(apiKey, {
    prompt,
    schema,
    timeoutMs,
    maxOutputTokens: 500,
    temperature: 0.1,
    models: GEMINI_MODELS,
    maxAborts: options.maxAborts ?? 1,
  });
  const proposalLike = normalizeProposal(
    {
      accepted: parsed?.decision !== 'reject',
      category: parsed?.category || proposal.category,
      subcategory: parsed?.subcategory || proposal.subcategory,
      services: parsed?.services || proposal.services,
      confidence: parsed?.confidence,
      reasoning: parsed?.reasoning,
    },
    masterCatalog
  );
  const decision = ['accept', 'reject', 'unsure'].includes(parsed?.decision) ? parsed.decision : 'unsure';
  return {
    decision,
    category: proposalLike.category,
    subcategory: proposalLike.subcategory,
    services: proposalLike.services,
    confidence: modelConfidence(parsed),
    reasoning: String(parsed?.reasoning || '').slice(0, 500),
  };
}

/**
 * Low confidence is rejected below 0.55 and left for manual review below 0.8.
 * Both the classifier and the verifier must clear the auto-stage bar.
 */
function gateClassification({ classifier, verification, target }) {
  const classConf = Number(classifier?.confidence);
  const verifyConf = Number(verification?.confidence);
  const gating = Math.min(
    Number.isFinite(classConf) ? classConf : 0,
    Number.isFinite(verifyConf) ? verifyConf : 0
  );
  const onTarget =
    !target || (classifier?.category === target.cat && classifier?.subcategory === target.sub);
  const verifierMovedOffTarget = Boolean(
    verification &&
      verification.decision !== 'unsure' &&
      verification.category &&
      target &&
      (verification.category !== target.cat || verification.subcategory !== target.sub)
  );

  if (!classifier?.accepted || !classifier?.category || !classifier?.subcategory) {
    return { status: 'rejected', needsReview: false, reason: 'not_in_catalog', confidence: gating };
  }
  if (!onTarget) {
    return { status: 'rejected', needsReview: false, reason: 'off_target', confidence: gating };
  }
  if (verification?.decision === 'reject' || verifierMovedOffTarget) {
    return { status: 'rejected', needsReview: false, reason: 'verification_reject', confidence: gating };
  }
  if (gating < CONFIDENCE_REJECT_BELOW) {
    return { status: 'rejected', needsReview: false, reason: 'low_confidence', confidence: gating };
  }
  if (gating < CONFIDENCE_AUTO_STAGE || verification?.decision === 'unsure') {
    return { status: 'pending', needsReview: true, reason: 'manual_review', confidence: gating };
  }
  return { status: 'pending', needsReview: false, reason: null, confidence: gating };
}

module.exports = {
  CONFIDENCE_REJECT_BELOW,
  CONFIDENCE_AUTO_STAGE,
  KEYWORD_DRAFT_CONFIDENCE,
  CLASSIFIER_ATTEMPTS,
  CLASSIFIER_BACKOFF_MS,
  classifyPlace,
  verifyPlace,
  gateClassification,
  normalizeProposal,
  isClassifierQuotaError,
  isClassifierTransientError,
  classifierErrorText,
  withClassifierRetries,
  suggestFromKeywords,
  unclassifiedFields,
};
