-- Mapfix: persistent catalog for Vercel (admin create category/subcategory/service).
-- Run in Supabase SQL Editor if not applied via CLI.

CREATE TABLE IF NOT EXISTS public.catalog_snapshots (
  id text PRIMARY KEY,
  master_catalog jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.catalog_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "catalog_snapshots_service_all" ON public.catalog_snapshots;
CREATE POLICY "catalog_snapshots_service_all"
  ON public.catalog_snapshots
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Optional: allow anon read if you ever expose catalog without the API.
-- DROP POLICY IF EXISTS "catalog_snapshots_anon_read" ON public.catalog_snapshots;
-- CREATE POLICY "catalog_snapshots_anon_read"
--   ON public.catalog_snapshots FOR SELECT TO anon USING (true);

COMMENT ON TABLE public.catalog_snapshots IS 'Mapfix masterCatalog JSON; id=master is the live snapshot';
