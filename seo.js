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
  const qs = extraQuery && String(extraQuery).replace(/^\?/, '');
  return siteBaseUrl() + path + (qs ? `?${qs}` : '');
}

function keepTrackingQuery(query) {
  const q = query || {};
  const next = new URLSearchParams();
  for (const k of ['claim', 'add', 'feedback', 'q', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    if (q[k]) next.set(k, String(q[k]));
  }
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
  if (landing.loc) {
    const loc = (data?.mockLocations || []).find((l) => l && l.id === landing.loc);
    if (loc) {
      return seoForLocation(loc, catalog[loc.cat]?.name || loc.cat);
    }
  }
  if (landing.cat && catalog[landing.cat]) {
    const subName = landing.sub ? catalog[landing.cat]?.subcats?.[landing.sub]?.name : '';
    return seoForCategory(landing.cat, catalog[landing.cat].name, landing.area, landing.sub, subName);
  }
  return seoForHome(landing.area);
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
      if (Number(loc.rating) > 0 && Number(loc.reviewsCount) > 0) {
        node.aggregateRating = {
          '@type': 'AggregateRating',
          ratingValue: Number(loc.rating),
          reviewCount: Number(loc.reviewsCount),
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
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}

function crawlerHtml(seo, landing, data) {
  const catalog = data?.masterCatalog || {};
  const locs = Array.isArray(data?.mockLocations) ? data.mockLocations : [];
  const catLinks = Object.entries(catalog)
    .map(([key, cat]) => {
      const href = canonicalPath({ cat: key, area: landing.area || '' });
      const label = stripHeadingDecor(cat?.name || key);
      return `<li><a href="${escapeHtmlAttr(href)}">${escapeHtml(label)}${landing.area ? ' на ' + escapeHtml(areaName(landing.area)) : ' у Києві'}</a></li>`;
    })
    .join('');
  const areaLinks = SITEMAP_AREAS.map((key) => {
    const href = canonicalPath({ area: key, cat: landing.cat || '' });
    return `<li><a href="${escapeHtmlAttr(href)}">${escapeHtml(areaName(key))}</a></li>`;
  }).join('');
  const intentLinks = PRIORITY_SUBS.map((row) => {
    const href = canonicalPath({ cat: row.cat, sub: row.sub, area: landing.area || '' });
    const copy = SUB_COPY[`${row.cat}/${row.sub}`];
    const label = copy ? copy.h1(placeBit(landing.area)) : `${row.cat}/${row.sub}`;
    return `<li><a href="${escapeHtmlAttr(href)}">${escapeHtml(label)}</a></li>`;
  }).join('');

  let filtered = locs.filter((l) => l && l.id && !l.trashed && !l.deletedAt);
  if (landing.cat) filtered = filtered.filter((l) => l.cat === landing.cat);
  if (landing.sub) {
    const withSub = filtered.filter((l) => Array.isArray(l.subcats) && l.subcats.includes(landing.sub));
    if (withSub.length) filtered = withSub;
  }
  const listed = filtered.slice(0, 24);
  const placeItems = listed
    .map((l) => {
      const href = canonicalPath({ loc: l.id });
      const addr = l.address ? ` — ${l.address}` : '';
      return `<li><a href="${escapeHtmlAttr(href)}">${escapeHtml(l.title || 'Майстер')}</a>${escapeHtml(addr)}</li>`;
    })
    .join('');
  const countLine = landing.loc
    ? ''
    : filtered.length > 0
      ? `<p>На карті зараз ${filtered.length} ${landing.cat ? 'майстрів у цій категорії' : 'точок'}${landing.area ? ' поруч із районом ' + escapeHtml(areaName(landing.area)) : ' у Києві'}.</p>`
      : '<p>Карта наповнюється. Додайте свій бізнес безкоштовно — без комісії з замовлень.</p>';

  const faq =
    !landing.loc && !landing.cat
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

function sitemapXml({ categories = [], locations = [], areas = [] } = {}) {
  const base = siteBaseUrl();
  const urls = [{ loc: `${base}/`, changefreq: 'weekly', priority: '1.0' }];
  const areaKeys = areas.length ? areas : SITEMAP_AREAS;
  const seen = new Set(urls.map((u) => u.loc));

  function pushUrl(path, changefreq, priority, lastmod) {
    const loc = `${base}${path}`;
    if (seen.has(loc)) return;
    seen.add(loc);
    const row = { loc, changefreq, priority };
    const day = validSitemapDate(lastmod);
    if (day) row.lastmod = day;
    urls.push(row);
  }

  for (const cat of categories) {
    pushUrl(canonicalPath({ cat: cat.key }), 'weekly', '0.9');
  }
  for (const row of PRIORITY_SUBS) {
    if (categories.some((c) => c.key === row.cat)) {
      pushUrl(canonicalPath(row), 'weekly', '0.85');
    }
  }
  for (const area of areaKeys) {
    pushUrl(canonicalPath({ area }), 'weekly', '0.8');
    for (const cat of categories) {
      pushUrl(canonicalPath({ area, cat: cat.key }), 'weekly', '0.7');
    }
    for (const row of PRIORITY_SUBS) {
      pushUrl(canonicalPath({ area, cat: row.cat, sub: row.sub }), 'weekly', '0.65');
    }
  }
  for (const loc of locations) {
    pushUrl(canonicalPath({ loc: loc.id }), 'weekly', '0.6', loc.lastmod);
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
};
