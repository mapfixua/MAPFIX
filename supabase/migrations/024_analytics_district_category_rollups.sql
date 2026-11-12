-- Wave 1 statistics: district + category on new events, and daily rollups.
-- Apply in the Supabase SQL editor (service role) after 023. The app does not run this file.
-- Safe to re-run. Nullable columns. This file does not UPDATE analytics_events:
-- old rows stay without a district and show up as «невідомо». No mass history rewrite.
--
-- Rollups are replaced per closed Kyiv day (delete + insert), so a second cron run
-- or the backfill script writes the same numbers again. Raw events: 180 days,
-- impressions: 14 days, deleted in batches of 5000. Today is never rolled up;
-- the statistics screen reads it from analytics_events. Older days come only from
-- the rollup tables.

ALTER TABLE public.analytics_events
  ADD COLUMN IF NOT EXISTS result_count smallint;

ALTER TABLE public.analytics_events
  ADD COLUMN IF NOT EXISTS district text;

ALTER TABLE public.analytics_events
  ADD COLUMN IF NOT EXISTS category text;

COMMENT ON COLUMN public.analytics_events.district IS
  'Card district set by the server: sviatoshyn, borshchahivka, akademmistechko, kotsiubynske, or kyiv. Null on older rows and on events with no card. The client does not send this.';

COMMENT ON COLUMN public.analytics_events.category IS
  'locations.cat at the time of the event, set by the server. Null when the event has no card.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'analytics_events_result_count_nonneg'
      AND conrelid = 'public.analytics_events'::regclass
  ) THEN
    ALTER TABLE public.analytics_events
      ADD CONSTRAINT analytics_events_result_count_nonneg
      CHECK (result_count IS NULL OR result_count >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS analytics_events_district_created_idx
  ON public.analytics_events (district, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_category_created_idx
  ON public.analytics_events (category, created_at DESC);

CREATE TABLE IF NOT EXISTS public.analytics_daily (
  day date NOT NULL,
  event_type text NOT NULL,
  district text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  device_type text NOT NULL DEFAULT '',
  events integer NOT NULL DEFAULT 0,
  sessions integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event_type, district, category, source, device_type),
  CONSTRAINT analytics_daily_nonneg CHECK (events >= 0 AND sessions >= 0)
);

CREATE TABLE IF NOT EXISTS public.analytics_search_daily (
  day date NOT NULL,
  q text NOT NULL,
  district text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  device_type text NOT NULL DEFAULT '',
  zero boolean NOT NULL DEFAULT false,
  events integer NOT NULL DEFAULT 0,
  result_count_sum integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, q, district, category, source, device_type, zero),
  CONSTRAINT analytics_search_daily_nonneg CHECK (events >= 0 AND result_count_sum >= 0),
  CONSTRAINT analytics_search_daily_q_len CHECK (char_length(q) <= 80)
);

CREATE TABLE IF NOT EXISTS public.analytics_location_daily (
  day date NOT NULL,
  location_id text NOT NULL,
  district text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  device_type text NOT NULL DEFAULT '',
  impressions integer NOT NULL DEFAULT 0,
  views integer NOT NULL DEFAULT 0,
  calls integer NOT NULL DEFAULT 0,
  chats integer NOT NULL DEFAULT 0,
  directions integer NOT NULL DEFAULT 0,
  shares integer NOT NULL DEFAULT 0,
  favorites integer NOT NULL DEFAULT 0,
  orders integer NOT NULL DEFAULT 0,
  claims integer NOT NULL DEFAULT 0,
  reports integer NOT NULL DEFAULT 0,
  dives integer NOT NULL DEFAULT 0,
  reviews integer NOT NULL DEFAULT 0,
  map_focus integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, location_id, district, category, source, device_type),
  CONSTRAINT analytics_location_daily_nonneg CHECK (
    impressions >= 0 AND views >= 0 AND calls >= 0 AND chats >= 0 AND directions >= 0
    AND shares >= 0 AND favorites >= 0 AND orders >= 0 AND claims >= 0 AND reports >= 0
    AND dives >= 0 AND reviews >= 0 AND map_focus >= 0
  )
);

CREATE INDEX IF NOT EXISTS analytics_location_daily_loc_idx
  ON public.analytics_location_daily (location_id, day);

COMMENT ON TABLE public.analytics_daily IS
  'Kyiv day × event type × district × category × source × device. Replaced per closed day. _sessions, _sessions_area, _sessions_cat and map_load are rollup-only rows.';
