'use strict';

function siteBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || 'https://mapfix-wine.vercel.app').replace(/\/$/, '');
}

function stripHeadingDecor(name) {
  return String(name || '')
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\s]+/u, '')
    .trim();
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
};

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
    const a = parts[1] || '';
    const b = parts[2] || '';
    const areaA = resolveAreaKey(a);
    if (areaA) {
      area = areaA;
      if (b && cats.has(b)) cat = b;
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
  if (area && cat) return `/kyiv/${encodeURIComponent(area)}/${encodeURIComponent(cat)}`;
  if (area) return `/kyiv/${encodeURIComponent(area)}`;
  if (cat && sub) return `/kyiv/${encodeURIComponent(cat)}/${encodeURIComponent(sub)}`;
  if (cat) return `/kyiv/${encodeURIComponent(cat)}`;
  return '/';
}

function canonicalUrl(landing, extraQuery) {
  const path = canonicalPath(landing);
  const qs = extraQuery && String(extraQuery).replace(/^\?/, '');
  return siteBaseUrl() + path + (qs ? `?${qs}` : '');
}

function keepTrackingQuery(query) {
  const q = query || {};
  const next = new URLSearchParams();
  for (const k of ['claim', 'add', 'feedback', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    if (q[k]) next.set(k, String(q[k]));
  }
  return next.toString();
}

function shouldRedirectLegacy(pathname, query) {
  const path = String(pathname || '/') || '/';
  if (path !== '/' && path !== '/index.html' && path !== '/kyiv' && path !== '/kiev') return false;
  const q = query || {};
  return Boolean(q.loc || q.cat || q.area);
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

function seoForCategory(catKey, catName, areaKey) {
  const place = areaName(areaKey);
  const p = placeBit(areaKey);
  const copy = CAT_COPY[catKey];
  const name = stripHeadingDecor(catName) || catKey || 'Послуги';
  const url = canonicalUrl({ cat: catKey, area: areaKey || '' });
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
  const title = String(loc?.title || 'Майстер').trim() || 'Майстер';
  const cat = stripHeadingDecor(catName) || 'майстер';
  const address = String(loc?.address || 'Київ').trim() || 'Київ';
  const url = canonicalUrl({ loc: loc?.id || '' });
  return {
    h1: title,
    title: `${title} — ${cat} Київ, майстер додому | Mapfix`,
    description: `${title}: ${address}. Ремонт, сантехнік, майстер додому. Телефон, маршрут і відгуки на карті Mapfix.`,
    keywords: `${title}, ${cat}, майстер додому, сантехнік Київ, ремонт, ${address}, Mapfix`,
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
    return seoForCategory(landing.cat, catalog[landing.cat].name, landing.area);
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
      crumbs.push({ '@type': 'ListItem', position: 3, name, item: seo.url });
    } else {
      crumbs.push({ '@type': 'ListItem', position: 2, name, item: seo.url });
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
  const areaLinks = ['sviatoshyn', 'borshchahivka', 'akademmistechko']
    .map((key) => {
      const href = canonicalPath({ area: key, cat: landing.cat || '' });
      return `<li><a href="${escapeHtmlAttr(href)}">${escapeHtml(areaName(key))}</a></li>`;
    })
    .join('');

  let filtered = locs.filter((l) => l && l.id && !l.trashed);
  if (landing.cat) filtered = filtered.filter((l) => l.cat === landing.cat);
  const listed = filtered.slice(0, 24);
  const placeItems = listed
    .map((l) => {
      const href = canonicalPath({ loc: l.id });
      const addr = l.address ? ` — ${l.address}` : '';
      return `<li><a href="${escapeHtmlAttr(href)}">${escapeHtml(l.title || 'Майстер')}</a>${escapeHtml(addr)}</li>`;
    })
    .join('');

  return `<section id="seo-static" class="seo-static" aria-label="Каталог Mapfix">
  <h1>${escapeHtml(seo.h1)}</h1>
  <p>${escapeHtml(seo.description)}</p>
  <h2>Послуги</h2>
  <ul>${catLinks}</ul>
  <h2>Райони Києва</h2>
  <ul>${areaLinks}</ul>
  ${placeItems ? `<h2>Майстри на карті</h2><ol>${placeItems}</ol>` : ''}
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
    'Allow: /kyiv',
    'Allow: /p/',
    'Disallow: /admin',
    'Disallow: /admin.html',
    'Disallow: /client',
    'Disallow: /login',
    'Disallow: /login.html',
    'Disallow: /register',
    'Disallow: /register.html',
    'Disallow: /forgot-password.html',
    'Disallow: /reset-password.html',
    'Disallow: /link-telegram.html',
    'Disallow: /api/',
    '',
    `Host: ${base.replace(/^https?:\/\//, '')}`,
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

function sitemapXml({ categories = [], locations = [], areas = [] } = {}) {
  const base = siteBaseUrl();
  const today = new Date().toISOString().slice(0, 10);
  const urls = [{ loc: `${base}/`, changefreq: 'daily', priority: '1.0' }];
  const areaKeys = areas.length ? areas : ['sviatoshyn', 'borshchahivka', 'akademmistechko'];

  for (const cat of categories) {
    urls.push({
      loc: `${base}${canonicalPath({ cat: cat.key })}`,
      changefreq: 'daily',
      priority: '0.9',
    });
  }
  for (const area of areaKeys) {
    urls.push({
      loc: `${base}${canonicalPath({ area })}`,
      changefreq: 'weekly',
      priority: '0.8',
    });
    for (const cat of categories) {
      urls.push({
        loc: `${base}${canonicalPath({ area, cat: cat.key })}`,
        changefreq: 'weekly',
        priority: '0.7',
      });
    }
  }
  for (const loc of locations) {
    urls.push({
      loc: `${base}${canonicalPath({ loc: loc.id })}`,
      changefreq: 'weekly',
      priority: '0.6',
      lastmod: loc.lastmod || today,
    });
  }

  const body = urls
    .map(
      (u) => `  <url>
    <loc>${xmlEscape(u.loc)}</loc>
    <lastmod>${xmlEscape(u.lastmod || today)}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`
    )
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
  DEFAULT_SEO,
  SEO_AREAS,
  KNOWN_CATS,
  parseLanding,
  canonicalPath,
  canonicalUrl,
  keepTrackingQuery,
  shouldRedirectLegacy,
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
};
