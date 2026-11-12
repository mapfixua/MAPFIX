-- Search result count on analytics_events.
-- Nullable. Existing rows are left as they are: this file does not UPDATE history.
-- Safe to re-run. Apply in the Supabase SQL editor (service role). Do not backfill.

ALTER TABLE public.analytics_events
  ADD COLUMN IF NOT EXISTS result_count smallint;

COMMENT ON COLUMN public.analytics_events.result_count IS
  'For search events: how many results the visitor saw. Null on older rows and on non-search events. The same count is also kept in meta.result_count.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'analytics_events_result_count_nonneg'
      AND conrelid = 'public.analytics_events'::regclass
  ) THEN
    ALTER TABLE public.analytics_events
      ADD CONSTRAINT analytics_events_result_count_nonneg
      CHECK (result_count IS NULL OR result_count >= 0);
  END IF;
END $$;