COMMENT ON TABLE public.analytics_search_daily IS
  'Search phrases (lower case, at most 80 characters) per Kyiv day. zero marks a search with no results.';
COMMENT ON TABLE public.analytics_location_daily IS
  'Per card, per Kyiv day, split by the same filters as the statistics screen so Excel matches the filter.';

ALTER TABLE public.analytics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_search_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_location_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "analytics_daily_service_all" ON public.analytics_daily;
CREATE POLICY "analytics_daily_service_all"
  ON public.analytics_daily FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "analytics_search_daily_service_all" ON public.analytics_search_daily;
CREATE POLICY "analytics_search_daily_service_all"
  ON public.analytics_search_daily FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "analytics_location_daily_service_all" ON public.analytics_location_daily;
CREATE POLICY "analytics_location_daily_service_all"
  ON public.analytics_location_daily FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.analytics_daily FROM anon, authenticated;
REVOKE ALL ON public.analytics_search_daily FROM anon, authenticated;
REVOKE ALL ON public.analytics_location_daily FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_daily TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_search_daily TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_location_daily TO service_role;

-- Helpers. Match analytics-dimensions.js (sourceKey, deviceKey, isZeroSearch, clipQuery).

CREATE OR REPLACE FUNCTION public.analytics_event_source(
  p_source text, p_medium text, p_campaign text, p_host text
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN NULLIF(btrim(p_source), '') IS NOT NULL THEN left(concat_ws(
      ' / ',
      btrim(p_source),
      NULLIF(btrim(p_medium), ''),
      NULLIF(btrim(p_campaign), '')
    ), 120)
    WHEN NULLIF(btrim(p_host), '') IS NOT NULL THEN left(btrim(p_host), 120)
    ELSE 'direct'
  END
$$;

CREATE OR REPLACE FUNCTION public.analytics_event_device(p_device text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lower(btrim(COALESCE(p_device, ''))) IN ('mobile', 'tablet', 'desktop')
      THEN lower(btrim(p_device))
    ELSE ''
  END
$$;

CREATE OR REPLACE FUNCTION public.analytics_search_q(p_meta jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT left(lower(btrim(COALESCE(p_meta->>'q', ''))), 80)
$$;

CREATE OR REPLACE FUNCTION public.analytics_search_zero(p_count smallint, p_meta jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_count = 0 THEN true
    WHEN p_count > 0 THEN false
    WHEN COALESCE(p_meta->>'zero', '') IN ('1', 'true') THEN true
    WHEN lower(COALESCE(p_meta->>'matched', '')) IN ('false', '0') THEN true
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION public.analytics_dim_match(p_filter text, p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_filter IS NULL OR btrim(p_filter) = '' THEN true
    WHEN p_filter = '__unknown__' THEN COALESCE(p_value, '') = ''
    ELSE p_value = p_filter
  END
$$;

CREATE OR REPLACE FUNCTION public.analytics_is_public_event(p_role text, p_path text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(p_role, '') <> 'admin'
    AND COALESCE(p_path, '') <> '/admin'
    AND COALESCE(p_path, '') <> '/admin.html'
    AND COALESCE(p_path, '') NOT LIKE '/admin/%'
$$;

CREATE OR REPLACE FUNCTION public.analytics_grains_for_day(p_day date)
RETURNS TABLE (
  day date,
  event_type text,
  district text,
  category text,
  source text,
  device_type text,
  events integer,
  sessions integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from timestamptz := (p_day::timestamp AT TIME ZONE 'Europe/Kyiv');
  v_to timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'Europe/Kyiv');
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      e.event_type AS et,
      COALESCE(NULLIF(btrim(e.district), ''), '') AS dist,
      COALESCE(NULLIF(btrim(e.category), ''), '') AS cat,
      public.analytics_event_source(e.utm_source, e.utm_medium, e.utm_campaign, e.referrer_host) AS src,
      public.analytics_event_device(e.device_type) AS dev,
      e.session_id AS sid,
      e.path AS pth
    FROM public.analytics_events e
    WHERE e.created_at >= v_from
      AND e.created_at < v_to
      AND public.analytics_is_public_event(e.user_role, e.path)
  )
  SELECT p_day, b.et, b.dist, b.cat, b.src, b.dev,
         count(*)::integer, count(DISTINCT b.sid)::integer
  FROM base b
  GROUP BY b.et, b.dist, b.cat, b.src, b.dev
  UNION ALL
  SELECT p_day, 'map_load'::text, b.dist, b.cat, b.src, b.dev,
         count(*)::integer, count(DISTINCT b.sid)::integer
  FROM base b
  WHERE b.et = 'page_view' AND b.pth IN ('/', '/index.html')
  GROUP BY b.dist, b.cat, b.src, b.dev
  UNION ALL
  SELECT p_day, '_sessions'::text, ''::text, ''::text, b.src, b.dev,
         0, count(DISTINCT b.sid)::integer
  FROM base b
  WHERE b.sid IS NOT NULL
  GROUP BY b.src, b.dev
  UNION ALL
  SELECT p_day, '_sessions_area'::text, b.dist, ''::text, b.src, b.dev,
         0, count(DISTINCT b.sid)::integer
  FROM base b
  WHERE b.sid IS NOT NULL
  GROUP BY b.dist, b.src, b.dev
  UNION ALL
  SELECT p_day, '_sessions_cat'::text, ''::text, b.cat, b.src, b.dev,
         0, count(DISTINCT b.sid)::integer
  FROM base b
  WHERE b.sid IS NOT NULL
  GROUP BY b.cat, b.src, b.dev;
END;
$$;

CREATE OR REPLACE FUNCTION public.analytics_search_rows_for_day(p_day date)
RETURNS TABLE (
  day date,
  q text,
  district text,
  category text,
  source text,
  device_type text,
  zero boolean,
  events integer,
  result_count_sum integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from timestamptz := (p_day::timestamp AT TIME ZONE 'Europe/Kyiv');
  v_to timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'Europe/Kyiv');
BEGIN
  RETURN QUERY
  SELECT
    p_day,
    s.q,
    s.dist,
    s.cat,
    s.src,
    s.dev,
    s.is_zero,
    count(*)::integer,
    COALESCE(sum(s.result_count), 0)::integer
  FROM (
    SELECT
      public.analytics_search_q(e.meta) AS q,
      COALESCE(NULLIF(btrim(e.district), ''), '') AS dist,
      COALESCE(NULLIF(btrim(e.category), ''), '') AS cat,
      public.analytics_event_source(e.utm_source, e.utm_medium, e.utm_campaign, e.referrer_host) AS src,
      public.analytics_event_device(e.device_type) AS dev,
      public.analytics_search_zero(e.result_count, e.meta) AS is_zero,
      e.result_count
    FROM public.analytics_events e
    WHERE e.event_type = 'search'
      AND e.created_at >= v_from
      AND e.created_at < v_to
      AND public.analytics_is_public_event(e.user_role, e.path)
  ) s
  WHERE s.q <> ''
  GROUP BY s.q, s.dist, s.cat, s.src, s.dev, s.is_zero;
END;
$$;

CREATE OR REPLACE FUNCTION public.analytics_location_rows_for_day(p_day date)
RETURNS TABLE (
  day date,
  location_id text,
  district text,
  category text,
  source text,
  device_type text,
  impressions integer,
  views integer,
  calls integer,
  chats integer,
  directions integer,
  shares integer,
  favorites integer,
  orders integer,
  claims integer,
  reports integer,
  dives integer,
  reviews integer,
  map_focus integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from timestamptz := (p_day::timestamp AT TIME ZONE 'Europe/Kyiv');
  v_to timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'Europe/Kyiv');
BEGIN
  RETURN QUERY
  SELECT
    p_day,
    left(btrim(e.location_id), 80),
    COALESCE(NULLIF(btrim(e.district), ''), ''),
    COALESCE(NULLIF(btrim(e.category), ''), ''),
    public.analytics_event_source(e.utm_source, e.utm_medium, e.utm_campaign, e.referrer_host),
    public.analytics_event_device(e.device_type),
    count(*) FILTER (WHERE e.event_type = 'impression')::integer,
    count(*) FILTER (WHERE e.event_type = 'view')::integer,
    count(*) FILTER (WHERE e.event_type = 'call')::integer,
    count(*) FILTER (WHERE e.event_type = 'chat')::integer,
    count(*) FILTER (WHERE e.event_type = 'directions')::integer,
    count(*) FILTER (WHERE e.event_type = 'share')::integer,
    count(*) FILTER (WHERE e.event_type = 'favorite')::integer,
    count(*) FILTER (WHERE e.event_type = 'order')::integer,
    count(*) FILTER (WHERE e.event_type = 'claim')::integer,
    count(*) FILTER (WHERE e.event_type = 'report')::integer,
    count(*) FILTER (WHERE e.event_type = 'dive')::integer,
    count(*) FILTER (WHERE e.event_type = 'review')::integer,
    count(*) FILTER (WHERE e.event_type = 'map_focus')::integer
  FROM public.analytics_events e
  WHERE e.created_at >= v_from
    AND e.created_at < v_to
    AND NULLIF(btrim(e.location_id), '') IS NOT NULL
    AND public.analytics_is_public_event(e.user_role, e.path)
    AND e.event_type IN (
      'impression', 'view', 'call', 'chat', 'directions', 'share', 'favorite',
      'order', 'claim', 'report', 'dive', 'review', 'map_focus'
    )
  GROUP BY 2, 3, 4, 5, 6;
END;
$$;

-- Replace one closed Kyiv day. Running it twice leaves the same rows.
CREATE OR REPLACE FUNCTION public.analytics_rollup_day(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (timezone('Europe/Kyiv', now()))::date;
  v_grains integer := 0;
  v_searches integer := 0;
  v_locations integer := 0;
BEGIN
  IF p_day IS NULL OR p_day >= v_today THEN
    RETURN jsonb_build_object('ok', false, 'skipped', 'open_day', 'day', p_day);
  END IF;

  DELETE FROM public.analytics_daily WHERE day = p_day;
  INSERT INTO public.analytics_daily (day, event_type, district, category, source, device_type, events, sessions)
  SELECT g.day, g.event_type, g.district, g.category, g.source, g.device_type, g.events, g.sessions
  FROM public.analytics_grains_for_day(p_day) g;
  GET DIAGNOSTICS v_grains = ROW_COUNT;

  DELETE FROM public.analytics_search_daily WHERE day = p_day;
  INSERT INTO public.analytics_search_daily (
    day, q, district, category, source, device_type, zero, events, result_count_sum
  )
  SELECT s.day, s.q, s.district, s.category, s.source, s.device_type, s.zero, s.events, s.result_count_sum
  FROM public.analytics_search_rows_for_day(p_day) s;
  GET DIAGNOSTICS v_searches = ROW_COUNT;

  DELETE FROM public.analytics_location_daily WHERE day = p_day;
  INSERT INTO public.analytics_location_daily (
    day, location_id, district, category, source, device_type,
    impressions, views, calls, chats, directions, shares, favorites, orders,
    claims, reports, dives, reviews, map_focus
  )
  SELECT
    l.day, l.location_id, l.district, l.category, l.source, l.device_type,
    l.impressions, l.views, l.calls, l.chats, l.directions, l.shares, l.favorites, l.orders,
    l.claims, l.reports, l.dives, l.reviews, l.map_focus
  FROM public.analytics_location_rows_for_day(p_day) l;
  GET DIAGNOSTICS v_locations = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'day', p_day,
    'grains', v_grains,
    'searches', v_searches,
    'locations', v_locations
  );
END;
$$;

-- Delete at most p_limit impression rows older than 14 Kyiv days, then the same
-- number of other raw rows older than 180 Kyiv days. Rollup tables are kept.
CREATE OR REPLACE FUNCTION public.analytics_purge_raw(p_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 5000), 1), 5000);
  v_today date := (timezone('Europe/Kyiv', now()))::date;
  v_imp integer := 0;
  v_old integer := 0;
BEGIN
  WITH doomed AS (
    SELECT id
    FROM public.analytics_events
    WHERE event_type = 'impression'
      AND created_at < (v_today - 14)::timestamp AT TIME ZONE 'Europe/Kyiv'
    ORDER BY id
    LIMIT v_limit
  )
  DELETE FROM public.analytics_events e
  USING doomed d
  WHERE e.id = d.id;
  GET DIAGNOSTICS v_imp = ROW_COUNT;

  WITH doomed AS (
    SELECT id
    FROM public.analytics_events
    WHERE event_type IS DISTINCT FROM 'impression'
      AND created_at < (v_today - 180)::timestamp AT TIME ZONE 'Europe/Kyiv'
    ORDER BY id
    LIMIT v_limit
  )
  DELETE FROM public.analytics_events e
  USING doomed d
  WHERE e.id = d.id;
  GET DIAGNOSTICS v_old = ROW_COUNT;

  RETURN jsonb_build_object('impressions', v_imp, 'events', v_old, 'limit', v_limit);
END;
$$;

CREATE OR REPLACE FUNCTION public.analytics_event_bounds()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'min', (SELECT (min(created_at) AT TIME ZONE 'Europe/Kyiv')::date FROM public.analytics_events),
    'max', (SELECT (max(created_at) AT TIME ZONE 'Europe/Kyiv')::date FROM public.analytics_events)
  );
$$;

CREATE OR REPLACE FUNCTION public.analytics_span_grains(
  p_from date,
  p_to date,
  p_district text,
  p_category text,
  p_source text,
  p_device text
) RETURNS TABLE (
  day date,
  event_type text,
  district text,
  category text,
  source text,
  device_type text,
  events integer,
  sessions integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (timezone('Europe/Kyiv', now()))::date;
BEGIN
  RETURN QUERY
  WITH raw_days AS (
    SELECT gs::date AS raw_day
    FROM generate_series(p_from, p_to, interval '1 day') gs
    WHERE gs::date >= v_today
       OR (
         gs::date = v_today - 1
         AND NOT EXISTS (SELECT 1 FROM public.analytics_daily x WHERE x.day = v_today - 1)
       )
  ),
  hist AS (
    SELECT d.day, d.event_type, d.district, d.category, d.source, d.device_type, d.events, d.sessions
    FROM public.analytics_daily d
    WHERE d.day BETWEEN p_from AND p_to
      AND d.day < v_today
      AND NOT EXISTS (SELECT 1 FROM raw_days r WHERE r.raw_day = d.day)
  ),
  raw AS (
    SELECT g.day, g.event_type, g.district, g.category, g.source, g.device_type, g.events, g.sessions
    FROM raw_days r
    CROSS JOIN LATERAL public.analytics_grains_for_day(r.raw_day) g
  ),
  united AS (
    SELECT * FROM hist
    UNION ALL
    SELECT * FROM raw
  )
  SELECT u.day, u.event_type, u.district, u.category, u.source, u.device_type, u.events, u.sessions
  FROM united u
  WHERE public.analytics_dim_match(p_district, u.district)
    AND public.analytics_dim_match(p_category, u.category)
    AND public.analytics_dim_match(p_source, u.source)
    AND public.analytics_dim_match(p_device, u.device_type);
END;
$$;

CREATE OR REPLACE FUNCTION public.analytics_span_searches(
  p_from date,
  p_to date,
  p_district text,
  p_category text,
  p_source text,
  p_device text
) RETURNS TABLE (
  day date,
  q text,
  district text,
  events integer,
  zero_events integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (timezone('Europe/Kyiv', now()))::date;
BEGIN
  RETURN QUERY
  WITH raw_days AS (
    SELECT gs::date AS raw_day
    FROM generate_series(p_from, p_to, interval '1 day') gs
    WHERE gs::date >= v_today
       OR (
         gs::date = v_today - 1
         AND NOT EXISTS (SELECT 1 FROM public.analytics_search_daily x WHERE x.day = v_today - 1)
       )
  ),
  hist AS (
    SELECT s.day, s.q, s.district, s.category, s.source, s.device_type, s.zero, s.events
    FROM public.analytics_search_daily s
    WHERE s.day BETWEEN p_from AND p_to
      AND s.day < v_today
      AND NOT EXISTS (SELECT 1 FROM raw_days r WHERE r.raw_day = s.day)
  ),
  raw AS (
    SELECT s.day, s.q, s.district, s.category, s.source, s.device_type, s.zero, s.events
    FROM raw_days r
    CROSS JOIN LATERAL public.analytics_search_rows_for_day(r.raw_day) s
  ),
  united AS (
    SELECT * FROM hist
    UNION ALL
    SELECT * FROM raw
  )
  SELECT
    u.day,
    u.q,
    u.district,
    sum(u.events)::integer,
    COALESCE(sum(u.events) FILTER (WHERE u.zero), 0)::integer
  FROM united u
  WHERE public.analytics_dim_match(p_district, u.district)
    AND public.analytics_dim_match(p_category, u.category)
    AND public.analytics_dim_match(p_source, u.source)
    AND public.analytics_dim_match(p_device, u.device_type)
  GROUP BY u.day, u.q, u.district;
END;
$$;

CREATE OR REPLACE FUNCTION public.analytics_span_locations(
  p_from date,
  p_to date,
  p_district text,
  p_category text,
  p_source text,
  p_device text
) RETURNS TABLE (
  location_id text,
  impressions integer,
  views integer,
  calls integer,
  chats integer,
  directions integer,
  shares integer,
  favorites integer,
  orders integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (timezone('Europe/Kyiv', now()))::date;
BEGIN
  RETURN QUERY
  WITH raw_days AS (
    SELECT gs::date AS raw_day
    FROM generate_series(p_from, p_to, interval '1 day') gs
    WHERE gs::date >= v_today
       OR (
         gs::date = v_today - 1
         AND NOT EXISTS (SELECT 1 FROM public.analytics_location_daily x WHERE x.day = v_today - 1)
       )
  ),
  hist AS (
    SELECT
      l.day, l.location_id, l.district, l.category, l.source, l.device_type,
      l.impressions, l.views, l.calls, l.chats, l.directions, l.shares, l.favorites, l.orders
    FROM public.analytics_location_daily l
    WHERE l.day BETWEEN p_from AND p_to
      AND l.day < v_today
      AND NOT EXISTS (SELECT 1 FROM raw_days r WHERE r.raw_day = l.day)
  ),
  raw AS (
    SELECT
      l.day, l.location_id, l.district, l.category, l.source, l.device_type,
      l.impressions, l.views, l.calls, l.chats, l.directions, l.shares, l.favorites, l.orders
    FROM raw_days r
    CROSS JOIN LATERAL public.analytics_location_rows_for_day(r.raw_day) l
  ),
  united AS (
    SELECT * FROM hist
    UNION ALL
    SELECT * FROM raw
  )
  SELECT
    u.location_id,
    sum(u.impressions)::integer,
    sum(u.views)::integer,
    sum(u.calls)::integer,
    sum(u.chats)::integer,
    sum(u.directions)::integer,
    sum(u.shares)::integer,
    sum(u.favorites)::integer,
    sum(u.orders)::integer
  FROM united u
  WHERE public.analytics_dim_match(p_district, u.district)
    AND public.analytics_dim_match(p_category, u.category)
    AND public.analytics_dim_match(p_source, u.source)
    AND public.analytics_dim_match(p_device, u.device_type)
  GROUP BY u.location_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.analytics_dashboard(
  p_from date,
  p_to date,
  p_district text DEFAULT '',
  p_category text DEFAULT '',
  p_source text DEFAULT '',
  p_device text DEFAULT ''
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (timezone('Europe/Kyiv', now()))::date;
  v_from date := p_from;
  v_to date := p_to;
  v_hist_end date;
  v_expected integer := 0;
  v_rolled integer := 0;
  v_place boolean;
  v_result jsonb;
BEGIN
  IF v_from IS NULL OR v_to IS NULL THEN
    RETURN jsonb_build_object('error', 'bad_range');
  END IF;
  IF v_to < v_from THEN
    v_hist_end := v_from;
    v_from := v_to;
    v_to := v_hist_end;
  END IF;
  IF v_to - v_from > 366 THEN
    v_from := v_to - 366;
  END IF;

  v_place := btrim(COALESCE(p_district, '')) <> '' OR btrim(COALESCE(p_category, '')) <> '';
  v_hist_end := LEAST(v_to, v_today - 2);
  IF v_from <= v_hist_end THEN
    v_expected := (v_hist_end - v_from) + 1;
    SELECT count(DISTINCT d.day) INTO v_rolled
    FROM public.analytics_daily d
    WHERE d.day BETWEEN v_from AND v_hist_end;
  END IF;

  DROP TABLE IF EXISTS pg_temp._af_grains;
  DROP TABLE IF EXISTS pg_temp._af_all;
  DROP TABLE IF EXISTS pg_temp._af_searches;
  DROP TABLE IF EXISTS pg_temp._af_locations;
  CREATE TEMP TABLE _af_grains ON COMMIT DROP AS
    SELECT * FROM public.analytics_span_grains(v_from, v_to, p_district, p_category, p_source, p_device);
  CREATE TEMP TABLE _af_all ON COMMIT DROP AS
    SELECT * FROM public.analytics_span_grains(v_from, v_to, '', '', '', '');
  CREATE TEMP TABLE _af_searches ON COMMIT DROP AS
    SELECT * FROM public.analytics_span_searches(v_from, v_to, p_district, p_category, p_source, p_device);
  CREATE TEMP TABLE _af_locations ON COMMIT DROP AS
    SELECT * FROM public.analytics_span_locations(v_from, v_to, p_district, p_category, p_source, p_device);

  WITH days AS (
    SELECT
      g.day,
      CASE
        WHEN btrim(COALESCE(p_district, '')) <> '' AND btrim(COALESCE(p_category, '')) = ''
          THEN COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = '_sessions_area'), 0)
        WHEN btrim(COALESCE(p_category, '')) <> '' AND btrim(COALESCE(p_district, '')) = ''
          THEN COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = '_sessions_cat'), 0)
        WHEN btrim(COALESCE(p_district, '')) <> '' AND btrim(COALESCE(p_category, '')) <> ''
          THEN COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = 'view'), 0)
        ELSE COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = '_sessions'), 0)
      END::integer AS sessions,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'page_view'), 0)::integer AS page_views,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'map_load'), 0)::integer AS map_loads,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'search'), 0)::integer AS searches,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'impression'), 0)::integer AS impressions,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'view'), 0)::integer AS views,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'call'), 0)::integer AS calls,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'chat'), 0)::integer AS chats,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'directions'), 0)::integer AS directions,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'favorite'), 0)::integer AS favorites,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'share'), 0)::integer AS shares,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'order'), 0)::integer AS orders,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'dive'), 0)::integer AS dives,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'map_focus'), 0)::integer AS map_focus,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'claim'), 0)::integer AS claims,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'review'), 0)::integer AS reviews,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'report'), 0)::integer AS reports,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'login'), 0)::integer AS logins,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'register'), 0)::integer AS registers
    FROM pg_temp._af_grains g
    GROUP BY g.day
  ),
  day_zeros AS (
    SELECT s.day, COALESCE(sum(s.zero_events), 0)::integer AS zero_searches
    FROM pg_temp._af_searches s
    GROUP BY s.day
  )
  SELECT jsonb_build_object(
    'partial', v_rolled < v_expected,
    'from', v_from,
    'to', v_to,
    'totals', (
      SELECT jsonb_build_object(
        'sessions', COALESCE(sum(sessions), 0),
        'pageViews', COALESCE(sum(page_views), 0),
        'mapLoads', COALESCE(sum(map_loads), 0),
        'searches', COALESCE(sum(searches), 0),
        'zeroSearches', COALESCE((SELECT sum(z.zero_searches) FROM day_zeros z), 0),
        'impressions', COALESCE(sum(impressions), 0),
        'views', COALESCE(sum(views), 0),
        'calls', COALESCE(sum(calls), 0),
        'chats', COALESCE(sum(chats), 0),
        'directions', COALESCE(sum(directions), 0),
        'favorites', COALESCE(sum(favorites), 0),
        'shares', COALESCE(sum(shares), 0),
        'orders', COALESCE(sum(orders), 0),
        'dives', COALESCE(sum(dives), 0),
        'mapFocus', COALESCE(sum(map_focus), 0),
        'claims', COALESCE(sum(claims), 0),
        'reviews', COALESCE(sum(reviews), 0),
        'reports', COALESCE(sum(reports), 0),
        'logins', COALESCE(sum(logins), 0),
        'registers', COALESCE(sum(registers), 0)
      )
      FROM days
    ),
    'days', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'day', d.day,
        'sessions', d.sessions,
        'pageViews', d.page_views,
        'mapLoads', d.map_loads,
        'searches', d.searches,
        'zeroSearches', COALESCE(z.zero_searches, 0),
        'impressions', d.impressions,
        'views', d.views,
        'calls', d.calls,
        'chats', d.chats,
        'directions', d.directions,
        'favorites', d.favorites,
        'shares', d.shares,
        'orders', d.orders,
        'logins', d.logins
      ) ORDER BY d.day)
      FROM days d
      LEFT JOIN day_zeros z ON z.day = d.day
    ), '[]'::jsonb),
    'districts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'key', g.district,
        'sessions', CASE
          WHEN btrim(COALESCE(p_category, '')) <> ''
            THEN COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = 'view'), 0)
          ELSE COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = '_sessions_area'), 0)
        END,
        'searches', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'search'), 0),
        'impressions', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'impression'), 0),
        'views', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'view'), 0),
        'calls', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'call'), 0),
        'chats', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'chat'), 0),
        'directions', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'directions'), 0)
      ))
      FROM pg_temp._af_grains g
      GROUP BY g.district
    ), '[]'::jsonb),
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'key', g.category,
        'sessions', CASE
          WHEN btrim(COALESCE(p_district, '')) <> ''
            THEN COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = 'view'), 0)
          ELSE COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = '_sessions_cat'), 0)
        END,
        'searches', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'search'), 0),
        'views', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'view'), 0),
        'calls', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'call'), 0),
        'chats', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'chat'), 0),
        'directions', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'directions'), 0)
      ))
      FROM pg_temp._af_grains g
      GROUP BY g.category
    ), '[]'::jsonb),
    'sources', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'key', g.source,
        'views', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'view'), 0),
        'calls', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'call'), 0),
        'chats', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'chat'), 0),
        'directions', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'directions'), 0)
      ))
      FROM pg_temp._af_grains g
      GROUP BY g.source
    ), '[]'::jsonb),
    'devices', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'key', g.device_type,
        'sessions', CASE
          WHEN v_place THEN COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = 'view'), 0)
          ELSE COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = '_sessions'), 0)
        END,
        'views', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'view'), 0),
        'calls', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'call'), 0),
        'chats', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'chat'), 0),
        'directions', COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'directions'), 0)
      ))
      FROM pg_temp._af_grains g
      GROUP BY g.device_type
    ), '[]'::jsonb),
    'searches', COALESCE((
      SELECT jsonb_agg(row_to_json(s)::jsonb)
      FROM (
        SELECT q, district, sum(events)::integer AS events, sum(zero_events)::integer AS "zeroEvents"
        FROM pg_temp._af_searches
        GROUP BY q, district
        ORDER BY sum(events) DESC, q
        LIMIT 500
      ) s
    ), '[]'::jsonb),
    'locations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', l.location_id,
        'impressions', l.impressions,
        'views', l.views,
        'calls', l.calls,
        'chats', l.chats,
        'directions', l.directions,
        'shares', l.shares,
        'favorites', l.favorites,
        'orders', l.orders
      ))
      FROM pg_temp._af_locations l
    ), '[]'::jsonb),
    'options', jsonb_build_object(
      'districts', COALESCE((
        SELECT jsonb_agg(DISTINCT a.district)
        FROM pg_temp._af_all a
        WHERE left(a.event_type, 1) <> '_' AND a.event_type <> 'map_load'
      ), '[]'::jsonb),
      'categories', COALESCE((
        SELECT jsonb_agg(DISTINCT a.category)
        FROM pg_temp._af_all a
        WHERE left(a.event_type, 1) <> '_' AND a.event_type <> 'map_load'
      ), '[]'::jsonb),
      'sources', COALESCE((
        SELECT jsonb_agg(DISTINCT a.source)
        FROM pg_temp._af_all a
        WHERE left(a.event_type, 1) <> '_' AND a.event_type <> 'map_load'
      ), '[]'::jsonb),
      'devices', COALESCE((
        SELECT jsonb_agg(DISTINCT a.device_type)
        FROM pg_temp._af_all a
        WHERE left(a.event_type, 1) <> '_' AND a.event_type <> 'map_load'
      ), '[]'::jsonb)
    )
  ) INTO v_result;

  IF v_result IS NULL THEN
    v_result := jsonb_build_object(
      'partial', v_rolled < v_expected,
      'from', v_from,
      'to', v_to,
      'totals', '{}'::jsonb,
      'days', '[]'::jsonb,
      'districts', '[]'::jsonb,
      'categories', '[]'::jsonb,
      'sources', '[]'::jsonb,
      'devices', '[]'::jsonb,
      'searches', '[]'::jsonb,
      'locations', '[]'::jsonb,
      'options', jsonb_build_object('districts', '[]'::jsonb, 'categories', '[]'::jsonb, 'sources', '[]'::jsonb, 'devices', '[]'::jsonb)
    );
  ELSE
    v_result := jsonb_set(v_result, '{partial}', to_jsonb(v_rolled < v_expected));
  END IF;

  -- Attach zero-search counts onto district rows (phrase table, not the event grain).
  v_result := jsonb_set(
    v_result,
    '{districts}',
    COALESCE((
      SELECT jsonb_agg(
        d.elem || jsonb_build_object('zeroSearches', COALESCE(z.zero_events, 0))
      )
      FROM jsonb_array_elements(v_result->'districts') d(elem)
      LEFT JOIN (
        SELECT district, sum(zero_events)::integer AS zero_events
        FROM pg_temp._af_searches
        GROUP BY district
      ) z ON z.district = d.elem->>'key'
    ), '[]'::jsonb)
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_event_source(text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_event_device(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_search_q(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_search_zero(smallint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_dim_match(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_is_public_event(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_grains_for_day(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_search_rows_for_day(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_location_rows_for_day(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_rollup_day(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_purge_raw(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_event_bounds() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_span_grains(date, date, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_span_searches(date, date, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_span_locations(date, date, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_dashboard(date, date, text, text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.analytics_event_source(text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_event_device(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_search_q(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_search_zero(smallint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_dim_match(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_is_public_event(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_grains_for_day(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_search_rows_for_day(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_location_rows_for_day(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_rollup_day(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_purge_raw(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_event_bounds() TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_span_grains(date, date, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_span_searches(date, date, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_span_locations(date, date, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_dashboard(date, date, text, text, text, text) TO service_role;
