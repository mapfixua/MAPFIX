'use strict';

function siteBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || 'https://www.mapfix.com.ua').replace(/\/$/, '');
}

function stripHeadingDecor(name) {
  return String(name || '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
}

function clipMeta(text, max) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)).replace(/\s+\S*$/, '').trim() + '…';
}

function escapeHtmlAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const KNOWN_CATS = [
  'beauty',
  'auto',
  'repair',
  'pets',
  'home',
  'education',
  'sport',
  'rental',
  'medical',
  'food',
  'furniture',
];

const SEO_AREAS = {
  sviatoshyn: { key: 'sviatoshyn', name: 'Святошин', on: 'Святошині', lat: 50.4574, lng: 30.3553 },
  svyatoshyn: { key: 'sviatoshyn', name: 'Святошин', on: 'Святошині', lat: 50.4574, lng: 30.3553 },
  borshchahivka: { key: 'borshchahivka', name: 'Борщагівка', on: 'Борщагівці', lat: 50.4378, lng: 30.338 },
  borschagivka: { key: 'borshchahivka', name: 'Борщагівка', on: 'Борщагівці', lat: 50.4378, lng: 30.338 },
  akademmistechko: { key: 'akademmistechko', name: 'Академмістечко', on: 'Академмістечку', lat: 50.4655, lng: 30.355 },
  kotsiubynske: { key: 'kotsiubynske', name: 'Коцюбинське', on: 'Коцюбинському', lat: 50.4906, lng: 30.3347 },
  kotsyubynske: { key: 'kotsiubynske', name: 'Коцюбинське', on: 'Коцюбинському', lat: 50.4906, lng: 30.3347 },
  kotsiubinske: { key: 'kotsiubynske', name: 'Коцюбинське', on: 'Коцюбинському', lat: 50.4906, lng: 30.3347 },
};

const SITEMAP_AREAS = ['sviatoshyn', 'borshchahivka', 'akademmistechko', 'kotsiubynske'];

/** Radius around each SEO_AREAS centre. A card inside several radii is listed only on the nearest one. */
const AREA_RADIUS_KM = {
  sviatoshyn: 2,
  borshchahivka: 3.5,
  akademmistechko: 1.5,
  kotsiubynske: 3,
};

/** Address text that places a card in a district even when another centre is closer. */
const AREA_ADDRESS_RE = {
  sviatoshyn: /святошин/i,
  borshchahivka: /борщаг/i,
  akademmistechko: /академмістеч/i,
  kotsiubynske: /коцюбин/i,
};

const LISTING_PAGE_SIZE = 24;

/**
 * Seeded placeholder businesses (fake phones and ratings). They stay in the database
 * and the admin panel. Remove an id here to show that card on the public site again.
 * A location is also hidden when demo, isDemo, placeholder, or hiddenFromPublic is true.
 */
const DEMO_LOCATION_IDS = new Set([
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
]);

const PATH_ALIASES = {
  santekhnik: { cat: 'home', sub: 'plumber' },
  santehnik: { cat: 'home', sub: 'plumber' },
  elektrik: { cat: 'home', sub: 'electrician' },
  elektryk: { cat: 'home', sub: 'electrician' },
  'majster-dodomu': { cat: 'home', sub: 'handyman' },
  'cholovik-na-godynu': { cat: 'home', sub: 'handyman' },
  shynomontazh: { cat: 'auto', sub: 'tyres' },
  shinmontazh: { cat: 'auto', sub: 'tyres' },
  sto: { cat: 'auto' },
  avtoservis: { cat: 'auto' },
  manikiur: { cat: 'beauty' },
  barbershop: { cat: 'beauty' },
  'salon-krasy': { cat: 'beauty' },
  'remont-tehniky': { cat: 'repair' },
};

const PRIORITY_SUBS = [
  { cat: 'home', sub: 'plumber' },
  { cat: 'home', sub: 'electrician' },
  { cat: 'home', sub: 'handyman' },
  { cat: 'auto', sub: 'tyres' },
];

const CAT_COPY = {
  home: {
    h1: (p) => `Сантехнік і майстер додому${p}`,
    title: (p) => `Сантехнік і майстер додому${p} | Mapfix`,
    description: (p) =>
      `Сантехнік, електрик і майстер додому${p}. Без комісій — дивіться графік, ціни й телефонуйте напряму на карті Mapfix.`,
    keywords: 'сантехнік Київ, майстер додому, електрик Київ, ремонт квартири, сантехнік поруч',
  },
  auto: {
    h1: (p) => `СТО, шиномонтаж і автосервіс${p}`,
    title: (p) => `СТО, шиномонтаж і автосервіс${p} | Mapfix`,
    description: (p) =>
      `Автосервіс, шиномонтаж і СТО${p}. Порівняйте майстрів на карті й зателефонуйте без комісії посередника.`,
    keywords: 'СТО Київ, шиномонтаж, автосервіс, ремонт авто, Mapfix',
  },
  repair: {
    h1: (p) => `Ремонт техніки${p}`,
    title: (p) => `Ремонт техніки${p} — майстри на карті | Mapfix`,
    description: (p) =>
      `Ремонт побутової техніки${p}. Знайдіть майстра поруч, перегляньте відгуки й замовте послугу на Mapfix.`,
    keywords: 'ремонт техніки Київ, майстер з ремонту, ремонт холодильника, Mapfix',
  },
  beauty: {
    h1: (p) => `Салони краси та майстри${p}`,
    title: (p) => `Салони краси, манікюр, барбер${p} | Mapfix`,
    description: (p) =>
      `Манікюр, барбершоп і салони краси${p}. Оберіть майстра на карті Mapfix без комісій.`,
    keywords: 'манікюр Київ, барбершоп, салон краси, перукар, Mapfix',
  },
  pets: {
    h1: (p) => `Грумінг і ветеринар${p}`,
    title: (p) => `Грумінг, ветклініка${p} | Mapfix`,
    description: (p) => `Грумінг і ветеринарні послуги${p}. Оберіть майстра на карті Mapfix без комісій.`,
    keywords: 'грумінг Київ, ветеринар, стрижка собак, Mapfix',
  },
  education: {
    h1: (p) => `Репетитори та школи${p}`,
    title: (p) => `Репетитори, курси${p} | Mapfix`,
    description: (p) => `Репетитори, курси й школи${p}. Порівняйте на карті Mapfix і зателефонуйте напряму.`,
    keywords: 'репетитор Київ, курси, школа, Mapfix',
  },
  sport: {
    h1: (p) => `Спорт і тренери${p}`,
    title: (p) => `Спортзал, тренер${p} | Mapfix`,
    description: (p) => `Спортзали, тренери й секції${p}. Знайдіть поруч на карті Mapfix.`,
    keywords: 'спортзал Київ, тренер, фітнес, Mapfix',
  },
  rental: {
    h1: (p) => `Оренда інструменту${p}`,
    title: (p) => `Оренда інструменту${p} | Mapfix`,
    description: (p) => `Оренда інструменту та техніки${p}. Дивіться на карті Mapfix і телефонуйте без комісії.`,
    keywords: 'оренда інструменту Київ, прокат, Mapfix',
  },
  medical: {
    h1: (p) => `Медичні послуги${p}`,
    title: (p) => `Масаж, медпослуги${p} | Mapfix`,
    description: (p) => `Масаж і медичні послуги${p}. Оберіть фахівця на карті Mapfix.`,
    keywords: 'масаж Київ, медичні послуги, Mapfix',
  },
  food: {
    h1: (p) => `Їжа поруч${p}`,
    title: (p) => `Їжа та заклади${p} | Mapfix`,
    description: (p) => `Заклади харчування${p} на карті Mapfix. Телефонуйте напряму, без комісій.`,
    keywords: 'їжа Київ, кафе, Mapfix',
  },
  furniture: {
    h1: (p) => `Меблі на замовлення${p}`,
    title: (p) => `Меблі, збірка меблів${p} | Mapfix`,
    description: (p) => `Збірка й виготовлення меблів${p}. Майстри на карті Mapfix без комісії посередника.`,
    keywords: 'збірка меблів Київ, меблі на замовлення, Mapfix',
  },
};

const SUB_COPY = {
  'home/plumber': {
    h1: (p) => `Сантехнік${p}`,
    title: (p) => `Сантехнік${p} — виклик майстра | Mapfix`,
    description: (p) =>
      `Сантехнік${p}: засмічення, змішувач, унітаз, підключення техніки. Дивіться майстрів на карті й телефонуйте без комісії.`,
    keywords: 'сантехнік Київ, виклик сантехніка, засмічення, сантехнік поруч',
  },
  'home/electrician': {
    h1: (p) => `Електрик${p}`,
    title: (p) => `Електрик${p} — розетка, щиток, люстра | Mapfix`,
    description: (p) =>
      `Електрик${p}: розетка, люстра, проводка, електрощит. Порівняйте майстрів на карті Mapfix і зателефонуйте напряму.`,
    keywords: 'електрик Київ, виклик електрика, розетка, проводка',
  },
  'home/handyman': {
    h1: (p) => `Майстер на годину${p}`,
    title: (p) => `Майстер на годину${p} — дрібний ремонт | Mapfix`,
    description: (p) =>
      `Чоловік на годину${p}: полиця, телевізор, дрібний ремонт. Без комісій — телефонуйте майстру з карти Mapfix.`,
    keywords: 'майстер на годину Київ, дрібний ремонт, чоловік на годину',
  },
  'auto/tyres': {
    h1: (p) => `Шиномонтаж${p}`,
    title: (p) => `Шиномонтаж${p} — заміна шин | Mapfix`,
    description: (p) =>
      `Шиномонтаж${p}: сезонна заміна, балансування. Оберіть сервіс на карті Mapfix і запишіться без комісії.`,
    keywords: 'шиномонтаж Київ, заміна шин, балансування, шиномонтаж поруч',
  },
};

