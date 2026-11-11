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
  const indexHtml = read('public/index.html');
  const appJsPath = path.join(ROOT, 'public/js/mapfix-app.js');
  const appJs = fs.existsSync(appJsPath) ? fs.readFileSync(appJsPath, 'utf8') : '';
  const client = `${indexHtml}\n${appJs}`;
  const hasNoStore = /cache:\s*['"]no-store['"]/.test(client);
  const hasApiData = client.includes('/api/data');
  const hasBust = client.includes("fetch('/api/data'");
  const hasSync = indexHtml.includes('mapfix-sync.js') && fs.existsSync(path.join(ROOT, 'public/mapfix-sync.js'));

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
      `fetch('/api/data') у клієнті: ${hasBust ? 'OK' : 'FAIL'}`,
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
  const adminHtml = read('public/admin.html');

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
  const loginHtml = read('public/login.html');
  const serverJs = read('server.js');

  const hasLoginRoute = serverJs.includes("app.post('/api/login'");
  const hasRedirect = loginHtml.includes('/api/login') && loginHtml.includes('redirectByRole');
  const adminUser = users.find((u) => u.login === 'admin');
  const hashPresent = Boolean(adminUser?.passwordHash && String(adminUser.passwordHash).startsWith('$2'));
  const defaultPasswordStillWorks = adminUser
    ? await bcrypt.compare('admin123', adminUser.passwordHash)
    : false;

  let apiLoginOk = false;
  try {
    const res = await httpRequest('POST', '/api/login', {
      login: 'admin',
      password: process.env.MAPFIX_ADMIN_PASSWORD || '',
    });
    apiLoginOk = res.status === 200;
  } catch (_) {
    apiLoginOk = false;
  }

  const ok =
    hasLoginRoute &&
    hasRedirect &&
    hashPresent &&
    !defaultPasswordStillWorks &&
    users.every((u) => u.id && u.login && u.passwordHash && u.role);
  return {
    id: 4,
    name: 'Self-check: login.html ↔ users.json ↔ /api/login',
    ok,
    details: [
      `users.json записів: ${users.length}`,
      `admin hash present: ${hashPresent ? 'OK' : 'FAIL'}`,
      `default admin123 disabled: ${!defaultPasswordStillWorks ? 'OK' : 'FAIL (still works)'}`,
      `login.html → redirectByRole: ${hasRedirect ? 'OK' : 'FAIL'}`,
      `POST /api/login (MAPFIX_ADMIN_PASSWORD): ${apiLoginOk ? 'OK (live)' : 'skip/offline'}`,
    ],
  };
}

