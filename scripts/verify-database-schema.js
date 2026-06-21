'use strict';

/**
 * Verifies that Supabase schema matches what Mapfix application code expects.
 * Uses Supabase REST API (service role / anon key) — no DDL required.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const ROOT = path.join(__dirname, '..');

const EXPECTED = {
  users: ['phone', 'telegram_id', 'telegram_linked_at'],
  otp_codes: [
    'id',
    'phone',
    'code_hash',
    'expires_at',
    'attempts',
    'max_attempts',
    'consumed_at',
    'created_at',
  ],
  telegram_link_tokens: [
    'id',
    'token',
    'user_id',
    'phone',
    'expires_at',
    'used_at',
    'telegram_id',
    'created_at',
  ],
};

/** Maps DB snake_case columns to JS property names used in app code */
const CODE_MAPPING = {
  'users.phone': 'mapUserRow → user.phone (otp-auth, telegram-auth)',
  'users.telegram_id': 'mapUserRow → user.telegramId | raw row.telegram_id in telegram-bot',
  'users.telegram_linked_at': 'mapUserRow → user.telegramLinkedAt',
  'users.password_hash': 'mapUserRow → user.passwordHash (server.js login/register)',
  'otp_codes.code_hash': 'otp-auth.js hashOtpCode → code_hash',
  'otp_codes.consumed_at': 'otp-auth.js cancelOtpById / verifyOtp',
  'telegram_link_tokens.user_id': 'telegram-auth.js createTelegramLinkToken',
  'telegram_link_tokens.used_at': 'telegram-auth.js consumeTelegramLinkToken',
};

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

async function probeTable(supabase, table, columns) {
  const selectList = columns.join(', ');
  const { error } = await supabase.from(table).select(selectList).limit(0);
  return error;
}

async function main() {
  loadEnvFile();

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.error('[db:verify] Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env');
    process.exit(1);
  }

  const supabase = createClient(url, key);
  let failed = false;

  console.log('[db:verify] Checking schema against application code…\n');

  for (const [table, columns] of Object.entries(EXPECTED)) {
    const error = await probeTable(supabase, table, columns);
    if (error) {
      failed = true;
      console.log(`FAIL  ${table}`);
      console.log(`      ${error.message}`);
      if (error.message.includes('does not exist')) {
        console.log(`      → Run: npm run db:sync`);
      }
    } else {
      console.log(`OK    ${table} (${columns.join(', ')})`);
    }
  }

  console.log('\n[db:verify] Column mapping (DB → JS):');
  for (const [col, note] of Object.entries(CODE_MAPPING)) {
    console.log(`  ${col} → ${note}`);
  }

  if (failed) {
    console.log('\n[db:verify] Schema incomplete. Apply supabase/sync_database.sql first.');
    process.exit(1);
  }

  console.log('\n[db:verify] All required tables/columns are reachable.');
}

main().catch((err) => {
  console.error('[db:verify] Error:', err.message);
  process.exit(1);
});