const DEFAULT_SEO = {
  h1: 'Майстри та ремонт у Києві',
  title: 'Mapfix — майстер додому, сантехнік Київ, ремонт поруч',
  description:
    'Карта майстрів у Києві: сантехнік, ремонт квартири, майстер додому. Знайдіть виконавця поруч, порівняйте ціни й замовте послугу на Mapfix.',
  keywords:
    'майстер додому, сантехнік Київ, ремонт, майстер Київ, карта послуг, сантехнік, електрик, ремонт квартири, Mapfix',
};

function placeBit(areaKey) {
  if (!areaKey) return ' у Києві';
  const hit = SEO_AREAS[areaKey];
  if (hit) return ` на ${hit.on || hit.name}`;
  return ' у Києві';
}

function resolveAreaKey(raw) {
  const hit = SEO_AREAS[String(raw || '').toLowerCase().trim()];
  return hit ? hit.key : '';
}

function resolvePathAlias(raw) {
  return PATH_ALIASES[String(raw || '').toLowerCase().trim()] || null;
}

function areaName(key) {
  const hit = SEO_AREAS[key];
  return hit ? hit.name : '';
}

function catalogKeysFrom(catalog) {
  const keys = new Set(KNOWN_CATS);
  Object.keys(catalog || {}).forEach((k) => keys.add(k));
  return keys;
}

function parseLanding({ pathname, query, catalog } = {}) {
  const q = query || {};
  const cats = catalogKeysFrom(catalog);
  const parts = String(pathname || '/')
    .split('/')
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });

  let loc = String(q.loc || '').trim();
  let cat = String(q.cat || '').trim();
  let area = resolveAreaKey(q.area);
  let sub = String(q.sub || '').trim();

  if (parts[0] === 'p' && parts[1]) loc = parts[1];
  if (parts[0] === 'kyiv' || parts[0] === 'kiev') {
    const a = (parts[1] || '').toLowerCase();
    const b = (parts[2] || '').toLowerCase();
    const c = (parts[3] || '').toLowerCase();
    const areaA = resolveAreaKey(a);
    const aliasA = resolvePathAlias(a);
    const aliasB = resolvePathAlias(b);
    if (areaA) {
      area = areaA;
      if (b && cats.has(b)) {
        cat = b;
        if (c) sub = c;
      } else if (aliasB) {
        cat = aliasB.cat;
        sub = aliasB.sub || sub;
      }
    } else if (aliasA) {
      cat = aliasA.cat;
      sub = aliasA.sub || sub;
    } else if (a && cats.has(a)) {
      cat = a;
      if (b) sub = b;
    }
  }

  if (cat && !cats.has(cat)) cat = '';
  return { loc, cat, area, sub };
}

function canonicalPath({ loc, cat, area, sub } = {}) {
  if (loc) return `/p/${encodeURIComponent(loc)}`;
  if (area && cat && sub) {
    return `/kyiv/${encodeURIComponent(area)}/${encodeURIComponent(cat)}/${encodeURIComponent(sub)}`;
  }
  if (area && cat) return `/kyiv/${encodeURIComponent(area)}/${encodeURIComponent(cat)}`;
  if (area) return `/kyiv/${encodeURIComponent(area)}`;
  if (cat && sub) return `/kyiv/${encodeURIComponent(cat)}/${encodeURIComponent(sub)}`;
  if (cat) return `/kyiv/${encodeURIComponent(cat)}`;
  return '/';
}

