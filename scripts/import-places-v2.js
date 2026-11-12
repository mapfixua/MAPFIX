'use strict';

/**
 * Wave runner for Places import v2.
 *
 * Default is a dry run: it may call Google and write import_candidates only.
 * It never inserts into locations. Publishing is the admin action.
 *
 *   node scripts/import-places-v2.js --wave A --plan
 *   node scripts/import-places-v2.js --wave A
 *   node scripts/import-places-v2.js --wave A --report-only
 *
 * Caps: --max-text 800 --max-details 800
 * Do not pass API keys on the command line. They are read from the environment.
 */

const fs = require('fs');
const path = require('path');
const { planWave, runWave } = require('../places-v2.js');

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function loadLocations() {
  try {
    const remote = await fetchLocationsFromSupabase();
    if (remote.ok && remote.locations.length) return remote.locations;
  } catch (err) {
    console.warn('[import-places-v2] supabase locations skipped:', err.message);
  }
  const file = path.join(__dirname, '..', 'data.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed.mockLocations || [];
}

async function main() {
  const wave = argValue('--wave', 'A');
  const plan = planWave(wave);
  console.log(
    JSON.stringify(
      {
        wave: plan.wave,
        label: plan.label,
        targets: plan.targets,
        tileCount: plan.tileCount,
        plannedTextSearch: plan.plannedTextSearch,
        details: 'one Place Details call per place that passes filters and is not an exact place_id duplicate, capped per run',
      },
      null,
      2
    )
  );
  if (hasFlag('--plan')) return;

  const { loadMasterCatalog } = require('../catalog-data.js');
  const { fetchLocationsFromSupabase } = require('../locations-store.js');
  const { upsertImportCandidates } = require('../import-candidates-store.js');
  const reportOnly = hasFlag('--report-only');
  const locations = await loadLocations();
  const masterCatalog = loadMasterCatalog();
  const chunks = [];
  const result = await runWave({
    wave,
    locations,
    masterCatalog,
    maxTextSearch: argValue('--max-text', undefined),
    maxDetails: argValue('--max-details', undefined),
    onStage: async (chunk) => {
      if (!chunk.length || reportOnly) return;
      const saved = await upsertImportCandidates(chunk);
      if (!saved.ok) {
        throw new Error(saved.error?.message || 'Не вдалося записати import_candidates. Застосуйте міграцію 021.');
      }
      chunks.push(saved.upserted);
    },
  });

  const reportDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `places-v2-wave-${plan.wave}.json`);
  const summary = {
    dryRun: true,
    publishedLocations: 0,
    reportOnly,
    wave: result.wave,
    stoppedReason: result.stoppedReason,
    counts: result.counts,
    cost: result.cost,
    staged: chunks.reduce((sum, n) => sum + n, 0),
    candidateCount: result.candidates.length,
  };
  fs.writeFileSync(reportPath, JSON.stringify({ ...summary, candidates: result.candidates }, null, 2));
  console.log(JSON.stringify({ ...summary, reportPath }, null, 2));
}

main().catch((err) => {
  console.error('[import-places-v2]', err.message);
  process.exit(1);
});
