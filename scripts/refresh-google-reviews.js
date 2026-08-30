#!/usr/bin/env node
'use strict';

/**
 * Backfill Google review texts for bulk-imported locations.
 *
 *   node scripts/refresh-google-reviews.js
 *   node scripts/refresh-google-reviews.js --limit 20
 */

const fs = require('fs');
const path = require('path');
const { fetchLocationsFromSupabase, upsertLocationsToSupabase } = require('../locations-store.js');
const {
  enrichLocationGoogleReviews,
  locationNeedsGoogleReviews,
} = require('../places-import.js');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const eq = t.indexOf('=');
      if (eq === -1) return;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith('-')) return true;
  return next;
}

async function main() {
  loadEnv();
  const key = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set');
  }

  const limitRaw = argValue('--limit', '');
  const limit = limitRaw === true || limitRaw === '' ? 0 : Math.max(1, Number(limitRaw) || 0);
  const force = process.argv.includes('--force');

  const remote = await fetchLocationsFromSupabase();
  let locations = [];
  const dataFile = path.join(__dirname, '..', 'data.json');
  let fileData = null;
  if (fs.existsSync(dataFile)) {
    fileData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  }
  if (remote.ok && remote.locations.length) {
    locations = remote.locations;
    console.log(`[refresh-reviews] Supabase: ${locations.length} точок`);
  } else if (fileData?.mockLocations) {
    locations = fileData.mockLocations;
    console.log(`[refresh-reviews] data.json: ${locations.length} точок`);
  } else {
    throw new Error('Немає локацій у Supabase і data.json');
  }

  const queue = locations.filter((loc) => !loc.deletedAt && (force || locationNeedsGoogleReviews(loc)));
  const work = limit ? queue.slice(0, limit) : queue;
  console.log(`[refresh-reviews] чергa ${work.length} з ${queue.length}`);

  const changed = [];
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < work.length; i++) {
    const loc = work[i];
    process.stdout.write(`[${i + 1}/${work.length}] ${loc.title} … `);
    const result = await enrichLocationGoogleReviews(loc, { apiKey: key, force });
    if (result.ok && !result.skipped) {
      changed.push(loc);
      console.log(`+${result.reviewCount} текстів (Google ${loc.reviewsCount || 0})`);
    } else if (result.error) {
      failed += 1;
      console.log(`помилка: ${result.error}`);
    } else {
      skipped += 1;
      console.log(`пропуск (${result.reason || 'skip'})`);
    }
    await sleep(140);
  }

  if (changed.length) {
    const sync = await upsertLocationsToSupabase(changed);
    if (!sync.ok) {
      console.warn('[refresh-reviews] supabase:', sync.error?.message || sync.error);
    } else {
      console.log(`[refresh-reviews] записано в Supabase: ${changed.length}`);
    }
    if (fileData?.mockLocations) {
      const byId = new Map(changed.map((loc) => [loc.id, loc]));
      fileData.mockLocations = fileData.mockLocations.map((loc) => byId.get(loc.id) || loc);
      fs.writeFileSync(dataFile, JSON.stringify(fileData, null, 2), 'utf8');
      console.log('[refresh-reviews] оновлено data.json');
    }
  }

  console.log(
    `[refresh-reviews] готово: оновлено ${changed.length}, пропущено ${skipped}, помилок ${failed}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
