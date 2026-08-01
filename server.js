const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const crypto = require('crypto');
const { validateCatalogHierarchy } = require('./catalog-data.js');
const { parseVoiceSearch, suggestCatalogForPlace, classifyPlacesForImport } = require('./search-ai.js');
const { attachAuth, setAuthCookie, clearAuthCookie } = require('./auth-jwt.js');
const { resolveProjectRoot, resolvePublicDir } = require('./paths.js');
const {
  supabaseClient,
  USERS_TABLE,
  mapUserRow,
  toUserRow,
} = require('./supabaseClient.js');
const {
  isTelegramConfigured,
  mountTelegramWebhook,
  startTelegramBotRuntime,
  getTelegramStatus,
} = require('./telegram-bot.js');
const {
  createTelegramLinkToken,
  getTelegramBotLink,
  getTelegramIdForPhone,
  normalizePhone,
  updateUserPhone,
} = require('./telegram-auth.js');
const { createAuthRouter } = require('./routes/auth.js');
let oauthPublicConfig = () => ({
  googleClientId: '',
  appleClientId: '',
  googleEnabled: false,
  appleEnabled: false,
});
let signInWithGoogle = async () => ({ ok: false, error: 'google_not_configured' });
let signInWithApple = async () => ({ ok: false, error: 'apple_not_configured' });
try {
  const oauth = require('./oauth-auth.js');
  oauthPublicConfig = oauth.oauthPublicConfig;
  signInWithGoogle = oauth.signInWithGoogle;
  signInWithApple = oauth.signInWithApple;
} catch (oauthLoadErr) {
  console.error('[oauth] module unavailable:', oauthLoadErr.message);
}
const {
  fetchOsmPlaces,
  fetchGooglePlaces,
  searchGooglePlacesText,
  fetchGooglePlaceDetails,
  googlePlaceToLocation,
  importPlaceFromGoogleMapsUrl,
  importExcelRowsToLocations,
  mergeLocations,
  CITY_PRESETS,
  CATEGORY_OSM_FILTERS,
  resolveCity,
  parseCsv,
  csvRowToLocation,
  PROVIDER_IMPORT_TEMPLATE_CSV,
  buildCityImportCandidates,
} = require('./places-import.js');
const {
  fetchLocationsFromSupabase,
  syncAllLocationsToSupabase,
  upsertLocationsToSupabase,
  deleteLocationsFromSupabase,
} = require('./locations-store.js');
const {
  fetchCatalogFromSupabase,
  upsertCatalogToSupabase,
  pruneStaleEmptyCategories,
  mergeCatalog,
} = require('./catalog-store.js');
const {
  fetchProviderProfilesMap,
  upsertProviderProfile,
} = require('./provider-profiles-store.js');
const {
  categoryClickKey,
  subcategoryClickKey,
  serviceClickKey,
  fetchCatalogClicksMap,
  incrementCatalogClick,
} = require('./catalog-clicks-store.js');
const {
  MAX_PHOTOS,
  normalizePhotos,
  uploadLocationPhoto,
  deleteLocationPhotoFile,
} = require('./location-photos.js');

const LOGIN_RE = /^[a-z0-9._-]{3,32}$/;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const IS_VERCEL = !!process.env.VERCEL;

const app = express();
if (IS_VERCEL) app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const ROOT = resolveProjectRoot();
const PUBLIC_DIR = resolvePublicDir(ROOT);
if (IS_VERCEL) {
  console.log('[vercel] ROOT:', ROOT, 'PUBLIC_DIR:', PUBLIC_DIR);
  console.log('[vercel] login.html exists:', fs.existsSync(path.join(PUBLIC_DIR, 'login.html')));
}
const DATA_FILE = path.join(ROOT, 'data.json');
const ORDERS_FILE = path.join(ROOT, 'orders.json');
const FAVORITES_FILE = path.join(ROOT, 'favorites.json');
const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.SESSION_SECRET ||
  'mapfix-dev-secret-change-in-production';
const BCRYPT_ROUNDS = 10;
const VALID_ROLES = ['client', 'provider'];
const ADMIN_PANEL_ROLES = ['provider', 'admin'];
const ALL_KNOWN_ROLES = ['client', 'provider', 'admin'];
const ORDER_STATUSES = ['Очікує', 'В роботі', 'Виконано'];

app.use(express.json({ limit: '7mb' }));
app.use(cookieParser());
app.use(attachAuth(JWT_SECRET));

// Always mount webhook routes (health GET + POST). Delivery mode starts later.
mountTelegramWebhook(app);
if (isTelegramConfigured()) {
  console.log('[telegram] Routes ready: GET/POST /api/telegram/webhook');
}
function makeKey(name, existingKeys) {
  let base = String(name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9а-яіїєґ_]/gi, '')
    .slice(0, 50);
  if (!base) base = 'key_' + Date.now().toString(36);
  let key = base;
  let n = 1;
  while (existingKeys.includes(key)) key = `${base}_${n++}`;
  return key;
}

function firstEmoji(text) {
  const m = String(text).match(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u);
  return m ? m[0] : '📍';
}

function isValidPrice(price) {
  // Must contain at least one digit (allows "650", "650 грн", "від 500 грн").
  return /\d/.test(String(price || '').trim());
}

function formatPrice(price) {
  const p = String(price).trim();
  if (!isValidPrice(p)) {
    throw new Error('INVALID_PRICE');
  }
  if (/грн/i.test(p)) return p;
  return `${p} грн`;
}

function normalizePricesMap(prices) {
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return {};
  const out = {};
  for (const [rawName, rawPrice] of Object.entries(prices)) {
    const name = String(rawName || '').trim();
    const price = String(rawPrice || '').trim();
    if (!name || !isValidPrice(price)) continue;
    try {
      out[name] = formatPrice(price);
    } catch {
      /* skip invalid */
    }
  }
  return out;
}

function catalogWriteError(writeResult) {
  if (writeResult?.catalogOk || writeResult?.localOk) return null;
  if (writeResult?.catalogMissing) {
    return 'Виконайте міграцію 007_catalog_snapshots.sql у Supabase (таблиця catalog_snapshots)';
  }
  return 'Не вдалося зберегти каталог. Перевірте Supabase або права запису';
}

function getSessionUser(req) {
  return req.authUser || null;
}

function setSessionUser(res, user) {
  setAuthCookie(res, user, JWT_SECRET);
}

function canAccessAdmin(req) {
  const user = getSessionUser(req);
  return user && ADMIN_PANEL_ROLES.includes(user.role);
}

function rejectClientFromPanel(req, res, next) {
  const user = getSessionUser(req);
  if (user?.role === 'client') {
    return res.status(403).json({ error: 'Клієнти не мають доступу до панелі провайдера' });
  }
  next();
}

function requireAuth(req, res, next) {
  if (!getSessionUser(req)) {
    return res.status(401).json({ error: 'Потрібен вхід у систему' });
  }
  next();
}

function requireAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Доступ лише для суперадміна' });
  }
  next();
}

function requireProvider(req, res, next) {
  const user = getSessionUser(req);
  if (!user || user.role !== 'provider') {
    return res.status(403).json({ error: 'Доступ лише для провайдера' });
  }
  next();
}

function requireProviderOrAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!user || (user.role !== 'provider' && user.role !== 'admin')) {
    return res.status(403).json({ error: 'Доступ лише для провайдера або адміна' });
  }
  next();
}

function canManageLocation(loc, user) {
  if (!loc || !user) return false;
  if (user.role === 'admin') return true;
  return loc.providerId === user.id;
}

function requireClient(req, res, next) {
  const user = getSessionUser(req);
  if (!user || user.role !== 'client') {
    return res.status(403).json({ error: 'Доступ лише для клієнта' });
  }
  next();
}

function makeServiceId(locationId, serviceName) {
  return `${locationId}::${serviceName}`;
}