function normalizePath(pathname) {
  const path = String(pathname || '/') || '/';
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

function canonicalUrl(landing, extraQuery) {
  const path = canonicalPath(landing);
  const params = new URLSearchParams();
  if (extraQuery) {
    new URLSearchParams(String(extraQuery).replace(/^\?/, '')).forEach((value, key) => {
      if (value) params.set(key, value);
    });
  }
  const page = Number(landing?.page) || 1;
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return siteBaseUrl() + path + (qs ? `?${qs}` : '');
}

function listingPath(landing) {
  const path = canonicalPath(landing);
  const page = Number(landing?.page) || 1;
  return page > 1 ? `${path}?page=${page}` : path;
}

function keepTrackingQuery(query) {
  const q = query || {};
  const next = new URLSearchParams();
  for (const k of ['claim', 'add', 'feedback', 'q', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    if (q[k]) next.set(k, String(q[k]));
  }
  const page = String(q.page || '');
  if (/^[1-9]\d*$/.test(page) && page !== '1') next.set('page', page);
  return next.toString();
}

function shouldRedirectLegacy(pathname, query) {
  const path = String(pathname || '/') || '/';
  if (path !== '/' && path !== '/index.html' && path !== '/kyiv' && path !== '/kiev') return false;
  const q = query || {};
  return Boolean(q.loc || q.cat || q.area || q.sub);
}

function shouldRedirectAlias(pathname, landing) {
  const path = normalizePath(pathname);
  if (path === '/' || path === '/index.html') return false;
  if (path === '/kyiv' || path === '/kiev') return false;
  const canon = canonicalPath(landing);
  if (path.startsWith('/kiev')) return Boolean(landing.loc || landing.cat || landing.area || landing.sub);
  return path !== canon && Boolean(landing.loc || landing.cat || landing.area || landing.sub);
}

function seoForHome(areaKey) {
  const place = areaName(areaKey);
  const p = placeBit(areaKey);
  const url = canonicalUrl({ area: areaKey || '' });
  if (place) {
    return {
      h1: `Майстри${p}`,
      title: `Майстри${p} — карта послуг Mapfix`,
      description: `Карта майстрів${p}: сантехнік, ремонт, автосервіс. Телефонуйте напряму, без комісій посередника.`,
      keywords: `майстер ${place}, сантехнік ${place}, ремонт ${place}, Mapfix`,
      url,
      image: siteBaseUrl() + '/icon-512.png',
    };
  }
  return { ...DEFAULT_SEO, url, image: siteBaseUrl() + '/icon-512.png' };
}

function seoForCategory(catKey, catName, areaKey, subKey, subName) {
  const place = areaName(areaKey);
  const p = placeBit(areaKey);
  const subCopy = subKey ? SUB_COPY[`${catKey}/${subKey}`] : null;
  const copy = subCopy || CAT_COPY[catKey];
  const name = stripHeadingDecor(subName || catName) || catKey || 'Послуги';
  const url = canonicalUrl({ cat: catKey, area: areaKey || '', sub: subKey || '' });
  if (copy) {
    return {
      h1: copy.h1(p),
      title: copy.title(p),
      description: copy.description(p),
      keywords: `${copy.keywords}, ${place || 'Київ'}`,
      url,
      image: siteBaseUrl() + '/icon-512.png',
    };
  }
  return {
    h1: `${name}${p}`,
    title: `${name}${p} — майстри поруч | Mapfix`,
    description: `${name}${p}. Майстер додому, ремонт — оберіть виконавця на карті Mapfix.`,
    keywords: `${name}, ${place || 'Київ'}, майстер додому, сантехнік Київ, ремонт, Mapfix`,
    url,
    image: siteBaseUrl() + '/icon-512.png',
  };
}

function seoForLocation(loc, catName) {
  const rawTitle = stripHeadingDecor(String(loc?.title || 'Майстер').trim()) || 'Майстер';
  const title = clipMeta(rawTitle, 58);
  const cat = stripHeadingDecor(catName) || 'майстер';
  const address = String(loc?.address || 'Київ').trim() || 'Київ';
  const url = canonicalUrl({ loc: loc?.id || '' });
  return {
    h1: rawTitle,
    title: `${title} — ${clipMeta(cat, 28)} | Mapfix`,
    description: clipMeta(
      `${rawTitle}: ${address}. Телефон, маршрут і відгуки на карті Mapfix. Без комісії посередника.`,
      160
    ),
    keywords: `${clipMeta(rawTitle, 40)}, ${cat}, майстер додому, Київ, Mapfix`,
    url,
    image: siteBaseUrl() + '/icon-512.png',
  };
}

function buildSeo(landing, data) {
  const catalog = data?.masterCatalog || {};
  let seo;
  if (landing.loc) {
    const loc = (data?.mockLocations || []).find((l) => l && l.id === landing.loc);
    if (loc) {
      seo = seoForLocation(loc, catalog[loc.cat]?.name || loc.cat);
    }
  }
  if (!seo && landing.cat && catalog[landing.cat]) {
    const subName = landing.sub ? catalog[landing.cat]?.subcats?.[landing.sub]?.name : '';
    seo = seoForCategory(landing.cat, catalog[landing.cat].name, landing.area, landing.sub, subName);
  }
  if (!seo) seo = seoForHome(landing.area);
  const page = Number(landing.page) || 1;
  if (page > 1) {
    seo = {
      ...seo,
      title: `${seo.title} — сторінка ${page}`,
      url: canonicalUrl({ ...landing, page }),
    };
  }
  return seo;
}

function mapfixReviews(loc) {
  const reviews = Array.isArray(loc?.reviews) ? loc.reviews : [];
  return reviews.filter((review) => {
    if (!review || typeof review !== 'object') return false;
    const source = String(review.source || '').toLowerCase();
    if (source && source !== 'mapfix') return false;
    const collectedHere = source === 'mapfix' || Boolean(review.userId) || Boolean(review.createdAt);
    if (!collectedHere) return false;
    const rating = Number(review.rating);
    const text = String(review.text || '').trim();
    return text.length >= 3 && Number.isFinite(rating) && rating > 0 && rating <= 5;
  });
}

function jsonLdGraph(seo, landing, data) {
  const base = siteBaseUrl();
  const catalog = data?.masterCatalog || {};
  const graph = [
    {
      '@type': 'Organization',
      '@id': `${base}/#org`,
      name: 'Mapfix',
      url: base + '/',
      logo: `${base}/icon-512.png`,
      description: DEFAULT_SEO.description,
      areaServed: { '@type': 'City', name: 'Київ' },
    },
    {
      '@type': 'WebSite',
      '@id': `${base}/#website`,
      url: base + '/',
      name: 'Mapfix',
      inLanguage: 'uk-UA',
      publisher: { '@id': `${base}/#org` },
      potentialAction: {
        '@type': 'SearchAction',
        target: `${base}/?q={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    },
  ];

  if (landing.loc) {
    const loc = (data?.mockLocations || []).find((l) => l && l.id === landing.loc);
    if (loc) {
      const node = {
        '@type': 'LocalBusiness',
        '@id': `${base}/p/${encodeURIComponent(loc.id)}#biz`,
        name: loc.title,
        url: seo.url,
        address: {
          '@type': 'PostalAddress',
          streetAddress: loc.address || undefined,
          addressLocality: 'Київ',
          addressCountry: 'UA',
        },
      };
      if (loc.phone) node.telephone = loc.phone;
      const lat = Number(loc.lat);
      const lng = Number(loc.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        node.geo = { '@type': 'GeoCoordinates', latitude: lat, longitude: lng };
      }
      const ownedReviews = mapfixReviews(loc);
      if (ownedReviews.length) {
        const avg = ownedReviews.reduce((sum, review) => sum + Number(review.rating), 0) / ownedReviews.length;
        node.aggregateRating = {
          '@type': 'AggregateRating',
          ratingValue: Math.round(avg * 10) / 10,
          reviewCount: ownedReviews.length,
          bestRating: 5,
        };
      }
      graph.push(node);
      graph.push({
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Mapfix', item: base + '/' },
          {
            '@type': 'ListItem',
            position: 2,
            name: stripHeadingDecor(catalog[loc.cat]?.name || loc.cat || 'Послуги'),
            item: base + canonicalPath({ cat: loc.cat }),
          },
          { '@type': 'ListItem', position: 3, name: loc.title, item: seo.url },
        ],
      });
    }
  } else if (landing.cat) {
    const name = stripHeadingDecor(catalog[landing.cat]?.name || landing.cat);
    const crumbs = [{ '@type': 'ListItem', position: 1, name: 'Mapfix', item: base + '/' }];
    if (landing.area) {
      crumbs.push({
        '@type': 'ListItem',
        position: 2,
        name: areaName(landing.area),
        item: base + canonicalPath({ area: landing.area }),
      });
      crumbs.push({ '@type': 'ListItem', position: 3, name, item: base + canonicalPath({ cat: landing.cat, area: landing.area }) });
      if (landing.sub) {
        crumbs.push({ '@type': 'ListItem', position: 4, name: seo.h1, item: seo.url });
      }
    } else {
      crumbs.push({ '@type': 'ListItem', position: 2, name, item: base + canonicalPath({ cat: landing.cat }) });
      if (landing.sub) {
        crumbs.push({ '@type': 'ListItem', position: 3, name: seo.h1, item: seo.url });
      }
    }
    graph.push({ '@type': 'BreadcrumbList', itemListElement: crumbs });
    graph.push({
      '@type': 'Service',
      name: seo.h1,
      provider: { '@id': `${base}/#org` },
      areaServed: { '@type': 'City', name: areaName(landing.area) || 'Київ' },
      url: seo.url,
    });
    const listingLd = itemListForLanding(seo, landing, data?.mockLocations || []);
    if (listingLd) graph.push(listingLd);
  } else {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'Як знайти сантехніка або майстра додому в Києві?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Відкрийте карту Mapfix, оберіть категорію або район і телефонуйте майстру напряму. Комісії за замовлення немає.',
          },
        },
        {
          '@type': 'Question',
          name: 'Чи бере Mapfix комісію з клієнта?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Ні. Клієнт платить лише майстру за роботу. Пошук на карті безкоштовний.',
          },
        },
        {
          '@type': 'Question',
          name: 'Як майстру забрати свій заклад з карти?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Відкрийте картку закладу, введіть телефон з картки — якщо номер збігається, заклад одразу ваш.',
          },
        },
      ],
    });
    const listingLd = itemListForLanding(seo, landing, data?.mockLocations || []);
    if (listingLd) graph.push(listingLd);
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}

function listingLink(label, landing, locations) {
  const target = { loc: '', cat: landing.cat || '', area: landing.area || '', sub: landing.sub || '', page: 1 };
  if (locations && !isIndexableListing(target, locations)) return '';
  return `<li><a href="${escapeHtmlAttr(listingPath(target))}">${escapeHtml(label)}</a></li>`;
}

function crawlerHtml(seo, landing, data) {
  const catalog = data?.masterCatalog || {};
  const locs = Array.isArray(data?.mockLocations) ? data.mockLocations : [];
  if (landing.loc) {
    const loc = locs.find((row) => row && row.id === landing.loc);
    return loc ? cardCrawlerHtml(seo, loc, catalog, locs) : '';
  }

  const listing = buildListing(landing, locs);
  const place = landing.area ? areaName(landing.area) : '';
  const catLinks = Object.entries(catalog)
    .map(([key, cat]) => {
      const label = `${stripHeadingDecor(cat?.name || key)}${place ? ` на ${place}` : ' у Києві'}`;
      return listingLink(label, { cat: key, area: landing.area || '' }, locs);
    })
    .filter(Boolean)
    .join('');
  const areaLinks = SITEMAP_AREAS.map((key) =>
    listingLink(areaName(key), { area: key, cat: landing.cat || '', sub: landing.sub || '' }, locs)
  )
    .filter(Boolean)
    .join('');
  const intentLinks = PRIORITY_SUBS.map((row) => {
    const copy = SUB_COPY[`${row.cat}/${row.sub}`];
    const label = copy ? copy.h1(placeBit(landing.area)) : `${row.cat}/${row.sub}`;
    return listingLink(label, { cat: row.cat, sub: row.sub, area: landing.area || '' }, locs);
  })
    .filter(Boolean)
    .join('');
  const placeItems = listing.pageItems
    .map((row) => {
      const href = canonicalPath({ loc: row.id });
      const addr = row.address ? ` — ${row.address}` : '';
      return `<li><a href="${escapeHtmlAttr(href)}">${escapeHtml(row.title || 'Майстер')}</a>${escapeHtml(addr)}</li>`;
    })
    .join('');
  const where = place ? ` на ${place}` : ' у Києві';
  const countLine = listing.filtered.length
    ? `<p>На карті зараз ${listing.filtered.length} ${placesWord(listing.filtered.length)}${landing.cat ? ' у цій категорії' : ''}${escapeHtml(where)}.</p>`
    : '<p>У цьому доборі поки немає карток. Додайте свій бізнес безкоштовно — без комісії з замовлень.</p>';
  const pagesNav = paginationNav(listing, landing);
  const faq =
    !landing.cat && (Number(landing.page) || 1) === 1
      ? `<h2>Питання</h2>
  <h3>Як знайти сантехніка в Києві?</h3>
  <p>Оберіть категорію «Дім» або відкрийте сторінку сантехніка, порівняйте майстрів на карті й зателефонуйте напряму.</p>
  <h3>Чи є комісія?</h3>
  <p>Ні. Клієнт платить лише майстру. Пошук безкоштовний.</p>
  <h3>Як забрати картку закладу?</h3>
  <p>Відкрийте заклад і введіть телефон з картки. Якщо номер збігається — заклад ваш за хвилину.</p>`
      : '';

  return `<section id="seo-static" class="seo-static" aria-label="Каталог Mapfix">
  <p>${escapeHtml(seo.description)}</p>
  ${countLine}
  <h2>Популярні запити</h2>
  <ul>${intentLinks}</ul>
  <h2>Послуги</h2>
  <ul>${catLinks}</ul>
  <h2>Райони Києва</h2>
  <ul>${areaLinks}</ul>
  ${placeItems ? `<h2>Майстри на карті</h2><ol>${placeItems}</ol>` : ''}
  ${pagesNav}
  ${faq}
</section>`;
}

