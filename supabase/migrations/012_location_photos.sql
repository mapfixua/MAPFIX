-- Location photos (URLs in jsonb) + Supabase Storage bucket
ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Public bucket for provider location photos (max 5 MB, jpeg/png/webp)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'location-photos',
  'location-photos',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Allow public read; writes go through service role from the API
DROP POLICY IF EXISTS "location_photos_public_read" ON storage.objects;
CREATE POLICY "location_photos_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'location-photos');