function checkSeoLanding() {
  const seo = require('../seo.js');
  const serverJs = read('server.js');
  const indexHtml = read('public/index.html');
  const plumber = seo.parseLanding({ pathname: '/kyiv/santekhnik', query: {} });
  const homeSub = seo.parseLanding({ pathname: '/kyiv/home/plumber', query: {} });
  const area = seo.parseLanding({ pathname: '/kyiv/kotsiubynske', query: {} });
  const title = seo.stripHeadingDecor('🛠️ Ремонт та Побутові послуги');
  const sm = seo.sitemapXml({
    categories: [{ key: 'home' }, { key: 'auto' }],
    locations: [
      {
        id: 'loc-1',
        title: 'Майстер',
        lastmod: '2026-01-02',
        lat: 50.49,
        lng: 30.33,
        cat: 'home',
        subcats: ['plumber'],
        address: 'Коцюбинське',
      },
      { id: 'loc-2', title: 'Авто', cat: 'auto', lat: 50.45, lng: 30.52 },
      { id: 'loc-top-tyres', title: 'TopTyres', cat: 'auto', lat: 50.45, lng: 30.52 },
    ],
  });
  const homeBlock = (sm.match(/<loc>https:\/\/www\.mapfix\.com\.ua\/<\/loc>[\s\S]*?<\/url>/) || [''])[0];
  const datedBlock = (sm.match(/<loc>[^<]*\/p\/loc-1<\/loc>[\s\S]*?<\/url>/) || [''])[0];
  const undatedBlock = (sm.match(/<loc>[^<]*\/p\/loc-2<\/loc>[\s\S]*?<\/url>/) || [''])[0];
  const legacy = seo.legacyHostRedirectUrl(
    'mapfix-wine.vercel.app',
    '/kyiv/home/plumber?q=1'
  );
  const checks = {
    plumberAlias: plumber.cat === 'home' && plumber.sub === 'plumber',
    plumberCanon: seo.canonicalPath(homeSub) === '/kyiv/home/plumber',
    aliasRedirect: seo.shouldRedirectAlias('/kyiv/santekhnik', plumber),
    kotsiubynske: area.area === 'kotsiubynske',
    emojiStrip: title.startsWith('Ремонт'),
    sitemapPlumber: sm.includes('/kyiv/home/plumber') && sm.includes('/kyiv/kotsiubynske') && !sm.includes('/kotsyubynske</loc>') && !sm.includes('/p/loc-top-tyres'),
    sitemapLastmod:
      datedBlock.includes('<lastmod>2026-01-02</lastmod>') &&
      !undatedBlock.includes('<lastmod>') &&
      homeBlock.includes('<lastmod>2026-01-02</lastmod>'),
    legacyHost: legacy === 'https://www.mapfix.com.ua/kyiv/home/plumber?q=1',
    serverAlias: serverJs.includes('resolveSeoRequest') && serverJs.includes('/kyiv/:seg1/:seg2/:seg3'),
    serverLegacy: serverJs.includes('legacyHostRedirectUrl'),
    jsonldSlot: indexHtml.includes('<!--MAPFIX_JSONLD-->') && indexHtml.includes('twitter:image'),
    lightSitemap: serverJs.includes('sitemapXml({ categories, locations })'),
    branded404:
      serverJs.includes('sendHtmlNotFound') &&
      serverJs.includes('renderNotFoundPage') &&
      seo.renderNotFoundPage().includes('Сторінку не знайдено') &&
      seo.renderNotFoundPage().includes('noindex') &&
      seo.resolveSeoRequest({
        pathname: '/kyiv/foo',
        query: {},
        catalog: { home: { name: 'Дім', subcats: {} } },
        locations: [],
      }).notFound === true,
    hideDemos:
      seo.isPublicTestLocation({ id: 'loc-top-tyres', title: 'TopTyres Шиномонтаж на Подолі' }) &&
      seo.isPublicTestLocation({ id: 'flagged', title: 'Справжній', demo: true }) &&
      !seo.isPublicTestLocation({ id: 'loc-real', title: 'Майстер Іван' }),
    districtFilter: (() => {
      const listing = seo.buildListing({ area: 'kotsiubynske', cat: 'home', page: 1 }, [
        { id: 'near', title: 'Поруч', cat: 'home', lat: 50.49, lng: 30.33, address: 'Коцюбинське' },
        { id: 'far', title: 'Далеко', cat: 'home', lat: 50.45, lng: 30.52, address: 'Київ' },
      ]);
      const empty = seo.buildListing({ area: 'sviatoshyn', cat: 'food', page: 1 }, [
        { id: 'far', title: 'Далеко', cat: 'home', lat: 50.45, lng: 30.52 },
      ]);
      return listing.filtered.length === 1 && listing.filtered[0].id === 'near' && empty.noindex === true;
    })(),
    noFakeRating: (() => {
      const googleLoc = {
        id: 'g',
        title: 'Імпорт',
        cat: 'home',
        rating: 5,
        reviewsCount: 3,
        reviews: [{ rating: 5, text: 'Відгук з Google Maps', source: 'google_maps' }],
      };
      const ownedLoc = {
        id: 'o',
        title: 'Свій',
        cat: 'home',
        reviews: [{ rating: 4, text: 'Швидко і акуратно', userId: 'user-1', createdAt: '2026-02-01T00:00:00.000Z' }],
      };
      const catalog = { home: { name: 'Дім', subcats: {} } };
      const googleLd = JSON.stringify(
        seo.jsonLdGraph(seo.buildSeo({ loc: 'g' }, { masterCatalog: catalog, mockLocations: [googleLoc] }), { loc: 'g' }, {
          masterCatalog: catalog,
          mockLocations: [googleLoc],
        })
      );
      const ownedLd = JSON.stringify(
        seo.jsonLdGraph(seo.buildSeo({ loc: 'o' }, { masterCatalog: catalog, mockLocations: [ownedLoc] }), { loc: 'o' }, {
          masterCatalog: catalog,
          mockLocations: [ownedLoc],
        })
      );
      return !googleLd.includes('AggregateRating') && ownedLd.includes('AggregateRating');
    })(),
    cardDetails: (() => {
      const loc = {
        id: 'card',
        title: 'Майстер',
        cat: 'home',
        text: 'Міняю змішувачі',
        subcats: ['plumber'],
        prices: { 'Заміна змішувача': '800 грн' },
        schedule: { 'Пн-Пт': '09:00 - 18:00' },
        lat: 50.45,
        lng: 30.52,
      };
      const catalog = { home: { name: 'Дім', subcats: { plumber: { name: 'Сантехнік' } } } };
      const html = seo.crawlerHtml(seo.buildSeo({ loc: 'card' }, { masterCatalog: catalog, mockLocations: [loc] }), { loc: 'card' }, {
        masterCatalog: catalog,
        mockLocations: [loc],
      });
      return html.includes('Міняю змішувачі') && html.includes('800 грн') && html.includes('09:00 - 18:00') && html.includes('Сантехнік');
    })(),
    cardSchemaLocalityHours: (() => {
      const catalog = {
        beauty: { name: 'Краса', subcats: { nails: { name: 'Нігті' } } },
        home: { name: 'Дім', subcats: {} },
      };
      const kots = {
        id: 'kots-nails',
        title: 'Манікюр на Доківській',
        cat: 'beauty',
        address: 'вул. Доківська, Коцюбинське',
        lat: 50.4906,
        lng: 30.3347,
        schedule: { Пн: '09:00 - 18:00', Нд: 'Вихідний' },
        photos: [],
        reviewsCount: 516,
        rating: 4.9,
        reviews: [{ source: 'google_maps', rating: 5, text: 'UNIQUE_GOOGLE_REVIEW_BODY' }],
      };
      const twin = { ...kots, id: 'kots-nails-2', title: 'Другий салон', reviews: [], reviewsCount: 0 };
      const outside = { id: 'city-beauty', title: 'Центр', cat: 'beauty', lat: 50.4, lng: 30.6, address: 'Київ' };
      const hoursOnly = {
        id: 'hours-only',
        title: 'Лише текст графіка',
        cat: 'home',
        address: 'Київ',
        lat: 50.45,
        lng: 30.52,
        workingHours: 'понеділок: 10:00–20:00',
      };
      const withPhoto = {
        ...kots,
        id: 'with-photo',
        photos: [{ url: 'https://cdn.example.com/master.jpg' }],
        reviews: [],
        reviewsCount: 0,
      };
      const iconOnly = { ...withPhoto, id: 'icon-only', photos: [{ url: '/icon-512.png' }] };
      const locs = [kots, twin, outside, hoursOnly];
      const data = { masterCatalog: catalog, mockLocations: locs };
      const graph = seo.jsonLdGraph(seo.buildSeo({ loc: 'kots-nails' }, data), { loc: 'kots-nails' }, data);
      const biz = graph['@graph'].find((node) => node['@type'] === 'LocalBusiness');
      const crumb = graph['@graph'].find((node) => node['@type'] === 'BreadcrumbList');
      const bizJson = JSON.stringify(biz);
      const hoursGraph = seo.jsonLdGraph(
        seo.buildSeo({ loc: 'hours-only' }, { masterCatalog: catalog, mockLocations: [hoursOnly] }),
        { loc: 'hours-only' },
        { masterCatalog: catalog, mockLocations: [hoursOnly] }
      );
      const hoursBiz = hoursGraph['@graph'].find((node) => node['@type'] === 'LocalBusiness');
      const photoGraph = seo.jsonLdGraph(
        seo.buildSeo({ loc: 'with-photo' }, { masterCatalog: catalog, mockLocations: [withPhoto, twin, outside] }),
        { loc: 'with-photo' },
        { masterCatalog: catalog, mockLocations: [withPhoto, twin, outside] }
      );
      const photoBiz = photoGraph['@graph'].find((node) => node['@type'] === 'LocalBusiness');
      const iconGraph = seo.jsonLdGraph(
        seo.buildSeo({ loc: 'icon-only' }, { masterCatalog: catalog, mockLocations: [iconOnly] }),
        { loc: 'icon-only' },
        { masterCatalog: catalog, mockLocations: [iconOnly] }
      );
      const iconBiz = iconGraph['@graph'].find((node) => node['@type'] === 'LocalBusiness');
      const lone = { ...kots, id: 'lone', reviews: [], reviewsCount: 0 };
      const loneGraph = seo.jsonLdGraph(
        seo.buildSeo({ loc: 'lone' }, { masterCatalog: catalog, mockLocations: [lone] }),
        { loc: 'lone' },
        { masterCatalog: catalog, mockLocations: [lone] }
      );
      const loneCrumb = loneGraph['@graph'].find((node) => node['@type'] === 'BreadcrumbList');
      const html = seo.crawlerHtml(seo.buildSeo({ loc: 'kots-nails' }, data), { loc: 'kots-nails' }, data);
      const monday = (biz.openingHoursSpecification || []).find((row) => row.dayOfWeek === 'Monday');
      return (
        biz.address.addressLocality === 'Коцюбинське' &&
        monday &&
        monday.opens === '09:00' &&
        monday.closes === '18:00' &&
        !(biz.openingHoursSpecification || []).some((row) => row.dayOfWeek === 'Sunday') &&
        !('image' in biz) &&
        !bizJson.includes('icon-512') &&
        !bizJson.includes('aggregateRating') &&
        !bizJson.includes('516') &&
        crumb.itemListElement[1].item.endsWith('/kyiv/kotsiubynske/beauty') &&
        html.includes('/kyiv/kotsiubynske/beauty') &&
        !html.includes('UNIQUE_GOOGLE_REVIEW_BODY') &&
        hoursBiz.address.addressLocality === 'Київ' &&
        hoursBiz.openingHoursSpecification[0].dayOfWeek === 'Monday' &&
        hoursBiz.openingHoursSpecification[0].opens === '10:00' &&
        photoBiz.image === 'https://cdn.example.com/master.jpg' &&
        !('image' in iconBiz) &&
        loneCrumb.itemListElement[1].item.endsWith('/kyiv/beauty') &&
        !loneCrumb.itemListElement[1].item.includes('/kotsiubynske/')
      );
    })(),
    visibleDistrictFooter: (() => {
      const at = (id, cat, sub, lat, lng, address) => ({
        id,
        title: id,
        cat,
        subcats: sub ? [sub] : [],
        lat,
        lng,
        address,
      });
      const locs = [
        at('k1', 'beauty', 'nails', 50.4906, 30.3347, 'Коцюбинське'),
        at('k2', 'beauty', 'barber', 50.491, 30.335, 'Коцюбинське'),
        at('k3', 'beauty', 'hair', 50.492, 30.336, 'Коцюбинське'),
        at('k4', 'beauty', 'nails', 50.489, 30.333, 'Коцюбинське'),
        at('k5', 'beauty', 'barber', 50.49, 30.334, 'Коцюбинське'),
        at('k6', 'beauty', 'hair', 50.4902, 30.3342, 'Коцюбинське'),
        at('city-nails', 'beauty', 'nails', 50.4, 30.6, 'Київ'),
        at('city-barber', 'beauty', 'barber', 50.4, 30.6, 'Київ'),
        at('city-hair', 'beauty', 'hair', 50.4, 30.6, 'Київ'),
        at('a1', 'beauty', '', 50.4655, 30.355, 'Академмістечко'),
        at('a2', 'beauty', '', 50.4658, 30.3552, 'Академмістечко'),
        at('s1', 'beauty', '', 50.4574, 30.3553, 'Святошин'),
      ];
      const catalog = {
        beauty: {
          name: 'Краса',
          subcats: { nails: { name: 'Нігті' }, barber: { name: 'Барбер' }, hair: { name: 'Волосся' } },
        },
      };
      const landing = { loc: '', cat: 'beauty', area: 'kotsiubynske', sub: '', page: 1 };
      const data = { masterCatalog: catalog, mockLocations: locs };
      const shell =
        '<html><head><title>x</title><meta name="description" content="d"><link rel="canonical" href="https://www.mapfix.com.ua/"></head><body><!--MAPFIX_CRAWL--><h1 class="nav-title" id="navTitle">t</h1><footer class="site-footer" id="siteFooter"><a href="/old">old</a></footer></body></html>';
      const page = seo.injectSeoIntoHtml(shell, seo.buildSeo(landing, data), {
        landing,
        seoData: data,
        crawlerHtml: '<section id="seo-static" class="seo-static">hidden</section>',
      });
      const footer = (page.match(/<footer class="site-footer"[\s\S]*?<\/footer>/) || [''])[0];
      const staticBlock = (page.match(/<section id="seo-static"[\s\S]*?<\/section>/) || [''])[0];
      return (
        footer.includes('href="/kyiv/akademmistechko/beauty"') &&
        !footer.includes('href="/kyiv/sviatoshyn/beauty"') &&
        !footer.includes('href="/kyiv/borshchahivka/beauty"') &&
        !footer.includes('href="/kyiv/kotsiubynske/beauty"') &&
        footer.includes('href="/kyiv/kotsiubynske/beauty/nails"') &&
        footer.includes('href="/kyiv/kotsiubynske/beauty/barber"') &&
        footer.includes('href="/kyiv/kotsiubynske/beauty/hair"') &&
        !footer.includes('seo-static') &&
        !staticBlock.includes('site-footer') &&
        indexHtml.includes('id="siteFooter"') &&
        seo.MIN_AREA_LISTING === 2
      );
    })(),
    demoAbsentFromSitemap: (() => {
      const demoIds = [
        'loc-top-tyres',
        'loc-auto-diagnostics',
        'loc-home-master',
        'loc-english-school',
        'loc-clean-car',
        'loc-pet-groom',
        'loc-nail-studio',
        'loc-barber-kyiv',
        'loc-football-arena',
        'loc-shoe-master',
      ];
      const catalog = {
        auto: { name: 'Авто', subcats: { tyres: { name: 'Шини' } } },
        beauty: { name: 'Краса', subcats: {} },
      };
      const demos = [
        ...demoIds.map((id) => ({ id, title: 'Demo', cat: 'auto', lat: 50.45, lng: 30.52 })),
        { id: 'test-title', title: 'Test …', cat: 'beauty', lat: 50.45, lng: 30.52 },
        { id: 'qa-biz', title: 'QA/Admin Biz', cat: 'beauty', lat: 50.45, lng: 30.52 },
      ];
      const real = { id: 'real-master', title: 'Майстер Іван', cat: 'auto', lat: 50.45, lng: 30.52 };
      const locations = [...demos, real];
      const smDemo = seo.sitemapXml({
        categories: [{ key: 'auto' }, { key: 'beauty' }],
        locations,
      });
      const listingHtml = seo.crawlerHtml(
        seo.buildSeo({ loc: '', cat: 'auto', area: '', sub: '' }, { masterCatalog: catalog, mockLocations: locations }),
        { loc: '', cat: 'auto', area: '', sub: '' },
        { masterCatalog: catalog, mockLocations: locations }
      );
      const hiddenTitles = seo.crawlerHtml(
        seo.buildSeo({ loc: '', cat: 'beauty', area: '', sub: '' }, { masterCatalog: catalog, mockLocations: locations }),
        { loc: '', cat: 'beauty', area: '', sub: '' },
        { masterCatalog: catalog, mockLocations: locations }
      );
      const hiddenResolved = [...demoIds, 'test-title', 'qa-biz'].every((id) => {
        const resolved = seo.resolveSeoRequest({
          pathname: `/p/${id}`,
          query: {},
          catalog,
          locations,
        });
        return resolved.notFound === true && !resolved.landing;
      });
      const realResolved = seo.resolveSeoRequest({
        pathname: '/p/real-master',
        query: {},
        catalog,
        locations,
      });
      return (
        demoIds.every((id) => !smDemo.includes(`/p/${id}`)) &&
        !smDemo.includes('/p/test-title') &&
        !smDemo.includes('/p/qa-biz') &&
        smDemo.includes('/p/real-master') &&
        !listingHtml.includes('/p/loc-top-tyres') &&
        listingHtml.includes('/p/real-master') &&
        !hiddenTitles.includes('Test …') &&
        !hiddenTitles.includes('QA/Admin Biz') &&
        hiddenResolved &&
        realResolved.landing &&
        realResolved.landing.loc === 'real-master' &&
        seo.isPublicTestLocation({ id: 'qa-biz', title: 'QA/Admin Biz' }) &&
        seo.isPublicTestLocation({ id: 'test-title', title: 'Test …' })
      );
    })(),
    clientKeepsServerHead: (() => {
      const appJs = read('public/js/mapfix-app.js');
      return (
        appJs.includes('seoListingTouched') &&
        appJs.includes('keepServerSeo') &&
        appJs.includes('Манікюр{p} — манікюр, педикюр, нарощування | Mapfix') &&
        appJs.includes('function canonicalHrefFor') &&
        appJs.includes("page !== '1'") &&
        !appJs.includes('шлях без query') &&
        appJs.includes('function updateListingCount') &&
        appJs.includes('locationMatchesMapFilter') &&
        indexHtml.includes('id="listingCount"')
      );
    })(),
    registerIndexable:
      !read('public/register.html').includes('noindex') &&
      read('public/register.html').includes('Додати бізнес безкоштовно') &&
      read('public/register.html').includes('rel="canonical" href="https://www.mapfix.com.ua/register.html"') &&
      read('public/login.html').includes('noindex') &&
      !/filename === 'register\.html'/.test(serverJs) &&
      sm.includes('/register.html'),
    kotsCanonical:
      seo.kotsyubynskeToKyivPath(null, '') === '/kyiv/kotsiubynske' &&
      seo.kotsyubynskeToKyivPath(null, 'shynomontazh') === '/kyiv/kotsiubynske/auto/tyres' &&
      seo.kotsyubynskeToKyivPath(null, 'krasa/') === '/kyiv/kotsiubynske/beauty' &&
      serverJs.includes('kotsyubynskeToKyivPath') &&
      serverJs.includes("app.get('/kotsiubynske'") &&
      serverJs.includes("app.get('/kotsiubinske'") &&
      read('public/sw.js').includes("p.startsWith('/kotsyubynske/')") &&
      read('public/sw.js').includes('res.redirected'),
    kotsyubynskeHub: (() => {
      const hub = seo.renderKotsyubynskeHub({
        catalog: {
          beauty: { name: '✂️ Краса', subcats: {} },
          auto: { name: '🚗 Авто', subcats: {} },
          home: { name: '🏠 Дім', subcats: { plumber: { name: 'Сантехнік' }, electrician: { name: 'Електрик' } } },
        },
        locations: [
          { id: 'a', title: 'Салон', cat: 'beauty', phone: '+380671112233', address: 'вул. Доківська, Коцюбинське', lat: 50.49, lng: 30.33 },
          { id: 'b', title: 'Test salon', cat: 'beauty', phone: '1', address: 'Коцюбинське', lat: 50.49, lng: 30.33 },
          { id: 'c', title: 'Далеко', cat: 'auto', address: 'Львів', lat: 49.84, lng: 24.03 },
          { id: 'd', title: 'Сантехнік Іван', cat: 'home', subcats: ['plumber'], phone: '0670000000', address: 'Київ', lat: 50.492, lng: 30.331 },
        ],
      });
      const cat = seo.renderKotsyubynskeCategory({
        catalog: {
          beauty: { name: '✂️ Краса', subcats: {} },
          home: { name: 'Дім', subcats: { plumber: { name: 'Сантехнік' }, electrician: { name: 'Електрик' } } },
        },
        locations: [
          { id: 'a', title: 'Салон', cat: 'beauty', phone: '+380671112233', address: 'Коцюбинське', lat: 50.49, lng: 30.33 },
          { id: 'b', title: 'Test salon', cat: 'beauty', address: 'Коцюбинське', lat: 50.49, lng: 30.33 },
          { id: 'd', title: 'Сантехнік Іван', cat: 'home', subcats: ['plumber'], phone: '0670000000', address: 'Київ', lat: 50.492, lng: 30.331 },
        ],
        slug: 'krasa',
      });
      const empty = seo.renderKotsyubynskeCategory({
        catalog: { food: { name: 'Їжа', subcats: {} } },
        locations: [],
        slug: 'yizha',
      });
      const smLocal = seo.sitemapXml({ extraPaths: ['/kotsyubynske', '/kotsyubynske/krasa'] });
      return (
        hub.html.includes('Майстри та послуги в Коцюбинському') &&
        hub.html.includes('https://www.mapfix.com.ua/kotsyubynske') &&
        hub.html.includes('/kotsyubynske/krasa') &&
        hub.html.includes('/p/a') &&
        !hub.html.includes('Test salon') &&
        !hub.html.includes('/p/c') &&
        cat.html.includes('Краса у Коцюбинському') &&
        cat.html.includes('ItemList') &&
        cat.html.includes('LocalBusiness') &&
        cat.html.includes('/register') &&
        !cat.html.includes('Test salon') &&
        empty.noindex === true &&
        empty.html.includes('noindex') &&
        empty.html.includes('Додати свій бізнес безкоштовно') &&
        smLocal.includes('https://www.mapfix.com.ua/kotsyubynske</loc>') &&
        smLocal.includes('https://www.mapfix.com.ua/kotsyubynske/krasa</loc>') &&
        serverJs.includes("app.get('/kotsyubynske'") &&
        indexHtml.includes('href="/kyiv/kotsiubynske"') &&
        indexHtml.includes('/js/mapfix-app.js') &&
        indexHtml.includes('/css/mapfix-map.css') &&
        read('.gitignore').includes('.test-cookies.txt') &&
        indexHtml.includes('Поруч зі мною') &&
        !/locateUser\(\{\s*center:\s*true\s*\}\s*;/.test(indexHtml)
      );
    })(),
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    id: 5,
    name: 'SEO лендінги (чисті URL, sitemap, aliases)',
    ok,
    details: Object.entries(checks).map(([k, v]) => `${k}: ${v ? 'OK' : 'FAIL'}`),
  };
}

async function main() {
  console.log('\n=== Mapfix Architecture Self-Check ===\n');

  const results = await Promise.all([
    checkMapStability(),
    Promise.resolve(checkCatalogHierarchy()),
    Promise.resolve(checkRolesAndBinding()),
    checkLoginFlow(),
    Promise.resolve(checkSeoLanding()),
  ]);

  let allOk = true;
  for (const r of results) {
    const mark = r.ok ? '✅' : '❌';
    console.log(`${mark} [${r.id}/4] ${r.name}`);
    r.details.forEach((d) => console.log(`    · ${d}`));
    if (!r.ok) allOk = false;
    console.log('');
  }

  console.log(allOk ? '✅ Усі модулі готові.\n' : '❌ Є проблеми — перегляньте пункти вище.\n');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
