# Mapfix — повний бриф платформи для AI-агента (Grok)

> **Призначення документа:** дати моделі повний контекст, щоб вона могла самостійно писати код змін для mapfix.com.ua / репозиторію MAPFIX.
> **Мова продукту:** українська. **Репозиторій:** `mapfixua/MAPFIX`.
> **Домени:** `https://www.mapfix.com.ua`, прев’ю/прод на Vercel (`mapfix-wine.vercel.app`).
> **Дата зрізу коду:** актуальний `main` (гібрид Express + Supabase + Telegram).

---

## 1. Що це за продукт

**Mapfix** — українська **карта локальних послуг** (не маркетплейс з комісією).

| Аспект | Суть |
|--------|------|
| Ідея | Знайти майстра / бізнес поруч на карті, побачити ціни й відгуки, **подзвонити або залишити заявку напряму** |
| Ринок | Україна, фокус **Київ** + західні райони / Коцюбинське (Святошин, Борщагівка, Академмістечко) |
| Монетизація | Без комісії з угод. Бізнес додається безкоштовно; опційна підписка **99 грн/міс** (ліміти цін/фото), оплата через Mono-банку вручну |
| PWA | Так (`public/manifest.json`, `public/sw.js`) |

**Це НЕ:** checkout з оплатою через платформу, booking слотів (схема є, UI ще немає), React/Next SPA.

**Це ТАК:** карта + каталог + картки точок + кабінет клієнта + кабінет майстра/адміна + імпорт точок + SEO-лендінги районів/послуг.

### Категорії каталогу

`beauty`, `auto`, `repair`, `pets`, `home`, `education`, `sport`, `rental`, `medical`, `food`, `furniture`.

Ієрархія: **категорія → підкатегорія → послуги (items)**. Живе в `masterCatalog` (Supabase `catalog_snapshots` id=`master` + seed у `data.json`).

---

## 2. Для кого (ролі)

| Роль у БД | Хто | Що робить |
|-----------|-----|-----------|
| `client` | Клієнт / споживач | Карта, пошук, дзвінок, улюблене, заявки, відгуки, тікети підтримки |
| `provider` | Бізнес / майстер | Клейм лістингу, редагування точки (ціни, фото, графік), замовлення, профіль, підписка |
| `admin` | Оператор | Усе provider + користувачі, каталог, імпорти, trash, білінг mark-paid, аналітика, модерація |

- Реєстрація дозволяє лише `client` | `provider`.
- `admin` створюється вручну в БД / seed (не через OAuth і не через публічну реєстрацію).
- Клієнт може стати provider через claim / promote / admin `make-provider`.
- Панель `/admin` доступна `provider` і `admin`; клієнтів реджектить `rejectClientFromPanel`.
- Кабінет клієнта: `/client`.

Константи в `server.js`: `VALID_ROLES`, `ADMIN_PANEL_ROLES`, `ALL_KNOWN_ROLES`.

---

## 3. Ціль продукту і KPI-логіка

1. **Discovery:** людина швидко знаходить потрібну послугу біля себе.
2. **Contact:** дзвінок / заявка без посередника.
3. **Supply:** наповнення карти (OSM / Google / Gemini / Telegram / Excel) + клейм бізнесом.
4. **Retention бізнесу:** кабінет, замовлення в Telegram, Pro-підписка.
5. **SEO:** лендінги `/kyiv/...` під запити типу «сантехнік Київ Борщагівка».

Аналітика: кліки по каталогу, page/search/heartbeat events (`analytics.js`, `catalog-clicks-store.js`), ops-digest (`ops-monitor.js`).

---

## 4. Архітектура «де все працює»