async function readOrders() {
  try {
    const raw = await fsPromises.readFile(ORDERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeOrders(orders) {
  await fsPromises.writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

async function readFavorites() {
  try {
    const raw = await fsPromises.readFile(FAVORITES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeFavorites(favorites) {
  await fsPromises.writeFile(FAVORITES_FILE, JSON.stringify(favorites, null, 2), 'utf8');
}

function enrichOrder(order, data, users) {
  const loc = findLocation(data, order.locationId);
  const client = users.find((u) => u.id === order.clientId);
  const provider = order.providerId
    ? users.find((u) => u.id === order.providerId)
    : null;
  return {
    ...order,
    locationTitle: loc?.title || '—',
    locationAddress: loc?.address || '',
    clientLogin: client?.login || '—',
    providerLogin: provider?.login || '—',
    companyName: order.providerId
      ? data.providerProfiles[order.providerId]?.companyName
      : null,
  };
}

function normalizeServiceCategories(input, masterCatalog) {
  if (!Array.isArray(input)) return [];
  const validKeys = new Set(Object.keys(masterCatalog || {}));
  return [
    ...new Set(
      input.map((key) => String(key).trim()).filter((key) => validKeys.has(key))
    ),
  ];
}

function normalizeServiceSubcategories(input, masterCatalog) {
  if (!Array.isArray(input)) return [];
  const result = [];
  for (const raw of input) {
    const category = String(raw?.category || '').trim();
    const subcategory = String(raw?.subcategory || '').trim();
    const cat = masterCatalog?.[category];
    const sub = cat?.subcats?.[subcategory];
    if (!sub) continue;
    const validNames = new Set((sub.items || []).map((item) => item.name));
    const wholeSub =
      raw.wholeSubcategory === true ||
      raw.allServices === true ||
      raw.selectAll === true;
    let services = [];
    if (wholeSub) {
      services = [...validNames];
    } else if (Array.isArray(raw.services)) {
      services = [
        ...new Set(
          raw.services
            .map((name) => String(name).trim())
            .filter((name) => validNames.has(name))
        ),
      ];
    }
    if (services.length) {
      result.push({ category, subcategory, services });
    }
  }
  return result;
}

function normalizeCustomSubcategories(input, masterCatalog) {
  if (!Array.isArray(input)) return [];
  const validCats = new Set(Object.keys(masterCatalog || {}));
  const result = [];
  for (const raw of input) {
    const category = String(raw?.category || '').trim();
    const name = String(raw?.name || raw?.subcategoryName || '').trim();
    if (!validCats.has(category) || name.length < 2) continue;
    const services = Array.isArray(raw.services)
      ? [
          ...new Set(
            raw.services.map((s) => String(s).trim()).filter(Boolean)
          ),
        ]
      : [];
    result.push({ category, name, services });
  }
  return result;
}

function mergeProviderServiceCategories(categories, subcategorySelections, customSubcategories) {
  const merged = new Set(categories);
  subcategorySelections.forEach((entry) => merged.add(entry.category));
  (customSubcategories || []).forEach((entry) => merged.add(entry.category));
  return [...merged];
}

function isLocationTrashed(loc) {
  return Boolean(loc && loc.deletedAt);
}

function isImportedLocation(loc) {
  if (!loc) return false;
  if (loc.importSource) return true;
  if (String(loc.id || '').startsWith('loc-imp-')) return true;
  return false;
}

function activeLocations(list) {
  return (list || []).filter((l) => !isLocationTrashed(l));
}

function trashedLocations(list) {
  return (list || []).filter((l) => isLocationTrashed(l));
}

function locationMatchesBulkFilter(loc, filter = {}) {
  if (!loc) return false;
  if (filter.onlyImported && !isImportedLocation(loc)) return false;
  if (filter.onlyActive && isLocationTrashed(loc)) return false;
  if (filter.onlyTrashed && !isLocationTrashed(loc)) return false;
  if (filter.cat && loc.cat !== filter.cat) return false;
  if (filter.subcategory) {
    const subs = Array.isArray(loc.subcats) ? loc.subcats : [];
    if (!subs.includes(filter.subcategory)) return false;
  }
  if (Array.isArray(filter.ids) && filter.ids.length) {
    if (!filter.ids.includes(loc.id)) return false;
  }
  return true;
}

function ensureDataShape(data) {
  if (!data.providerProfiles) data.providerProfiles = {};
  if (!data.mockLocations) data.mockLocations = [];
  if (!data.masterCatalog) data.masterCatalog = {};
  data.mockLocations.forEach((loc) => {
    if (loc.providerId === undefined) loc.providerId = null;
    if (!Array.isArray(loc.subcats)) loc.subcats = loc.subcats ? [].concat(loc.subcats) : [];
    if (!Array.isArray(loc.photos)) loc.photos = [];
  });
  Object.values(data.providerProfiles).forEach((profile) => {
    if (!Array.isArray(profile.serviceCategories)) profile.serviceCategories = [];
    if (!Array.isArray(profile.serviceSubcategories)) profile.serviceSubcategories = [];
    if (!Array.isArray(profile.customSubcategories)) profile.customSubcategories = [];
  });
  return data;
}

async function readData() {
  const raw = await fsPromises.readFile(DATA_FILE, 'utf8');
  const data = ensureDataShape(JSON.parse(raw));
  const fileCatalog = data.masterCatalog;

  // Prefer Supabase locations when table is populated (Vercel-safe persistence)
  try {
    const remote = await fetchLocationsFromSupabase();
    if (remote.ok && remote.locations.length > 0) {
      data.mockLocations = remote.locations;
    }
  } catch (err) {
    console.warn('[readData] Supabase locations skip:', err.message);
  }

  // Merge seeded data.json catalog with live Supabase snapshot (admin edits)
  try {
    const remoteCat = await fetchCatalogFromSupabase();
    if (remoteCat.ok && remoteCat.catalog) {
      data.masterCatalog = mergeCatalog(fileCatalog, remoteCat.catalog);
    }
  } catch (err) {
    console.warn('[readData] Supabase catalog skip:', err.message);
  }

  pruneStaleEmptyCategories(data.masterCatalog);

  try {
    const remoteProfiles = await fetchProviderProfilesMap();
    if (remoteProfiles.ok && remoteProfiles.profiles) {
      data.providerProfiles = {
        ...data.providerProfiles,
        ...remoteProfiles.profiles,
      };
    }
  } catch (err) {
    console.warn('[readData] Supabase provider profiles skip:', err.message);
  }

  return data;
}

async function writeData(data) {
  const payload = ensureDataShape(data);
  pruneStaleEmptyCategories(payload.masterCatalog);
  console.log('[writeData]', DATA_FILE, 'locations:', payload.mockLocations?.length ?? 0);
  let localOk = false;
  try {
    await fsPromises.writeFile(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
    localOk = true;
    console.log('[writeData] OK');
  } catch (err) {
    // On Vercel filesystem is read-only — continue to Supabase sync
    console.warn('[writeData] local file skip:', err.message);
  }

  let catalogOk = false;
  let catalogMissing = false;
  try {
    const catSync = await upsertCatalogToSupabase(payload.masterCatalog);
    catalogOk = Boolean(catSync.ok);
    catalogMissing = Boolean(catSync.missing);
    if (catSync.ok) {
      console.log('[writeData] Supabase catalog synced');
    } else if (catSync.error) {
      console.warn('[writeData] Supabase catalog sync:', catSync.error.message);
    }
  } catch (err) {
    console.warn('[writeData] Supabase catalog error:', err.message);
  }

  try {
    const sync = await syncAllLocationsToSupabase(payload.mockLocations);
    if (sync.ok) {
      console.log('[writeData] Supabase locations synced:', sync.count);
    } else if (sync.error) {
      console.warn('[writeData] Supabase locations sync:', sync.error.message);
    }
  } catch (err) {
    console.warn('[writeData] Supabase locations error:', err.message);
  }

  return { localOk, catalogOk, catalogMissing };
}

async function readUsers() {
  const { data, error } = await supabaseClient.from(USERS_TABLE).select('*');
  if (error) throw new Error(error.message);
  return (data || []).map(mapUserRow).filter(Boolean);
}

async function findUserByLogin(inputLogin) {
  const { data, error } = await supabaseClient
    .from(USERS_TABLE)
    .select('*')
    .eq('login', inputLogin)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return mapUserRow(data);
}

async function getUserProfile(userId, data) {
  return data.providerProfiles[userId] || null;
}

async function toPublicUserWithProfile(user, data) {
  const base = {
    id: user.id,
    login: user.login,
    role: user.role,
    phone: user.phone || null,
    telegramLinked: Boolean(user.telegramId),
  };
  if (user.role === 'provider') {
    const profile = await getUserProfile(user.id, data);
    if (profile) base.companyName = profile.companyName;
  }
  return base;
}

function findLocation(data, id) {
  return data.mockLocations.find((l) => l.id === id);
}

function ownsLocation(loc, userId) {
  return loc && loc.providerId === userId;
}

function formatLocationPhone(raw) {
  const phoneRaw = String(raw || '').trim();
  if (!phoneRaw) return '';
  const normalized = normalizePhone(phoneRaw);
  return normalized.replace(/\D/g, '').length >= 10 ? normalized : phoneRaw;
}

function defaultLocation(providerId, body) {
  return {
    id: 'loc-' + crypto.randomUUID().slice(0, 8),
    providerId,
    lat: Number(body.lat) || 50.45,
    lng: Number(body.lng) || 30.52,
    cat: body.cat || 'beauty',
    title: body.title?.trim() || 'Нова точка',
    text: body.text?.trim() || '',
    rating: 0,
    reviewsCount: 0,
    openStatus: body.openStatus === 'closed' ? 'closed' : 'open',
    workingHours: body.workingHours?.trim() || '09:00 - 18:00',
    phone: formatLocationPhone(body.phone),
    address: body.address?.trim() || '',
    schedule: body.schedule || { 'Пн-Пт': '09:00 - 18:00' },
    subcats: Array.isArray(body.subcats) ? body.subcats : [],
    customSubcats:
      body.customSubcats && typeof body.customSubcats === 'object' ? body.customSubcats : {},
    prices: normalizePricesMap(body.prices),
    reviews: [],
    views: 0,
    photos: normalizePhotos(body.photos),
  };
}

/** Persist only changed locations — avoids full catalog/location rewrite hangs on Vercel. */
async function persistLocationsPatch(data, changedLocs) {
  const payload = ensureDataShape(data);
  try {
    await fsPromises.writeFile(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.warn('[persistLocationsPatch] local skip:', err.message);
  }
  if (Array.isArray(changedLocs) && changedLocs.length) {
    const sync = await upsertLocationsToSupabase(changedLocs);
    if (!sync.ok) {
      console.warn('[persistLocationsPatch] supabase:', sync.error?.message || sync.error);
      return { ok: false, error: sync.error };
    }
  }
  return { ok: true };
}

function sendPublicPage(res, filename) {
  const filePath = path.resolve(PUBLIC_DIR, filename);
  res.set('Cache-Control', 'no-store');
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error('[sendPublicPage]', { filename, filePath, publicDir: PUBLIC_DIR, err: err.message });
      if (!res.headersSent) {
        res.status(err.statusCode || 404).send(`Cannot serve ${filename}`);
      }
    }
  });
}

app.get('/', (req, res) => {
  sendPublicPage(res, 'index.html');
});

app.get('/login.html', (req, res) => {
  sendPublicPage(res, 'login.html');
});

app.get('/login', (req, res) => {
  const next = req.query.next ? `?next=${encodeURIComponent(req.query.next)}` : '';
  res.redirect('/login.html' + next);
});

app.get('/register.html', (req, res) => {
  sendPublicPage(res, 'register.html');
});

app.get('/register', (req, res) => {
  res.redirect('/register.html');
});

app.get('/forgot-password.html', (req, res) => {
  sendPublicPage(res, 'forgot-password.html');
});

app.get('/forgot-password', (req, res) => {
  res.redirect('/forgot-password.html');
});

app.get('/reset-password.html', (req, res) => {
  sendPublicPage(res, 'reset-password.html');
});

app.get('/reset-password', (req, res) => {
  res.redirect('/reset-password.html');
});

app.get('/link-telegram.html', (req, res) => {
  sendPublicPage(res, 'link-telegram.html');
});

app.get('/link-telegram', (req, res) => {
  res.redirect('/link-telegram.html');
});

app.get('/api/telegram/status', (_req, res) => {
  res.json({ ok: true, ...getTelegramStatus() });
});

app.get('/admin', (req, res) => {
  if (!canAccessAdmin(req)) {
    return res.redirect('/login.html?next=/admin');
  }
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.resolve(PUBLIC_DIR, 'admin.html'));
});

app.get('/admin.html', (req, res) => {
  res.redirect('/admin');
});

app.get('/client', (req, res) => {
  const user = getSessionUser(req);
  if (!user || user.role !== 'client') {
    return res.redirect('/login.html');
  }
  res.sendFile(path.resolve(PUBLIC_DIR, 'client.html'));
});

app.get('/api/me', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.json({ loggedIn: false });
  }
  try {
    const data = await readData();
    const fullUser = (await readUsers()).find((u) => u.id === user.id) || user;
    if (fullUser.phone && !fullUser.telegramId) {
      fullUser.telegramId = await getTelegramIdForPhone(fullUser.phone);
    }
    const publicUser = await toPublicUserWithProfile(fullUser, data);
    res.json({ loggedIn: true, user: publicUser });
  } catch (err) {
    console.error(err);
    res.json({ loggedIn: true, user });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const login = req.body.login?.trim().toLowerCase();
    const password = req.body.password;
    const role = req.body.role;
    const companyName = req.body.companyName?.trim();
    const emailRaw = req.body.email?.trim().toLowerCase() || '';
    const phoneRaw = req.body.phone?.trim() || '';
    const categoryKey = String(req.body.categoryKey || req.body.serviceCategory || '').trim();

    if (!login || !LOGIN_RE.test(login)) {
      return res.status(400).json({
        error:
          'Логін: лише латинські літери, цифри, крапка, _ або - (3–32 символи). Українською не можна.',
      });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'Пароль має містити щонайменше 6 символів' });
    }
    if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
      return res.status(400).json({ error: 'Некоректний email' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: "Роль має бути 'client' або 'provider'" });
    }
    if (role === 'provider' && !companyName) {
      return res.status(400).json({ error: 'Для провайдера вкажіть назву компанії' });
    }

    const normalizedPhone = phoneRaw ? normalizePhone(phoneRaw) : '';
    if (phoneRaw && (!normalizedPhone || normalizedPhone.replace(/\D/g, '').length < 10)) {
      return res.status(400).json({ error: 'Вкажіть коректний номер телефону' });
    }

    let serviceCategories = [];
    let catalog = {};
    try {
      const localRaw = await fsPromises.readFile(DATA_FILE, 'utf8');
      catalog = ensureDataShape(JSON.parse(localRaw)).masterCatalog || {};
    } catch (_) {
      catalog = {};
    }
    if (role === 'provider') {
      if (categoryKey && catalog[categoryKey]) {
        serviceCategories = [categoryKey];
      } else if (categoryKey) {
        return res.status(400).json({ error: 'Оберіть категорію зі списку' });
      }
    }

    const { data: existingUser, error: lookupError } = await supabaseClient
      .from(USERS_TABLE)
      .select('id')
      .eq('login', login)
      .maybeSingle();
    if (lookupError) {
      console.error(lookupError);
      return res.status(500).json({ error: 'Помилка перевірки логіну' });
    }
    if (existingUser) {
      return res.status(409).json({ error: 'Користувач з таким логіном вже існує' });
    }

    const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const newUser = {
      id: crypto.randomUUID(),
      login,
      passwordHash,
      role,
    };
    if (emailRaw) newUser.email = emailRaw;
    if (normalizedPhone) newUser.phone = normalizedPhone;

    const { error: insertError } = await supabaseClient
      .from(USERS_TABLE)
      .insert(toUserRow(newUser));
    if (insertError) {
      console.error(insertError);
      if (insertError.code === '23505' && String(insertError.message).includes('email')) {
        return res.status(409).json({ error: 'Цей email уже використовується' });
      }
      if (insertError.code === '23505' && String(insertError.message).includes('phone')) {
        return res.status(409).json({ error: 'Цей телефон уже використовується' });
      }
      return res.status(500).json({ error: 'Помилка збереження користувача' });
    }

    const providerProfile =
      role === 'provider'
        ? {
            companyName,
            phone: normalizedPhone || phoneRaw || '',
            serviceCategories,
            serviceSubcategories: [],
            customSubcategories: [],
            createdAt: new Date().toISOString(),
          }
        : null;

    if (providerProfile) {
      try {
        const saved = await upsertProviderProfile(newUser.id, providerProfile);
        if (!saved.ok && !saved.missing) {
          console.warn('[register] provider profile:', saved.error?.message || saved.error);
        }
        // Best-effort local cache (may be read-only on Vercel)
        try {
          const raw = await fsPromises.readFile(DATA_FILE, 'utf8');
          const local = ensureDataShape(JSON.parse(raw));
          local.providerProfiles[newUser.id] = providerProfile;
          await fsPromises.writeFile(DATA_FILE, JSON.stringify(local, null, 2), 'utf8');
        } catch (localErr) {
          console.warn('[register] local profile skip:', localErr.message);
        }
      } catch (profileErr) {
        console.warn('[register] provider profile skip:', profileErr.message);
      }
    }

    setSessionUser(res, newUser);

    let telegramLink = null;
    if (normalizedPhone && isTelegramConfigured() && process.env.TELEGRAM_BOT_USERNAME) {
      try {
        const { token, expiresAt, phone: savedPhone } = await createTelegramLinkToken({
          userId: newUser.id,
          phone: normalizedPhone,
        });
        telegramLink = {
          botUrl: getTelegramBotLink(token),
          expiresAt,
          phone: savedPhone,
        };
      } catch (linkErr) {
        console.warn('[register] telegram link skip:', linkErr.message);
      }
    }

    const data = ensureDataShape({
      providerProfiles: providerProfile ? { [newUser.id]: providerProfile } : {},
      mockLocations: [],
      masterCatalog: catalog,
    });
    res.status(201).json({
      ok: true,
      user: await toPublicUserWithProfile(newUser, data),
      telegramLink,
      nextStep: telegramLink
        ? 'open_telegram'
        : 'done',
      message: telegramLink
        ? 'Акаунт створено. Відкрийте Telegram-бота, щоб отримувати коди входу.'
        : 'Акаунт створено. Можна входити логіном і паролем.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка реєстрації' });
  }
});

