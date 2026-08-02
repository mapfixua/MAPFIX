'use strict';

/**
 * Best-effort apply of 014_security_hardening.sql using DATABASE_URL / SUPABASE_DB_URL.
 * If no DB URL is present, exits 0 with instructions (server still works via service_role + kv-store).
 */
const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    });
}

async function main() {
  const root = path.join(__dirname, '..');
  loadEnvFile(path.join(root, '.env'));
  loadEnvFile(path.join(root, '.env.vercel.tmp'));
  loadEnvFile(path.join(root, '.env.local'));

  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';
  const sqlPath = path.join(root, 'supabase', 'migrations', '014_security_hardening.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  if (!dbUrl) {
    console.log('[db:harden] DATABASE_URL / SUPABASE_DB_URL not set — skip SQL apply.');
    console.log('[db:harden] Code hardening is active; run 014_security_hardening.sql in Supabase when possible.');
    process.exit(0);
  }

  let pg;
  try {
    pg = require('pg');
  } catch {
    console.error('[db:harden] pg package missing');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql);
    console.log('[db:harden] Applied 014_security_hardening.sql');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[db:harden]', err.message || err);
  process.exit(1);
});