```
Browser (static HTML + fetch)
        │  cookie mapfix_auth (JWT HS256)
        ▼
Express app = server.js
        │
        ├─ Vercel: api/index.js → module.exports = require('../server.js')
        │          vercel.json: усі шляхи → /api/index.js, maxDuration 60s
        │
        ├─ Local: npm start → scripts/free-port.js + node server.js :3000
        │
        ▼
Supabase Postgres (+ Storage bucket location-photos)
        │
        ├─ users, otp_codes, telegram_link_tokens, password_reset_tokens
        ├─ locations, provider_profiles, catalog_snapshots, catalog_clicks
        ├─ service_orders, client_favorites, location_reviews, moderation_reports
        ├─ location_services (+ booking tables masters/bookings — schema only)
        │
Telegram Bot (telegraf) ── OTP DM, link account, group ads inbox, order notify
Optional: Gemini (search/import), Google Places, Resend (email)
```

### Важливо про деплой

- **Прод = Vercel serverless Node.** Файлова система **read-only** → не можна покладатися на запис у `data.json` / `orders.json` в проді.
- Тому durable store = **Supabase**; `data.json` = seed / локальний fallback.
- «KV» у проєкті — **не Redis**. Це JSON-блоки в таблиці `catalog_snapshots` через `app-state-store.js` / `kv-store.js` (billing, analytics, oauth_index, support, telegram inbox тощо).

### Env (див. `.env.example`)

Обов’язкові для нормальної роботи: `VITE_SUPABASE_URL` / `SUPABASE_URL`, ключ Supabase (краще `SUPABASE_SERVICE_ROLE_KEY` для серверних записів через RLS), `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`.

Опційні: `GEMINI_API_KEY`, Google Places/Maps, OAuth Google/Apple, `RESEND_API_KEY`, `PUBLIC_BASE_URL`, `TELEGRAM_MODE`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`, `ADMIN_ALERT_EMAIL`, `DATABASE_URL` (для `npm run db:sync`).

---

## 5. Frontend: як влаштований UI

**Не SPA-фреймворк.** Мультисторінкові **static HTML + inline JS**, віддає Express.

| Файл | Роль |
|------|------|
| `public/index.html` | Головна карта (Leaflet), пошук, sheet картки точки, CTA |
| `public/admin.html` | Кабінет майстра **і** адмін-панель (один великий файл) |
| `public/client.html` | Кабінет клієнта |
| `public/login.html`, `register.html` | Логін / реєстрація |
| `public/link-telegram.html` | Прив’язка Telegram |
| `public/forgot-password.html`, `reset-password.html` | Скидання пароля |
| `public/css/mapfix-ui.css` | Спільні стилі |
| `public/mf-analytics.js`, `mapfix-sync.js`, `sw.js` | Аналітика / sync / PWA |

Бренд: teal `#12c4b5`, шрифт Manrope, тайли OSM, український UI.

SEO-рендер карти: `seo.js` + `serveMapPage` у `server.js` — інжект title/description/OG/JSON-LD, шляхи `/`, `/kyiv/...`, `/kiev/...` (аліаси), `/p/:id`, sitemap/robots.

---

## 6. Механіка роботи для користувачів

### 6.1. Клієнт на карті

1. Відкриває `/` або SEO-лендінг.
2. Фронт тягне `GET /api/data` (каталог + локації + кліки).
3. Фільтр категорія / підкатегорія / текст; голосовий/AI пошук → `POST /api/search-ai`.
4. Клік по піну → картка: ціни, відгуки, телефон, маршрут, share, улюблене, «Замовити».
5. Перегляди/кліки: `/api/locations/:id/view`, `/click`, `/api/catalog/click`.

### 6.2. Замовлення

1. Залогінений `client` → `POST /api/orders`.
2. Статус стартує як **`Очікує`**.
3. Provider отримує Telegram (якщо прив’язаний) і/або email (`notifications.js`).
4. Provider: `PATCH /api/provider/orders/:id` — `Очікує` → `В роботі` → `Виконано`.
5. Клієнт може отримати нотифікацію про зміну статусу.

Поля замовлення (орієнтир): `id`, `clientId`, `providerId`, `locationId`, `serviceId` (`loc::name`), `serviceName`, `price`, `preferredAt`, `note`, `contactMode` (`call|message|any`), `status`, `providerNote`, timestamps.

### 6.3. Улюблене і відгуки

