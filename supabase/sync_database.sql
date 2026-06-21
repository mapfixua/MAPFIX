-- =============================================================================
-- Mapfix: sync_database.sql
-- Idempotent full schema sync for passwordless Telegram OTP auth.
--
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- Does NOT drop tables or truncate data.
--
-- Aligns with application code in:
--   supabaseClient.js, otp-auth.js, telegram-auth.js, telegram-bot.js, server.js
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. USERS — extend existing table (core auth + Telegram OTP fields)
-- ---------------------------------------------------------------------------
-- Code expects: id, login, password_hash, role, phone, telegram_id, telegram_linked_at

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_linked_at timestamptz;

COMMENT ON COLUMN users.phone IS 'E.164 normalized phone (+380...) for OTP login';
COMMENT ON COLUMN users.telegram_id IS 'Telegram chat_id for Bot API sendMessage';
COMMENT ON COLUMN users.telegram_linked_at IS 'When user completed /start link_<token> in bot';

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique
  ON users (phone)
  WHERE phone IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_id_unique
  ON users (telegram_id)
  WHERE telegram_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone);
CREATE INDEX IF NOT EXISTS users_phone_lookup ON users (phone);

-- ---------------------------------------------------------------------------
-- 2. OTP_CODES — hashed one-time codes for login
-- ---------------------------------------------------------------------------
-- Code (otp-auth.js) uses: phone, code_hash, expires_at, attempts, max_attempts, consumed_at, created_at

CREATE TABLE IF NOT EXISTS otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS code_hash text;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'otp_codes_attempts_non_negative'
  ) THEN
    ALTER TABLE otp_codes
      ADD CONSTRAINT otp_codes_attempts_non_negative CHECK (attempts >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'otp_codes_max_attempts_positive'
  ) THEN
    ALTER TABLE otp_codes
      ADD CONSTRAINT otp_codes_max_attempts_positive CHECK (max_attempts > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'otp_codes_expires_after_created'
  ) THEN
    ALTER TABLE otp_codes
      ADD CONSTRAINT otp_codes_expires_after_created CHECK (expires_at > created_at);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_otp_codes_phone_created
  ON otp_codes (phone, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_otp_codes_expires_at
  ON otp_codes (expires_at);

CREATE INDEX IF NOT EXISTS idx_otp_codes_active
  ON otp_codes (phone)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE otp_codes IS 'Short-lived hashed OTP codes for passwordless login';

-- ---------------------------------------------------------------------------
-- 3. TELEGRAM_LINK_TOKENS — deep-link tokens for t.me/Bot?start=link_<token>
-- ---------------------------------------------------------------------------
-- Code (telegram-auth.js) uses: token, user_id, phone, expires_at, used_at, telegram_id, created_at

CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  phone text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  telegram_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE telegram_link_tokens ADD COLUMN IF NOT EXISTS token text;
ALTER TABLE telegram_link_tokens ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE telegram_link_tokens ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE telegram_link_tokens ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE telegram_link_tokens ADD COLUMN IF NOT EXISTS used_at timestamptz;
ALTER TABLE telegram_link_tokens ADD COLUMN IF NOT EXISTS telegram_id bigint;
ALTER TABLE telegram_link_tokens ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'link_token_expires_after_created'
  ) THEN
    ALTER TABLE telegram_link_tokens
      ADD CONSTRAINT link_token_expires_after_created CHECK (expires_at > created_at);
  END IF;
EXCEPTION
  WHEN others THEN
    RAISE NOTICE 'link_token_expires_after_created constraint skipped: %', SQLERRM;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS telegram_link_tokens_token_key
  ON telegram_link_tokens (token);

CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_token
  ON telegram_link_tokens (token);

CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_user_id
  ON telegram_link_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_expires
  ON telegram_link_tokens (expires_at);

COMMENT ON TABLE telegram_link_tokens IS 'Deep-link tokens to bind telegram_id to user/phone via bot /start';

COMMIT;

-- ---------------------------------------------------------------------------
-- 4. Post-sync verification (read-only)
-- ---------------------------------------------------------------------------

SELECT
  'users' AS table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'users'
  AND column_name IN ('id', 'login', 'password_hash', 'role', 'phone', 'telegram_id', 'telegram_linked_at')
ORDER BY column_name;

SELECT
  'otp_codes' AS table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'otp_codes'
ORDER BY ordinal_position;

SELECT
  'telegram_link_tokens' AS table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'telegram_link_tokens'
ORDER BY ordinal_position;
