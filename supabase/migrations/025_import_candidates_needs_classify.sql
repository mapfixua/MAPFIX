-- Places import v2: classification failures stay retryable.
-- Idempotent. Does not publish locations or call Google.
-- One-time repair: rows rejected only because Gemini failed
-- (quota 429, 503, or "This operation was aborted") become needs_classify.

ALTER TABLE public.import_candidates DROP CONSTRAINT IF EXISTS import_candidates_status_chk;

ALTER TABLE public.import_candidates
  ADD CONSTRAINT import_candidates_status_chk
  CHECK (status IN ('pending', 'approved', 'rejected', 'published', 'needs_classify'));

UPDATE public.import_candidates
SET
  status = 'needs_classify',
  needs_review = true,
  reject_reason = NULL,
  updated_at = now()
WHERE status = 'rejected'
  AND reject_reason = 'classify_error';

COMMENT ON COLUMN public.import_candidates.status IS
  'pending, needs_classify (Gemini failed or quota; retry from raw_payload without Google), approved, rejected, published.';