- Favorites: `GET/POST/DELETE /api/client/favorites` → таблиця `client_favorites` (з fallback blob/JSON).
- Reviews: `POST /api/locations/:id/reviews` → `location_reviews` + оверлей на локації. Багато відгуків також імпортовані з Google.

### 6.4. Бізнес: клейм і кабінет

1. Реєстрація як `provider` (потрібні `companyName`, опційно `categoryKey`) або promote з client.
2. Клейм існуючої точки:
   - за телефоном на картці: `POST /api/locations/:id/claim-by-phone`;
   - або OTP claim request/confirm (див. provider API в `server.js`).
3. Редагування локацій, цін, фото (Storage), графіка, профілю.
4. Імпорт місць (Google/OSM/Excel) з кабінету.
5. Білінг: trial 90 днів, Pro 99 грн/міс через Mono jar; адмін `mark-paid`. За замовчуванням `limitsEnabled: false` → ліміти вимкнені (режим запуску).

Ліміти коли увімкнено: free — max 3 ціни, 0 фото; paid — безліміт цін, до 6 фото, `mapBoost`.

---

## 7. Авторизація (детально)

**Не використовується Supabase Auth sessions.** Своя схема: **JWT у HTTP-only cookie** + таблиця `users` у Supabase.

### 7.1. Cookie / JWT (`auth-jwt.js`)

| Параметр | Значення |
|----------|----------|
| Cookie | `mapfix_auth` |
| Алгоритм | HS256 (ручний HMAC) |
| Payload | `{ id, login, role, exp }` |
| TTL | 7 днів |
| Прапорці | `httpOnly`, `sameSite: 'lax'`, `secure` на prod/Vercel, `path: '/'` |
| Secret | `JWT_SECRET` або `SESSION_SECRET` |

На кожен запит: middleware `attachAuth` → `req.authUser`.  
Хелпери: `getSessionUser`, `setSessionUser`, `requireAuth`, `requireAdmin`, `requireProvider`, `requireClient`, `requireProviderOrAdmin`.  
`GET /api/me` → `{ loggedIn, user }` (+ `telegramLinked`).  
`POST /api/logout` чистить cookie.  
Rate limit auth: ~40 / 15 хв / IP (`rate-limit.js`).

### 7.2. Логін / пароль

- `POST /api/register` — `login`, `password`, `role`, опційно `email`, `phone`, `companyName`, `categoryKey`.
- `POST /api/login` — `login` + `password`.
- Login: `^[a-z0-9._-]{3,32}$` (латиниця).
- Пароль min 6, bcrypt rounds 10 (`bcryptjs`).
- При реєстрації з телефоном + налаштованим ботом — може одразу створитися telegram link token.

### 7.3. Telegram OTP (passwordless)

Модулі: `otp-auth.js`, `routes/auth.js`, `telegram-bot.js`.

1. Користувач **вже існує** і має **прив’язаний Telegram** + phone.
2. `POST /api/auth/otp/request` `{ phone }` → OTP 6 цифр, HMAC-хеш у `otp_codes`, код у Telegram DM.
3. `POST /api/auth/otp/verify` `{ phone, code }` → cookie.
4. TTL 5 хв, cooldown 60 с, max 5 спроб. Код **ніколи** не повертається в API-відповіді.

OTP **не створює** акаунт — спочатку link Telegram.

### 7.4. Прив’язка Telegram

1. Залогінений юзер: `POST /api/auth/telegram/link` (або UI `/link-telegram.html`) з phone.
2. Створюється рядок у `telegram_link_tokens` (TTL ~15 хв).
3. Deep link: `https://t.me/<TELEGRAM_BOT_USERNAME>?start=link_<token>`.
4. Бот `/start link_<token>` → `consumeTelegramLinkToken` → пише `phone`, `telegram_id`, `telegram_linked_at` у `users`.

### 7.5. Google / Apple OAuth (`oauth-auth.js`)

- `POST /api/auth/google`, `POST /api/auth/apple`.
- `GET /api/auth/oauth-config` — публічні client IDs.
- Lookup: oauth id columns → KV `oauth_index` → email.
- Нові юзери отримують випадковий bcrypt password; `admin` через OAuth **неможливий**.
- Provider через OAuth лише якщо явно `role=provider` + `companyName`.

