-- Mapfix: booking by hourly slots + service price lists.
-- Safe to re-run.
--
-- After 2026-10-30 Supabase no longer auto-exposes new public tables to the
-- Data API. Grants below are the explicit opt-in. RLS still limits who can
-- read or write: the Node server uses service_role; the map must not see
-- client phones on bookings.

-- ---------------------------------------------------------------------------
-- Masters at a location (the people a client books)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.masters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id text NOT NULL REFERENCES public.locations (id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.users (id) ON DELETE SET NULL,
  display_name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  photo_url text NOT NULL DEFAULT '',
  bio text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS masters_location_idx ON public.masters (location_id);
CREATE INDEX IF NOT EXISTS masters_user_idx ON public.masters (user_id);

COMMENT ON TABLE public.masters IS 'Staff who can be booked at a map location';

-- ---------------------------------------------------------------------------
-- Price list: one row per service at a location
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.location_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id text NOT NULL REFERENCES public.locations (id) ON DELETE CASCADE,
  category_key text NOT NULL DEFAULT '',
  subcategory_key text NOT NULL DEFAULT '',
  name text NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 60,
  price_amount numeric(12, 2),
  currency text NOT NULL DEFAULT 'UAH',
  price_label text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT location_services_duration_chk
    CHECK (duration_minutes > 0 AND duration_minutes <= 480),
  CONSTRAINT location_services_name_uniq UNIQUE (location_id, name)
);

CREATE INDEX IF NOT EXISTS location_services_location_idx
  ON public.location_services (location_id);

COMMENT ON TABLE public.location_services IS 'Per-location price list. price_amount is null when the label is "за домовленістю".';
COMMENT ON COLUMN public.location_services.price_label IS 'Display string, same shape as locations.prices values ("1 200 грн")';

-- Which master performs which service (optional duration/price override)
CREATE TABLE IF NOT EXISTS public.master_services (
  master_id uuid NOT NULL REFERENCES public.masters (id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES public.location_services (id) ON DELETE CASCADE,
  duration_minutes integer,
  price_amount numeric(12, 2),
  is_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (master_id, service_id),
  CONSTRAINT master_services_duration_chk
    CHECK (duration_minutes IS NULL OR (duration_minutes > 0 AND duration_minutes <= 480))
);

COMMENT ON TABLE public.master_services IS 'Services a master can be booked for';

-- ---------------------------------------------------------------------------
-- Weekly grid. Hourly slots are derived from these windows, not stored as rows.
-- weekday: ISO, 1 = Monday … 7 = Sunday
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.master_weekly_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id uuid NOT NULL REFERENCES public.masters (id) ON DELETE CASCADE,
  weekday smallint NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  slot_minutes integer NOT NULL DEFAULT 60,
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT master_weekly_hours_weekday_chk CHECK (weekday BETWEEN 1 AND 7),
  CONSTRAINT master_weekly_hours_range_chk CHECK (end_time > start_time),
  CONSTRAINT master_weekly_hours_slot_chk CHECK (slot_minutes IN (30, 60, 90, 120)),
  CONSTRAINT master_weekly_hours_uniq UNIQUE (master_id, weekday, start_time)
);

CREATE INDEX IF NOT EXISTS master_weekly_hours_master_idx
  ON public.master_weekly_hours (master_id);

COMMENT ON TABLE public.master_weekly_hours IS 'Recurring hours. A day may have two rows (morning and afternoon) when there is a break.';

