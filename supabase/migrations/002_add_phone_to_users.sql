-- Mapfix: add phone column to users
-- Superseded by supabase/sync_database.sql — run: npm run db:sync
-- Fixes: column users.phone does not exist
-- Safe to re-run (IF NOT EXISTS). Existing rows keep all data; phone starts as NULL.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone text;

COMMENT ON COLUMN users.phone IS 'E.164 or normalized national phone for OTP login';

CREATE INDEX IF NOT EXISTS idx_users_phone
  ON users (phone);

-- If Telegram OTP linking also fails, run the users section from
-- 001_passwordless_telegram.sql (telegram_id, telegram_linked_at).
