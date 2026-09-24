# Mapfix — Supabase database

## One-shot schema sync

Use **`sync_database.sql`** as the single source of truth. It is idempotent (safe to re-run) and aligns with:

| Table | Used by |
|-------|---------|
| `users` (+ `phone`, `telegram_id`, `telegram_linked_at`) | `supabaseClient.js`, `otp-auth.js`, `telegram-auth.js`, `telegram-bot.js`, `server.js` |
| `otp_codes` | `otp-auth.js` |
| `telegram_link_tokens` | `telegram-auth.js` |
| `masters`, `master_weekly_hours`, `master_time_off`, `bookings` | schema only (hourly booking; app not switched yet) |
| `location_services`, `master_services` | schema only (price list; `locations.prices` still live) |
| `service_orders`, `client_favorites`, `location_reviews`, `moderation_reports` | schema ready; app still uses JSON blobs |

Older files `migrations/001_*.sql` and `002_*.sql` are kept for history; **`sync_database.sql` supersedes them**.

Booking, prices, orders, favorites, reviews, and reports are in `migrations/018_booking_slots_and_prices.sql`. The app writes orders, favorites, reports, user reviews, and the price list into those tables. Hourly booking still has no screen. Writes need `SUPABASE_SERVICE_ROLE_KEY` because row security blocks the public key.

## Apply automatically

### Option 1 — npm + DATABASE_URL (recommended)

1. Supabase Dashboard → **Project Settings** → **Database**
2. Copy **Connection string** (URI). Use **Direct** or **Session** mode.
3. Add to `.env`:

```env
DATABASE_URL=postgresql://postgres.[PROJECT_REF]:[YOUR_PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
```

4. Install dependencies and run:

```bash
npm install
npm run db:sync
npm run db:verify
```

If providers cannot save **company name**, also run migration  
`supabase/migrations/013_provider_profiles_rls.sql` in the SQL Editor (adds RLS policies for `provider_profiles`).

### Option 2 — Supabase CLI

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
npm run db:sync
```

The script falls back to `supabase db execute --file supabase/sync_database.sql --linked` when `DATABASE_URL` is not set.

### Option 3 — SQL Editor (manual)

1. Open `supabase/sync_database.sql`
2. Supabase Dashboard → **SQL Editor** → paste → **Run**

## Verify without DDL access

```bash
npm run db:verify
```

Probes tables via Supabase REST API and reports missing columns.

## Column naming (DB ↔ code)

| PostgreSQL (snake_case) | JavaScript |
|-------------------------|------------|
| `password_hash` | `passwordHash` |
| `telegram_id` | `telegramId` (via `mapUserRow`) |
| `telegram_linked_at` | `telegramLinkedAt` |
| `code_hash` | stored hashed in `otp-auth.js` |
| `user_id` | UUID from JWT session |
| `used_at` | token consumed timestamp |
| `consumed_at` | OTP used timestamp |

Supabase client returns snake_case; `mapUserRow()` in `supabaseClient.js` normalizes user rows. Telegram bot reads raw rows (`user.telegram_id`) where appropriate.