app.get('/api/auth/oauth-config', (_req, res) => {
  res.json(oauthPublicConfig());
});

async function finishOauthSignIn(res, result) {
  if (!result.ok) {
    const status =
      result.error === 'google_not_configured' || result.error === 'apple_not_configured'
        ? 503
        : 401;
    const messages = {
      google_not_configured: 'Google-вхід ще не налаштовано (GOOGLE_CLIENT_ID)',
      apple_not_configured: 'Apple-вхід ще не налаштовано (APPLE_CLIENT_ID)',
      invalid_token: 'Невірний токен авторизації',
      invalid_nonce: 'Помилка безпеки Apple Sign In. Спробуйте ще раз',
    };
    return res.status(status).json({
      ok: false,
      error: result.error,
      message: messages[result.error] || 'Не вдалося увійти',
    });
  }

  if (result.created && result.user.role === 'provider' && result.profileCompany) {
    const profile = {
      companyName: result.profileCompany,
      phone: '',
      serviceCategories: [],
      serviceSubcategories: [],
      customSubcategories: [],
      createdAt: new Date().toISOString(),
    };
    try {
      await upsertProviderProfile(result.user.id, profile);
    } catch (err) {
      console.warn('[oauth] provider profile:', err.message);
    }
  }

  setSessionUser(res, result.user);
  const data = await readData();
  return res.json({
    ok: true,
    created: Boolean(result.created),
    provider: result.provider,
    user: await toPublicUserWithProfile(result.user, data),
  });
}

app.post('/api/auth/google', async (req, res) => {
  try {
    const result = await signInWithGoogle({
      idToken: req.body?.credential || req.body?.idToken,
      role: req.body?.role,
      companyName: req.body?.companyName,
    });
    await finishOauthSignIn(res, result);
  } catch (err) {
    console.error('[POST /api/auth/google]', err);
    res.status(500).json({ error: 'Помилка Google-входу' });
  }
});

app.post('/api/auth/apple', async (req, res) => {
  try {
    const result = await signInWithApple({
      idToken: req.body?.idToken || req.body?.identityToken,
      rawNonce: req.body?.rawNonce || req.body?.nonce,
      role: req.body?.role,
      companyName: req.body?.companyName,
      name: req.body?.name || req.body?.fullName,
    });
    await finishOauthSignIn(res, result);
  } catch (err) {
    console.error('[POST /api/auth/apple]', err);
    res.status(500).json({ error: 'Помилка Apple-входу' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const inputLogin = req.body.login?.trim().toLowerCase();
    const password = req.body.password;

    if (!inputLogin || !password) {
      return res.status(400).json({ error: 'Вкажіть логін і пароль' });
    }

    const user = await findUserByLogin(inputLogin);
    if (!user) {
      return res.status(401).json({ error: 'Користувача не знайдено' });
    }
    const match = await bcrypt.compare(String(password), user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: 'Невірний пароль' });
    }

    setSessionUser(res, user);
    const data = await readData();
    res.json({ ok: true, user: await toPublicUserWithProfile(user, data) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка входу' });
  }
});

app.post('/api/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/telegram/link', requireAuth, async (req, res) => {
  try {
    if (!isTelegramConfigured()) {
      return res.status(503).json({
        error: 'bot_not_configured',
        message: 'Telegram-бот не налаштовано. Додайте TELEGRAM_BOT_TOKEN у .env',
      });
    }

    const sessionUser = getSessionUser(req);
    let phone = req.body?.phone?.trim();

    if (!phone) {
      const { data: row, error: userError } = await supabaseClient
        .from(USERS_TABLE)
        .select('phone')
        .eq('id', sessionUser.id)
        .maybeSingle();
      if (userError) throw new Error(userError.message);
      phone = row?.phone || '';
    }

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone || normalizedPhone.replace(/\D/g, '').length < 10) {
      return res.status(400).json({ error: 'Вкажіть коректний номер телефону' });
    }

    if (!process.env.TELEGRAM_BOT_USERNAME) {
      return res.status(503).json({
        error: 'bot_username_missing',
        message: 'Додайте TELEGRAM_BOT_USERNAME у .env (без @)',
      });
    }

    const { token, expiresAt, phone: savedPhone } = await createTelegramLinkToken({
      userId: sessionUser.id,
      phone: normalizedPhone,
    });

    res.json({
      ok: true,
      token,
      botUrl: getTelegramBotLink(token),
      expiresAt,
      phone: savedPhone,
    });
  } catch (err) {
    console.error('[POST /api/auth/telegram/link]', err);
    if (String(err.message).includes('phone_or_telegram_conflict')) {
      return res.status(409).json({ error: 'Цей номер уже привʼязаний до іншого акаунта' });
    }
    res.status(500).json({ error: 'Не вдалося створити посилання для Telegram' });
  }
});

app.use(
  '/api/auth',
  createAuthRouter({
    jwtSecret: JWT_SECRET,
    toPublicUserWithProfile,
    readData,
  })
);

app.get('/api/data', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const data = await readData();
    let catalogClicks = {};
    try {
      const clicksRes = await fetchCatalogClicksMap();
      if (clicksRes.ok) catalogClicks = clicksRes.clicks || {};
    } catch (err) {
      console.warn('[GET /api/data] catalog clicks skip:', err.message);
    }
    res.json({
      ...data,
      mockLocations: activeLocations(data.mockLocations),
      catalogClicks,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося прочитати data.json' });
  }
});

app.post('/api/catalog/click', async (req, res) => {
  try {
    const type = String(req.body?.type || '').trim();
    const categoryKey = String(req.body?.categoryKey || '').trim();
    const subcategoryKey = String(req.body?.subcategoryKey || '').trim();
    const serviceName = String(req.body?.serviceName || '').trim();

    let clickKey = '';
    if (type === 'category') {
      if (!categoryKey) return res.status(400).json({ error: 'categoryKey required' });
      clickKey = categoryClickKey(categoryKey);
    } else if (type === 'subcategory') {
      if (!categoryKey || !subcategoryKey) {
        return res.status(400).json({ error: 'categoryKey and subcategoryKey required' });
      }
      clickKey = subcategoryClickKey(categoryKey, subcategoryKey);
    } else if (type === 'service') {
      if (!categoryKey || !subcategoryKey || !serviceName) {
        return res.status(400).json({ error: 'categoryKey, subcategoryKey and serviceName required' });
      }
      clickKey = serviceClickKey(categoryKey, subcategoryKey, serviceName);
    } else {
      return res.status(400).json({ error: 'type must be category | subcategory | service' });
    }

    const result = await incrementCatalogClick(clickKey);
    if (!result.ok) {
      if (result.missing) {
        return res.status(503).json({
          error: 'Виконайте міграцію 011_catalog_clicks.sql у Supabase',
        });
      }
      throw result.error || new Error('increment failed');
    }

    res.json({ ok: true, clickKey, clicks: result.clicks });
  } catch (err) {
    console.error('[POST /api/catalog/click]', err);
    res.status(500).json({ error: 'Не вдалося зберегти клік' });
  }
});

app.post('/api/search-ai', async (req, res) => {
  try {
    const text = req.body?.text?.trim();
    if (!text) {
      return res.status(400).json({ error: 'Вкажіть текст запиту' });
    }

    const data = await readData();
    const result = await parseVoiceSearch(text, data.masterCatalog, {
      geminiApiKey: GEMINI_API_KEY || undefined,
    });

    if (!result.category) {
      return res.status(404).json({
        error: 'Не вдалося визначити категорію. Спробуйте інший запит.',
        query: text,
        source: result.source,
      });
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      category: result.category,
      subcategory: result.subcategory,
      service: result.service,
      source: result.source,
      confidence: result.confidence,
      query: text,
      suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
      gemini: Boolean(GEMINI_API_KEY),
    });
  } catch (err) {
    console.error('[POST /api/search-ai]', err);
    res.status(500).json({ error: 'Помилка AI-пошуку' });
  }
});

