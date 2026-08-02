-- Mapfix hardening: close open RLS, OAuth columns, custom_subcats, orders helpers.
-- Safe to re-run. Prefer service_role for server writes; public read for map locations.

-- OAuth ids on users
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS google_id text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS apple_id text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "googleId" text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "appleId" text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email text;

CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_uidx ON public.users (google_id) WHERE google_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_apple_id_uidx ON public.users (apple_id) WHERE apple_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_googleId_uidx ON public.users ("googleId") WHERE "googleId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_appleId_uidx ON public.users ("appleId") WHERE "appleId" IS NOT NULL;

-- Locations: custom subcats + tighten RLS (server uses service_role)
ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS custom_subcats jsonb DEFAULT '[]'::jsonb;

ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "locations_select_all" ON public.locations;
DROP POLICY IF EXISTS "locations_insert_all" ON public.locations;
DROP POLICY IF EXISTS "locations_update_all" ON public.locations;
DROP POLICY IF EXISTS "locations_delete_all" ON public.locations;
DROP POLICY IF EXISTS "locations_anon_select" ON public.locations;
DROP POLICY IF EXISTS "locations_service_all" ON public.locations;

CREATE POLICY "locations_anon_select"
  ON public.locations FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "locations_service_all"
  ON public.locations FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Password reset tokens: service_role only
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'password_reset_tokens'
  ) THEN
    ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "password_reset_tokens_select_all" ON public.password_reset_tokens;
    DROP POLICY IF EXISTS "password_reset_tokens_insert_all" ON public.password_reset_tokens;
    DROP POLICY IF EXISTS "password_reset_tokens_update_all" ON public.password_reset_tokens;
    DROP POLICY IF EXISTS "password_reset_tokens_delete_all" ON public.password_reset_tokens;
    DROP POLICY IF EXISTS "password_reset_tokens_anon_all" ON public.password_reset_tokens;
    DROP POLICY IF EXISTS "password_reset_tokens_service_all" ON public.password_reset_tokens;
    EXECUTE $p$
      CREATE POLICY "password_reset_tokens_service_all"
        ON public.password_reset_tokens FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true)
    $p$;
  END IF;
END $$;
