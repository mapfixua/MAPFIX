const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
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

loadEnvFile();

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  '';

if (!supabaseUrl || !supabaseKey) {
  console.warn('[supabase] Задайте VITE_SUPABASE_URL та VITE_SUPABASE_ANON_KEY у .env');
}

const supabaseClient = createClient(supabaseUrl, supabaseKey);

const USERS_TABLE = process.env.SUPABASE_USERS_TABLE || 'users';

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    login: row.login,
    passwordHash: row.passwordHash ?? row.password_hash ?? null,
    role: row.role,
    phone: row.phone ?? null,
    email: row.email ?? null,
    telegramId: row.telegramId ?? row.telegram_id ?? null,
    telegramLinkedAt: row.telegramLinkedAt ?? row.telegram_linked_at ?? null,
    googleId: row.googleId ?? row.google_id ?? null,
    appleId: row.appleId ?? row.apple_id ?? null,
  };
}

function toUserRow(user) {
  // Live Supabase `users` table uses camelCase `passwordHash` (not password_hash).
  const row = {
    id: user.id,
    login: user.login,
    passwordHash: user.passwordHash,
    role: user.role,
  };
  if (user.phone) row.phone = user.phone;
  if (user.email) row.email = user.email;
  // OAuth columns are added separately — table may not have them yet.
  return row;
}

module.exports = {
  supabaseClient,
  USERS_TABLE,
  mapUserRow,
  toUserRow,
};
