-- Click counters for catalog popularity sorting (category / subcategory / service)
CREATE TABLE IF NOT EXISTS public.catalog_clicks (
  click_key text PRIMARY KEY,
  clicks integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_clicks_clicks_idx ON public.catalog_clicks (clicks DESC);
