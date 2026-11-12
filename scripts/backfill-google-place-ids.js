'use strict';

/**
 * Find google_place_id for existing locations. Dry-run by default.
 * Writes reports/place-id-backfill.json and does not update the database
 * unless --write is passed. --write sets only locations.google_place_id.
 *
 *   node scripts/backfill-google-place-ids.js
 *   node scripts/backfill-google-place-ids.js --write
 *
 * API keys are read from the environment, never from argv.
 */

const fs = require('fs');
const path = require('path');
const { supabaseClient } = require('../supabaseClient.js');
const { fetchLocationsFromSupabase } = require('../locations-store.js');
const { chooseBackfillMatch } = require('../places-backfill.js');
const { createPlacesBudget } = require('../places-quota.js');
const { normalizePhone } = require('../phone-normalize.js');

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return '';
  return `***${digits.slice(-4)}`;
}

async function searchNear(location, apiKey) {
  const body = {
    textQuery: String(location.title || '').trim(),
    languageCode: 'uk',
    regionCode: 'UA',
    maxResultCount: 5,
  };
  if (Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))) {
    body.locationBias = {
      circle: {
        center: { latitude: Number(location.lat), longitude: Number(location.lng) },
        radius: 200,
      },
    };
  }
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.businessStatus',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json?.error?.message || `HTTP ${res.status}`).slice(0, 200));
  return (json.places || [])
    .map((p) => ({
      placeId: p.id,
      title: p.displayName?.text || '',
      phone: normalizePhone(p.nationalPhoneNumber || ''),
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      businessStatus: p.businessStatus || '',
    }))
    .filter((p) => p.placeId && p.title);
}

async function main() {
  const write = hasFlag('--write');
  const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY is not set');

  const remote = await fetchLocationsFromSupabase();
  if (!remote.ok) throw new Error(remote.error?.message || 'Не вдалося прочитати locations');
  const active = (remote.locations || []).filter((loc) => !loc.deletedAt && !loc.googlePlaceId);
  const budget = createPlacesBudget({ maxTextSearch: 500, maxDetails: 0 });
  const report = {
    dryRun: !write,
    scanned: active.length,
    confident: [],
    skipped: [],
  };

  for (const loc of active) {
    let places = [];
    try {
      const spent = await budget.spend('text', `backfill:${loc.id}:${loc.title}`, () => searchNear(loc, apiKey));
      places = spent.value || [];
    } catch (err) {
      if (err.code === 'cap' || err.name === 'PlacesQuotaError') {
        report.stoppedReason = 'text_search_cap';
        break;
      }
      report.skipped.push({ id: loc.id, title: loc.title, reason: 'search_error' });
      continue;
    }
    const match = chooseBackfillMatch(loc, places);
    const entry = {
      id: loc.id,
      title: loc.title,
      phone: maskPhone(loc.phone),
      reason: match.reason,
      placeId: match.placeId || null,
      distanceMeters: Number.isFinite(match.distance) ? Math.round(match.distance) : null,
    };
    if (!match.confident) {
      report.skipped.push(entry);
      continue;
    }
    report.confident.push(entry);
    if (write) {
      const { error } = await supabaseClient
        .from('locations')
        .update({ google_place_id: match.placeId })
        .eq('id', loc.id)
        .is('google_place_id', null);
      if (error) {
        entry.writeError = error.message;
      }
    }
  }

  report.cost = budget.estimateCost();
  report.confidentCount = report.confident.length;
  report.skippedCount = report.skipped.length;
  const reportDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'place-id-backfill.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        dryRun: report.dryRun,
        scanned: report.scanned,
        confidentCount: report.confidentCount,
        skippedCount: report.skippedCount,
        stoppedReason: report.stoppedReason || null,
        cost: report.cost,
        reportPath,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('[backfill-google-place-ids]', err.message);
  process.exit(1);
});