function landingBootScript(landing) {
  const payload = {
    cat: landing.cat || null,
    area: landing.area || null,
    loc: landing.loc || null,
    sub: landing.sub || null,
  };
  return `window.__MAPFIX_LANDING=${JSON.stringify(payload)};`;
}

function injectSeoIntoHtml(html, seo, extras = {}) {
  const title = escapeHtmlAttr(seo.title);
  const description = escapeHtmlAttr(seo.description);
  const keywords = escapeHtmlAttr(seo.keywords);
  const url = escapeHtmlAttr(seo.url);
  const image = escapeHtmlAttr(seo.image || siteBaseUrl() + '/icon-512.png');
  const h1 = escapeHtml(seo.h1 || DEFAULT_SEO.h1);
  let out = String(html);
  out = out.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);
  out = out.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="description" content="${description}">`
  );
  if (/<meta\s+name="keywords"/i.test(out)) {
    out = out.replace(
      /<meta\s+name="keywords"\s+content="[^"]*"\s*\/?>/i,
      `<meta name="keywords" content="${keywords}">`
    );
  }
  out = out.replace(
    /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/i,
    `<meta property="og:title" content="${title}">`
  );
  out = out.replace(
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/i,
    `<meta property="og:description" content="${description}">`
  );
  out = out.replace(
    /<meta\s+property="og:url"\s+content="[^"]*"\s*\/?>/i,
    `<meta property="og:url" content="${url}">`
  );
  if (/<meta\s+property="og:image"/i.test(out)) {
    out = out.replace(
      /<meta\s+property="og:image"\s+content="[^"]*"\s*\/?>/i,
      `<meta property="og:image" content="${image}">`
    );
  }
  if (/<link\s+rel="canonical"/i.test(out)) {
    out = out.replace(
      /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/i,
      `<link rel="canonical" href="${url}">`
    );
  }
  out = out.replace(
    /<link\s+rel="alternate"\s+hreflang="uk"\s+href="[^"]*"\s*\/?>/i,
    `<link rel="alternate" hreflang="uk" href="${url}">`
  );
  out = out.replace(
    /<link\s+rel="alternate"\s+hreflang="x-default"\s+href="[^"]*"\s*\/?>/i,
    `<link rel="alternate" hreflang="x-default" href="${url}">`
  );
  if (/<meta\s+name="twitter:title"/i.test(out)) {
    out = out.replace(
      /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/?>/i,
      `<meta name="twitter:title" content="${title}">`
    );
  }
  if (/<meta\s+name="twitter:description"/i.test(out)) {
    out = out.replace(
      /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/?>/i,
      `<meta name="twitter:description" content="${description}">`
    );
  }
  if (/<meta\s+name="twitter:image"/i.test(out)) {
    out = out.replace(
      /<meta\s+name="twitter:image"\s+content="[^"]*"\s*\/?>/i,
      `<meta name="twitter:image" content="${image}">`
    );
  }
  out = out.replace(
    /<h1 class="nav-title" id="navTitle">[^<]*<\/h1>/i,
    `<h1 class="nav-title" id="navTitle">${h1}</h1>`
  );
  if (extras.jsonLd) {
    const json = JSON.stringify(extras.jsonLd).replace(/</g, '\\u003c');
    const tag = `<script type="application/ld+json">${json}</script>`;
    if (/<!--MAPFIX_JSONLD-->/.test(out)) {
      out = out.replace(/<!--MAPFIX_JSONLD-->/, tag);
    } else {
      out = out.replace(/<\/head>/i, `    ${tag}\n</head>`);
    }
  }
  if (extras.bootScript) {
    out = out.replace(/window\.__MAPFIX_LANDING\s*=\s*null;/, extras.bootScript);
  }
  if (extras.crawlerHtml) {
    if (/<!--MAPFIX_CRAWL-->/.test(out)) {
      out = out.replace(/<!--MAPFIX_CRAWL-->/, extras.crawlerHtml);
    } else {
      out = out.replace(/<body>/i, `<body>\n${extras.crawlerHtml}`);
    }
  }
  if (extras.noindex) {
    const robots = '<meta name="robots" content="noindex, follow">';
    if (/<meta\s+name="robots"/i.test(out)) {
      out = out.replace(/<meta\s+name="robots"\s+content="[^"]*"\s*\/?>/i, robots);
    } else {
      out = out.replace(/<\/head>/i, `    ${robots}\n</head>`);
    }
  }
  const paging = [];
  if (extras.prevUrl) paging.push(`<link rel="prev" href="${escapeHtmlAttr(extras.prevUrl)}">`);
  if (extras.nextUrl) paging.push(`<link rel="next" href="${escapeHtmlAttr(extras.nextUrl)}">`);
  if (paging.length) out = out.replace(/<\/head>/i, `    ${paging.join('\n    ')}\n</head>`);
  return out;
}

function robotsTxt() {
  const base = siteBaseUrl();
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    '',
    `Host: ${base.replace(/^https?:\/\//, '')}`,
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

const LEGACY_SITE_HOSTS = new Set(['mapfix-wine.vercel.app', 'www.mapfix-wine.vercel.app']);

function validSitemapDate(value) {
  const day = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
}

function legacyHostRedirectUrl(hostname, originalUrl) {
  const host = String(hostname || '')
    .split(':')[0]
    .toLowerCase();
  if (!LEGACY_SITE_HOSTS.has(host)) return '';
  const base = siteBaseUrl();
  let baseHost = '';
  try {
    baseHost = new URL(base).hostname.toLowerCase();
  } catch {
    return '';
  }
  if (!baseHost || baseHost === host) return '';
  const path = String(originalUrl || '/');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** Same centre as the map’s initial setView in public/index.html. */
const KOTSYUBYNSKE = {
  slug: 'kotsyubynske',
  hubH1: 'Майстри та послуги в Коцюбинському',
  lat: 50.49,
  lng: 30.33,
  radiusKm: 3,
  mapZoom: 14,
};

const KOTSYUBYNSKE_CATEGORY_SLUGS = {
  beauty: 'krasa',
  auto: 'avtoservis',
  repair: 'remont',
  pets: 'tvaryny',
  home: 'dim',
  education: 'navchannia',
  sport: 'sport',
  rental: 'orenda',
  medical: 'medytsyna',
  food: 'yizha',
  furniture: 'mebli',
};

/** Search-intent pages that already exist as category/subcategory aliases. */
const KOTSYUBYNSKE_EXTRA_PAGES = [
  { slug: 'santekhnik', cat: 'home', sub: 'plumber', label: 'Сантехнік' },
  { slug: 'elektryk', cat: 'home', sub: 'electrician', label: 'Електрик' },
];

function isHiddenPlaceholderLocation(loc) {
  if (!loc || typeof loc !== 'object') return false;
  if (loc.demo === true || loc.isDemo === true || loc.placeholder === true || loc.hiddenFromPublic === true) {
    return true;
  }
  return DEMO_LOCATION_IDS.has(String(loc.id || ''));
}

function isPublicTestLocation(loc) {
  if (!loc || typeof loc !== 'object') return false;
  if (isHiddenPlaceholderLocation(loc)) return true;
  if (loc.isTest === true || loc.is_test === true) return true;
  const title = String(loc.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return false;
  if (/^test\b/i.test(title)) return true;
  if (/^тестов/i.test(title)) return true;
  if (/\b(qa|admin)\s+biz\b/i.test(title)) return true;
  return false;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function translitSlug(value) {
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y',
    і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
    т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia',
  };
  const slug = String(value || '')
    .toLowerCase()
    .split('')
    .map((ch) => (Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'kategoriia';
}

function placesWord(count) {
  const n = Math.abs(Number(count) || 0);
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 > 10 && mod100 < 20) return 'місць';
  if (mod10 === 1) return 'місце';
  if (mod10 >= 2 && mod10 <= 4) return 'місця';
  return 'місць';
}

function kotsyubynskeMapHref() {
  const { lat, lng, mapZoom } = KOTSYUBYNSKE;
  return `/?lat=${lat}&lng=${lng}&zoom=${mapZoom}`;
}

function addressMentionsKotsyubynske(loc) {
  return /коцюбинськ/i.test(String(loc?.address || ''));
}

function isNearKotsyubynske(loc) {
  const lat = Number(loc?.lat);
  const lng = Number(loc?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    if (haversineKm(KOTSYUBYNSKE.lat, KOTSYUBYNSKE.lng, lat, lng) <= KOTSYUBYNSKE.radiusKm) return true;
  }
  return addressMentionsKotsyubynske(loc);
}

function publicKotsyubynskeLocations(locations) {
  return (locations || []).filter((loc) => {
    if (!loc || !loc.id || loc.deletedAt) return false;
    if (isPublicTestLocation(loc)) return false;
    return isNearKotsyubynske(loc);
  });
}

function localPageDefs(catalog) {
  const defs = [];
  const seen = new Set();
  for (const [key, cat] of Object.entries(catalog || {})) {
    const label = stripHeadingDecor(cat?.name) || key;
    let slug = KOTSYUBYNSKE_CATEGORY_SLUGS[key] || translitSlug(label);
    if (seen.has(slug)) slug = `${slug}-${translitSlug(key)}`;
    seen.add(slug);
    defs.push({ slug, cat: key, sub: '', label });
  }
  for (const extra of KOTSYUBYNSKE_EXTRA_PAGES) {
    if (!catalog?.[extra.cat]) continue;
    if (extra.sub && !catalog[extra.cat]?.subcats?.[extra.sub]) continue;
    if (seen.has(extra.slug)) continue;
    seen.add(extra.slug);
    defs.push({ slug: extra.slug, cat: extra.cat, sub: extra.sub, label: extra.label });
  }
  return defs;
}

function locationsForLocalPage(locations, def) {
  return publicKotsyubynskeLocations(locations).filter((loc) => {
    if (def?.cat && loc.cat !== def.cat) return false;
    if (def?.sub) {
      const subs = Array.isArray(loc.subcats) ? loc.subcats : [];
      if (!subs.includes(def.sub)) return false;
    }
    return true;
  });
}

function resolveKotsyubynskeSlug(catalog, raw) {
  const slug = String(raw || '').toLowerCase().trim();
  if (!slug) return { page: null };
  const defs = localPageDefs(catalog);
  const direct = defs.find((def) => def.slug === slug);
  if (direct) return { page: direct };
  const byCat = defs.find((def) => def.cat === slug && !def.sub);
  if (byCat) return { redirect: `/kotsyubynske/${byCat.slug}` };
  const alias = PATH_ALIASES[slug];
  if (alias) {
    const exact = defs.find((def) => def.cat === alias.cat && (def.sub || '') === (alias.sub || ''));
    if (exact) return { redirect: `/kotsyubynske/${exact.slug}` };
    const catPage = defs.find((def) => def.cat === alias.cat && !def.sub);
    if (catPage) return { redirect: `/kotsyubynske/${catPage.slug}` };
  }
  return null;
}

function kotsyubynskeSitemapPaths(catalog, locations) {
  const paths = ['/kotsyubynske'];
  for (const def of localPageDefs(catalog)) {
    if (locationsForLocalPage(locations, def).length) paths.push(`/kotsyubynske/${def.slug}`);
  }
  return paths;
}

function categoryLabelOf(catalog, catKey) {
  return stripHeadingDecor(catalog?.[catKey]?.name) || catKey || 'Послуга';
}

function sortByTitle(list) {
  return list.slice().sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'uk'));
}

function phoneHref(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  const href = raw.replace(/[^\d+]/g, '');
  return href ? `tel:${href}` : '';
}

function localBusinessNode(loc, catalog) {
  const base = siteBaseUrl();
  const node = {
    '@type': 'LocalBusiness',
    name: String(loc.title || 'Майстер'),
    url: `${base}/p/${encodeURIComponent(loc.id)}`,
  };
  const phone = String(loc.phone || '').trim();
  if (phone) node.telephone = phone;
  if (loc.address) {
    node.address = {
      '@type': 'PostalAddress',
      streetAddress: String(loc.address),
      addressLocality: 'Коцюбинське',
      addressCountry: 'UA',
    };
  }
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    node.geo = { '@type': 'GeoCoordinates', latitude: lat, longitude: lng };
  }
  const catName = categoryLabelOf(catalog, loc.cat);
  if (catName) node.description = catName;
  return node;
}

function itemListJsonLd(name, url, locations, catalog) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    url,
    itemListElement: locations.map((loc, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: localBusinessNode(loc, catalog),
    })),
  };
}