app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [data, users, orders] = await Promise.all([readData(), readUsers(), readOrders()]);

    const locByProvider = new Map();
    activeLocations(data.mockLocations).forEach((loc) => {
      if (!loc.providerId) return;
      if (!locByProvider.has(loc.providerId)) locByProvider.set(loc.providerId, []);
      locByProvider.get(loc.providerId).push(loc);
    });

    const providers = users
      .filter((u) => u.role === 'provider')
      .map((u) => {
        const locs = locByProvider.get(u.id) || [];
        const views = locs.reduce((sum, l) => sum + (Number(l.views) || 0), 0);
        const servicesCount = locs.reduce(
          (sum, l) => sum + Object.keys(l.prices || {}).length,
          0
        );
        const ordersCount = orders.filter((o) => o.providerId === u.id).length;
        return {
          id: u.id,
          login: u.login,
          phone: u.phone || data.providerProfiles[u.id]?.phone || '',
          email: u.email || null,
          companyName: data.providerProfiles[u.id]?.companyName || '—',
          locationsCount: locs.length,
          servicesCount,
          views,
          ordersCount,
          hasPassword: Boolean(u.passwordHash),
          telegramLinked: Boolean(u.telegramId),
        };
      });

    const clients = users
      .filter((u) => u.role === 'client')
      .map((u) => ({
        id: u.id,
        login: u.login,
        phone: u.phone || null,
        email: u.email || null,
        hasPassword: Boolean(u.passwordHash),
        telegramLinked: Boolean(u.telegramId),
      }));

    const admins = users
      .filter((u) => u.role === 'admin')
      .map((u) => ({
        id: u.id,
        login: u.login,
        phone: u.phone || null,
        email: u.email || null,
        hasPassword: Boolean(u.passwordHash),
      }));

    const locations = activeLocations(data.mockLocations).map((loc) => ({
      id: loc.id,
      title: loc.title,
      providerId: loc.providerId,
      cat: loc.cat,
      subcats: Array.isArray(loc.subcats) ? loc.subcats : [],
      address: loc.address,
      openStatus: loc.openStatus,
      servicesCount: Object.keys(loc.prices || {}).length,
      views: Number(loc.views) || 0,
      rating: loc.rating || 0,
      reviewsCount: loc.reviewsCount || 0,
      phone: loc.phone || '',
      importSource: loc.importSource || null,
      imported: isImportedLocation(loc),
    }));

    const trash = trashedLocations(data.mockLocations).map((loc) => ({
      id: loc.id,
      title: loc.title,
      cat: loc.cat,
      address: loc.address || '',
      importSource: loc.importSource || null,
      imported: isImportedLocation(loc),
      deletedAt: loc.deletedAt,
      deletedReason: loc.deletedReason || '',
    }));

    res.json({
      providers,
      clients,
      admins,
      usersTotal: users.length,
      locations,
      trash,
      trashCount: trash.length,
      importedCount: locations.filter((l) => l.imported).length,
      catalogCategories: Object.keys(data.masterCatalog).length,
      ordersTotal: orders.length,
      importCities: CITY_PRESETS,
      importCategories: Object.keys(CATEGORY_OSM_FILTERS),
      googlePlacesConfigured: Boolean(
        process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY
      ),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка завантаження панелі' });
  }
});

app.get('/api/admin/providers/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const [data, users, orders] = await Promise.all([readData(), readUsers(), readOrders()]);
    const user = users.find((u) => u.id === userId && u.role === 'provider');
    if (!user) return res.status(404).json({ error: 'Провайдера не знайдено' });

    const profile = data.providerProfiles[userId] || {};
    const locations = data.mockLocations.filter((l) => l.providerId === userId);
    const providerOrders = orders.filter((o) => o.providerId === userId);
    const views = locations.reduce((sum, l) => sum + (Number(l.views) || 0), 0);
    const services = [];
    locations.forEach((loc) => {
      Object.entries(loc.prices || {}).forEach(([name, price]) => {
        services.push({ locationId: loc.id, locationTitle: loc.title, name, price });
      });
    });

    res.json({
      id: user.id,
      login: user.login,
      role: user.role,
      phone: user.phone || profile.phone || null,
      email: user.email || null,
      hasPassword: Boolean(user.passwordHash),
      telegramLinked: Boolean(user.telegramId),
      telegramId: user.telegramId || null,
      companyName: profile.companyName || '—',
      serviceCategories: profile.serviceCategories || [],
      serviceSubcategories: profile.serviceSubcategories || [],
      customSubcategories: profile.customSubcategories || [],
      stats: {
        locationsCount: locations.length,
        servicesCount: services.length,
        views,
        ordersCount: providerOrders.length,
        reviewsCount: locations.reduce((s, l) => s + (Number(l.reviewsCount) || 0), 0),
      },
      locations: locations.map((loc) => ({
        id: loc.id,
        title: loc.title,
        address: loc.address,
        cat: loc.cat,
        phone: loc.phone,
        openStatus: loc.openStatus,
        views: Number(loc.views) || 0,
        rating: loc.rating || 0,
        reviewsCount: loc.reviewsCount || 0,
        servicesCount: Object.keys(loc.prices || {}).length,
        prices: loc.prices || {},
        subcats: loc.subcats || [],
      })),
      services,
      recentOrders: providerOrders.slice(-20).reverse(),
    });
  } catch (err) {
    console.error('[GET /api/admin/providers/:userId]', err);
    res.status(500).json({ error: 'Не вдалося завантажити провайдера' });
  }
});

app.get('/api/admin/users/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const [data, users, orders] = await Promise.all([readData(), readUsers(), readOrders()]);
    const user = users.find((u) => u.id === userId);
    if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });

    const profile = data.providerProfiles[userId] || null;
    const userOrders = orders.filter(
      (o) => o.clientId === userId || o.providerId === userId || o.userId === userId
    );

    res.json({
      id: user.id,
      login: user.login,
      role: user.role,
      phone: user.phone || null,
      email: user.email || null,
      hasPassword: Boolean(user.passwordHash),
      telegramLinked: Boolean(user.telegramId),
      telegramId: user.telegramId || null,
      profile,
      ordersCount: userOrders.length,
      recentOrders: userOrders.slice(-20).reverse(),
      locationsCount: data.mockLocations.filter((l) => l.providerId === userId).length,
    });
  } catch (err) {
    console.error('[GET /api/admin/users/:userId]', err);
    res.status(500).json({ error: 'Не вдалося завантажити користувача' });
  }
});

app.get('/api/admin/locations/:id/detail', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const [data, users, orders] = await Promise.all([readData(), readUsers(), readOrders()]);
    const loc = data.mockLocations.find((l) => l.id === id);
    if (!loc) return res.status(404).json({ error: 'Локацію не знайдено' });

    const provider = loc.providerId ? users.find((u) => u.id === loc.providerId) : null;
    const profile = loc.providerId ? data.providerProfiles[loc.providerId] : null;

    res.json({
      ...loc,
      views: Number(loc.views) || 0,
      provider: provider
        ? {
            id: provider.id,
            login: provider.login,
            companyName: profile?.companyName || '—',
            phone: provider.phone || profile?.phone || null,
          }
        : null,
      ordersCount: orders.filter((o) => o.locationId === id).length,
      catalogCategoryName: data.masterCatalog?.[loc.cat]?.name || loc.cat,
      catalogSubcategoryNames: (Array.isArray(loc.subcats) ? loc.subcats : []).map((subKey) => ({
        key: subKey,
        name: data.masterCatalog?.[loc.cat]?.subcats?.[subKey]?.name || subKey,
      })),
    });
  } catch (err) {
    console.error('[GET /api/admin/locations/:id/detail]', err);
    res.status(500).json({ error: 'Не вдалося завантажити локацію' });
  }
});

app.post('/api/admin/users/:userId/password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    const newPassword = String(req.body?.password || req.body?.newPassword || '');
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Пароль має містити щонайменше 6 символів' });
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const { error } = await supabaseClient
      .from(USERS_TABLE)
      .update({ passwordHash })
      .eq('id', userId);

    if (error) {
      console.error('[admin set password]', error.message);
      return res.status(503).json({ error: 'Не вдалося оновити пароль' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/admin/users/:userId/password]', err);
    res.status(500).json({ error: 'Помилка оновлення пароля' });
  }
});

app.post('/api/locations/:id/view', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const data = await readData();
    const loc = data.mockLocations.find((l) => l.id === id);
    if (!loc) return res.status(404).json({ error: 'not_found' });
    loc.views = (Number(loc.views) || 0) + 1;
    await writeData(data);
    res.json({ ok: true, views: loc.views });
  } catch (err) {
    console.error('[POST /api/locations/:id/view]', err);
    res.status(500).json({ error: 'view_failed' });
  }
});

app.post('/api/admin/import-places', requireAuth, requireAdmin, async (req, res) => {
  try {
    const source = String(req.body?.source || 'osm').toLowerCase();
    const city = req.body?.city || 'kotsyubynske';
    const category = req.body?.category || 'beauty';
    const dryRun = Boolean(req.body?.dryRun);
    const selectedIds = Array.isArray(req.body?.selectedIds)
      ? req.body.selectedIds.map(String)
      : null;
    const providedLocations = Array.isArray(req.body?.locations) ? req.body.locations : null;

    let incoming = [];
    let meta = {};

    if (providedLocations && providedLocations.length && !dryRun) {
      incoming = providedLocations
        .filter((l) => l && l.title && Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng)))
        .map((l) => ({
          ...l,
          lat: Number(l.lat),
          lng: Number(l.lng),
          cat: l.cat || category,
          providerId: null,
          importSource: l.importSource || source,
        }));
      meta = { source, locations: incoming };
    } else if (source === 'osm') {
      meta = await fetchOsmPlaces({ city, category });
      incoming = meta.locations;
    } else if (source === 'places' || source === 'google') {
      meta = await fetchGooglePlaces({ city, category });
      incoming = meta.locations;
    } else {
      return res.status(400).json({
        error: 'Підтримуються source: osm | places',
      });
    }

    if (selectedIds && selectedIds.length && !providedLocations) {
      const allow = new Set(selectedIds);
      incoming = incoming.filter((l) => allow.has(l.id));
    }

    const data = await readData();
    const active = activeLocations(data.mockLocations);
    const trash = trashedLocations(data.mockLocations);
    const merged = mergeLocations(active, incoming);

    if (!dryRun) {
      data.mockLocations = [...merged.locations, ...trash];
      await writeData(data);
    }

    const preview = incoming.map((l) => ({
      id: l.id,
      title: l.title,
      phone: l.phone || '',
      address: l.address || '',
      lat: l.lat,
      lng: l.lng,
      rating: l.rating || 0,
      cat: l.cat || category,
      text: l.text || '',
      openStatus: l.openStatus || 'open',
      importSource: l.importSource || meta.source || source,
      willAdd: merged.added.includes(l.id),
      willSkip: Boolean(merged.skipped.find((s) => s.id === l.id)),
    }));

    res.json({
      ok: true,
      dryRun,
      source: meta.source || source,
      city: resolveCity(city),
      category,
      found: incoming.length,
      added: merged.added.length,
      skipped: merged.skipped.length,
      skippedDetails: merged.skipped.slice(0, 50),
      total: dryRun ? active.length : merged.locations.length,
      candidates: preview,
      preview: preview.slice(0, 20),
    });
  } catch (err) {
    console.error('[POST /api/admin/import-places]', err);
    res.status(500).json({ error: err.message || 'Помилка імпорту' });
  }
});