### 7.6. Скидання пароля (`password-reset.js`)

| Метод | Request | Complete |
|-------|---------|----------|
| phone (Telegram OTP) | `POST /api/auth/password/reset-request` `{ method:'phone', phone }` | `.../reset` + code + newPassword |
| email (Resend link) | `{ method:'email', email }` | token + newPassword |

Email-токени в `password_reset_tokens` (SHA-256), ~30 хв; відповідь без enumeration.

### Публічна форма user

`{ id, login, role, phone, telegramLinked, companyName? }` — пароль/хеш ніколи назовні.

---

## 8. Telegram-боти: як підключені

**Один бот** (telegraf), токен `TELEGRAM_BOT_TOKEN`, username на кшталт `Mapfix_auth_bot`.

### Режим запуску (`telegram-bot.js`)

| Режим | Коли | Як |
|-------|------|-----|
| Polling | Local / `TELEGRAM_MODE=polling` | `bot.launch()` після `deleteWebhook` |
| Webhook | Vercel / `TELEGRAM_MODE=webhook` | `POST /api/telegram/webhook` + `setWebhook(PUBLIC_BASE_URL)` |

Webhook захист: header `x-telegram-bot-api-secret-token` ↔ `TELEGRAM_WEBHOOK_SECRET`.  
Статус: `GET /api/telegram/status`, `GET /api/telegram/webhook`.

### Що робить бот

| Сценарій | Поведінка |
|----------|-----------|
| `/start` | Інструкція прив’язати акаунт із сайту |
| `/start link_<token>` | Прив’язка phone + telegram_id |
| `/help` | Підказки OTP + group ads |
| DM OTP | `sendOtpToTelegram` |
| Нотифікації замовлень | `notifications.js` → `sendTelegramToUserId` |
| Повідомлення в групі/супергрупі | `ingestGroupMessage` → inbox оголошень для адміна |

### Імпорт оголошень з Telegram (`telegram-ads-import.js`)

- Це **не скрейпінг чужих груп автоматично для публіки**.
- Живий inbox: бот у групі (адмін, Privacy Mode off) ловить тексти схожі на оголошення послуг → blob `telegram_group_ads` у `catalog_snapshots` (до ~150).
- Адмін API: `GET/DELETE /api/admin/import-telegram-ads/inbox`, `POST /api/admin/import-telegram-ads`.
- Пайплайн: parse телефони/адреси → Gemini/локальна класифікація каталогу → Nominatim geocode → preview (`dryRun` default true) → confirm пише locations з `importSource: 'telegram_ads'`.
- Також можна залити Desktop JSON / paste текстом.

---

## 9. Модель даних і шари збереження

### Локація (ядро карти)

Ключові поля: `id`, `providerId`, `lat`, `lng`, `cat`, `title`, `text`, `rating`, `reviewsCount`, `openStatus`, `workingHours`, `phone`, `address`, `schedule`, `subcats`, `customSubcats`, `prices` (map `serviceName → "1 200 грн"`), `reviews`, `views`, `photos[]`, `importSource`, `claimedAt`, `deletedAt`, `googlePlaceId`, timestamps.

Soft-delete → trash; purge — hard delete.

### Provider profile

`companyName`, `phone`, `serviceCategories`, `serviceSubcategories`, `customSubcategories`, …

### Catalog

`masterCatalog[catKey] = { name, icon, subcats[subKey] = { name, tags[], items[{name, price?}] } }`.

### Пріоритет читання/запису

| Сутність | Primary | Fallback |
|----------|---------|----------|
| Users | Supabase `users` | — (`users.json` лише legacy seed) |
| Locations / catalog / profiles | Supabase (+ overlay) | `data.json` |
| Orders / favorites / reports / reviews | Relational tables | app-state blob → local JSON |
| Billing / analytics / oauth index / support / TG inbox | `catalog_snapshots` blobs | — |
| Photos | Supabase Storage `location-photos` | — |

`readData()` / `writeData()` у `server.js`: merge seed + Supabase; на Vercel запис JSON може fail — upsert у Supabase обов’язковий.