const LOCAL_PAGE_CSS = `
:root { --primary:#12c4b5; --dark:#0b0d10; --border:#e4e6eb; --bg:#eceef2; --ink:#0b0d10; --muted:#6b7280; }
* { box-sizing: border-box; }
body { margin:0; font-family:Manrope,"Segoe UI",sans-serif; background:var(--bg); color:var(--ink); }
a { color:inherit; }
.wrap { max-width:720px; margin:0 auto; padding:16px 16px 48px; }
.top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:18px; }
.brand { display:inline-flex; align-items:center; gap:8px; font-weight:800; text-decoration:none; font-size:18px; }
.brand i { width:28px; height:28px; border-radius:8px; background:var(--primary); display:inline-flex; align-items:center; justify-content:center; font-style:normal; font-size:14px; }
.crumb { font-size:13px; color:var(--muted); margin:0 0 8px; }
.crumb a { color:var(--ink); font-weight:700; }
h1 { font-size:1.55rem; line-height:1.25; margin:0 0 8px; }
.lead { margin:0 0 14px; color:#374151; line-height:1.45; }
.actions { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 18px; }
.btn { display:inline-flex; align-items:center; justify-content:center; min-height:44px; padding:10px 14px; border-radius:12px; font-weight:800; text-decoration:none; text-align:center; }
.btn-primary { background:var(--primary); color:var(--dark); }
.btn-ghost { background:#fff; border:1px solid var(--border); }
.cats { list-style:none; padding:0; margin:0 0 8px; display:flex; flex-direction:column; gap:8px; }
.cats a { display:flex; justify-content:space-between; align-items:center; gap:12px; min-height:48px; padding:12px 14px; background:#fff; border:1px solid var(--border); border-radius:14px; text-decoration:none; font-weight:800; }
.count { color:var(--muted); font-weight:700; font-size:14px; white-space:nowrap; }
h2 { font-size:1.15rem; margin:22px 0 10px; }
.cards { display:flex; flex-direction:column; gap:10px; }
.card { background:#fff; border:1px solid var(--border); border-radius:16px; padding:14px; }
.card h3 { font-size:1.05rem; margin:0 0 6px; line-height:1.3; }
.card h3 a { text-decoration:none; font-weight:800; }
.card p { margin:0; color:#374151; font-size:14px; line-height:1.45; }
.card .phone { margin-top:6px; }
.card .phone a { font-weight:800; text-decoration:none; }
.page-foot { margin-top:28px; font-size:13px; color:var(--muted); }
.page-foot a { font-weight:700; }
.empty { background:#fff; border:1px dashed var(--border); border-radius:16px; padding:16px; }
@media (max-width:420px) {
  h1 { font-size:1.35rem; }
  .actions { flex-direction:column; }
  .btn { width:100%; }
}
`;

function renderLocalPageDocument({ title, description, canonicalPath: path, h1, body, noindex, jsonLd, omitCanonical, footerHtml }) {
  const base = siteBaseUrl();
  const canonical = path ? `${base}${path}` : '';
  const canonicalTag = omitCanonical || !canonical ? '' : `<link rel="canonical" href="${escapeHtmlAttr(canonical)}">`;
  const robots = noindex ? '<meta name="robots" content="noindex, follow">' : '<meta name="robots" content="index, follow">';
  const ld = jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`
    : '';
  const footer = footerHtml || '<footer class="page-foot"><a href="/">На карту</a> · <a href="/kotsyubynske">Коцюбинське</a></footer>';
  return `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtmlAttr(description)}">
${canonicalTag}
${robots}
<meta property="og:title" content="${escapeHtmlAttr(title)}">
<meta property="og:description" content="${escapeHtmlAttr(description)}">
<meta property="og:type" content="website">
<meta property="og:locale" content="uk_UA">
<meta property="og:url" content="${escapeHtmlAttr(canonical)}">
<meta property="og:site_name" content="Mapfix">
<meta name="theme-color" content="#12c4b5">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&display=swap" rel="stylesheet">
<style>${LOCAL_PAGE_CSS}</style>
${ld}
</head>
<body>
<div class="wrap">
<header class="top">
  <a class="brand" href="/"><i>M</i>Mapfix</a>
</header>
${body}
${footer}
</div>
</body>
</html>`;
}

function locationCardHtml(loc, catalog) {
  const href = `/p/${encodeURIComponent(loc.id)}`;
  const name = loc.title || 'Майстер';
  const cat = categoryLabelOf(catalog, loc.cat);
  const phone = String(loc.phone || '').trim();
  const tel = phoneHref(phone);
  const phoneHtml = phone
    ? `<p class="phone">${tel ? `<a href="${escapeHtmlAttr(tel)}">${escapeHtml(phone)}</a>` : escapeHtml(phone)}</p>`
    : '';
  return `<article class="card">
  <h3><a href="${escapeHtmlAttr(href)}">${escapeHtml(name)}</a></h3>
  <p>${escapeHtml(cat)}</p>
  ${phoneHtml}
</article>`;
}

function renderKotsyubynskeHub({ catalog, locations } = {}) {
  const nearby = sortByTitle(publicKotsyubynskeLocations(locations));
  const groups = localPageDefs(catalog)
    .map((def) => ({ def, count: locationsForLocalPage(locations, def).length }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.def.label.localeCompare(b.def.label, 'uk'));
  const catList = groups.length
    ? `<ul class="cats">${groups
        .map(
          ({ def, count }) =>
            `<li><a href="/kotsyubynske/${escapeHtmlAttr(def.slug)}"><span>${escapeHtml(def.label)}</span><span class="count">${count} ${placesWord(count)}</span></a></li>`
        )
        .join('')}</ul>`
    : '<p class="empty">Поки немає категорій із закладами поруч. Можна додати свій бізнес безкоштовно.</p>';
  const cards = nearby.length
    ? `<h2>Заклади поруч</h2><div class="cards">${nearby.map((loc) => locationCardHtml(loc, catalog)).join('')}</div>`
    : '';
  const description =
    'Майстри та послуги в Коцюбинському: краса, автосервіс, сантехнік, електрик. Телефони закладів поруч на Mapfix — без комісій.';
  const body = `<p class="crumb"><a href="/">Mapfix</a> · Коцюбинське</p>
