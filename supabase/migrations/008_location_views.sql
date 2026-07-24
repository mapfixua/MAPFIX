-- Optional analytics: location profile open counts
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS views integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.locations.views IS 'How many times the location detail was opened on the map';