Мапінг snake_case ↔ camelCase: `mapUserRow()` у `supabaseClient.js`. Код часто толерує обидва варіанти колонок.

Схема: `supabase/sync_database.sql` (idempotent source of truth) + `migrations/*`. Скрипти: `npm run db:sync`, `db:verify`, `db:harden`.

**Booking (masters, bookings, …):** таблиці з migration `018` є, **екранів і API-потоку ще немає** — ціни живі в `locations.prices`, синк у `location_services` при нагоді.

---

## 10. Пошук і AI

`search-ai.js`:

1. Локальний synonym/score по каталогу.
2. Якщо є `GEMINI_API_KEY` — Gemini rank/parse → category/subcategory/service.
3. Хелпери імпорту: `suggestCatalogForPlace`, `classifyPlacesForImport`.

`POST /api/search-ai` (rate limit ~20/хв) → `{ category, subcategory, service, source, confidence, suggestions }`.

---

## 11. SEO (`seo.js`)

- Canonical: `PUBLIC_BASE_URL` або `https://www.mapfix.com.ua`.
- Райони: sviatoshyn, borshchahivka, akademmistechko, kotsiubynske.
- Аліаси шляхів: наприклад `santekhnik` → home/plumber, `shynomontazh` → auto/tyres; `/kiev/...` → canonical `/kyiv/...`.
- `/sitemap.xml`, `/robots.txt`, `public/llms.txt`.
- Cache map HTML: `s-maxage=180`.

---

## 12. Карта API (орієнтир для змін)

### Сторінки

