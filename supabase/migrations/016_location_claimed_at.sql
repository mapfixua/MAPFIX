-- Optional claim timestamp for imported locations taken by providers
ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
