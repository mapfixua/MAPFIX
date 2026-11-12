'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadMasterCatalog } = require('../catalog-data.js');
const { collectTaxonomy, buildSearchResponseSchema, buildClassifyResponseSchema, buildVerifyResponseSchema } = require('../catalog-taxonomy.js');
const { modelConfidence } = require('../search-ai.js');
const { gateClassification } = require('../places-classify.js');

function enumsOf(schema) {
  const found = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.enum)) found.push(node.enum);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value);
    }
  }
  walk(schema);
  return found;
}

test('Gemini schemas enumerate exactly the catalog category, subcategory and service ids', () => {
  const catalog = loadMasterCatalog();
  const tax = collectTaxonomy(catalog);
  assert.ok(tax.categories.length >= 11);
  assert.ok(tax.subcategories.length >= 80);
  assert.ok(tax.serviceIds.length >= 500);
  assert.equal(new Set(tax.categories).size, tax.categories.length);
  assert.equal(new Set(tax.subcategories).size, tax.subcategories.length);
  assert.equal(new Set(tax.serviceIds).size, tax.serviceIds.length);

  for (const schema of [
    buildSearchResponseSchema(catalog),
    buildClassifyResponseSchema(catalog),
    buildVerifyResponseSchema(catalog),
  ]) {
    const enums = enumsOf(schema);
    const flat = enums.flat();
    for (const key of tax.categories) assert.ok(flat.includes(key), key);
    for (const key of tax.subcategories) assert.ok(flat.includes(key), key);
    for (const id of tax.serviceIds) assert.ok(flat.includes(id), id);
  }

  const search = buildSearchResponseSchema(catalog);
  const props = search.properties.matches.items.properties;
  assert.deepEqual([...props.category.enum].sort(), [...tax.categories].sort());
  assert.deepEqual([...props.subcategory.enum].sort(), [...tax.subcategories].sort());
  assert.deepEqual([...props.service.enum].sort(), [...tax.serviceIds].sort());

  const classify = buildClassifyResponseSchema(catalog);
  assert.deepEqual([...classify.properties.category.enum].sort(), [...tax.categories].sort());
  assert.deepEqual([...classify.properties.subcategory.enum].sort(), [...tax.subcategories].sort());
  assert.deepEqual([...classify.properties.services.items.enum].sort(), [...tax.serviceIds].sort());

  const verify = buildVerifyResponseSchema(catalog);
  assert.deepEqual(verify.properties.decision.enum, ['accept', 'reject', 'unsure']);
});

test('model confidence is the value the model returned, not a hard-coded 10', () => {
  assert.equal(modelConfidence({}), null);
  assert.equal(modelConfidence({ confidence: 0.42 }), 0.42);
  assert.equal(modelConfidence({ score: 8 }), 0.8);
  const source = fs.readFileSync(path.join(__dirname, '..', 'search-ai.js'), 'utf8');
  assert.equal(source.includes("classificationFromMatch(validated, services, 'gemini', 10)"), false);
  assert.equal(source.includes('|| 10'), false);
});

test('low confidence is rejected and mid confidence stays for manual review', () => {
  const target = { cat: 'home', sub: 'plumber' };
  const high = gateClassification({
    classifier: { accepted: true, category: 'home', subcategory: 'plumber', confidence: 0.91 },
    verification: { decision: 'accept', category: 'home', subcategory: 'plumber', confidence: 0.88 },
    target,
  });
  assert.equal(high.status, 'pending');
  assert.equal(high.needsReview, false);

  const mid = gateClassification({
    classifier: { accepted: true, category: 'home', subcategory: 'plumber', confidence: 0.7 },
    verification: { decision: 'accept', category: 'home', subcategory: 'plumber', confidence: 0.9 },
    target,
  });
  assert.equal(mid.status, 'pending');
  assert.equal(mid.needsReview, true);

  const low = gateClassification({
    classifier: { accepted: true, category: 'home', subcategory: 'plumber', confidence: 0.4 },
    verification: { decision: 'accept', category: 'home', subcategory: 'plumber', confidence: 0.9 },
    target,
  });
  assert.equal(low.status, 'rejected');
  assert.equal(low.reason, 'low_confidence');

  const rejected = gateClassification({
    classifier: { accepted: true, category: 'home', subcategory: 'plumber', confidence: 0.95 },
    verification: { decision: 'reject', category: 'home', subcategory: 'plumber', confidence: 0.2 },
    target,
  });
  assert.equal(rejected.reason, 'verification_reject');
});
