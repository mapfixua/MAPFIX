const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const crypto = require('crypto');
const { validateCatalogHierarchy } = require('./catalog-data.js');
const { parseVoiceSearch } = require('./search-ai.js');
const { attachAuth, setAuthCookie, clearAuthCookie } = require('./auth-jwt.js');
const { resolveProjectRoot, resolvePublicDir } = require('./paths.js');
const {
  supabaseClient,
  USERS_TABLE,
  mapUserRow,
  toUserRow,
} = require('./supabaseClient.js');

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

app.use(express.json());
app.use(cookieParser());
app.use(attachAuth(JWT_SECRET));
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

function formatPrice(price) {
  const p = String(price).trim();
  if (/грн/i.test(p)) return p;
  return `${p} грн`;
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

function ensureDataShape(data) {
  if (!data.providerProfiles) data.providerProfiles = {};
  if (!data.mockLocations) data.mockLocations = [];
  if (!data.masterCatalog) data.masterCatalog = {};
  data.mockLocations.forEach((loc) => {
    if (loc.providerId === undefined) loc.providerId = null;
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
  return ensureDataShape(JSON.parse(raw));
}

async function writeData(data) {
  const payload = ensureDataShape(data);
  console.log('[writeData]', DATA_FILE, 'locations:', payload.mockLocations?.length ?? 0);
  await fsPromises.writeFile(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log('[writeData] OK');
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
  const base = { id: user.id, login: user.login, role: user.role };
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
    phone: body.phone?.trim() || '',
    address: body.address?.trim() || '',
    schedule: body.schedule || { 'Пн-Пт': '09:00 - 18:00' },
    subcats: Array.isArray(body.subcats) ? body.subcats : [],
    prices: typeof body.prices === 'object' && body.prices ? body.prices : {},
    reviews: [],
  };
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
    const publicUser = await toPublicUserWithProfile(
      (await readUsers()).find((u) => u.id === user.id) || user,
      data
    );
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

    if (!login || login.length < 3) {
      return res.status(400).json({ error: 'Логін має містити щонайменше 3 символи' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'Пароль має містити щонайменше 6 символів' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: "Роль має бути 'client' або 'provider'" });
    }
    if (role === 'provider' && !companyName) {
      return res.status(400).json({ error: 'Для провайдера вкажіть назву компанії' });
    }

    const dataForCatalog = await readData();
    const catalog = dataForCatalog.masterCatalog;
    const serviceSubcategories =
      role === 'provider'
        ? normalizeServiceSubcategories(req.body.serviceSubcategories, catalog)
        : [];
    const customSubcategories =
      role === 'provider'
        ? normalizeCustomSubcategories(req.body.customSubcategories, catalog)
        : [];
    let serviceCategories =
      role === 'provider'
        ? mergeProviderServiceCategories(
            normalizeServiceCategories(req.body.serviceCategories, catalog),
            serviceSubcategories,
            customSubcategories
          )
        : [];

    if (
      role === 'provider' &&
      serviceCategories.length === 0 &&
      !serviceSubcategories.length &&
      !customSubcategories.length
    ) {
      return res.status(400).json({
        error:
          'Оберіть категорію, підкатегорію з каталогу або додайте свою підкатегорію',
      });
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

    const { error: insertError } = await supabaseClient
      .from(USERS_TABLE)
      .insert(toUserRow(newUser));
    if (insertError) {
      console.error(insertError);
      return res.status(500).json({ error: 'Помилка збереження користувача' });
    }

    if (role === 'provider') {
      const data = await readData();
      data.providerProfiles[newUser.id] = {
        companyName,
        phone: req.body.phone?.trim() || '',
        serviceCategories,
        serviceSubcategories,
        customSubcategories,
        createdAt: new Date().toISOString(),
      };
      await writeData(data);
    }

    setSessionUser(res, newUser);
    const data = await readData();
    res.status(201).json({ ok: true, user: await toPublicUserWithProfile(newUser, data) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка реєстрації' });
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
app.get('/api/data', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const data = await readData();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося прочитати data.json' });
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
      query: text,
    });
  } catch (err) {
    console.error('[POST /api/search-ai]', err);
    res.status(500).json({ error: 'Помилка AI-пошуку' });
  }
});

app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [data, users] = await Promise.all([readData(), readUsers()]);
    const providers = users
      .filter((u) => u.role === 'provider')
      .map((u) => ({
        id: u.id,
        login: u.login,
        companyName: data.providerProfiles[u.id]?.companyName || '—',
        phone: data.providerProfiles[u.id]?.phone || '',
        locationsCount: data.mockLocations.filter((l) => l.providerId === u.id).length,
      }));

    const locations = data.mockLocations.map((loc) => ({
      id: loc.id,
      title: loc.title,
      providerId: loc.providerId,
      cat: loc.cat,
      address: loc.address,
      openStatus: loc.openStatus,
      servicesCount: Object.keys(loc.prices || {}).length,
    }));

    res.json({
      providers,
      locations,
      catalogCategories: Object.keys(data.masterCatalog).length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка завантаження панелі' });
  }
});

app.delete('/api/admin/locations/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = await readData();
    const idx = data.mockLocations.findIndex((l) => l.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Локацію не знайдено' });
    data.mockLocations.splice(idx, 1);
    await writeData(data);
    res.json({ ok: true });
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

app.get('/api/provider/dashboard', requireAuth, rejectClientFromPanel, requireProviderOrAdmin, async (req, res) => {
  try {
    const user = getSessionUser(req);
    const data = await readData();
    const profile =
      data.providerProfiles[user.id] ||
      (user.role === 'admin'
        ? { companyName: 'Адміністратор' }
        : { companyName: 'Моя компанія' });
    const locations = data.mockLocations.filter((l) => l.providerId === user.id);

    res.json({
      profile,
      locations,
      masterCatalog: data.masterCatalog,
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
    await writeData(data);
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

    const fields = [
      'title',
      'text',
      'address',
      'phone',
      'workingHours',
      'openStatus',
      'cat',
    ];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) loc[f] = req.body[f];
    });
    if (req.body.lat !== undefined) loc.lat = Number(req.body.lat);
    if (req.body.lng !== undefined) loc.lng = Number(req.body.lng);
    if (Array.isArray(req.body.subcats)) loc.subcats = req.body.subcats;
    if (req.body.schedule) loc.schedule = req.body.schedule;

    await writeData(data);
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
    data.mockLocations.splice(idx, 1);
    await writeData(data);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка видалення' });
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

    await writeData(data);
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
    await writeData(data);
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
    if (req.body.companyName?.trim()) profile.companyName = req.body.companyName.trim();
    if (req.body.phone !== undefined) profile.phone = req.body.phone.trim();
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
    } else if (profile.serviceSubcategories?.length || profile.customSubcategories?.length) {
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
      !profile.serviceCategories.length &&
      !profile.serviceSubcategories.length &&
      !profile.customSubcategories.length
    ) {
      return res.status(400).json({
        error:
          'Оберіть категорію, підкатегорію з каталогу або додайте свою підкатегорію',
      });
    }
    await writeData(data);
    res.json({ ok: true, profile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Помилка оновлення профілю' });
  }
});

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
    console.warn('[startup] Невідомі ролі в Supabase (usersІ):', badUsers.map((u) => u.login).join(', '));
  }
}

if (require.main === module) {
  const server = app.listen(PORT, async () => {
    console.log(`Mapfix: http://localhost:${PORT}`);
    console.log(`Вхід: http://localhost:${PORT}/login.html`);
    console.log(`Реєстрація: http://localhost:${PORT}/register.html`);
    console.log(`Кабінет клієнта: http://localhost:${PORT}/client`);
    console.log(`Адмін-панель: http://localhost:${PORT}/admin`);
    try {
      await validateStartupData();
    } catch (err) {
      console.error('[startup] Помилка валідації:', err.message);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[startup] Порт ${PORT} уже зайнятий іншим процесом.`);
      console.error('Спробуйте: npm start  (скрипт автоматично звільнить порт)');
      console.error(
        `Або вручну (PowerShell): Get-NetTCPConnection -LocalPort ${PORT} | Stop-Process -Id {OwningProcess} -Force\n`
      );
      process.exit(1);
    }
    console.error('[startup] Помилка сервера:', err.message);
    process.exit(1);
  });
}

module.exports = app;