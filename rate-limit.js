'use strict';

/**
 * In-memory sliding window rate limiter (per serverless isolate).
 * Best-effort protection for login / OTP / search-ai / OAuth.
 */
function createRateLimiter({ windowMs = 60_000, max = 30 } = {}) {
  const hits = new Map();

  function prune(now) {
    for (const [key, bucket] of hits) {
      if (now - bucket.start > windowMs) hits.delete(key);
    }
  }

  return function rateLimit(req, res, next) {
    const now = Date.now();
    if (hits.size > 5000) prune(now);
    const ip = String(req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
      .split(',')[0]
      .trim();
    const route = req.path || req.url || '';
    const key = `${ip}:${route}`;
    let bucket = hits.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      hits.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retrySec = Math.ceil((windowMs - (now - bucket.start)) / 1000);
      res.set('Retry-After', String(Math.max(1, retrySec)));
      return res.status(429).json({ error: 'Забагато запитів. Спробуйте трохи пізніше.' });
    }
    return next();
  };
}

module.exports = { createRateLimiter };
