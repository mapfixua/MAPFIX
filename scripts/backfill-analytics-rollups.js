'use strict';

/**
 * Fill the daily rollup tables from analytics_events that are already stored.
 * Idempotent: each closed Kyiv day is deleted and inserted again.
 * Does not UPDATE district or category on old event rows.
 *
 * Apply migration 024 first. Then:
 *   npm run analytics:backfill
 *   npm run analytics:backfill -- --from 2026-01-01 --to 2026-11-11
 *   npm run analytics:backfill -- --dry-run
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Today (Kyiv) is skipped;
 * the statistics screen reads it from the journal.
 */

const { getServiceRoleClient } = require('../supabaseClient.js');
const { kyivDayKey } = require('../analytics-events.js');
const { listDays, shiftDay } = require('../analytics-dimensions.js');

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return '';
  return String(process.argv[idx + 1] || '');
}

function daysToRoll({ from, to, bounds, today }) {
  let start = from || bounds?.min || '';
  let end = to || bounds?.max || '';
  if (start && end && start > end) [start, end] = [end, start];
  if (!start || !end) return [];
  return listDays(start, end, today);
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args || {});
  if (error) {
    const err = new Error(error.message || name);
    err.missing = /could not find the function|does not exist|schema cache/i.test(String(error.message || ''));
    throw err;
  }
  return data;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const from = argValue('--from');
  const to = argValue('--to');
  if (from && !YMD.test(from)) throw new Error('--from має бути YYYY-MM-DD');
  if (to && !YMD.test(to)) throw new Error('--to має бути YYYY-MM-DD');

  const client = getServiceRoleClient();
  if (!client) {
    console.error('Потрібен SUPABASE_SERVICE_ROLE_KEY (і SUPABASE_URL) у середовищі. Міграцію цей скрипт не застосовує.');
    process.exit(1);
  }

  const today = kyivDayKey();
  let bounds = { min: null, max: null };
  try {
    bounds = (await rpc(client, 'analytics_event_bounds', {})) || bounds;
  } catch (err) {
    if (err.missing) {
      console.error('Функції зведень немає. Спочатку застосуйте supabase/migrations/024_analytics_district_category_rollups.sql');
      process.exit(1);
    }
    throw err;
  }

  const days = daysToRoll({
    from: from || bounds.min,
    to: to || bounds.max,
    bounds,
    today,
  });
  console.log(`[analytics:backfill] сьогодні за Києвом ${today} — цей день не зводиться`);
  console.log(`[analytics:backfill] днів до запису: ${days.length}${bounds.min ? ` (у журналі ${bounds.min} … ${bounds.max})` : ''}`);
  if (!days.length) return;
  if (dryRun) {
    console.log(days.join('\n'));
    return;
  }

  let failed = 0;
  for (const day of days) {
    try {
      const result = await rpc(client, 'analytics_rollup_day', { p_day: day });
      if (result && result.skipped) {
        console.log(`[analytics:backfill] ${day} пропущено (${result.skipped})`);
        continue;
      }
      console.log(
        `[analytics:backfill] ${day} grains=${result?.grains ?? 0} searches=${result?.searches ?? 0} locations=${result?.locations ?? 0}`
      );
    } catch (err) {
      failed += 1;
      console.error(`[analytics:backfill] ${day} ${err.message}`);
    }
  }
  if (failed) {
    console.error(`[analytics:backfill] помилок: ${failed}. Повторний запуск допише ті самі дні.`);
    process.exit(1);
  }
  console.log('[analytics:backfill] готово');
}

module.exports = { daysToRoll, shiftDay };

if (require.main === module) {
  main().catch((err) => {
    console.error('[analytics:backfill]', err.message || err);
    process.exit(1);
  });
}