/** Admin-only: scan Ukrainian city → filter by Mapfix catalog (Gemini) → preview/confirm. */
app.post('/api/admin/import-city-gemini', requireAuth, requireAdmin, async (req, res) => {
  try {
    const cityName = String(req.body?.city || '').trim();
    const dryRun = req.body?.dryRun !== false;
    const providedLocations = Array.isArray(req.body?.locations) ? req.body.locations : null;
    const maxPerQuery = Math.min(15, Math.max(3, Number(req.body?.maxPerQuery) || 8));
    const maxCandidates = Math.min(120, Math.max(10, Number(req.body?.maxCandidates) || 80));

    if (!cityName && !(providedLocations && providedLocations.length && !dryRun)) {
      return res.status(400).json({ error: 'Вкажіть українське місто або смт (наприклад Коцюбинське, Київ, Ірпінь)' });
    }

    const data = await readData();
    const catalog = data.masterCatalog || {};
    if (!Object.keys(catalog).length) {
      return res.status(503).json({ error: 'Каталог Mapfix порожній' });
    }

    let incoming = [];
    let scanMeta = null;

    if (providedLocations && providedLocations.length && !dryRun) {
      incoming = providedLocations
        .filter((l) => l && l.title && Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng)))
        .filter((l) => catalog[l.cat]?.subcats && (l.subcats || []).some((s) => catalog[l.cat].subcats[s]))
        .map((l) => ({
          ...l,
          lat: Number(l.lat),
          lng: Number(l.lng),
          providerId: null,
          importSource: l.importSource || 'city_gemini',
          subcats: Array.isArray(l.subcats) ? l.subcats.filter((s) => catalog[l.cat]?.subcats?.[s]) : [],
        }))
        .filter((l) => l.subcats.length > 0);
    } else {
      if (!GEMINI_API_KEY && !process.env.GOOGLE_PLACES_API_KEY && !process.env.GOOGLE_MAPS_API_KEY) {
        // OSM still works with local classifier; warn but continue
        console.warn('[import-city-gemini] No GEMINI/Places keys — OSM + local catalog match');
      }
      scanMeta = await buildCityImportCandidates({
        cityName,
        masterCatalog: catalog,
        classifyPlacesForImport,
        geminiApiKey: GEMINI_API_KEY || undefined,
        placesApiKey: process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || undefined,
        maxPerQuery,
        maxCandidates,
      });
      incoming = scanMeta.locations;
    }

    const active = activeLocations(data.mockLocations);
    const trash = trashedLocations(data.mockLocations);
    const merged = mergeLocations(active, incoming);

    if (!dryRun) {
      if (!incoming.length) {
        return res.status(400).json({ error: 'Немає точок для імпорту після фільтра каталогу' });
      }
      data.mockLocations = [...merged.locations, ...trash];
      const created = merged.locations.filter((l) => merged.added.includes(l.id));
      await persistLocationsPatch(data, created.length ? created : incoming);
    }

    const preview = incoming.map((l) => {
      const cat = catalog[l.cat];
      const subKey = (l.subcats || [])[0];
      return {
        id: l.id,
        title: l.title,
        phone: l.phone || '',
        address: l.address || '',
        lat: l.lat,
        lng: l.lng,
        rating: l.rating || 0,
        cat: l.cat,
        subcats: l.subcats || [],
        categoryName: cat?.name || l.cat,
        subcategoryName: subKey && cat?.subcats?.[subKey] ? cat.subcats[subKey].name : subKey || '',
        text: l.text || '',
        openStatus: l.openStatus || 'open',
        importSource: l.importSource || 'city_gemini',
        willAdd: merged.added.includes(l.id),
        willSkip: Boolean(merged.skipped.find((s) => s.id === l.id)),
        // keep full location for confirm write
        _location: l,
      };
    });

    res.json({
      ok: true,
      dryRun,
      city: scanMeta?.city || { name: cityName },
      source: scanMeta?.source || 'confirm',
      scanned: scanMeta?.scanned ?? incoming.length,
      rejected: scanMeta?.rejected ?? 0,
      matched: scanMeta?.matched ?? incoming.length,
      queryCount: scanMeta?.queryCount ?? 0,
      found: incoming.length,
      added: merged.added.length,
      skipped: merged.skipped.length,
      skippedDetails: merged.skipped.slice(0, 50),
      geminiConfigured: Boolean(GEMINI_API_KEY),
      placesConfigured: Boolean(process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY),
      candidates: preview,
      catalogOptions: Object.entries(catalog).map(([key, cat]) => ({
        key,
        name: cat.name || key,
        subcats: Object.entries(cat.subcats || {}).map(([sk, sub]) => ({
          key: sk,
          name: sub.name || sk,
        })),
      })),
    });
  } catch (err) {
    console.error('[POST /api/admin/import-city-gemini]', err);
    res.status(500).json({ error: err.message || 'Помилка імпорту міста' });
  }
});

async function handleGoogleMapsUrlImport(req, res, { adminImport = false } = {}) {
  try {
    const user = getSessionUser(req);
    const url = String(req.body?.url || '').trim();
    const dryRun = req.body?.dryRun !== false;
    if (!url) {
      return res.status(400).json({ error: 'Вставте посилання Google Maps (maps.app.goo.gl / maps.google.com)' });
    }

    const { place, resolved } = await importPlaceFromGoogleMapsUrl({ url });
    const data = await readData();
    const ai = await suggestCatalogForPlace(place, data.masterCatalog, {
      geminiApiKey: GEMINI_API_KEY || undefined,
    });

    const category =
      String(req.body?.category || '').trim() ||
      ai.category ||
      'home';
    const subcategory =
      String(req.body?.subcategory || '').trim() ||
      ai.subcategory ||
      '';

    if (!data.masterCatalog?.[category]) {
      return res.status(400).json({
        error: `Категорію «${category}» не знайдено в каталозі. Оберіть вручну.`,
        place,
        ai,
      });
    }

    const loc = googlePlaceToLocation(place, {
      providerId: adminImport ? null : user.id,
      cat: category,
      subcategory: subcategory || undefined,
    });
    loc.importMeta = {
      ...(loc.importMeta || {}),
      sourceUrl: url,
      resolvedUrl: resolved.finalUrl,
      aiCategory: ai.category,
      aiSubcategory: ai.subcategory,
      aiSource: ai.source,
      importedBy: user.id,
      dataSource: place.dataSource,
    };

    const active = activeLocations(data.mockLocations);
    const trash = trashedLocations(data.mockLocations);
    const merged = mergeLocations(active, [loc], { updateExisting: false });

    if (!dryRun) {
      if (!merged.added.length) {
        return res.status(409).json({
          error: 'Схожа точка вже є на карті',
          skipped: merged.skipped,
          place,
          ai,
          location: loc,
        });
      }
      const created = merged.locations.find((l) => l.id === merged.added[0]);
      data.mockLocations = [...merged.locations, ...trash];
      await persistLocationsPatch(data, [created]);
      return res.status(201).json({
        ok: true,
        dryRun: false,
        added: 1,
        location: created,
        place,
        ai,
        category,
        subcategory: subcategory || null,
        categoryName: data.masterCatalog[category]?.name || category,
        dataSource: place.dataSource,
        isPartial: place.dataSource !== 'google_places_api',
        subcategoryName:
          subcategory && data.masterCatalog[category]?.subcats?.[subcategory]
            ? data.masterCatalog[category].subcats[subcategory].name
            : null,
      });
    }

    res.json({
      ok: true,
      dryRun: true,
      willAdd: merged.added.length > 0,
      willSkip: merged.skipped.length > 0,
      skipped: merged.skipped,
      place,
      location: loc,
      ai,
      category,
      subcategory: subcategory || null,
      categoryName: data.masterCatalog[category]?.name || category,
      dataSource: place.dataSource,
      isPartial: place.dataSource !== 'google_places_api',
      subcategoryName:
        subcategory && data.masterCatalog[category]?.subcats?.[subcategory]
          ? data.masterCatalog[category].subcats[subcategory].name
          : null,
      catalogOptions: Object.entries(data.masterCatalog || {}).map(([key, cat]) => ({
        key,
        name: cat.name,
        subcats: Object.entries(cat.subcats || {}).map(([sk, sub]) => ({
          key: sk,
          name: sub.name,
        })),
      })),
    });
  } catch (err) {
    console.error('[POST /api/import-google-maps-url]', err);
    res.status(400).json({ error: err.message || 'Помилка імпорту з Google Maps' });
  }
}

app.post('/api/import-google-maps-url', requireAuth, (req, res) =>
  handleGoogleMapsUrlImport(req, res)
);

app.post('/api/admin/import-google-maps-url', requireAuth, requireAdmin, (req, res) =>
  handleGoogleMapsUrlImport(req, res, { adminImport: true })
);

app.post('/api/admin/locations/trash', requireAuth, requireAdmin, async (req, res) => {
  try {
    const reason = String(req.body?.reason || 'admin_trash').slice(0, 120);
    const filter = {
      onlyActive: true,
      onlyImported: Boolean(req.body?.onlyImported),
      cat: req.body?.cat ? String(req.body.cat) : '',
      subcategory: req.body?.subcategory ? String(req.body.subcategory) : '',
      ids: Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [],
    };

    const data = await readData();
    const now = new Date().toISOString();
    const changed = [];
    for (const loc of data.mockLocations) {
      if (!locationMatchesBulkFilter(loc, filter)) continue;
      // If ids empty and no cat/imported flag — refuse full wipe without confirm flag
      if (!filter.ids.length && !filter.cat && !filter.onlyImported && !req.body?.all) {
        continue;
      }
      loc.deletedAt = now;
      loc.deletedReason = reason;
      changed.push(loc);
    }

    if (!changed.length) {
      return res.status(400).json({
        error: 'Немає точок для переміщення в кошик. Уточніть фільтр (категорія / імпорт / ids).',
      });
    }

    await persistLocationsPatch(data, changed);
    res.json({
      ok: true,
      trashed: changed.length,
      ids: changed.map((l) => l.id),
      remainingActive: activeLocations(data.mockLocations).length,
      trashCount: trashedLocations(data.mockLocations).length,
    });
  } catch (err) {
    console.error('[POST /api/admin/locations/trash]', err);
    res.status(500).json({ error: err.message || 'Помилка кошика' });
  }
});

app.post('/api/admin/locations/restore', requireAuth, requireAdmin, async (req, res) => {
  try {
    const filter = {
      onlyTrashed: true,
      onlyImported: Boolean(req.body?.onlyImported),
      cat: req.body?.cat ? String(req.body.cat) : '',
      subcategory: req.body?.subcategory ? String(req.body.subcategory) : '',
      ids: Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [],
      all: Boolean(req.body?.all),
    };
    const data = await readData();
    const changed = [];
    for (const loc of data.mockLocations) {
      if (!locationMatchesBulkFilter(loc, filter)) continue;
      if (!filter.ids.length && !filter.cat && !filter.onlyImported && !filter.all) continue;
      loc.deletedAt = null;
      loc.deletedReason = null;
      changed.push(loc);
    }
    if (!changed.length) {
      return res.status(400).json({ error: 'Немає точок для відновлення' });
    }
    await persistLocationsPatch(data, changed);
    res.json({
      ok: true,
      restored: changed.length,
      remainingTrash: trashedLocations(data.mockLocations).length,
    });
  } catch (err) {
    console.error('[POST /api/admin/locations/restore]', err);
    res.status(500).json({ error: err.message || 'Помилка відновлення' });
  }
});

