'use strict';

const {
  buildClassifyResponseSchema,
  buildVerifyResponseSchema,
  collectTaxonomy,
} = require('./catalog-taxonomy.js');
const { GEMINI_MODELS, geminiGenerateJson, modelConfidence, matchCatalogServices } = require('./search-ai.js');

const CONFIDENCE_REJECT_BELOW = 0.55;
const CONFIDENCE_AUTO_STAGE = 0.8;

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

async function classifyPlace(place, masterCatalog, apiKey) {
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

  const parsed = await geminiGenerateJson(apiKey, {
    prompt,
    schema,
    timeoutMs: 20000,
    maxOutputTokens: 700,
    temperature: 0.1,
    models: GEMINI_MODELS,
  });
  return normalizeProposal(parsed, masterCatalog);
}

async function verifyPlace(place, proposal, masterCatalog, apiKey) {
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

  const parsed = await geminiGenerateJson(apiKey, {
    prompt,
    schema,
    timeoutMs: 20000,
    maxOutputTokens: 500,
    temperature: 0.1,
    models: GEMINI_MODELS,
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
  classifyPlace,
  verifyPlace,
  gateClassification,
  normalizeProposal,
};
