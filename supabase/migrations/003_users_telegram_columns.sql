-- Minimal fix if users.telegram_id is still missing
-- Safe to re-run. Prefer full supabase/sync_database.sql when possible.

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_linked_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique
  ON users (phone) WHERE phone IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_id_unique
  ON users (telegram_id) WHERE telegram_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone);
