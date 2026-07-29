-- Soft-delete / trash for map locations
ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS deleted_reason text;

CREATE INDEX IF NOT EXISTS idx_locations_deleted_at ON public.locations (deleted_at);
CREATE INDEX IF NOT EXISTS idx_locations_active_cat ON public.locations (cat) WHERE deleted_at IS NULL;
