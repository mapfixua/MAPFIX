'use strict';

require('./env.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasRecentReview, summarizeReviewDates, mapPlacesReviews, REVIEW_WINDOW_MS } = require('../places-reviews.js');
const { mapGoogleReviews } = require('../places-import.js');

const NOW = Date.parse('2026-11-12T00:00:00.000Z');

test('a publishTime inside 365 days passes and an older one does not', () => {
  const recent = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString();
  const old = new Date(NOW - REVIEW_WINDOW_MS - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(hasRecentReview([{ publishTime: recent }], NOW), true);
  assert.equal(hasRecentReview([{ publishTime: old }], NOW), false);
  assert.equal(hasRecentReview([{ publishTime: old }, { publishTime: recent }], NOW), true);
});

test('relative Google dates do not satisfy the review filter', () => {
  assert.equal(hasRecentReview([{ date: '2 місяці тому', relativePublishTimeDescription: '2 місяці тому' }], NOW), false);
  const summary = summarizeReviewDates(
    [{ publishTime: '2026-08-01T12:00:00Z' }, { relativePublishTimeDescription: '3 роки тому' }],
    NOW
  );
  assert.deepEqual(summary.reviewDates, ['2026-08-01T12:00:00.000Z']);
  assert.equal(summary.fresh, true);
  assert.equal(summary.lastReviewAt, '2026-08-01T12:00:00.000Z');
});

test('mapGoogleReviews keeps publishTime instead of dropping it', () => {
  const mapped = mapGoogleReviews([
    {
      rating: 5,
      text: { text: 'Швидко полагодили' },
      authorAttribution: { displayName: 'Оля' },
      relativePublishTimeDescription: 'місяць тому',
      publishTime: '2026-10-01T08:00:00Z',
    },
  ]);
  assert.equal(mapped[0].publishTime, '2026-10-01T08:00:00.000Z');
  assert.equal(mapped[0].date, 'місяць тому');
  assert.equal(mapped[0].source, 'google_maps');
  assert.equal(mapPlacesReviews([]).length, 0);
});
