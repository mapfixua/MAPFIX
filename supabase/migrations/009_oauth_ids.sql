-- OAuth identifiers for Google / Apple Sign-In (Mapfix custom auth)
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS google_id text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS apple_id text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "googleId" text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "appleId" text;

CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_uidx ON public.users (google_id) WHERE google_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_apple_id_uidx ON public.users (apple_id) WHERE apple_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_googleId_uidx ON public.users ("googleId") WHERE "googleId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_appleId_uidx ON public.users ("appleId") WHERE "appleId" IS NOT NULL;
