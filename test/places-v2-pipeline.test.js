'use strict';

require('./env.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const { runWave, passesListingFilters } = require('../places-v2.js');
const { looksLikeBakery } = require('../places-waves.js');
const { createPlacesBudget } = require('../places-quota.js');
const { selectPublishable, buildLocationFromCandidate } = require('../places-publish.js');

const catalog = {
  home: {
    name: 'Дім',
    subcats: {
      plumber: {
        name: 'Послуги сантехніка',
        items: [{ name: 'Усунення засмічення труб' }],
      },
    },
  },
  food: {
    name: 'Їжа',
    subcats: {
      bakery: {
        name: 'Замовлення випічки',
        items: [{ name: 'Домашній хліб (за буханець)' }],
      },
    },
  },
};

test('listing filter keeps operational in-polygon places with ratings', () => {
  assert.equal(passesListingFilters({ businessStatus: 'OPERATIONAL', lat: 50.4501, lng: 30.5234, reviewsCount: 3 }).ok, true);
  assert.equal(passesListingFilters({ businessStatus: 'CLOSED_PERMANENTLY', lat: 50.4501, lng: 30.5234, reviewsCount: 3 }).reason, 'not_operational');
  assert.equal(passesListingFilters({ businessStatus: 'OPERATIONAL', lat: 50.548, lng: 30.211, reviewsCount: 3 }).reason, 'outside_polygon');
  assert.equal(passesListingFilters({ businessStatus: 'OPERATIONAL', lat: 50.45, lng: 30.52, reviewsCount: 0 }).reason, 'no_ratings');
});

test('bakery filter rejects cafes and keeps bakeries', () => {
  assert.equal(looksLikeBakery({ title: 'Пекарня на Подолі', types: ['bakery'] }), true);
  assert.equal(looksLikeBakery({ title: 'Кафе Хліб і кава', types: ['cafe', 'restaurant'] }), false);
  assert.equal(looksLikeBakery({ title: 'Ресторан', types: ['restaurant'] }), false);
});

test('a dry-run wave stages rows and does not create locations', async () => {
  const recent = new Date().toISOString();
  const calls = { text: 0, details: 0 };
  const result = await runWave({
    wave: 'A',
    tiles: [{ south: 50.44, west: 30.51, north: 50.46, east: 30.54 }],
    targets: [{ key: 'plumber', cat: 'home', sub: 'plumber', query: 'сантехнік' }],
    locations: [
      {
        id: 'loc-active',
        title: 'Вже є',
        phone: '+380501110000',
        lat: 50.45,
        lng: 30.523,
        googlePlaceId: 'place-existing',
      },
    ],
    masterCatalog: catalog,
    budget: createPlacesBudget({ maxTextSearch: 20, maxDetails: 20, minIntervalMs: 0, cache: false }),
    textSearch: async () => {
      calls.text += 1;
      return [
        {
          placeId: 'place-existing',
          title: 'Вже є',
          phone: '+380501110000',
          lat: 50.45,
          lng: 30.523,
          businessStatus: 'OPERATIONAL',
          reviewsCount: 4,
          types: ['plumber'],
        },
        {
          placeId: 'place-new',
          title: 'Майстерня Тепла Вода',
          phone: '+380671234567',
          lat: 50.451,
          lng: 30.525,
          businessStatus: 'OPERATIONAL',
          reviewsCount: 6,
          types: ['plumber'],
        },
        {
          placeId: 'place-irpin',
          title: 'Сантехнік Ірпінь',
          phone: '+380631111111',
          lat: 50.521,
          lng: 30.25,
          businessStatus: 'OPERATIONAL',
          reviewsCount: 9,
          types: ['plumber'],
        },
        {
          placeId: 'place-closed',
          title: 'Закрито',
          phone: '',
          lat: 50.4505,
          lng: 30.524,
          businessStatus: 'CLOSED_TEMPORARILY',
          reviewsCount: 2,
          types: [],
        },
      ];
    },
    details: async ({ placeId }) => {
      calls.details += 1;
      assert.notEqual(placeId, 'place-existing');
      return {
        id: placeId,
        displayName: { text: 'Майстерня Тепла Вода' },
        formattedAddress: 'вул. Хрещатик, Київ',
        location: { latitude: 50.451, longitude: 30.525 },
        nationalPhoneNumber: '+380671234567',
        businessStatus: 'OPERATIONAL',
        userRatingCount: 6,
        rating: 4.8,
        types: ['plumber'],
        regularOpeningHours: { weekdayDescriptions: ['понеділок: 09:00 - 18:00'] },
        reviews: [
          {
            rating: 5,
            text: { text: 'Прийхав вчасно' },
            publishTime: recent,
            relativePublishTimeDescription: 'тиждень тому',
          },
        ],
      };
    },
    classify: async () => ({
      accepted: true,
      category: 'home',
      subcategory: 'plumber',
      services: ['Усунення засмічення труб'],
      confidence: 0.92,
      reasoning: 'Назва і тип відповідають сантехніку',
    }),
    verify: async () => ({
      decision: 'accept',
      category: 'home',
      subcategory: 'plumber',
      services: ['Усунення засмічення труб'],
      confidence: 0.9,
      reasoning: 'Відгук про виклик майстра',
    }),
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.publishedLocations, 0);
  assert.equal(calls.details, 1);
  const byId = Object.fromEntries(result.candidates.map((row) => [row.place_id, row]));
  assert.equal(byId['place-existing'].dedup_status, 'duplicate_of loc-active');
  assert.equal(byId['place-new'].status, 'pending');
  assert.equal(byId['place-new'].dedup_status, 'new');
  assert.equal(byId['place-new'].needs_review, false);
  assert.equal(byId['place-new'].proposed_cat, 'home');
  assert.deepEqual(byId['place-new'].proposed_services, ['Усунення засмічення труб']);
  assert.ok(byId['place-new'].review_dates.length >= 1);
  assert.equal(byId['place-irpin'], undefined);
  assert.equal(byId['place-closed'], undefined);
  assert.ok(result.cost.textSearchRequests >= 1);
  assert.equal(result.cost.detailsRequests, 1);
});

test('publishing creates places_v2 rows and refuses deleted, claimed and duplicate matches', () => {
  const fresh = buildLocationFromCandidate(
    {
      place_id: 'place-new',
      status: 'approved',
      dedup_status: 'new',
      proposed_cat: 'home',
      proposed_subcats: ['plumber'],
      proposed_services: ['Усунення засмічення труб'],
      proposed_title: 'Майстерня Тепла Вода',
      proposed_phone: '+380671234567',
      proposed_address: 'Київ',
      proposed_lat: 50.451,
      proposed_lng: 30.525,
      business_status: 'OPERATIONAL',
      review_dates: ['2026-10-01T00:00:00.000Z'],
      last_review_at: '2026-10-01T00:00:00.000Z',
      raw_payload: { details: { rating: 4.8, userRatingCount: 6, reviews: [] } },
    },
    catalog
  );
  assert.equal(fresh.importSource, 'places_v2');
  assert.equal(fresh.googlePlaceId, 'place-new');
  assert.equal(fresh.providerId, null);
  assert.equal(fresh.prices['Усунення засмічення труб'] !== undefined, true);

  const locations = [
    { id: 'loc-del', title: 'Авокадо', phone: '', lat: 50.49, lng: 30.33, googlePlaceId: 'place-del', deletedAt: '2026-01-01' },
    { id: 'loc-own', title: 'Зайнято', phone: '+380501111111', lat: 50.45, lng: 30.52, googlePlaceId: 'place-own', providerId: 'p1' },
  ];
  const decision = selectPublishable(
    [
      { id: 'c1', status: 'approved', dedup_status: 'new', place_id: 'place-new', proposed_title: 'Майстерня Тепла Вода', proposed_phone: '+380671234567', proposed_lat: 50.451, proposed_lng: 30.525, proposed_cat: 'home', proposed_subcats: ['plumber'], proposed_services: [] },
      { id: 'c2', status: 'approved', dedup_status: 'matches_deleted loc-del', place_id: 'place-del', proposed_title: 'Авокадо', proposed_lat: 50.49, proposed_lng: 30.33 },
      { id: 'c3', status: 'approved', dedup_status: 'matches_claimed loc-own', place_id: 'place-own', proposed_title: 'Зайнято', proposed_lat: 50.45, proposed_lng: 30.52 },
      { id: 'c4', status: 'approved', dedup_status: 'duplicate_of loc-own', place_id: 'place-dup', proposed_title: 'Зайнято', proposed_phone: '+380501111111', proposed_lat: 50.4502, proposed_lng: 30.5202 },
      { id: 'c5', status: 'pending', dedup_status: 'new', place_id: 'place-wait', proposed_title: 'Ще ні', proposed_lat: 50.46, proposed_lng: 30.53 },
    ],
    locations,
    catalog
  );
  assert.deepEqual(decision.created.map((item) => item.candidateId), ['c1']);
  assert.equal(decision.created[0].location.importSource, 'places_v2');
  const reasons = Object.fromEntries(decision.skipped.map((row) => [row.id, row.reason]));
  assert.equal(reasons.c2, 'deleted_not_restored');
  assert.equal(reasons.c3, 'claimed_not_overwritten');
  assert.equal(reasons.c4, 'duplicate');
  assert.equal(reasons.c5, 'not_approved');
});
