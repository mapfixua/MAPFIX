'use strict';

/**
 * Rotate local+remote admin password hash (login=admin) using SUPABASE_SERVICE_ROLE_KEY.
 * Pass hash via env NEW_ADMIN_HASH (bcrypt). Does not print secrets.
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
  loadEnvFile(path.join(root, '.env.local'));
  loadEnvFile(path.join(root, '.env.vercel.tmp'));

  const hash = String(process.env.NEW_ADMIN_HASH || '').trim();
  if (!hash.startsWith('$2')) {
    console.error('[admin-rotate] Set NEW_ADMIN_HASH to a bcrypt hash');
    process.exit(1);
  }

  // Always update local users.json fallback
  const usersPath = path.join(root, 'users.json');
  const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  let changed = false;
  for (const u of users) {
    if (String(u.login).toLowerCase() === 'admin') {
      u.passwordHash = hash;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2) + '\n', 'utf8');
    console.log('[admin-rotate] users.json updated');
  }

  // Remote Supabase (if configured)
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    '';
  if (!url || !key) {
    console.log('[admin-rotate] Supabase env missing — local only');
    return;
  }
  const sb = createClient(url, key);
  const table = process.env.SUPABASE_USERS_TABLE || 'users';
  const attempts = [
    { passwordHash: hash },
    { password_hash: hash },
  ];
  let ok = false;
  for (const patch of attempts) {
    const { error } = await sb.from(table).update(patch).eq('login', 'admin');
    if (!error) {
      ok = true;
      console.log('[admin-rotate] Supabase admin password updated via', Object.keys(patch)[0]);
      break;
    }
    console.warn('[admin-rotate] attempt failed:', error.message);
  }
  if (!ok) console.warn('[admin-rotate] could not update Supabase admin row');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
