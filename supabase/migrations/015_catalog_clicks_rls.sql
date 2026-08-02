-- Catalog click counters + RLS (safe to re-run)
CREATE TABLE IF NOT EXISTS public.catalog_clicks (
  click_key text PRIMARY KEY,
  clicks integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_clicks_clicks_idx
  ON public.catalog_clicks (clicks DESC);

ALTER TABLE public.catalog_clicks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "catalog_clicks_anon_all" ON public.catalog_clicks;
DROP POLICY IF EXISTS "catalog_clicks_select_all" ON public.catalog_clicks;
DROP POLICY IF EXISTS "catalog_clicks_insert_all" ON public.catalog_clicks;
DROP POLICY IF EXISTS "catalog_clicks_update_all" ON public.catalog_clicks;
DROP POLICY IF EXISTS "catalog_clicks_service_all" ON public.catalog_clicks;
DROP POLICY IF EXISTS "catalog_clicks_anon_select" ON public.catalog_clicks;

-- Public read (optional popularity), writes only via service_role (server)
CREATE POLICY "catalog_clicks_anon_select"
  ON public.catalog_clicks FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "catalog_clicks_service_all"
  ON public.catalog_clicks FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.catalog_clicks IS 'Mapfix catalog popularity counters; written by API service_role';
