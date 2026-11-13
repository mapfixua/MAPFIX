-- Fix public.analytics_dashboard on PostgreSQL 17.
-- Apply in the Supabase SQL editor (service role) after 024, before relying on
-- the admin statistics screen. Safe to re-run. Same arguments and JSON shape.
-- This file does not UPDATE analytics_events.
--
-- Migration 024 folds district, category, source and device breakdowns with
-- jsonb_agg(jsonb_build_object(..., sum(...))). PostgreSQL 17 rejects that
-- query with SQLSTATE 42803 (aggregate function calls cannot be nested), so
-- the statistics RPC fails. Those breakdowns are grouped first; jsonb_agg then
-- reads plain columns.
--
-- The other functions from 024 (analytics_grains_for_day, analytics_span_*,
-- analytics_rollup_day, analytics_purge_raw, analytics_event_bounds) do not
-- nest aggregates and stay as they are. EXECUTE on analytics_dashboard stays
-- limited to service_role.

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
  ),
  district_rows AS (
    SELECT
      g.district AS dim_key,
      CASE
        WHEN btrim(COALESCE(p_category, '')) <> ''
          THEN COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = 'view'), 0)
        ELSE COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = '_sessions_area'), 0)
      END AS sessions,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'search'), 0) AS searches,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'impression'), 0) AS impressions,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'view'), 0) AS views,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'call'), 0) AS calls,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'chat'), 0) AS chats,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'directions'), 0) AS directions
    FROM pg_temp._af_grains g
    GROUP BY g.district
  ),
  category_rows AS (
    SELECT
      g.category AS dim_key,
      CASE
        WHEN btrim(COALESCE(p_district, '')) <> ''
          THEN COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = 'view'), 0)
        ELSE COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = '_sessions_cat'), 0)
      END AS sessions,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'search'), 0) AS searches,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'view'), 0) AS views,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'call'), 0) AS calls,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'chat'), 0) AS chats,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'directions'), 0) AS directions
    FROM pg_temp._af_grains g
    GROUP BY g.category
  ),
  source_rows AS (
    SELECT
      g.source AS dim_key,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'view'), 0) AS views,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'call'), 0) AS calls,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'chat'), 0) AS chats,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'directions'), 0) AS directions
    FROM pg_temp._af_grains g
    GROUP BY g.source
  ),
  device_rows AS (
    SELECT
      g.device_type AS dim_key,
      CASE
        WHEN v_place THEN COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = 'view'), 0)
        ELSE COALESCE(sum(g.sessions) FILTER (WHERE g.event_type = '_sessions'), 0)
      END AS sessions,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'view'), 0) AS views,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'call'), 0) AS calls,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'chat'), 0) AS chats,
      COALESCE(sum(g.events) FILTER (WHERE g.event_type = 'directions'), 0) AS directions
    FROM pg_temp._af_grains g
    GROUP BY g.device_type
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
        'key', d.dim_key,
        'sessions', d.sessions,
        'searches', d.searches,
        'impressions', d.impressions,
        'views', d.views,
        'calls', d.calls,
        'chats', d.chats,
        'directions', d.directions
      ))
      FROM district_rows d
    ), '[]'::jsonb),
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'key', c.dim_key,
        'sessions', c.sessions,
        'searches', c.searches,
        'views', c.views,
        'calls', c.calls,
        'chats', c.chats,
        'directions', c.directions
      ))
      FROM category_rows c
    ), '[]'::jsonb),
    'sources', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'key', s.dim_key,
        'views', s.views,
        'calls', s.calls,
        'chats', s.chats,
        'directions', s.directions
      ))
      FROM source_rows s
    ), '[]'::jsonb),
    'devices', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'key', d.dim_key,
        'sessions', d.sessions,
        'views', d.views,
        'calls', d.calls,
        'chats', d.chats,
        'directions', d.directions
      ))
      FROM device_rows d
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

REVOKE ALL ON FUNCTION public.analytics_dashboard(date, date, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_dashboard(date, date, text, text, text, text) TO service_role;
