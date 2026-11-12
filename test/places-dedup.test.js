'use strict';

require('./env.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyDedup, titlesMatch } = require('../places-dedup.js');
const { mergeLocations } = require('../places-import.js');

test('transliteration-aware titles match across scripts and legal forms', () => {
  assert.equal(titlesMatch('ФОП Іваненко', 'Іваненко'), true);
  assert.equal(titlesMatch('Люкс', 'Liuks'), true);
  assert.equal(titlesMatch('Стоматологія Люкс', 'Люкс стоматологія'), true);
  assert.equal(titlesMatch('Сантехнік А', 'Сантехнік Б'), false);
});

test('dedup rules follow place id, phone distance, fuzzy title, deleted and claimed', () => {
  const active = {
    id: 'loc-active',
    title: 'Сантехнік Майстер',
    phone: '+380501112233',
    lat: 50.45,
    lng: 30.52,
    googlePlaceId: 'place-active',
  };
  const deleted = {
    id: 'loc-deleted',
    title: 'Авокадо',
    phone: '+380671110000',
    lat: 50.49,
    lng: 30.33,
    googlePlaceId: 'place-deleted',
    deletedAt: '2026-01-01T00:00:00.000Z',
  };
  const claimed = {
    id: 'loc-claimed',
    title: 'Jerome Education Space',
    phone: '+380931234567',
    lat: 50.49,
    lng: 30.334,
    googlePlaceId: 'place-claimed',
    claimedAt: '2026-02-01T00:00:00.000Z',
    providerId: 'provider-1',
  };
  const branch = {
    id: 'loc-branch',
    title: 'Jerome Education Space',
    phone: '+380931234567',
    lat: 50.478,
    lng: 30.36,
    googlePlaceId: 'place-branch',
  };
  const rows = [active, deleted, claimed, branch];

  assert.equal(
    classifyDedup({ placeId: 'place-active', title: 'Інше', phone: '', lat: 50.45, lng: 30.52 }, rows).status,
    'duplicate_of loc-active'
  );
  assert.equal(
    classifyDedup({ placeId: 'place-deleted', title: 'Авокадо', phone: '', lat: 50.49, lng: 30.33 }, rows).status,
    'matches_deleted loc-deleted'
  );
  assert.equal(
    classifyDedup({ placeId: 'place-claimed', title: 'X', phone: '', lat: 50.49, lng: 30.334 }, rows).status,
    'matches_claimed loc-claimed'
  );

  const phoneNear = classifyDedup(
    { placeId: 'new-phone', title: 'Зовсім інша назва', phone: '0501112233', lat: 50.4504, lng: 30.5204 },
    rows
  );
  assert.equal(phoneNear.status, 'duplicate_of loc-active');

  const farBranch = classifyDedup(
    { placeId: 'new-branch', title: 'Jerome Education Space', phone: '+380931234567', lat: 50.49, lng: 30.334 },
    [branch]
  );
  assert.match(farBranch.status, /^possible_branch_of /);

  const fuzzy = classifyDedup(
    { placeId: 'new-fuzzy', title: 'Santekhnik Maister', phone: '', lat: 50.4505, lng: 30.5205 },
    [active]
  );
  assert.equal(fuzzy.status, 'duplicate_of loc-active');

  const farTitle = classifyDedup(
    { placeId: 'new-far', title: 'Сантехнік Майстер', phone: '', lat: 50.47, lng: 30.52 },
    [active]
  );
  assert.equal(farTitle.status, 'new');
});

test('the same import batch dedupes later rows against earlier ones', () => {
  const first = { placeId: 'batch-1', title: 'Пекарня Хліб', phone: '+380441112233', lat: 50.45, lng: 30.52 };
  const second = classifyDedup(
    { placeId: 'batch-2', title: 'Пекарня Хліб', phone: '+380441112233', lat: 50.4502, lng: 30.5202 },
    [],
    { batch: [{ ...first, id: 'batch:batch-1' }] }
  );
  assert.equal(second.status, 'duplicate_of batch:batch-1');
});

test('existing mergeLocations still treats the same phone as a duplicate', () => {
  const merged = mergeLocations(
    [{ id: 'a', title: 'Картка', phone: '+380501112233', lat: 50.45, lng: 30.52 }],
    [{ id: 'b', title: 'Інша', phone: '0501112233', lat: 50.9, lng: 30.9 }]
  );
  assert.deepEqual(merged.added, []);
  assert.equal(merged.skipped[0].reason, 'near_duplicate');
  assert.equal(merged.locations.length, 1);
});
