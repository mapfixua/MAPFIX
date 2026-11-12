'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_MAX_TEXT_SEARCH = 800;
const DEFAULT_MAX_DETAILS = 800;

/**
 * Rough pay-as-you-go prices after the monthly free cap is exhausted.
 * Text Search with phone + userRatingCount is Enterprise (~$35 / 1,000, 1,000 free).
 * Place Details with reviews is Enterprise + Atmosphere (~$25 / 1,000, 1,000 free).
 * Free-tier remainder is not visible from this process, so both $0-if-inside-cap
 * and the exhausted-cap estimate are reported.
 */
const TEXT_SEARCH_USD = 0.035;
const DETAILS_USD = 0.025;

class PlacesQuotaError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PlacesQuotaError';
    this.code = code || 'quota';
  }
}

function resolveCacheDir(preferred) {
  const dir = preferred || path.join(process.cwd(), 'data', 'places-cache');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch (_) {
    const tmp = path.join(os.tmpdir(), 'mapfix-places-cache');
    fs.mkdirSync(tmp, { recursive: true });
    return tmp;
  }
}

function createPlacesBudget(options = {}) {
  const maxTextSearch = Math.max(0, Number(options.maxTextSearch ?? process.env.PLACES_V2_MAX_TEXT_SEARCH ?? DEFAULT_MAX_TEXT_SEARCH) || 0);
  const maxDetails = Math.max(0, Number(options.maxDetails ?? process.env.PLACES_V2_MAX_DETAILS ?? DEFAULT_MAX_DETAILS) || 0);
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs ?? process.env.PLACES_V2_MIN_INTERVAL_MS ?? 220) || 0);
  const cacheStore = options.cacheStore || null;
  const cacheEnabled = options.cache !== false && process.env.PLACES_V2_CACHE !== '0';
  // Serverless disks are ephemeral. A cacheStore (Supabase) is used when
  // provided; otherwise the CLI keeps a local directory. cache:false skips both.
  const cacheDir = cacheEnabled && !cacheStore ? resolveCacheDir(options.cacheDir) : null;
  const stats = {
    textSearch: 0,
    details: 0,
    cacheHits: 0,
    errors: 0,
  };
  let lastCallAt = 0;

  function cacheFile(key) {
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    return path.join(cacheDir, `${hash}.json`);
  }

  async function readCache(key) {
    if (!cacheEnabled) return null;
    if (cacheStore) {
      try {
        return await cacheStore.get(key);
      } catch (_) {
        return null;
      }
    }
    if (!cacheDir) return null;
    try {
      const raw = fs.readFileSync(cacheFile(key), 'utf8');
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async function writeCache(key, value) {
    if (!cacheEnabled) return;
    if (cacheStore) {
      try {
        await cacheStore.set(key, value);
      } catch (_) {
        /* cache is best-effort */
      }
      return;
    }
    if (!cacheDir) return;
    try {
      fs.writeFileSync(cacheFile(key), JSON.stringify(value));
    } catch (_) {
      /* cache is best-effort */
    }
  }

  async function pace() {
    const wait = lastCallAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
  }

  async function spend(kind, cacheKey, fn) {
    const cap = kind === 'details' ? maxDetails : maxTextSearch;
    const used = kind === 'details' ? stats.details : stats.textSearch;
    if (cacheKey) {
      const hit = await readCache(cacheKey);
      if (hit) {
        stats.cacheHits += 1;
        return { value: hit, cached: true };
      }
    }
    if (used >= cap) {
      throw new PlacesQuotaError(
        `Places ${kind} cap reached (${cap}). Stopping before another billable request.`,
        'cap'
      );
    }
    await pace();
    try {
      const value = await fn();
      if (kind === 'details') stats.details += 1;
      else stats.textSearch += 1;
      if (cacheKey && value) await writeCache(cacheKey, value);
      return { value, cached: false };
    } catch (err) {
      if (kind === 'details') stats.details += 1;
      else stats.textSearch += 1;
      stats.errors += 1;
      throw err;
    }
  }

  function estimateCost() {
    const exhaustedUsd = stats.textSearch * TEXT_SEARCH_USD + stats.details * DETAILS_USD;
    return {
      textSearchRequests: stats.textSearch,
      detailsRequests: stats.details,
      cacheHits: stats.cacheHits,
      errors: stats.errors,
      maxTextSearch,
      maxDetails,
      estimatedUsdIfFreeTierExhausted: Math.round(exhaustedUsd * 100) / 100,
      prices: {
        textSearchEnterpriseUsdPerCall: TEXT_SEARCH_USD,
        detailsAtmosphereUsdPerCall: DETAILS_USD,
        textSearchFreePerMonth: 1000,
        detailsFreePerMonth: 1000,
      },
      note:
        'Counts are network calls in this run (cache hits are free). Text Search here asks for phone and userRatingCount (Enterprise, about $35/1,000 after 1,000 free/month). Place Details asks for reviews (Enterprise + Atmosphere, about $25/1,000 after 1,000 free/month). If those monthly caps are still unused, estimated spend is $0.',
    };
  }

  return {
    maxTextSearch,
    maxDetails,
    cacheDir,
    stats,
    spend,
    estimateCost,
  };
}

module.exports = {
  DEFAULT_MAX_TEXT_SEARCH,
  DEFAULT_MAX_DETAILS,
  TEXT_SEARCH_USD,
  DETAILS_USD,
  PlacesQuotaError,
  createPlacesBudget,
};
