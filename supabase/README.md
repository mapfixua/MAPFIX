# Mapfix — Supabase database

## One-shot schema sync

Use **`sync_database.sql`** as the single source of truth. It is idempotent (safe to re-run) and aligns with:

| Table | Used by |
|-------|---------|
| `users` (+ `phone`, `telegram_id`, `telegram_linked_at`) | `supabaseClient.js`, `otp-auth.js`, `telegram-auth.js`, `telegram-bot.js`, `server.js` |
| `otp_codes` | `otp-auth.js` |
| `telegram_link_tokens` | `telegram-auth.js` |

Older files `migrations/001_*.sql` and `002_*.sql` are kept for history; **`sync_database.sql` supersedes them**.

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
