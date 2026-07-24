-- Lightweight provider profiles (Vercel-safe; avoids rewriting full data.json)
CREATE TABLE IF NOT EXISTS public.provider_profiles (
  user_id uuid PRIMARY KEY REFERENCES public.users (id) ON DELETE CASCADE,
  company_name text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  service_categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  service_subcategories jsonb NOT NULL DEFAULT '[]'::jsonb,
  custom_subcategories jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.provider_profiles ENABLE ROW LEVEL SECURITY;