<h1>${escapeHtml(KOTSYUBYNSKE.hubH1)}</h1>
<p class="lead">${nearby.length} ${placesWord(nearby.length)} у смт Коцюбинське та в радіусі ${KOTSYUBYNSKE.radiusKm} км. Телефонуйте напряму, без комісій.</p>
<div class="actions"><a class="btn btn-ghost" href="${escapeHtmlAttr(kotsyubynskeMapHref())}">Показати на карті</a></div>
<h2>Категорії</h2>
${catList}
${cards}`;
  return {
    noindex: false,
    html: renderLocalPageDocument({
      title: KOTSYUBYNSKE.hubH1,
      description,
      canonicalPath: '/kotsyubynske',
      body,
    }),
  };
}

function renderKotsyubynskeCategory({ catalog, locations, slug } = {}) {
  const resolved = resolveKotsyubynskeSlug(catalog, slug);
  if (!resolved) return null;
  if (resolved.redirect) return { redirect: resolved.redirect };
  const def = resolved.page;
  const list = sortByTitle(locationsForLocalPage(locations, def));
  const h1 = `${def.label} у Коцюбинському`;
  const empty = list.length === 0;
  const description = empty
    ? `${h1}. Додайте свій бізнес безкоштовно на Mapfix — без комісії з замовлень.`
    : `${h1}: ${list.length} ${placesWord(list.length)}. Адреси й телефони на Mapfix, дзвоніть напряму без комісії.`;
  const cards = empty
    ? '<p class="empty">У цій категорії поки немає карток поруч із Коцюбинським.</p>'
    : `<div class="cards">${list.map((loc) => locationCardHtml(loc, catalog)).join('')}</div>`;
  const body = `<p class="crumb"><a href="/">Mapfix</a> · <a href="/kotsyubynske">Коцюбинське</a></p>
<h1>${escapeHtml(h1)}</h1>
<p class="lead">${escapeHtml(description)}</p>
<div class="actions">
  <a class="btn btn-primary" href="/register">Додати свій бізнес безкоштовно</a>
  <a class="btn btn-ghost" href="${escapeHtmlAttr(kotsyubynskeMapHref())}">Показати на карті</a>
</div>
${cards}`;
  const canonicalPath = `/kotsyubynske/${def.slug}`;
  return {
    noindex: empty,
    html: renderLocalPageDocument({
      title: h1,
      description,
      canonicalPath,
      body,
      noindex: empty,
      jsonLd: empty ? null : itemListJsonLd(h1, `${siteBaseUrl()}${canonicalPath}`, list, catalog),
    }),
  };
}

function renderKotsyubynskeNotFound() {
  return renderLocalPageDocument({
    title: 'Сторінку не знайдено | Mapfix',
    description: 'Такої категорії в Коцюбинському на Mapfix немає.',
    canonicalPath: '/kotsyubynske',
    noindex: true,
    body: `<h1>Сторінку не знайдено</h1>
<p class="lead">Такої категорії немає. Поверніться до списку майстрів у Коцюбинському.</p>
<div class="actions"><a class="btn btn-primary" href="/kotsyubynske">Майстри в Коцюбинському</a></div>`,
  });
}

function locationAreaKeys(loc) {
  if (!loc) return [];
  const address = String(loc.address || '');
  const named = [];
  const inRadius = [];
  for (const key of SITEMAP_AREAS) {
    const area = SEO_AREAS[key];
    const radius = AREA_RADIUS_KM[key];
    if (!area || !radius) continue;
    if (AREA_ADDRESS_RE[key] && AREA_ADDRESS_RE[key].test(address)) named.push(key);
    const lat = Number(loc.lat);
    const lng = Number(loc.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const distance = haversineKm(area.lat, area.lng, lat, lng);
    if (distance <= radius) inRadius.push({ key, distance });
  }
  inRadius.sort((a, b) => a.distance - b.distance);
  const hits = new Set(named);
  if (inRadius.length) hits.add(inRadius[0].key);
  return SITEMAP_AREAS.filter((key) => hits.has(key));
}

function locationInArea(loc, areaKey) {
  const key = resolveAreaKey(areaKey);
  if (!key) return false;
  return locationAreaKeys(loc).includes(key);
}

function visibleLocations(locations) {
  return (locations || []).filter(
    (loc) => loc && loc.id && !loc.trashed && !loc.deletedAt && !isPublicTestLocation(loc)
  );
}

function locationMatchesListing(loc, landing) {
  if (!loc) return false;
  if (landing.cat && loc.cat !== landing.cat) return false;
  if (landing.sub) {
    const subs = Array.isArray(loc.subcats) ? loc.subcats : [];
    if (!subs.includes(landing.sub)) return false;
  }
  if (landing.area && !locationInArea(loc, landing.area)) return false;
  return true;
}

function sameLocationIds(a, b) {
  if (a.length !== b.length) return false;
  const ids = new Set(b.map((loc) => loc.id));
  return a.every((loc) => ids.has(loc.id));
}

function buildListing(landing, locations) {
  const all = visibleLocations(locations);
  const filtered = sortByTitle(all.filter((loc) => locationMatchesListing(loc, landing)));
  const page = Math.max(1, Number(landing.page) || 1);
  const pages = Math.max(1, Math.ceil(filtered.length / LISTING_PAGE_SIZE) || 1);
  const outOfRange = page > 1 && (page - 1) * LISTING_PAGE_SIZE >= filtered.length;
  const pageItems = outOfRange ? [] : filtered.slice((page - 1) * LISTING_PAGE_SIZE, page * LISTING_PAGE_SIZE);
  let noindex = false;
  if (landing.area && !landing.loc) {
    if (!filtered.length) noindex = true;
    else {
      const city = all.filter((loc) => locationMatchesListing(loc, { ...landing, area: '' }));
      if (sameLocationIds(filtered, city)) noindex = true;
    }
  }
  const pageUrl = (n) => canonicalUrl({ ...landing, loc: landing.loc || '', page: n });
  return {
    filtered,
    pageItems,
    page,
    pages,
    noindex,
    outOfRange,
    prevUrl: page > 1 && !outOfRange ? pageUrl(page - 1) : '',
    nextUrl: page < pages && !outOfRange ? pageUrl(page + 1) : '',
  };
}

function isIndexableListing(landing, locations) {
  if (landing.loc) {
    return visibleLocations(locations).some((loc) => loc.id === landing.loc);
  }
  return !buildListing({ ...landing, page: 1 }, locations).noindex;
}

function subcatLabel(catalog, cat, subKey) {
  const named = catalog?.[cat]?.subcats?.[subKey]?.name;
  if (named) return stripHeadingDecor(named);
  return String(subKey || '')
    .replace(/^custom_/, '')
    .replace(/_/g, ' ')
    .trim();
}

function similarLocations(loc, locations, limit) {
  const rest = visibleLocations(locations).filter((row) => row.id !== loc.id);
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  return rest
    .map((row) => {
      const distance =
        Number.isFinite(lat) && Number.isFinite(lng)
          ? haversineKm(lat, lng, Number(row.lat), Number(row.lng))
          : 9999;
      return { row, distance, sameCat: row.cat === loc.cat ? 0 : 1 };
    })
    .sort(
      (a, b) =>
        a.sameCat - b.sameCat ||
        a.distance - b.distance ||
        String(a.row.title || '').localeCompare(String(b.row.title || ''), 'uk')
    )
    .slice(0, limit)
    .map((entry) => entry.row);
}

function cardCrawlerHtml(seo, loc, catalog, locations) {
  const catName = categoryLabelOf(catalog, loc.cat);
  const catHref = loc.cat ? canonicalPath({ cat: loc.cat }) : '';
  const services = (Array.isArray(loc.subcats) ? loc.subcats : [])
    .map((key) => subcatLabel(catalog, loc.cat, key))
    .filter(Boolean);
  const prices = Object.entries(loc.prices || {}).filter(([name, value]) => String(name || '').trim() && String(value || '').trim());
  const schedule = Object.entries(loc.schedule || {}).filter(([day, hours]) => String(day || '').trim() && String(hours || '').trim());
  const description = String(loc.text || '').replace(/\s+/g, ' ').trim();
  const phone = String(loc.phone || '').trim();
  const tel = phoneHref(phone);
  const areas = locationAreaKeys(loc).filter((key) =>
    isIndexableListing({ area: key, cat: '', sub: '', page: 1 }, locations)
  );
  const similar = similarLocations(loc, locations, 6);
  const reviews = mapfixReviews(loc);
  const serviceHtml = services.length
    ? `<h2>Послуги</h2><ul>${services.map((name) => `<li>${escapeHtml(name)}</li>`).join('')}</ul>`
    : '';
  const priceHtml = prices.length
    ? `<h2>Ціни</h2><ul>${prices
        .map(([name, value]) => `<li>${escapeHtml(name)} — ${escapeHtml(value)}</li>`)
        .join('')}</ul>`
    : '';
  const scheduleHtml = schedule.length
    ? `<h2>Графік</h2><ul>${schedule
        .map(([day, hours]) => `<li>${escapeHtml(day)}: ${escapeHtml(hours)}</li>`)
        .join('')}</ul>`
    : loc.workingHours
      ? `<h2>Графік</h2><p>${escapeHtml(loc.workingHours)}</p>`
      : '';
  const descriptionHtml = description ? `<h2>Опис</h2><p>${escapeHtml(description)}</p>` : '';
  const phoneHtml = phone
    ? `<p>Телефон: ${tel ? `<a href="${escapeHtmlAttr(tel)}">${escapeHtml(phone)}</a>` : escapeHtml(phone)}</p>`
    : '';
  const areaHtml = areas.length
    ? `<p>Район: ${areas
        .map((key) => `<a href="${escapeHtmlAttr(canonicalPath({ area: key }))}">${escapeHtml(areaName(key))}</a>`)
        .join(', ')}</p>`
    : '';
  const reviewHtml = reviews.length
    ? `<h2>Відгуки на Mapfix</h2><ul>${reviews
        .map((review) => `<li>${escapeHtml(review.rating)} з 5. ${escapeHtml(review.text)}</li>`)
        .join('')}</ul>`
    : '';
  const similarHtml = similar.length
    ? `<h2>Схожі поруч</h2><ul>${similar
        .map((row) => `<li><a href="${escapeHtmlAttr(canonicalPath({ loc: row.id }))}">${escapeHtml(row.title || 'Майстер')}</a></li>`)
        .join('')}</ul>`
    : '';
  return `<section id="seo-static" class="seo-static" aria-label="Картка майстра">
  <p>${escapeHtml(seo.description)}</p>
  ${catHref ? `<p>Категорія: <a href="${escapeHtmlAttr(catHref)}">${escapeHtml(catName)}</a></p>` : ''}
  ${loc.address ? `<p>Адреса: ${escapeHtml(loc.address)}</p>` : ''}
  ${areaHtml}
  ${phoneHtml}
  ${descriptionHtml}
  ${serviceHtml}
  ${priceHtml}
  ${scheduleHtml}
  ${reviewHtml}
  ${similarHtml}
