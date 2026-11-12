'use strict';

const REVIEW_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

function parsePublishTime(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/**
 * Map Places Review objects. Keeps publishTime (ISO) and the relative
 * description the UI already shows in `date`.
 */
function mapPlacesReviews(reviews) {
  if (!Array.isArray(reviews)) return [];
  return reviews
    .slice(0, 8)
    .map((rev) => {
      const rating = Math.max(1, Math.min(5, Number(rev.rating) || 5));
      const text = String(rev.text?.text || rev.originalText?.text || '').trim();
      const author = rev.authorAttribution?.displayName || 'Google';
      const relative = rev.relativePublishTimeDescription || '';
      const publishTime = rev.publishTime ? String(rev.publishTime) : '';
      const parsed = parsePublishTime(publishTime);
      return {
        rating,
        text: text || 'Відгук з Google Maps',
        author,
        date: relative || (parsed ? new Date(parsed).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)),
        publishTime: parsed ? new Date(parsed).toISOString() : null,
        source: 'google_maps',
      };
    })
    .filter((r) => r.text);
}

function reviewPublishTimes(reviews) {
  const times = [];
  for (const rev of Array.isArray(reviews) ? reviews : []) {
    const ms = parsePublishTime(rev?.publishTime || rev?.publish_time);
    if (ms == null) continue;
    times.push(new Date(ms).toISOString());
  }
  times.sort();
  return times;
}

/**
 * At least one review whose publishTime falls in the last `windowMs`
 * (default 365 days). Relative strings ("2 місяці тому") do not count.
 * A timestamp slightly in the future (clock skew, 2 days) still counts.
 */
function hasRecentReview(reviews, now = Date.now(), windowMs = REVIEW_WINDOW_MS) {
  const skew = 2 * 24 * 60 * 60 * 1000;
  const current = Number(now);
  if (!Number.isFinite(current)) return false;
  for (const iso of reviewPublishTimes(reviews)) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    if (ms <= current + skew && current - ms <= windowMs) return true;
  }
  return false;
}

function summarizeReviewDates(reviews, now = Date.now(), windowMs = REVIEW_WINDOW_MS) {
  const reviewDates = reviewPublishTimes(reviews);
  const lastMs = reviewDates.length ? Date.parse(reviewDates[reviewDates.length - 1]) : null;
  return {
    reviewDates,
    lastReviewAt: lastMs ? new Date(lastMs).toISOString() : null,
    fresh: hasRecentReview(reviews, now, windowMs),
  };
}

module.exports = {
  REVIEW_WINDOW_MS,
  parsePublishTime,
  mapPlacesReviews,
  reviewPublishTimes,
  hasRecentReview,
  summarizeReviewDates,
};
