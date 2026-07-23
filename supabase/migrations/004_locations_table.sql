-- Mapfix: locations table (persist map points on Vercel via Supabase)
-- Run in SQL Editor. Safe to re-run.

CREATE TABLE IF NOT EXISTS locations (
  id text PRIMARY KEY,
  provider_id uuid,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  cat text NOT NULL DEFAULT 'beauty',
  title text NOT NULL,
  text text DEFAULT '',
  rating numeric DEFAULT 0,
  reviews_count integer DEFAULT 0,
  open_status text DEFAULT 'open',
  working_hours text DEFAULT '09:00 - 18:00',
  phone text DEFAULT '',
  address text DEFAULT '',
  schedule jsonb DEFAULT '{}'::jsonb,
  subcats jsonb DEFAULT '[]'::jsonb,
  prices jsonb DEFAULT '{}'::jsonb,
  reviews jsonb DEFAULT '[]'::jsonb,
  import_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_locations_cat ON locations (cat);
CREATE INDEX IF NOT EXISTS idx_locations_provider ON locations (provider_id);
CREATE INDEX IF NOT EXISTS idx_locations_geo ON locations (lat, lng);

COMMENT ON TABLE locations IS 'Mapfix map points; sync from data.json / import scripts';

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "locations_select_all" ON locations;
DROP POLICY IF EXISTS "locations_insert_all" ON locations;
DROP POLICY IF EXISTS "locations_update_all" ON locations;
DROP POLICY IF EXISTS "locations_delete_all" ON locations;

CREATE POLICY "locations_select_all"
  ON locations FOR SELECT
  USING (true);

CREATE POLICY "locations_insert_all"
  ON locations FOR INSERT
  WITH CHECK (true);

CREATE POLICY "locations_update_all"
  ON locations FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "locations_delete_all"
  ON locations FOR DELETE
  USING (true);