</section>`;
}

function paginationNav(listing, landing) {
  if (!listing || listing.pages <= 1) return '';
  const links = [];
  for (let page = 1; page <= listing.pages; page += 1) {
    const href = listingPath({ ...landing, page });
    if (page === listing.page) links.push(`<li><span aria-current="page">Сторінка ${page}</span></li>`);
    else links.push(`<li><a href="${escapeHtmlAttr(href)}">Сторінка ${page}</a></li>`);
  }
  return `<nav aria-label="Сторінки каталогу"><ol>${links.join('')}</ol></nav>`;
}

function businessListNode(loc) {
  const node = {
    '@type': 'LocalBusiness',
    name: String(loc.title || 'Майстер'),
    url: `${siteBaseUrl()}${canonicalPath({ loc: loc.id })}`,
  };
  const phone = String(loc.phone || '').trim();
  if (phone) node.telephone = phone;
  if (loc.address) {
    node.address = {
      '@type': 'PostalAddress',
      streetAddress: String(loc.address),
      addressLocality: 'Київ',
      addressCountry: 'UA',
    };
  }
  return node;
}

function itemListForLanding(seo, landing, locations) {
  if (landing.loc) return null;
  const listing = buildListing(landing, locations);
  if (!listing.pageItems.length) return null;
  return {
    '@type': 'ItemList',
    name: seo.h1,
    url: seo.url,
    numberOfItems: listing.pageItems.length,
    itemListElement: listing.pageItems.map((loc, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: businessListNode(loc),
    })),
  };
}

function splitPath(pathname) {
  return normalizePath(pathname)
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

function parsePageQuery(query) {
  if (!query || query.page == null || query.page === '') return { page: 1 };
  const raw = Array.isArray(query.page) ? query.page[0] : String(query.page);
  if (!/^[1-9]\d*$/.test(raw)) return { invalid: true };
  const page = Number(raw);
  if (page > 500) return { invalid: true };
  return { page };
}

function classifyKyivParts(parts, catalog) {
  if (parts.length === 1) return { landing: { loc: '', cat: '', area: '', sub: '' } };
  if (parts.length > 4) return { notFound: true };
  const a = String(parts[1] || '').toLowerCase();
  const b = parts[2] ? String(parts[2]).toLowerCase() : '';
  const c = parts[3] ? String(parts[3]).toLowerCase() : '';
  const cats = catalogKeysFrom(catalog);
  const areaA = resolveAreaKey(a);
  const aliasA = resolvePathAlias(a);
  const aliasB = b ? resolvePathAlias(b) : null;
  let area = '';
  let cat = '';
  let sub = '';
  if (areaA) {
    area = areaA;
    if (b) {
      if (cats.has(b)) {
        cat = b;
        if (c) {
          if (!catalog?.[cat]?.subcats?.[c]) return { notFound: true };
          sub = c;
        }
      } else if (aliasB && !c) {
        cat = aliasB.cat;
        sub = aliasB.sub || '';
        if (!cats.has(cat)) return { notFound: true };
        if (sub && !catalog?.[cat]?.subcats?.[sub]) return { notFound: true };
      } else {
        return { notFound: true };
      }
    } else if (c) {
      return { notFound: true };
    }
  } else if (aliasA && !b && !c) {
    cat = aliasA.cat;
    sub = aliasA.sub || '';
    if (!cats.has(cat)) return { notFound: true };
    if (sub && !catalog?.[cat]?.subcats?.[sub]) return { notFound: true };
  } else if (cats.has(a)) {
    cat = a;
    if (b) {
      if (!catalog?.[cat]?.subcats?.[b]) return { notFound: true };
      sub = b;
    }
    if (c) return { notFound: true };
  } else {
    return { notFound: true };
  }
  return { landing: { loc: '', cat, area, sub } };
}

function resolveSeoRequest({ pathname, query, catalog, locations } = {}) {
  const path = normalizePath(pathname);
  const parts = splitPath(path);
  const pageInfo = parsePageQuery(query);
  const withKeep = (target) => {
    const keep = keepTrackingQuery(query);
    return target + (keep ? `?${keep}` : '');
  };

  if (path === '/' || path === '/index.html') {
    if (pageInfo.invalid) return { notFound: true };
    if (shouldRedirectLegacy(path === '/index.html' ? '/' : path, query) || path === '/index.html') {
      const parsed = parseLanding({ pathname: '/', query, catalog });
      return { redirect: withKeep(canonicalPath(parsed)) };
    }
    if (String(query?.page || '') === '1') return { redirect: withKeep('/') };
    const landing = { loc: '', cat: '', area: '', sub: '', page: pageInfo.page || 1 };
    const listing = buildListing(landing, locations);
    if (listing.outOfRange) return { notFound: true };
    return { landing, listing, noindex: false, prevUrl: listing.prevUrl, nextUrl: listing.nextUrl };
  }

  if (parts[0] === 'p') {
    if (parts.length !== 2 || !parts[1]) return { notFound: true };
    if (query?.page) return { notFound: true };
    const id = parts[1];
    const loc = visibleLocations(locations).find((row) => row.id === id);
    if (!loc) return { notFound: true };
    const landing = { loc: id, cat: '', area: '', sub: '', page: 1 };
    if (shouldRedirectAlias(path, landing)) return { redirect: withKeep(canonicalPath(landing)) };
    return { landing, listing: null, noindex: false, prevUrl: '', nextUrl: '' };
  }

  if (parts[0] === 'kyiv' || parts[0] === 'kiev') {
    const classified = classifyKyivParts(parts, catalog);
    if (classified.notFound) return { notFound: true };
    if (pageInfo.invalid) return { notFound: true };
    const landing = { ...classified.landing, page: pageInfo.page || 1 };
    const bareKyiv = path === '/kyiv' || path === '/kiev';
    if (bareKyiv || shouldRedirectLegacy(path, query) || shouldRedirectAlias(path, landing) || String(query?.page || '') === '1') {
      const target = bareKyiv && !landing.cat && !landing.area && !landing.sub ? '/' : canonicalPath(landing);
      return { redirect: withKeep(target) };
    }
    const listing = buildListing(landing, locations);
    if (listing.outOfRange) return { notFound: true };
    return {
      landing,
      listing,
      noindex: listing.noindex,
      prevUrl: listing.prevUrl,
      nextUrl: listing.nextUrl,
    };
  }

  return { notFound: true };
}

/** Old /kotsyubynske slugs that must 301 even when the catalog has not loaded. */
const KOTSYUBYNSKE_STATIC_REDIRECTS = {
  krasa: '/kyiv/kotsiubynske/beauty',
  beauty: '/kyiv/kotsiubynske/beauty',
  manikiur: '/kyiv/kotsiubynske/beauty',
  barbershop: '/kyiv/kotsiubynske/beauty',
  'salon-krasy': '/kyiv/kotsiubynske/beauty',
  avtoservis: '/kyiv/kotsiubynske/auto',
  auto: '/kyiv/kotsiubynske/auto',
  sto: '/kyiv/kotsiubynske/auto',
  shynomontazh: '/kyiv/kotsiubynske/auto/tyres',
  shinmontazh: '/kyiv/kotsiubynske/auto/tyres',
  remont: '/kyiv/kotsiubynske/repair',
  repair: '/kyiv/kotsiubynske/repair',
  'remont-tehniky': '/kyiv/kotsiubynske/repair',
  tvaryny: '/kyiv/kotsiubynske/pets',
  pets: '/kyiv/kotsiubynske/pets',
  dim: '/kyiv/kotsiubynske/home',
  home: '/kyiv/kotsiubynske/home',
  santekhnik: '/kyiv/kotsiubynske/home/plumber',
  santehnik: '/kyiv/kotsiubynske/home/plumber',
  elektryk: '/kyiv/kotsiubynske/home/electrician',
  elektrik: '/kyiv/kotsiubynske/home/electrician',
  'majster-dodomu': '/kyiv/kotsiubynske/home/handyman',
  'cholovik-na-godynu': '/kyiv/kotsiubynske/home/handyman',
  navchannia: '/kyiv/kotsiubynske/education',
  education: '/kyiv/kotsiubynske/education',
  sport: '/kyiv/kotsiubynske/sport',
  orenda: '/kyiv/kotsiubynske/rental',
  rental: '/kyiv/kotsiubynske/rental',
  medytsyna: '/kyiv/kotsiubynske/medical',
  medical: '/kyiv/kotsiubynske/medical',
  yizha: '/kyiv/kotsiubynske/food',
  food: '/kyiv/kotsiubynske/food',
  mebli: '/kyiv/kotsiubynske/furniture',
  furniture: '/kyiv/kotsiubynske/furniture',
};

function kotsyubynskeToKyivPath(catalog, rawSlug) {
  const slug = String(rawSlug || '')
    .toLowerCase()
    .trim()
    .replace(/\/+$/, '');
  if (!slug) return '/kyiv/kotsiubynske';
  if (KOTSYUBYNSKE_STATIC_REDIRECTS[slug]) return KOTSYUBYNSKE_STATIC_REDIRECTS[slug];
  if (!catalog) return '';
  const alias = resolvePathAlias(slug);
  const cats = catalogKeysFrom(catalog);
  if (alias && cats.has(alias.cat)) {
    if (alias.sub && catalog?.[alias.cat]?.subcats?.[alias.sub]) {
      return canonicalPath({ area: 'kotsiubynske', cat: alias.cat, sub: alias.sub });
    }
    if (!alias.sub) return canonicalPath({ area: 'kotsiubynske', cat: alias.cat });
  }
  const resolved = resolveKotsyubynskeSlug(catalog, slug);
  if (!resolved) return '';
  if (resolved.page) {
    return canonicalPath({
      area: 'kotsiubynske',
      cat: resolved.page.cat,
      sub: resolved.page.sub || '',
    });
  }
  if (resolved.redirect) {
    const next = String(resolved.redirect).split('/').filter(Boolean).pop();
    if (next && next !== slug) return kotsyubynskeToKyivPath(catalog, next);
  }
  return '';
}

function renderNotFoundPage() {
  const links = [
    ['/', 'Карта майстрів'],
    ['/kyiv/home', 'Дім і ремонт'],
    ['/kyiv/home/plumber', 'Сантехнік'],
    ['/kyiv/home/electrician', 'Електрик'],
    ['/kyiv/auto', 'Автосервіс'],
    ['/kyiv/auto/tyres', 'Шиномонтаж'],
    ['/kyiv/beauty', 'Краса'],
    ['/kyiv/kotsiubynske', 'Коцюбинське'],
    ['/register', 'Додати свій бізнес'],
  ];
  const list = links
    .map(([href, label]) => `<li><a href="${escapeHtmlAttr(href)}">${escapeHtml(label)}</a></li>`)
    .join('');
  return renderLocalPageDocument({
    title: 'Сторінку не знайдено | Mapfix',
    description: 'Такої сторінки на Mapfix немає. Поверніться на карту майстрів у Києві.',
    noindex: true,
    omitCanonical: true,
    footerHtml: '<footer class="page-foot"><a href="/">На карту</a></footer>',
    body: `<h1>Сторінку не знайдено</h1>
