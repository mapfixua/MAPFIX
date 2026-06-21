-- Mapfix: passwordless login via Telegram OTP
-- Superseded by supabase/sync_database.sql — run: npm run db:sync
-- Run in Supabase → SQL Editor (table name: users)

-- ---------------------------------------------------------------------------
-- Step 1: Extend users table
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS telegram_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_linked_at timestamptz;

COMMENT ON COLUMN users.phone IS 'E.164 or normalized national phone for OTP login';
COMMENT ON COLUMN users.telegram_id IS 'Telegram chat_id for Bot API sendMessage';
COMMENT ON COLUMN users.telegram_linked_at IS 'When user completed /start link_<token> in bot';

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique
  ON users (phone)
  WHERE phone IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_id_unique
  ON users (telegram_id)
  WHERE telegram_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_phone_lookup
  ON users (phone);

-- ---------------------------------------------------------------------------
-- Step 2: OTP codes (hashed, never plain text)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT otp_codes_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT otp_codes_max_attempts_positive CHECK (max_attempts > 0),
  CONSTRAINT otp_codes_expires_after_created CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_otp_codes_phone_created
  ON otp_codes (phone, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_otp_codes_expires_at
  ON otp_codes (expires_at);

CREATE INDEX IF NOT EXISTS idx_otp_codes_active
  ON otp_codes (phone)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE otp_codes IS 'Short-lived hashed OTP codes for passwordless login';

-- ---------------------------------------------------------------------------
-- Step 3: One-time tokens for t.me/Bot?start=link_<token>
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  phone text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  telegram_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT link_token_expires_after_created CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_token
  ON telegram_link_tokens (token);

CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_user_id
  ON telegram_link_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_expires
  ON telegram_link_tokens (expires_at);

COMMENT ON TABLE telegram_link_tokens IS 'Deep-link tokens to bind telegram_id to user/phone via bot /start';
