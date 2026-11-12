-- Places import v2 chunks: close import_candidates to anon/authenticated,
-- and add the resumable-run cursor plus the Places response cache.
-- Idempotent. Does not insert or update location rows.
-- Run this in the Supabase SQL editor after 021_places_import_v2.sql.
-- The API reads and writes these tables with SUPABASE_SERVICE_ROLE_KEY only.

ALTER TABLE public.import_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "import_candidates_select_all" ON public.import_candidates;
DROP POLICY IF EXISTS "import_candidates_insert_all" ON public.import_candidates;
DROP POLICY IF EXISTS "import_candidates_update_all" ON public.import_candidates;
DROP POLICY IF EXISTS "import_candidates_delete_all" ON public.import_candidates;
DROP POLICY IF EXISTS "import_candidates_service_all" ON public.import_candidates;

REVOKE ALL ON TABLE public.import_candidates FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.import_candidates TO service_role;

CREATE POLICY "import_candidates_service_all"
  ON public.import_candidates
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.import_runs (
  id text PRIMARY KEY,
  kind text NOT NULL,
  wave text,
  query text,
  status text NOT NULL DEFAULT 'running',
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  text_search_used integer NOT NULL DEFAULT 0,
  details_used integer NOT NULL DEFAULT 0,
  max_text_search integer NOT NULL DEFAULT 800,
  max_details integer NOT NULL DEFAULT 800,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_runs_kind_chk CHECK (kind IN ('wave', 'backfill')),
  CONSTRAINT import_runs_status_chk CHECK (status IN ('running', 'done', 'error'))
);

ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS wave text;
ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS query text;
ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'running';
ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS cursor jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS counts jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS report jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS text_search_used integer NOT NULL DEFAULT 0;
ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS details_used integer NOT NULL DEFAULT 0;
ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS max_text_search integer NOT NULL DEFAULT 800;
ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS max_details integer NOT NULL DEFAULT 800;
ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS locked_until timestamptz;
ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.import_runs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.places_response_cache (
  cache_key text PRIMARY KEY,
  kind text NOT NULL DEFAULT 'text',
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.places_response_cache ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text';
ALTER TABLE public.places_response_cache ADD COLUMN IF NOT EXISTS payload jsonb;
ALTER TABLE public.places_response_cache ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.places_response_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "import_runs_select_all" ON public.import_runs;
DROP POLICY IF EXISTS "import_runs_insert_all" ON public.import_runs;
DROP POLICY IF EXISTS "import_runs_update_all" ON public.import_runs;
DROP POLICY IF EXISTS "import_runs_delete_all" ON public.import_runs;
DROP POLICY IF EXISTS "import_runs_service_all" ON public.import_runs;
DROP POLICY IF EXISTS "places_response_cache_select_all" ON public.places_response_cache;
DROP POLICY IF EXISTS "places_response_cache_insert_all" ON public.places_response_cache;
DROP POLICY IF EXISTS "places_response_cache_update_all" ON public.places_response_cache;
DROP POLICY IF EXISTS "places_response_cache_delete_all" ON public.places_response_cache;
DROP POLICY IF EXISTS "places_response_cache_service_all" ON public.places_response_cache;

REVOKE ALL ON TABLE public.import_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.places_response_cache FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.import_runs TO service_role;
GRANT ALL ON TABLE public.places_response_cache TO service_role;

CREATE POLICY "import_runs_service_all"
  ON public.import_runs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "places_response_cache_service_all"
  ON public.places_response_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.import_runs IS 'Cursor and caps for chunked Places import v2. Service role only.';
COMMENT ON TABLE public.places_response_cache IS 'Places Text Search and Details responses. Service role only. Keys are hashes, not API keys.';
COMMENT ON TABLE public.import_candidates IS 'Staging queue for Places import v2. Service role only. Publishing is a separate admin action.';
