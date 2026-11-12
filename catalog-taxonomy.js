'use strict';

/**
 * Exact taxonomy keys used as Gemini responseSchema enums.
 * Service identity is item.id or item.key when present, otherwise the
 * service name (the catalog has no separate service id today).
 */

function serviceIdOf(item) {
  const id = String(item?.id || item?.key || item?.name || '').trim();
  return id;
}

function collectTaxonomy(masterCatalog) {
  const categories = [];
  const subcategories = [];
  const serviceIds = [];
  const seenServices = new Set();
  const subcatToCategory = {};
  const servicesBySubcat = {};

  for (const [catKey, cat] of Object.entries(masterCatalog || {})) {
    if (!cat || typeof cat !== 'object') continue;
    categories.push(catKey);
    for (const [subKey, sub] of Object.entries(cat.subcats || {})) {
      subcategories.push(subKey);
      if (!subcatToCategory[subKey]) subcatToCategory[subKey] = catKey;
      const ids = [];
      for (const item of sub.items || []) {
        const id = serviceIdOf(item);
        if (!id) continue;
        ids.push(id);
        if (!seenServices.has(id)) {
          seenServices.add(id);
          serviceIds.push(id);
        }
      }
      servicesBySubcat[`${catKey}/${subKey}`] = ids;
    }
  }

  return {
    categories,
    subcategories,
    serviceIds,
    subcatToCategory,
    servicesBySubcat,
  };
}

function geminiNode(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(geminiNode);
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toUpperCase();
    } else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = {};
      for (const [prop, schema] of Object.entries(value)) {
        out.properties[prop] = geminiNode(schema);
      }
    } else if (key === 'items') {
      out.items = geminiNode(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function enumString(values) {
  return { type: 'string', enum: values.slice() };
}

/**
 * Search matches. Enums are exactly the catalog keys / service ids.
 * type tells the caller which of those fields to keep.
 */
function buildSearchResponseSchema(masterCatalog) {
  const tax = collectTaxonomy(masterCatalog);
  return geminiNode({
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['service', 'subcategory', 'category'] },
            category: enumString(tax.categories),
            subcategory: enumString(tax.subcategories),
            service: enumString(tax.serviceIds),
            score: { type: 'number' },
            confidence: { type: 'number' },
          },
          required: ['type', 'category', 'subcategory', 'service', 'score', 'confidence'],
        },
      },
    },
    required: ['matches'],
  });
}

/** One-place import classifier. Enums are exactly the catalog keys / service ids. */
function buildClassifyResponseSchema(masterCatalog) {
  const tax = collectTaxonomy(masterCatalog);
  return geminiNode({
    type: 'object',
    properties: {
      accepted: { type: 'boolean' },
      category: enumString(tax.categories),
      subcategory: enumString(tax.subcategories),
      services: { type: 'array', items: enumString(tax.serviceIds) },
      confidence: { type: 'number' },
      reasoning: { type: 'string' },
    },
    required: ['accepted', 'category', 'subcategory', 'services', 'confidence', 'reasoning'],
  });
}

function buildVerifyResponseSchema(masterCatalog) {
  const tax = collectTaxonomy(masterCatalog);
  return geminiNode({
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['accept', 'reject', 'unsure'] },
      category: enumString(tax.categories),
      subcategory: enumString(tax.subcategories),
      services: { type: 'array', items: enumString(tax.serviceIds) },
      confidence: { type: 'number' },
      reasoning: { type: 'string' },
    },
    required: ['decision', 'category', 'subcategory', 'services', 'confidence', 'reasoning'],
  });
}

/** Batch classifier used by the existing city import. */
function buildImportBatchResponseSchema(masterCatalog) {
  const tax = collectTaxonomy(masterCatalog);
  return geminiNode({
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            i: { type: 'integer' },
            accepted: { type: 'boolean' },
            category: enumString(tax.categories),
            subcategory: enumString(tax.subcategories),
            services: { type: 'array', items: enumString(tax.serviceIds) },
            confidence: { type: 'number' },
          },
          required: ['i', 'accepted', 'category', 'subcategory', 'services', 'confidence'],
        },
      },
    },
    required: ['matches'],
  });
}

module.exports = {
  serviceIdOf,
  collectTaxonomy,
  buildSearchResponseSchema,
  buildClassifyResponseSchema,
  buildVerifyResponseSchema,
  buildImportBatchResponseSchema,
};