app.post('/api/admin/locations/purge', requireAuth, requireAdmin, async (req, res) => {
  try {
    const filter = {
      onlyTrashed: true,
      onlyImported: Boolean(req.body?.onlyImported),
      cat: req.body?.cat ? String(req.body.cat) : '',
      subcategory: req.body?.subcategory ? String(req.body.subcategory) : '',
      ids: Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [],
      all: Boolean(req.body?.all),
    };
    const data = await readData();
    const toDelete = data.mockLocations.filter((loc) => {
      if (!locationMatchesBulkFilter(loc, filter)) return false;
      if (!filter.ids.length && !filter.cat && !filter.onlyImported && !filter.all) return false;
      return true;
    });
    if (!toDelete.length) {
      return res.status(400).json({ error: 'Немає точок для остаточного видалення' });
    }
    const ids = new Set(toDelete.map((l) => l.id));
    data.mockLocations = data.mockLocations.filter((l) => !ids.has(l.id));
    try {
      await fsPromises.writeFile(DATA_FILE, JSON.stringify(ensureDataShape(data), null, 2), 'utf8');
    } catch (e) {
      console.warn('[purge] local skip:', e.message);
    }
    await deleteLocationsFromSupabase([...ids]);
    res.json({
      ok: true,
      purged: toDelete.length,
      remainingTrash: trashedLocations(data.mockLocations).length,
      remainingActive: activeLocations(data.mockLocations).length,
    });
  } catch (err) {
    console.error('[POST /api/admin/locations/purge]', err);
    res.status(500).json({ error: err.message || 'Помилка очищення' });
  }
});

app.post('/api/admin/sync-locations-supabase', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = await readData();
    const sync = await syncAllLocationsToSupabase(data.mockLocations);
    if (!sync.ok) {
      return res.status(503).json({
        ok: false,
        error: sync.error?.message || 'Не вдалося синхронізувати. Виконайте міграцію 004_locations_table.sql',
      });
    }
    res.json({ ok: true, count: sync.count });
  } catch (err) {
    console.error('[POST /api/admin/sync-locations-supabase]', err);
    res.status(500).json({ error: err.message || 'Помилка синхронізації' });
  }
});

app.delete('/api/admin/locations/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const permanent = String(req.query.permanent || req.body?.permanent || '') === '1';
    const data = await readData();
    const idx = data.mockLocations.findIndex((l) => l.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Локацію не знайдено' });

    if (permanent || isLocationTrashed(data.mockLocations[idx])) {
      const [removed] = data.mockLocations.splice(idx, 1);
      try {
        await fsPromises.writeFile(DATA_FILE, JSON.stringify(ensureDataShape(data), null, 2), 'utf8');
      } catch (e) {
        console.warn('[admin delete] local skip:', e.message);
      }
      await deleteLocationsFromSupabase([removed.id]);
      return res.json({ ok: true, purged: true });
    }

    const loc = data.mockLocations[idx];
    loc.deletedAt = new Date().toISOString();
    loc.deletedReason = 'admin_delete';
    await persistLocationsPatch(data, [loc]);
    res.json({ ok: true, trashed: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка видалення' });
  }
});

app.delete('/api/admin/providers/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.userId;
    const { data: providerRow, error: findError } = await supabaseClient
      .from(USERS_TABLE)
      .select('id')
      .eq('id', userId)
      .eq('role', 'provider')
      .maybeSingle();
    if (findError) {
      console.error(findError);
      return res.status(500).json({ error: 'Помилка пошуку провайдера' });
    }
    if (!providerRow) return res.status(404).json({ error: 'Провайдера не знайдено' });

    const { error: deleteError } = await supabaseClient
      .from(USERS_TABLE)
      .delete()
      .eq('id', userId);
    if (deleteError) {
      console.error(deleteError);
      return res.status(500).json({ error: 'Помилка видалення провайдера' });
    }

    const data = await readData();
    data.mockLocations = data.mockLocations.filter((l) => l.providerId !== userId);
    delete data.providerProfiles[userId];
    await writeData(data);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка видалення провайдера' });
  }
});

app.post('/api/add-item', requireAuth, requireAdmin, async (req, res) => {
  try {
    const category = req.body.category?.trim();
    const subcategory = req.body.subcategory?.trim();
    const service = req.body.service?.trim();
    const price = req.body.price?.trim();

    if (!category || !subcategory || !service || !price) {
      return res.status(400).json({ error: 'Заповніть усі поля форми' });
    }
    if (!isValidPrice(price)) {
      return res.status(400).json({ error: 'Ціна має містити число (наприклад 650 або 650 грн)' });
    }

    const data = await readData();
    const catalog = data.masterCatalog;

    let catKey = Object.keys(catalog).find((k) => catalog[k].name === category);
    if (!catKey) {
      catKey = makeKey(category, Object.keys(catalog));
      catalog[catKey] = {
        name: category,
        icon: firstEmoji(category),
        subcats: {},
      };
    }

    const cat = catalog[catKey];
    let subKey = Object.keys(cat.subcats).find((k) => cat.subcats[k].name === subcategory);
    if (!subKey) {
      subKey = makeKey(subcategory, Object.keys(cat.subcats));
      cat.subcats[subKey] = {
        name: subcategory,
        tags: [service.toLowerCase()],
        items: [],
      };
    }

    const sub = cat.subcats[subKey];
    const priceStr = formatPrice(price);
    const existing = sub.items.find((i) => i.name === service);
    if (existing) {
      existing.price = priceStr;
    } else {
      sub.items.push({ name: service, price: priceStr });
    }

    await writeData(data);
    res.json({ ok: true, categoryKey: catKey, subcategoryKey: subKey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка збереження в data.json' });
  }
});

app.post('/api/admin/catalog/category', requireAuth, requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const iconRaw = String(req.body?.icon || '').trim();
    if (name.length < 2) {
      return res.status(400).json({ error: 'Назва категорії має містити щонайменше 2 символи' });
    }

    const data = await readData();
    const catalog = data.masterCatalog || (data.masterCatalog = {});
    const exists = Object.values(catalog).some(
      (c) => String(c.name || '').toLowerCase() === name.toLowerCase()
    );
    if (exists) {
      return res.status(409).json({ error: 'Категорія з такою назвою вже існує' });
    }

    const icon = firstEmoji(iconRaw || name);
    const displayName = icon && !name.startsWith(icon) ? `${icon} ${name}` : name;
    const catKey = makeKey(name, Object.keys(catalog));
    catalog[catKey] = {
      name: displayName,
      icon,
      subcats: {},
    };

    const writeResult = await writeData(data);
    const writeErr = catalogWriteError(writeResult);
    if (writeErr) return res.status(503).json({ error: writeErr });
    res.json({ ok: true, categoryKey: catKey, category: catalog[catKey] });
  } catch (err) {
    console.error('[POST /api/admin/catalog/category]', err);
    res.status(500).json({ error: 'Не вдалося створити категорію' });
  }
});

app.delete('/api/admin/catalog/category/:categoryKey', requireAuth, requireAdmin, async (req, res) => {
  try {
    const categoryKey = String(req.params.categoryKey || '').trim();
    if (!categoryKey) {
      return res.status(400).json({ error: 'Не вказано ключ категорії' });
    }

    const data = await readData();
    const catalog = data.masterCatalog || {};
    if (!catalog[categoryKey]) {
      return res.status(404).json({ error: 'Категорію не знайдено' });
    }

    delete catalog[categoryKey];
    const writeResult = await writeData(data);
    const writeErr = catalogWriteError(writeResult);
    if (writeErr) return res.status(503).json({ error: writeErr });
    res.json({ ok: true, categoryKey });
  } catch (err) {
    console.error('[DELETE /api/admin/catalog/category]', err);
    res.status(500).json({ error: 'Не вдалося видалити категорію' });
  }
});

app.post('/api/admin/catalog/subcategory', requireAuth, requireAdmin, async (req, res) => {
  try {
    const categoryKey = String(req.body?.categoryKey || '').trim();
    const name = String(req.body?.name || '').trim();
    if (!categoryKey) {
      return res.status(400).json({ error: 'Оберіть категорію' });
    }
    if (name.length < 2) {
      return res.status(400).json({ error: 'Назва підкатегорії має містити щонайменше 2 символи' });
    }

    const data = await readData();
    const catalog = data.masterCatalog || {};
    const cat = catalog[categoryKey];
    if (!cat) {
      return res.status(404).json({ error: 'Категорію не знайдено' });
    }
    if (!cat.subcats || typeof cat.subcats !== 'object') cat.subcats = {};

    const exists = Object.values(cat.subcats).some(
      (s) => String(s.name || '').toLowerCase() === name.toLowerCase()
    );
    if (exists) {
      return res.status(409).json({ error: 'Підкатегорія з такою назвою вже є в цій категорії' });
    }

    const subKey = makeKey(name, Object.keys(cat.subcats));
    cat.subcats[subKey] = {
      name,
      tags: [name.toLowerCase()],
      items: [],
    };

    const writeResult = await writeData(data);
    const writeErr = catalogWriteError(writeResult);
    if (writeErr) return res.status(503).json({ error: writeErr });
    res.json({ ok: true, categoryKey, subcategoryKey: subKey, subcategory: cat.subcats[subKey] });
  } catch (err) {
    console.error('[POST /api/admin/catalog/subcategory]', err);
    res.status(500).json({ error: 'Не вдалося створити підкатегорію' });
  }
});

app.post('/api/admin/catalog/service', requireAuth, requireAdmin, async (req, res) => {
  try {
    const categoryKey = String(req.body?.categoryKey || '').trim();
    const subcategoryKey = String(req.body?.subcategoryKey || '').trim();
    const name = String(req.body?.name || req.body?.service || '').trim();
    const price = String(req.body?.price || '').trim();

    if (!categoryKey || !subcategoryKey) {
      return res.status(400).json({ error: 'Оберіть категорію та підкатегорію' });
    }
    if (name.length < 2) {
      return res.status(400).json({ error: 'Назва послуги має містити щонайменше 2 символи' });
    }
    if (!price) {
      return res.status(400).json({ error: 'Вкажіть орієнтовну ціну' });
    }
    if (!isValidPrice(price)) {
      return res.status(400).json({ error: 'Ціна має містити число (наприклад 650 або 650 грн)' });
    }

    const data = await readData();
    const catalog = data.masterCatalog || {};
    const cat = catalog[categoryKey];
    const sub = cat?.subcats?.[subcategoryKey];
    if (!sub) {
      return res.status(404).json({ error: 'Підкатегорію не знайдено' });
    }
    if (!Array.isArray(sub.items)) sub.items = [];

    const priceStr = formatPrice(price);
    const existing = sub.items.find((i) => String(i.name).toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.price = priceStr;
    } else {
      sub.items.push({ name, price: priceStr });
      const tag = name.toLowerCase();
      if (!Array.isArray(sub.tags)) sub.tags = [];
      if (!sub.tags.includes(tag)) sub.tags.push(tag);
    }

    const writeResult = await writeData(data);
    const writeErr = catalogWriteError(writeResult);
    if (writeErr) return res.status(503).json({ error: writeErr });
    res.json({
      ok: true,
      categoryKey,
      subcategoryKey,
      updated: Boolean(existing),
    });
  } catch (err) {
    console.error('[POST /api/admin/catalog/service]', err);
    res.status(500).json({ error: 'Не вдалося додати послугу' });
  }
});

app.get('/api/provider/dashboard', requireAuth, rejectClientFromPanel, requireProviderOrAdmin, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const data = await readData();
    const fullUser = (await readUsers()).find((u) => u.id === user.id) || user;
    let telegramId = fullUser.telegramId || null;
    if (fullUser.phone && !telegramId) {
      telegramId = await getTelegramIdForPhone(fullUser.phone);
    }
    const profile =
      data.providerProfiles[user.id] ||
      (user.role === 'admin'
        ? { companyName: 'Адміністратор' }
        : { companyName: 'Моя компанія' });
    const accountPhone = fullUser.phone || profile.phone || '';
    if (!profile.phone && accountPhone) profile.phone = accountPhone;
    const locations = data.mockLocations.filter((l) => l.providerId === user.id && !isLocationTrashed(l));

    res.json({
      profile,
      locations,
      masterCatalog: data.masterCatalog,
      account: {
        phone: accountPhone,
        telegramLinked: Boolean(telegramId),
        telegramLinkedAt: fullUser.telegramLinkedAt || null,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка завантаження кабінету' });
  }
});

app.get('/api/provider/orders', requireAuth, requireProvider, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const [orders, data, users] = await Promise.all([readOrders(), readData(), readUsers()]);
    const mine = orders
      .filter((o) => o.providerId === user.id)
      .map((o) => enrichOrder(o, data, users))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ orders: mine });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка завантаження замовлень' });
  }
});

