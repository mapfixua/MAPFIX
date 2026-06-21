'use strict';

/**
 * Applies supabase/sync_database.sql to the remote Postgres database.
 *
 * Priority:
 *   1. DATABASE_URL or SUPABASE_DB_URL in .env (direct Postgres)
 *   2. Supabase CLI: supabase db execute --linked
 *   3. Print manual instructions
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SQL_FILE = path.join(ROOT, 'supabase', 'sync_database.sql');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    });
}

function printManualInstructions() {
  console.log(`
Mapfix database sync — manual steps
=====================================

Option A — npm (recommended after setting DATABASE_URL):
  1. Supabase Dashboard → Project Settings → Database
  2. Copy "Connection string" (URI), mode: Session or Direct
  3. Add to .env:
       DATABASE_URL=postgresql://postgres.[ref]:[PASSWORD]@...supabase.com:5432/postgres
  4. Run:
       npm run db:sync

Option B — Supabase CLI (linked project):
  supabase login
  supabase link --project-ref YOUR_PROJECT_REF
  supabase db execute --file supabase/sync_database.sql --linked

Option C — SQL Editor:
  Open supabase/sync_database.sql → paste into Supabase SQL Editor → Run

Verify schema after sync:
  npm run db:verify
`);
}

async function runWithPg(connectionString) {
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch {
    console.error('[db:sync] Install pg first: npm install pg');
    printManualInstructions();
    process.exit(1);
  }

  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  console.log('[db:sync] Connecting to Postgres…');
  await client.connect();
  try {
    await client.query(sql);
    console.log('[db:sync] OK — schema synced from supabase/sync_database.sql');
  } finally {
    await client.end();
  }
}

function runWithSupabaseCli() {
  const check = spawnSync('supabase', ['--version'], { encoding: 'utf8' });
  if (check.status !== 0) {
    return false;
  }

  console.log('[db:sync] Running via Supabase CLI…');
  const result = spawnSync(
    'supabase',
    ['db', 'execute', '--file', SQL_FILE, '--linked'],
    { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32' }
  );
  if (result.status === 0) {
    console.log('[db:sync] OK — schema synced via Supabase CLI');
    return true;
  }
  return false;
}

async function main() {
  loadEnvFile();

  if (!fs.existsSync(SQL_FILE)) {
    console.error('[db:sync] Missing file:', SQL_FILE);
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (dbUrl) {
    await runWithPg(dbUrl);
    return;
  }

  if (runWithSupabaseCli()) {
    return;
  }

  console.warn('[db:sync] DATABASE_URL not set and Supabase CLI unavailable.\n');
  printManualInstructions();
  process.exit(1);
}

main().catch((err) => {
  console.error('[db:sync] Failed:', err.message);
  process.exit(1);
});
