-- Ensure provider_profiles is writable (fixes silent company-name save failures on Vercel).
-- Table may already exist from 010_provider_profiles.sql with RLS enabled and no policies.

CREATE TABLE IF NOT EXISTS public.provider_profiles (
  user_id uuid PRIMARY KEY REFERENCES public.users (id) ON DELETE CASCADE,
  company_name text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  service_categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  service_subcategories jsonb NOT NULL DEFAULT '[]'::jsonb,
  custom_subcategories jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.provider_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provider_profiles_select_all" ON public.provider_profiles;
DROP POLICY IF EXISTS "provider_profiles_insert_all" ON public.provider_profiles;
DROP POLICY IF EXISTS "provider_profiles_update_all" ON public.provider_profiles;
DROP POLICY IF EXISTS "provider_profiles_delete_all" ON public.provider_profiles;
DROP POLICY IF EXISTS "provider_profiles_service_all" ON public.provider_profiles;

-- Mirror locations RLS: server uses service_role or anon key from Vercel env.
CREATE POLICY "provider_profiles_select_all"
  ON public.provider_profiles FOR SELECT
  USING (true);

CREATE POLICY "provider_profiles_insert_all"
  ON public.provider_profiles FOR INSERT
  WITH CHECK (true);

CREATE POLICY "provider_profiles_update_all"
  ON public.provider_profiles FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "provider_profiles_delete_all"
  ON public.provider_profiles FOR DELETE
  USING (true);

CREATE POLICY "provider_profiles_service_all"
  ON public.provider_profiles FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.provider_profiles IS 'Mapfix provider company profiles; upserted from /api/provider/profile';