app.patch('/api/provider/orders/:id', requireAuth, requireProvider, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const status = req.body.status;
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Невірний статус' });
    }
    const orders = await readOrders();
    const order = orders.find((o) => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'Замовлення не знайдено' });
    if (order.providerId !== user.id) {
      return res.status(403).json({ error: 'Немає доступу до цього замовлення' });
    }
    order.status = status;
    order.updatedAt = new Date().toISOString();
    await writeOrders(orders);
    const [data, users] = await Promise.all([readData(), readUsers()]);
    res.json({ ok: true, order: enrichOrder(order, data, users) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка оновлення статусу' });
  }
});

app.post('/api/orders', requireAuth, requireClient, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const locationId = req.body.locationId?.trim();
    const serviceName = req.body.serviceName?.trim();

    if (!locationId || !serviceName) {
      return res.status(400).json({ error: 'Вкажіть локацію та послугу' });
    }

    const data = await readData();
    const loc = findLocation(data, locationId);
    if (!loc) return res.status(404).json({ error: 'Локацію не знайдено' });
    if (!loc.prices || !loc.prices[serviceName]) {
      return res.status(400).json({ error: 'Послуга недоступна в цьому закладі' });
    }

    const serviceId = makeServiceId(locationId, serviceName);
    const order = {
      id: crypto.randomUUID(),
      clientId: user.id,
      providerId: loc.providerId || null,
      locationId,
      serviceId,
      serviceName,
      price: loc.prices[serviceName],
      status: 'Очікує',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const orders = await readOrders();
    orders.push(order);
    await writeOrders(orders);

    const users = await readUsers();
    res.status(201).json({ ok: true, order: enrichOrder(order, data, users) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка створення замовлення' });
  }
});

app.get('/api/client/dashboard', requireAuth, requireClient, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const [orders, favorites, data, users] = await Promise.all([
      readOrders(),
      readFavorites(),
      readData(),
      readUsers(),
    ]);

    const myOrders = orders
      .filter((o) => o.clientId === user.id)
      .map((o) => enrichOrder(o, data, users))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const myFavIds = favorites
      .filter((f) => f.clientId === user.id)
      .map((f) => f.locationId);

    const favoriteLocations = myFavIds
      .map((id) => findLocation(data, id))
      .filter(Boolean)
      .map((loc) => ({
        id: loc.id,
        title: loc.title,
        address: loc.address,
        cat: loc.cat,
        openStatus: loc.openStatus,
      }));

    res.json({ orders: myOrders, favorites: favoriteLocations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка завантаження кабінету' });
  }
});

app.get('/api/client/favorites', requireAuth, requireClient, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const favorites = await readFavorites();
    const ids = favorites.filter((f) => f.clientId === user.id).map((f) => f.locationId);
    res.json({ locationIds: ids });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка' });
  }
});

app.post('/api/client/favorites', requireAuth, requireClient, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const locationId = req.body.locationId?.trim();
    if (!locationId) return res.status(400).json({ error: 'Вкажіть locationId' });

    const data = await readData();
    if (!findLocation(data, locationId)) {
      return res.status(404).json({ error: 'Локацію не знайдено' });
    }

    const favorites = await readFavorites();
    const exists = favorites.some((f) => f.clientId === user.id && f.locationId === locationId);
    if (!exists) {
      favorites.push({
        clientId: user.id,
        locationId,
        addedAt: new Date().toISOString(),
      });
      await writeFavorites(favorites);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка додавання в обране' });
  }
});

app.delete('/api/client/favorites/:locationId', requireAuth, requireClient, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const locationId = req.params.locationId;
    let favorites = await readFavorites();
    favorites = favorites.filter(
      (f) => !(f.clientId === user.id && f.locationId === locationId)
    );
    await writeFavorites(favorites);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка видалення з обраного' });
  }
});

app.post('/api/provider/locations', requireAuth, rejectClientFromPanel, requireProviderOrAdmin, async (req, res) => {
  try {
    const user = getSessionUser(req);
    if (req.body?.providerId !== undefined) {
      return res.status(400).json({ error: 'providerId визначається сервером з сесії' });
    }

    if (!req.body?.title?.trim()) {
      return res.status(400).json({ error: 'Вкажіть назву закладу' });
    }
    if (!req.body?.address?.trim()) {
      return res.status(400).json({ error: 'Вкажіть адресу' });
    }
    if (!req.body?.cat?.trim()) {
      return res.status(400).json({ error: 'Оберіть категорію (cat)' });
    }

    const data = await readData();
    const loc = defaultLocation(user.id, req.body);
    if (loc.providerId !== user.id) {
      return res.status(500).json({ error: 'Помилка прив\'язки локації до користувача' });
    }
    data.mockLocations.push(loc);
    await persistLocationsPatch(data, [loc]);
    res.status(201).json({ ok: true, location: loc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка створення локації' });
  }
});

app.put('/api/provider/locations/:id', requireAuth, requireProviderOrAdmin, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const data = await readData();
    const loc = findLocation(data, req.params.id);
    if (!canManageLocation(loc, user)) {
      return res.status(403).json({ error: 'Немає доступу до цієї локації' });
    }

    const fields = ['title', 'text', 'address', 'workingHours', 'openStatus'];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) loc[f] = req.body[f];
    });
    if (req.body.phone !== undefined) {
      loc.phone = formatLocationPhone(req.body.phone);
    }
    if (req.body.lat !== undefined) loc.lat = Number(req.body.lat);
    if (req.body.lng !== undefined) loc.lng = Number(req.body.lng);

    if (req.body.cat !== undefined) {
      const catKey = String(req.body.cat || '').trim();
      if (!catKey || !data.masterCatalog?.[catKey]) {
        return res.status(400).json({ error: 'Оберіть дійсну категорію з каталогу' });
      }
      loc.cat = catKey;
    }

    if (req.body.customSubcats && typeof req.body.customSubcats === 'object') {
      loc.customSubcats = req.body.customSubcats;
    }

    if (Array.isArray(req.body.subcats)) {
      const validSubs = data.masterCatalog?.[loc.cat]?.subcats || {};
      const customKeys = new Set(Object.keys(loc.customSubcats || {}));
      const next = [
        ...new Set(
          req.body.subcats
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean)
        ),
      ];
      loc.subcats = next.filter((s) => validSubs[s] || customKeys.has(s));
      if (!loc.subcats.length) {
        return res.status(400).json({ error: 'Оберіть хоча б одну підкатегорію' });
      }
    }

    if (req.body.prices && typeof req.body.prices === 'object') {
      // Full editor save replaces the price list (unchecked services are removed).
      loc.prices = normalizePricesMap(req.body.prices);
    }
    if (req.body.schedule) loc.schedule = req.body.schedule;

    await persistLocationsPatch(data, [loc]);
    res.json({ ok: true, location: loc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка оновлення локації' });
  }
});

app.delete('/api/provider/locations/:id', requireAuth, requireProviderOrAdmin, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const data = await readData();
    const idx = data.mockLocations.findIndex((l) => l.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Локацію не знайдено' });
    if (!canManageLocation(data.mockLocations[idx], user)) {
      return res.status(403).json({ error: 'Немає доступу до цієї локації' });
    }
    const [removed] = data.mockLocations.splice(idx, 1);
    const photos = normalizePhotos(removed.photos);
    for (const photo of photos) {
      await deleteLocationPhotoFile(photo.path);
    }
    await persistLocationsPatch(data, []);
    try {
      await supabaseClient.from('locations').delete().eq('id', removed.id);
    } catch (_) {
      /* optional */
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка видалення локації' });
  }
});

app.post('/api/provider/locations/:id/photos', requireAuth, requireProviderOrAdmin, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const data = await readData();
    const loc = findLocation(data, req.params.id);
    if (!canManageLocation(loc, user)) {
      return res.status(403).json({ error: 'Немає доступу до цієї локації' });
    }

    loc.photos = normalizePhotos(loc.photos);
    if (loc.photos.length >= MAX_PHOTOS) {
      return res.status(400).json({
        error: `Можна завантажити не більше ${MAX_PHOTOS} фото`,
      });
    }

    const dataUrl = req.body?.dataUrl || req.body?.image;
    if (!dataUrl) {
      return res.status(400).json({ error: 'Надішліть фото (dataUrl)' });
    }

    const photo = await uploadLocationPhoto({
      locationId: loc.id,
      providerId: user.id,
      dataUrl,
    });
    loc.photos.push(photo);
    await persistLocationsPatch(data, [loc]);
    res.status(201).json({ ok: true, photo, photos: loc.photos, maxPhotos: MAX_PHOTOS });
  } catch (err) {
    console.error('[POST /api/provider/locations/:id/photos]', err);
    res.status(400).json({ error: err.message || 'Помилка завантаження фото' });
  }
});

app.delete('/api/provider/locations/:id/photos/:photoId', requireAuth, requireProviderOrAdmin, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const data = await readData();
    const loc = findLocation(data, req.params.id);
    if (!canManageLocation(loc, user)) {
      return res.status(403).json({ error: 'Немає доступу до цієї локації' });
    }

    loc.photos = normalizePhotos(loc.photos);
    const idx = loc.photos.findIndex((p) => p.id === req.params.photoId);
    if (idx === -1) return res.status(404).json({ error: 'Фото не знайдено' });
    const [removed] = loc.photos.splice(idx, 1);
    await deleteLocationPhotoFile(removed.path);
    await persistLocationsPatch(data, [loc]);
    res.json({ ok: true, photos: loc.photos });
  } catch (err) {
    console.error('[DELETE photo]', err);
    res.status(500).json({ error: 'Помилка видалення фото' });
  }
});

app.post('/api/provider/locations/:id/prices', requireAuth, requireProviderOrAdmin, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const serviceName = req.body.serviceName?.trim();
    const price = req.body.price?.trim();
    const cat = req.body.cat;
    const subcats = req.body.subcats;

    if (!serviceName || !price) {
      return res.status(400).json({ error: 'Вкажіть назву послуги та ціну' });
    }
    if (!isValidPrice(price)) {
      return res.status(400).json({ error: 'Ціна має містити число (наприклад 650 або 650 грн)' });
    }

    const data = await readData();
    const loc = findLocation(data, req.params.id);
    if (!canManageLocation(loc, user)) {
      return res.status(403).json({ error: 'Немає доступу до цієї локації' });
    }

    if (!loc.prices) loc.prices = {};
    loc.prices[serviceName] = formatPrice(price);
    if (cat) loc.cat = cat;
    if (Array.isArray(subcats) && subcats.length) {
      loc.subcats = [...new Set([...(loc.subcats || []), ...subcats])];
    }

    await persistLocationsPatch(data, [loc]);
    res.json({ ok: true, location: loc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка збереження послуги' });
  }
});