-- Vacation, day off, or a blocked hour
CREATE TABLE IF NOT EXISTS public.master_time_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id uuid NOT NULL REFERENCES public.masters (id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT master_time_off_range_chk CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS master_time_off_master_idx
  ON public.master_time_off (master_id, starts_at);

COMMENT ON TABLE public.master_time_off IS 'Exceptions that close slots inside the weekly hours';

-- ---------------------------------------------------------------------------
-- A booking occupies [starts_at, ends_at). Pending and confirmed cannot overlap
-- for the same master.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id text NOT NULL REFERENCES public.locations (id) ON DELETE CASCADE,
  master_id uuid NOT NULL REFERENCES public.masters (id) ON DELETE RESTRICT,
  service_id uuid REFERENCES public.location_services (id) ON DELETE SET NULL,
  client_user_id uuid REFERENCES public.users (id) ON DELETE SET NULL,
  client_name text NOT NULL DEFAULT '',
  client_phone text NOT NULL DEFAULT '',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  note text NOT NULL DEFAULT '',
  contact_mode text NOT NULL DEFAULT 'any',
  price_label text NOT NULL DEFAULT '',
  price_amount numeric(12, 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_range_chk CHECK (ends_at > starts_at),
  CONSTRAINT bookings_status_chk
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
  CONSTRAINT bookings_contact_chk
    CHECK (contact_mode IN ('call', 'message', 'any'))
);

CREATE INDEX IF NOT EXISTS bookings_master_start_idx
  ON public.bookings (master_id, starts_at);
CREATE INDEX IF NOT EXISTS bookings_location_start_idx
  ON public.bookings (location_id, starts_at);
CREATE INDEX IF NOT EXISTS bookings_client_idx
  ON public.bookings (client_user_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_master_no_overlap'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_master_no_overlap
      EXCLUDE USING gist (
        master_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
      )
      WHERE (status IN ('pending', 'confirmed'));
  END IF;
END $$;

COMMENT ON TABLE public.bookings IS 'Client appointment. One active booking per master per time range.';

-- ---------------------------------------------------------------------------
-- Tables the app already keeps as JSON blobs, so they exist before 2026-10-30
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.service_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.users (id) ON DELETE SET NULL,
  provider_id uuid REFERENCES public.users (id) ON DELETE SET NULL,
  location_id text REFERENCES public.locations (id) ON DELETE SET NULL,
  service_name text NOT NULL,
  price_label text NOT NULL DEFAULT '',
  preferred_at text,
  note text,
  contact_mode text NOT NULL DEFAULT 'any',
  status text NOT NULL DEFAULT 'Очікує',
  provider_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_orders_contact_chk
    CHECK (contact_mode IN ('call', 'message', 'any'))
);

CREATE INDEX IF NOT EXISTS service_orders_client_idx ON public.service_orders (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS service_orders_provider_idx ON public.service_orders (provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS service_orders_location_idx ON public.service_orders (location_id);

COMMENT ON TABLE public.service_orders IS 'Current "Замовити" requests. App still writes the JSON blob until switched over.';

CREATE TABLE IF NOT EXISTS public.client_favorites (
  client_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES public.locations (id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, location_id)
);

COMMENT ON TABLE public.client_favorites IS 'Saved map points per client';

CREATE TABLE IF NOT EXISTS public.location_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id text NOT NULL REFERENCES public.locations (id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.users (id) ON DELETE SET NULL,
  user_login text NOT NULL DEFAULT '',
  rating smallint NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT location_reviews_rating_chk CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT location_reviews_body_chk CHECK (char_length(body) >= 3)
);

CREATE INDEX IF NOT EXISTS location_reviews_location_idx
  ON public.location_reviews (location_id, created_at DESC);

COMMENT ON TABLE public.location_reviews IS 'Structured reviews. locations.reviews jsonb stays until the app reads this table.';

CREATE TABLE IF NOT EXISTS public.moderation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES public.users (id) ON DELETE SET NULL,
  reporter_login text NOT NULL DEFAULT '',
  contact text NOT NULL DEFAULT '',
  location_id text NOT NULL DEFAULT '',
  location_title text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  message text NOT NULL,
  page text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'new',
  admin_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_reports_status_chk
    CHECK (status IN ('new', 'reviewing', 'resolved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS moderation_reports_status_idx
  ON public.moderation_reports (status, created_at DESC);

COMMENT ON TABLE public.moderation_reports IS 'Site reports and feedback. App still uses the catalog_snapshots blob until switched over.';

-- ---------------------------------------------------------------------------
-- Data API grants (required for tables created on/after 2026-10-30)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'masters',
    'location_services',
    'master_services',
    'master_weekly_hours',
    'master_time_off',
    'bookings',
    'service_orders',
    'client_favorites',
    'location_reviews',
    'moderation_reports'
  ]
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO anon', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Public catalog: names, prices, weekly hours. No client phones.
DROP POLICY IF EXISTS "masters_public_select" ON public.masters;
CREATE POLICY "masters_public_select"
  ON public.masters FOR SELECT
  TO anon, authenticated
  USING (is_active);

DROP POLICY IF EXISTS "location_services_public_select" ON public.location_services;
CREATE POLICY "location_services_public_select"
  ON public.location_services FOR SELECT
  TO anon, authenticated
  USING (is_active);

DROP POLICY IF EXISTS "master_services_public_select" ON public.master_services;
CREATE POLICY "master_services_public_select"
  ON public.master_services FOR SELECT
  TO anon, authenticated
  USING (is_active);

DROP POLICY IF EXISTS "master_weekly_hours_public_select" ON public.master_weekly_hours;
CREATE POLICY "master_weekly_hours_public_select"
  ON public.master_weekly_hours FOR SELECT
  TO anon, authenticated
  USING (is_active);

DROP POLICY IF EXISTS "location_reviews_public_select" ON public.location_reviews;
CREATE POLICY "location_reviews_public_select"
  ON public.location_reviews FOR SELECT
  TO anon, authenticated
  USING (true);

-- Writes and private rows: server service_role only.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'masters',
    'location_services',
    'master_services',
    'master_weekly_hours',
    'master_time_off',
    'bookings',
    'service_orders',
    'client_favorites',
    'location_reviews',
    'moderation_reports'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      t || '_service_all',
      t
    );
  END LOOP;
END $$;
