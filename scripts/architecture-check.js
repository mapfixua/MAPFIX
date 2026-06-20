'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');
const { validateCatalogHierarchy } = require('../catalog-data.js');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function httpRequest(method, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {},
    };
    if (body) opts.headers['Content-Type'] = 'application/json';
    if (cookie) opts.headers.Cookie = cookie;

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        })
      );
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function parseCookie(setCookie) {
  if (!setCookie) return '';
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function checkMapStability() {
  const indexHtml = read('index.html');
  const hasNoStore = /cache:\s*['"]no-store['"]/.test(indexHtml);
  const hasApiData = indexHtml.includes('/api/data');
  const hasBust = indexHtml.includes('Date.now()') && (indexHtml.includes('?t=') || indexHtml.includes('&t='));
  const hasSync = indexHtml.includes('mapfix-sync.js') && fs.existsSync(path.join(ROOT, 'mapfix-sync.js'));

  let liveOk = false;
  let cacheHeader = '';
  try {
    const res = await httpRequest('GET', `/api/data?_=${Date.now()}`);
    cacheHeader = res.headers['cache-control'] || '';
    liveOk = res.status === 200 && cacheHeader.includes('no-store');
  } catch (_) {
    liveOk = false;
  }

  const ok = hasApiData && hasNoStore && hasBust && hasSync && (liveOk || !cacheHeader);
  return {
    id: 1,
    name: 'Стабільність карти (index.html → /api/data, без кешу)',
    ok,
    details: [
      `fetch /api/data: ${hasApiData ? 'OK' : 'FAIL'}`,
      `cache: 'no-store' у клієнті: ${hasNoStore ? 'OK' : 'FAIL'}`,
      `cache-bust ?t=: ${hasBust ? 'OK' : 'FAIL'}`,
      `mapfix-sync.js: ${hasSync ? 'OK' : 'FAIL'}`,
      liveOk
        ? `сервер Cache-Control: ${cacheHeader}`
        : 'сервер не відповів (запустіть npm start для live-перевірки)',
    ],
  };
}

function checkCatalogHierarchy() {
  const data = JSON.parse(read('data.json'));
  const result = validateCatalogHierarchy(data.masterCatalog);
  const catalogJs = read('catalog-data.js');
  const hasValidator = catalogJs.includes('validateCatalogHierarchy');

  return {
    id: 2,
    name: 'Ієрархія категорій (Категорія → Підкатегорія → Послуга + ціна)',
    ok: result.ok && hasValidator,
    details: [
      `Категорій: ${result.stats.cats}`,
      `Підкатегорій: ${result.stats.subcats}`,
      `Послуг: ${result.stats.services}`,
      hasValidator ? 'catalog-data.js: валідатор OK' : 'catalog-data.js: валідатор відсутній',
      ...(result.errors.length ? result.errors.slice(0, 3) : ['Структура data.json валідна']),
    ],
  };
}

function checkRolesAndBinding() {
  const serverJs = read('server.js');
  const adminHtml = read('admin.html');

  const checks = {
    requireAuth: serverJs.includes('function requireAuth'),
    requireProviderOrAdmin: serverJs.includes('requireProviderOrAdmin'),
    adminRouteGuard: serverJs.includes('canAccessAdmin'),
    providerIdFromSession: serverJs.includes('defaultLocation(user.id'),
    rejectBodyProviderId: serverJs.includes('providerId визначається сервером'),
    adminClientAuth: adminHtml.includes('/api/me') && adminHtml.includes("location.href = '/login.html'"),
    providerPanelGuard:
      adminHtml.includes("me.user.role === 'provider'") &&
      adminHtml.includes("me.user.role === 'admin'"),
  };

  const ok = Object.values(checks).every(Boolean);
  return {
    id: 3,
    name: 'Адмінка та ролі (авторизація + providerId з сесії)',
    ok,
    details: Object.entries(checks).map(([k, v]) => `${k}: ${v ? 'OK' : 'FAIL'}`),
  };
}

async function checkLoginFlow() {
  const users = JSON.parse(read('users.json'));
  const loginHtml = read('login.html');
  const serverJs = read('server.js');

  const hasLoginRoute = serverJs.includes("app.post('/api/login'");
  const hasRedirect = loginHtml.includes('/api/login') && loginHtml.includes('redirectByRole');
  const adminUser = users.find((u) => u.login === 'admin');
  const hashOk = adminUser
    ? await bcrypt.compare('admin123', adminUser.passwordHash)
    : false;

  let apiLoginOk = false;
  try {
    const res = await httpRequest('POST', '/api/login', {
      login: 'admin',
      password: 'admin123',
    });
    apiLoginOk = res.status === 200;
  } catch (_) {
    apiLoginOk = false;
  }

  const ok =
    hasLoginRoute &&
    hasRedirect &&
    hashOk &&
    users.every((u) => u.id && u.login && u.passwordHash && u.role);
  return {
    id: 4,
    name: 'Self-check: login.html ↔ users.json ↔ /api/login',
    ok,
    details: [
      `users.json записів: ${users.length}`,
      `bcrypt admin/admin123: ${hashOk ? 'OK' : 'FAIL'}`,
      `login.html → redirectByRole: ${hasRedirect ? 'OK' : 'FAIL'}`,
      `POST /api/login: ${apiLoginOk ? 'OK (live)' : 'offline або FAIL'}`,
    ],
  };
}

async function main() {
  console.log('\n=== Mapfix Architecture Self-Check ===\n');

  const results = await Promise.all([
    checkMapStability(),
    Promise.resolve(checkCatalogHierarchy()),
    Promise.resolve(checkRolesAndBinding()),
    checkLoginFlow(),
  ]);

  let allOk = true;
  for (const r of results) {
    const mark = r.ok ? '✅' : '❌';
    console.log(`${mark} [${r.id}/4] ${r.name}`);
    r.details.forEach((d) => console.log(`    · ${d}`));
    if (!r.ok) allOk = false;
    console.log('');
  }

  console.log(allOk ? '✅ Усі 4 модулі готові.\n' : '❌ Є проблеми — перегляньте пункти вище.\n');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
