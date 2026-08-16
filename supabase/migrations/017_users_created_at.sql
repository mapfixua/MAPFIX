-- Join date for admin user list (newest first).
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE public.users ALTER COLUMN created_at SET DEFAULT now();

UPDATE public.users u
SET created_at = p.created_at
FROM public.provider_profiles p
WHERE p.user_id = u.id
  AND u.created_at IS NULL
  AND p.created_at IS NOT NULL;
