-- Allow Mapfix server (anon / service key) to read/write locations
-- Run in Supabase SQL Editor after 004_locations_table.sql

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
