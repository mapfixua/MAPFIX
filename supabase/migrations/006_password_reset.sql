-- Mapfix: password recovery via email + optional email on users
-- Run in Supabase SQL Editor. Safe to re-run.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;

COMMENT ON COLUMN users.email IS 'Optional email for password recovery';

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
  ON users (email)
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_expires_after_created CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
  ON password_reset_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash
  ON password_reset_tokens (token_hash);

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "password_reset_select_all" ON password_reset_tokens;
DROP POLICY IF EXISTS "password_reset_insert_all" ON password_reset_tokens;
DROP POLICY IF EXISTS "password_reset_update_all" ON password_reset_tokens;

CREATE POLICY "password_reset_select_all"
  ON password_reset_tokens FOR SELECT USING (true);

CREATE POLICY "password_reset_insert_all"
  ON password_reset_tokens FOR INSERT WITH CHECK (true);

CREATE POLICY "password_reset_update_all"
  ON password_reset_tokens FOR UPDATE USING (true) WITH CHECK (true);

-- users.email readable/writable with existing anon usage (if RLS on users)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'
  ) THEN
    -- no-op if users has no RLS; policies only apply when RLS enabled
    NULL;
  END IF;
END $$;