app.delete('/api/provider/locations/:id/prices', requireAuth, requireProviderOrAdmin, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const serviceName = req.body.serviceName?.trim();
    if (!serviceName) return res.status(400).json({ error: 'Вкажіть назву послуги' });

    const data = await readData();
    const loc = findLocation(data, req.params.id);
    if (!canManageLocation(loc, user)) {
      return res.status(403).json({ error: 'Немає доступу до цієї локації' });
    }

    delete loc.prices[serviceName];
    await persistLocationsPatch(data, [loc]);
    res.json({ ok: true, location: loc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка видалення послуги' });
  }
});

app.put('/api/provider/profile', requireAuth, requireProvider, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const data = await readData();
    if (!data.providerProfiles[user.id]) {
      data.providerProfiles[user.id] = {};
    }
    const profile = data.providerProfiles[user.id];
    const onlyBasicProfile =
      req.body.serviceCategories === undefined &&
      req.body.serviceSubcategories === undefined &&
      req.body.customSubcategories === undefined;
    if (req.body.companyName?.trim()) profile.companyName = req.body.companyName.trim();
    if (req.body.phone !== undefined) {
      const phoneRaw = String(req.body.phone || '').trim();
      if (!phoneRaw) {
        profile.phone = '';
        const clearErr = await updateUserPhone(user.id, null);
        if (clearErr && clearErr.code !== '23502') {
          console.warn('[profile] clear users.phone:', clearErr.message);
        }
      } else {
        const normalizedPhone = normalizePhone(phoneRaw);
        if (!normalizedPhone || normalizedPhone.replace(/\D/g, '').length < 10) {
          return res.status(400).json({ error: 'Невірний формат телефону' });
        }
        const phoneError = await updateUserPhone(user.id, normalizedPhone);
        if (phoneError) {
          if (phoneError.code === '23505') {
            return res.status(409).json({
              error: 'Цей телефон уже зайнятий іншим акаунтом',
            });
          }
          return res.status(500).json({ error: 'Не вдалося зберегти телефон' });
        }
        profile.phone = normalizedPhone;
      }
    }
    if (req.body.serviceSubcategories !== undefined) {
      profile.serviceSubcategories = normalizeServiceSubcategories(
        req.body.serviceSubcategories,
        data.masterCatalog
      );
    }
    if (req.body.customSubcategories !== undefined) {
      profile.customSubcategories = normalizeCustomSubcategories(
        req.body.customSubcategories,
        data.masterCatalog
      );
    }
    if (req.body.serviceCategories !== undefined) {
      profile.serviceCategories = mergeProviderServiceCategories(
        normalizeServiceCategories(req.body.serviceCategories, data.masterCatalog),
        profile.serviceSubcategories || [],
        profile.customSubcategories || []
      );
    } else if (
      !onlyBasicProfile &&
      (profile.serviceSubcategories?.length || profile.customSubcategories?.length)
    ) {
      profile.serviceCategories = mergeProviderServiceCategories(
        profile.serviceCategories || [],
        profile.serviceSubcategories || [],
        profile.customSubcategories || []
      );
    }
    if (!Array.isArray(profile.serviceCategories)) profile.serviceCategories = [];
    if (!Array.isArray(profile.serviceSubcategories)) profile.serviceSubcategories = [];
    if (!Array.isArray(profile.customSubcategories)) profile.customSubcategories = [];
    if (
      !onlyBasicProfile &&
      !profile.serviceCategories.length &&
      !profile.serviceSubcategories.length &&
      !profile.customSubcategories.length
    ) {
      return res.status(400).json({
        error:
          'Оберіть категорію, підкатегорію з каталогу або додайте свою підкатегорію',
      });
    }
    try {
      await upsertProviderProfile(user.id, profile);
    } catch (e) {
      console.warn('[profile] supabase profile:', e.message);
    }
    try {
      await fsPromises.writeFile(DATA_FILE, JSON.stringify(ensureDataShape(data), null, 2), 'utf8');
    } catch (e) {
      console.warn('[profile] local skip:', e.message);
    }
    const fullUser = (await readUsers()).find((u) => u.id === user.id) || user;
    let telegramId = fullUser.telegramId || null;
    if (fullUser.phone && !telegramId) {
      telegramId = await getTelegramIdForPhone(fullUser.phone);
    }
    res.json({
      ok: true,
      profile,
      account: {
        phone: fullUser.phone || profile.phone || '',
        telegramLinked: Boolean(telegramId),
        telegramLinkedAt: fullUser.telegramLinkedAt || null,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка оновлення профілю' });
  }
});

app.get('/api/provider/import/template', requireAuth, requireProvider, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="mapfix-locations-template.csv"');
  res.send('\uFEFF' + PROVIDER_IMPORT_TEMPLATE_CSV);
});

app.get('/api/provider/places/search', requireAuth, requireProvider, async (req, res) => {
  try {
    if (!process.env.GOOGLE_PLACES_API_KEY && !process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(503).json({
        ok: false,
        error: 'places_not_configured',
        message: 'Додайте GOOGLE_PLACES_API_KEY у Vercel для пошуку місць Google',
      });
    }
    const places = await searchGooglePlacesText({
      query: req.query.q,
      lat: req.query.lat != null ? Number(req.query.lat) : undefined,
      lng: req.query.lng != null ? Number(req.query.lng) : undefined,
    });
    res.json({ ok: true, places });
  } catch (err) {
    console.error('[GET /api/provider/places/search]', err);
    res.status(400).json({ error: err.message || 'Помилка пошуку Google' });
  }
});

app.get('/api/provider/places/details', requireAuth, requireProvider, async (req, res) => {
  try {
    if (!process.env.GOOGLE_PLACES_API_KEY && !process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(503).json({
        ok: false,
        error: 'places_not_configured',
        message: 'Додайте GOOGLE_PLACES_API_KEY у Vercel',
      });
    }
    const place = await fetchGooglePlaceDetails({ placeId: req.query.placeId });
    res.json({ ok: true, place });
  } catch (err) {
    console.error('[GET /api/provider/places/details]', err);
    res.status(400).json({ error: err.message || 'Помилка деталей місця' });
  }
});

app.post('/api/provider/import/place', requireAuth, requireProvider, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const cat = String(req.body.cat || '').trim();
    if (!cat) return res.status(400).json({ error: 'Оберіть категорію Mapfix' });

    let place = req.body.place;
    if (!place && req.body.placeId) {
      place = await fetchGooglePlaceDetails({ placeId: req.body.placeId });
    }
    if (!place?.title || !Number.isFinite(Number(place.lat)) || !Number.isFinite(Number(place.lng))) {
      return res.status(400).json({ error: 'Немає даних місця для імпорту' });
    }

    const loc = googlePlaceToLocation(place, { providerId: user.id, cat });
    const data = await readData();
    const merged = mergeLocations(data.mockLocations, [loc], { updateExisting: false });
    if (!merged.added.length) {
      return res.status(409).json({
        error: 'Схожа точка вже є на карті',
        skipped: merged.skipped,
      });
    }
    const created = merged.locations.find((l) => l.id === merged.added[0]);
    created.providerId = user.id;
    data.mockLocations = merged.locations.map((l) =>
      l.id === created.id ? { ...l, providerId: user.id } : l
    );
    await persistLocationsPatch(data, [created]);
    res.status(201).json({ ok: true, location: created });
  } catch (err) {
    console.error('[POST /api/provider/import/place]', err);
    res.status(500).json({ error: err.message || 'Помилка імпорту місця' });
  }
});

async function handleExcelImport(req, res, { asSystem = false } = {}) {
  try {
    const user = getSessionUser(req);
    const defaultCat = String(req.body.defaultCat || '').trim() || 'home';
    let rows = Array.isArray(req.body.rows) ? req.body.rows : null;
    if (!rows && req.body.csv) {
      rows = parseCsv(String(req.body.csv));
    }
    if (!rows || !rows.length) {
      return res.status(400).json({
        error:
          'Немає рядків. Колонки: maps_url АБО title,address,phone,working_hours,lat,lng,cat',
      });
    }

    const providerId = asSystem ? null : user.id;
    const { locations: incoming, errors } = await importExcelRowsToLocations(rows, {
      defaultCategory: defaultCat,
      providerId,
    });

    if (!incoming.length) {
      return res.status(400).json({
        error: 'Жодного валідного рядка',
        errors,
      });
    }

    const data = await readData();
    const active = activeLocations(data.mockLocations);
    const trash = trashedLocations(data.mockLocations);
    const merged = mergeLocations(active, incoming, { updateExisting: false });
    const created = merged.locations
      .filter((l) => merged.added.includes(l.id))
      .map((l) => ({
        ...l,
        providerId,
      }));
    data.mockLocations = [
      ...merged.locations.map((l) =>
        merged.added.includes(l.id) ? { ...l, providerId } : l
      ),
      ...trash,
    ];
    await persistLocationsPatch(data, created);
    res.status(201).json({
      ok: true,
      added: created.length,
      skipped: merged.skipped.length,
      locations: created,
      skippedDetails: merged.skipped,
      errors,
    });
  } catch (err) {
    console.error('[POST /api/*/import/excel]', err);
    res.status(500).json({ error: err.message || 'Помилка імпорту Excel' });
  }
}

app.post('/api/provider/import/excel', requireAuth, requireProviderOrAdmin, (req, res) =>
  handleExcelImport(req, res, { asSystem: false })
);

app.post('/api/admin/import/excel', requireAuth, requireAdmin, (req, res) =>
  handleExcelImport(req, res, { asSystem: true })
);

app.use(express.static(PUBLIC_DIR, { index: false, fallthrough: true }));

async function validateStartupData() {
  const data = await readData();
  const catalogCheck = validateCatalogHierarchy(data.masterCatalog);
  if (!catalogCheck.ok) {
    console.warn('[startup] Помилки каталогу:', catalogCheck.errors.slice(0, 5).join('; '));
  } else {
    console.log(
      `[startup] Каталог OK: ${catalogCheck.stats.cats} кат., ${catalogCheck.stats.subcats} підкат., ${catalogCheck.stats.services} послуг`
    );
  }
  const users = await readUsers();
  const badUsers = users.filter((u) => !ALL_KNOWN_ROLES.includes(u.role));
  if (badUsers.length) {
    console.warn('[startup] Невідомі ролі в Supabase (users):', badUsers.map((u) => u.login).join(', '));
  }
}

if (require.main === module) {
  const server = app.listen(PORT, async () => {
    console.log(`Mapfix: http://localhost:${PORT}`);
    console.log(`Вхід: http://localhost:${PORT}/login.html`);
    console.log(`Реєстрація: http://localhost:${PORT}/register.html`);
    console.log(`Підключити Telegram: http://localhost:${PORT}/link-telegram.html`);
    console.log(`Кабінет клієнта: http://localhost:${PORT}/client`);
    console.log(`Адмін-панель: http://localhost:${PORT}/admin`);
    try {
      await validateStartupData();
    } catch (err) {
      console.error('[startup] Помилка валідації:', err.message);
    }
    try {
      await startTelegramBotRuntime();
    } catch (err) {
      console.error('[startup] Telegram runtime:', err.message);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[startup] Порт ${PORT} уже зайнятий іншим процесом.`);
      console.error('Спробуйте: npm.cmd start  (скрипт автоматично звільнить порт)');
      console.error(
        `Або вручну (PowerShell): Get-NetTCPConnection -LocalPort ${PORT} | Stop-Process -Id {OwningProcess} -Force\n`
      );
      process.exit(1);
    }
    console.error('[startup] Помилка сервера:', err.message);
    process.exit(1);
  });
} else if (process.env.VERCEL && isTelegramConfigured()) {
  // Best-effort webhook registration on serverless cold start
  startTelegramBotRuntime().catch((err) => {
    console.error('[vercel] Telegram runtime:', err.message);
  });
}

module.exports = app;