<p class="lead">Такої адреси на Mapfix немає. Оберіть категорію або поверніться на карту.</p>
<ul class="cats">${list}</ul>
<div class="actions"><a class="btn btn-primary" href="/">На карту майстрів</a></div>`,
  });
}

function locationLastmod(loc) {
  return validSitemapDate(loc?.lastmod || loc?.updatedAt || loc?.claimedAt || loc?.createdAt);
}

function listingLastmod(list) {
  let best = '';
  for (const loc of list) {
    const day = locationLastmod(loc);
    if (day && day > best) best = day;
  }
  return best;
}

function sitemapXml({ categories = [], locations = [], areas = [], extraPaths = [] } = {}) {
  const base = siteBaseUrl();
  const urls = [];
  const areaKeys = areas.length ? areas : SITEMAP_AREAS;
  const seen = new Set();
  const publicLocs = sortByTitle(visibleLocations(locations));
  const catKeys = categories.map((cat) => cat && cat.key).filter(Boolean);

  function pushUrl(path, changefreq, priority, lastmod) {
    const loc = `${base}${path}`;
    if (seen.has(loc)) return;
    seen.add(loc);
    const row = { loc, changefreq, priority };
    const day = validSitemapDate(lastmod);
    if (day) row.lastmod = day;
    urls.push(row);
  }

  function pushListing(landing, priority) {
    if (!isIndexableListing(landing, publicLocs)) return;
    const list = sortByTitle(publicLocs.filter((loc) => locationMatchesListing(loc, landing)));
    pushUrl(listingPath({ ...landing, page: 1 }), 'weekly', priority, listingLastmod(list));
    const pages = Math.ceil(list.length / LISTING_PAGE_SIZE);
    for (let page = 2; page <= pages; page += 1) {
      const slice = list.slice((page - 1) * LISTING_PAGE_SIZE, page * LISTING_PAGE_SIZE);
      pushUrl(listingPath({ ...landing, page }), 'weekly', '0.4', listingLastmod(slice));
    }
  }

  pushListing({ loc: '', cat: '', area: '', sub: '' }, '1.0');
  pushUrl('/register.html', 'monthly', '0.5');
  for (const key of catKeys) pushListing({ cat: key, area: '', sub: '' }, '0.9');
  for (const row of PRIORITY_SUBS) {
    if (catKeys.includes(row.cat)) pushListing({ cat: row.cat, sub: row.sub, area: '' }, '0.85');
  }
  for (const area of areaKeys) {
    pushListing({ area, cat: '', sub: '' }, '0.8');
    for (const key of catKeys) pushListing({ area, cat: key, sub: '' }, '0.7');
    for (const row of PRIORITY_SUBS) {
      if (!catKeys.includes(row.cat)) continue;
      pushListing({ area, cat: row.cat, sub: row.sub }, '0.65');
    }
  }
  for (const extra of extraPaths) {
    const path = String(extra || '');
    if (!path.startsWith('/')) continue;
    const priority = path.split('/').filter(Boolean).length > 1 ? '0.7' : '0.8';
    pushUrl(path, 'weekly', priority);
  }
  for (const loc of publicLocs) {
    if (!loc.id) continue;
    pushUrl(canonicalPath({ loc: loc.id }), 'weekly', '0.6', locationLastmod(loc));
  }

  const body = urls
    .map((u) => {
      const lastmod = u.lastmod ? `\n    <lastmod>${xmlEscape(u.lastmod)}</lastmod>` : '';
      return `  <url>
    <loc>${xmlEscape(u.loc)}</loc>${lastmod}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

module.exports = {
  siteBaseUrl,
  stripHeadingDecor,
  clipMeta,
  DEFAULT_SEO,
  SEO_AREAS,
  SITEMAP_AREAS,
  KNOWN_CATS,
  PATH_ALIASES,
  PRIORITY_SUBS,
  parseLanding,
  canonicalPath,
  canonicalUrl,
  keepTrackingQuery,
  shouldRedirectLegacy,
  shouldRedirectAlias,
  seoForHome,
  seoForCategory,
  seoForLocation,
  buildSeo,
  jsonLdGraph,
  crawlerHtml,
  landingBootScript,
  injectSeoIntoHtml,
  robotsTxt,
  sitemapXml,
  legacyHostRedirectUrl,
  isPublicTestLocation,
  isHiddenPlaceholderLocation,
  DEMO_LOCATION_IDS,
  AREA_RADIUS_KM,
  LISTING_PAGE_SIZE,
  locationInArea,
  buildListing,
  resolveSeoRequest,
  kotsyubynskeToKyivPath,
  KOTSYUBYNSKE_STATIC_REDIRECTS,
  renderNotFoundPage,
  mapfixReviews,
  KOTSYUBYNSKE,
  kotsyubynskeSitemapPaths,
  renderKotsyubynskeHub,
  renderKotsyubynskeCategory,
  renderKotsyubynskeNotFound,
  resolveKotsyubynskeSlug,
};