`/`, `/kyiv/*`, `/p/:id`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/link-telegram`, `/client`, `/admin`, `/robots.txt`, `/sitemap.xml`

### Auth

```
GET  /api/me
POST /api/register | /api/login | /api/logout
GET  /api/auth/oauth-config
POST /api/auth/google | /api/auth/apple | /api/auth/telegram/link
POST /api/auth/otp/request | /api/auth/otp/verify
POST /api/auth/password/reset-request | /api/auth/password/reset
GET|POST /api/telegram/webhook
GET  /api/telegram/status
```

### Карта / engagemenт

```
GET  /api/data
POST /api/search-ai
POST /api/catalog/click
POST /api/locations/:id/view | /click | /reviews
POST /api/locations/:id/claim-by-phone
POST /api/analytics/page | search | heartbeat | event
POST /api/reports | /api/feedback
```

### Client

`GET /api/client/dashboard`, favorites CRUD, `POST /api/orders`

### Provider

Dashboard, orders patch, claimable/claim, locations CRUD, photos, prices (+ templates/import), profile, places search/details, import place/excel, geocode reverse

### Billing

`/api/billing/config`, `/entitlements`, `/click`; admin billing + `mark-paid` + settings

### Support / Admin / Ops

Tickets; admin overview/analytics/users/catalog/locations/trash/imports (places, gemini, google URL, telegram, excel, refresh reviews); `GET /api/ops/hourly`, `/api/ops/health`  
Vercel Cron: щодня `0 6 * * *` → `/api/ops/hourly`.

Повна реалізація маршрутів — переважно моноліт **`server.js`** (+ `routes/auth.js` для частини auth).

---

## 13. Карта файлів для правок коду

| Зміна | Куди йти |
|-------|----------|
| Новий API / guards / orders / claim | `server.js` |
| UX карти, sheet, пошук UI | `public/index.html` |
| Кабінет майстра/адміна | `public/admin.html` |
| Кабінет клієнта | `public/client.html` |
| Auth UI | `public/login.html`, `register.html`, `link-telegram.html`, `forgot-password.html`, `reset-password.html` |
| JWT cookie | `auth-jwt.js` |
| OTP | `otp-auth.js`, `routes/auth.js` |
| Telegram link / resolve phone | `telegram-auth.js` |
| Bot runtime / webhook / OTP send | `telegram-bot.js` |
| TG ads import | `telegram-ads-import.js` |
| OAuth | `oauth-auth.js` |
| Password reset | `password-reset.js` |
| Supabase client / user map | `supabaseClient.js` |
| Locations sync | `locations-store.js` |
| Catalog | `catalog-store.js`, `catalog-data.js` |
| Orders/favorites/reviews/reports | `relational-store.js` |
| Blob state | `app-state-store.js`, `kv-store.js` |
| Billing | `billing.js` |
| AI search | `search-ai.js` |
| SEO | `seo.js` |
| Places import | `places-import.js` |
| Photos | `location-photos.js` |
| Notifications | `notifications.js` |
| Analytics / ops | `analytics.js`, `ops-monitor.js` |
| Schema | `supabase/sync_database.sql`, `supabase/migrations/*` |
| Deploy | `vercel.json`, `api/index.js` |
| Seed | `data.json` |
| Env template | `.env.example` |

### Рецепти типових задач

1. **Нова категорія/послуга** — admin catalog API або seed + sync `catalog_snapshots`.
2. **Нова поведінка карти** — `public/index.html` (+ інколи payload `/api/data`).
3. **Нова сутність на Vercel** — спочатку таблиця Supabase + store-модуль; якщо blob — `app-state-store` з унікальним `id`.
4. **Ліміти підписки** — `billing.js` + admin settings `limitsEnabled`.
5. **Новий SEO-лендінг** — `seo.js` (areas/aliases/copy); роутинг `/kyiv/:seg*` уже є.
6. **Зміна логіну/OTP/бота** — ніколи не ламати cookie name/`attachAuth` без міграції клієнтів; OTP вимагає linked telegram.
7. **RLS** — серверні записи з anon key часто падають; для write потрібен `SUPABASE_SERVICE_ROLE_KEY`.

---

## 14. Правила для AI, яка пише код сюди

1. **Мова UI/копірайту** — українська (як у продукті).
2. **Не вводити React/Next**, якщо задача не просить міграцію — стек HTML+Express.
3. **Не писати в локальні JSON як єдине джерело правди** — думати про Vercel + Supabase.
4. **Ролі:** не видавати `admin` через публічні flows; розрізняти `client` vs `provider`.
5. **Безпека:** не логити OTP/паролі; не повертати secrets; зберігати rate limits на auth.
6. **Telegram:** один бот — OTP + link + notify + group inbox; webhook secret на проді.
7. **Колонки:** підтримувати snake_case у Postgres і camelCase у JS через існуючі mapper’и.
8. **Тести локально:** `npm start` на `:3000`; перевірити cookie login, `/api/me`, карту `/api/data`.
9. **Мінімальний диф:** правити лише потрібні файли; `admin.html` / `index.html` / `server.js` величезні — точкові патчі.
10. **Booking-слоти** — schema ready, не підключати UI «заодно», якщо задача про інше.
11. **Коміти:** зрозумілі англійські або українські повідомлення за стилем репо.
12. Перед зміною auth/telegram/billing — перечитай відповідний модуль повністю, не вгадуй контракти.

---

## 15. Швидка ментальна модель (one-liner)

**Mapfix = Express-моноліт на Vercel + Supabase + один Telegram-бот; українська карта послуг Києва, де клієнт знаходить і контактує з майстром напряму, а бізнес клеймить точку й веде заявки без комісії платформи.**

---

## 16. Діаграма auth + Telegram

```
                  ┌─ login/password ──────────────┐
Browser ──────────┼─ Google/Apple OAuth ──────────┼──► set cookie mapfix_auth
                  ├─ OTP phone (потрібен TG link) ┤         │
                  └─ logout /me ──────────────────┘         ▼
                                                     requireAuth* на API
                                                            │
Logged-in user ── POST /api/auth/telegram/link ──► telegram_link_tokens
                                                            │
Telegram user ── /start link_<token> ──► users.telegram_id + phone
                                                            │
                    OTP request ──► otp_codes ──► bot DM code
                    New order ─────► bot DM to provider
                    Group ad text ─► admin inbox (catalog_snapshots)
```

---

*Кінець брифу. Оновлюй цей файл, коли змінюються auth, storage-пріоритети, деплой або ролі.*
