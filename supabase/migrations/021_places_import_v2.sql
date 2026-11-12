-- Mapfix places import v2: place id, review dates, staging queue.
-- Idempotent. Safe to re-run in the Supabase SQL editor.
-- Does not write or update location rows.

ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS google_place_id text;
ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS business_status text;
ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS last_review_at timestamptz;
ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS review_dates jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Unique across every row, including soft-deleted ones. Nulls stay allowed.
CREATE UNIQUE INDEX IF NOT EXISTS locations_google_place_id_unique
  ON public.locations (google_place_id)
  WHERE google_place_id IS NOT NULL;

COMMENT ON COLUMN public.locations.google_place_id IS 'Google Places id (places.googleapis.com). Unique when set, including deleted rows.';
COMMENT ON COLUMN public.locations.review_dates IS 'ISO publishTime values from Place Details reviews.';

CREATE TABLE IF NOT EXISTS public.import_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id text NOT NULL,
  wave text NOT NULL,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_cat text,
  proposed_subcats jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposed_services jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposed_title text,
  proposed_phone text,
  proposed_address text,
  proposed_lat double precision,
  proposed_lng double precision,
  proposed_working_hours text,
  classifier_confidence numeric,
  classifier_reasoning text,
  verification jsonb,
  dedup_status text NOT NULL,
  business_status text,
  review_dates jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_review_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  needs_review boolean NOT NULL DEFAULT false,
  reject_reason text,
  published_location_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_candidates_place_wave_unique UNIQUE (place_id, wave),
  CONSTRAINT import_candidates_status_chk CHECK (status IN ('pending', 'approved', 'rejected', 'published')),
  CONSTRAINT import_candidates_dedup_chk CHECK (
    dedup_status = 'new'
    OR dedup_status LIKE 'duplicate_of %'
    OR dedup_status LIKE 'possible_branch_of %'
    OR dedup_status LIKE 'matches_deleted %'
    OR dedup_status LIKE 'matches_claimed %'
  )
);

ALTER TABLE public.import_candidates ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE public.import_candidates ADD COLUMN IF NOT EXISTS reject_reason text;
ALTER TABLE public.import_candidates ADD COLUMN IF NOT EXISTS published_location_id text;
ALTER TABLE public.import_candidates ADD COLUMN IF NOT EXISTS business_status text;
ALTER TABLE public.import_candidates ADD COLUMN IF NOT EXISTS review_dates jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.import_candidates ADD COLUMN IF NOT EXISTS last_review_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_import_candidates_wave_status
  ON public.import_candidates (wave, status);

CREATE INDEX IF NOT EXISTS idx_import_candidates_place
  ON public.import_candidates (place_id);

COMMENT ON TABLE public.import_candidates IS 'Staging queue for Places import v2. Publishing is a separate admin action.';

ALTER TABLE public.import_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "import_candidates_select_all" ON public.import_candidates;
DROP POLICY IF EXISTS "import_candidates_insert_all" ON public.import_candidates;
DROP POLICY IF EXISTS "import_candidates_update_all" ON public.import_candidates;
DROP POLICY IF EXISTS "import_candidates_delete_all" ON public.import_candidates;

CREATE POLICY "import_candidates_select_all"
  ON public.import_candidates FOR SELECT
  USING (true);

CREATE POLICY "import_candidates_insert_all"
  ON public.import_candidates FOR INSERT
  WITH CHECK (true);

CREATE POLICY "import_candidates_update_all"
  ON public.import_candidates FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "import_candidates_delete_all"
  ON public.import_candidates FOR DELETE
  USING (true);
