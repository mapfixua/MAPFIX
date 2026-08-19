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

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const DEFAULT_SEO = {
  title: 'Mapfix — майстер додому, сантехнік Київ, ремонт поруч',
  description:
    'Карта майстрів у Києві: сантехнік, ремонт квартири, майстер додому. Знайдіть виконавця поруч, порівняйте ціни й замовте послугу на Mapfix.',
  keywords:
    'майстер додому, сантехнік Київ, ремонт, майстер Київ, карта послуг, сантехнік, електрик, ремонт квартири, Mapfix',
};

function seoForHome() {
  const url = siteBaseUrl() + '/';
  return { ...DEFAULT_SEO, url, image: siteBaseUrl() + '/icon-512.png' };
}

function seoForCategory(catKey, catName) {
  const name = stripHeadingDecor(catName) || catKey || 'Послуги';
  const url = `${siteBaseUrl()}/?cat=${encodeURIComponent(catKey)}`;
  return {
    title: `${name} Київ — майстер додому, ремонт | Mapfix`,
    description: `${name} у Києві та області. Майстер додому, сантехнік, ремонт — оберіть виконавця на карті Mapfix і замовте послугу.`,
    keywords: `${name}, ${name} Київ, майстер додому, сантехнік Київ, ремонт, карта послуг, Mapfix`,
    url,
    image: siteBaseUrl() + '/icon-512.png',
  };
}

function seoForLocation(loc, catName) {
  const title = String(loc?.title || 'Майстер').trim() || 'Майстер';
  const cat = stripHeadingDecor(catName) || 'майстер';
  const address = String(loc?.address || 'Київ').trim() || 'Київ';
  const url = `${siteBaseUrl()}/?loc=${encodeURIComponent(loc?.id || '')}`;
  return {
    title: `${title} — ${cat} Київ, майстер додому | Mapfix`,
    description: `${title}: ${address}. Ремонт, сантехнік, майстер додому. Телефон, маршрут і відгуки на карті Mapfix.`,
    keywords: `${title}, ${cat}, майстер додому, сантехнік Київ, ремонт, ${address}, Mapfix`,
    url,
    image: siteBaseUrl() + '/icon-512.png',
  };
}

function injectSeoIntoHtml(html, seo) {
  const title = escapeHtmlAttr(seo.title);
  const description = escapeHtmlAttr(seo.description);
  const keywords = escapeHtmlAttr(seo.keywords);
  const url = escapeHtmlAttr(seo.url);
  const image = escapeHtmlAttr(seo.image || siteBaseUrl() + '/icon-512.png');
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
  } else {
    out = out.replace(
      /<meta name="description"[^>]*>/i,
      (m) => `${m}\n    <meta name="keywords" content="${keywords}">`
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
  return out;
}

function robotsTxt() {
  const base = siteBaseUrl();
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /admin.html',
    'Disallow: /login',
    'Disallow: /login.html',
    'Disallow: /register',
    'Disallow: /register.html',
    'Disallow: /forgot-password.html',
    'Disallow: /reset-password.html',
    'Disallow: /link-telegram.html',
    'Disallow: /api/',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

function sitemapXml({ categories = [], locations = [] } = {}) {
  const base = siteBaseUrl();
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${base}/`, changefreq: 'daily', priority: '1.0' },
    ...categories.map((cat) => ({
      loc: `${base}/?cat=${encodeURIComponent(cat.key)}`,
      changefreq: 'daily',
      priority: '0.8',
    })),
    ...locations.map((loc) => ({
      loc: `${base}/?loc=${encodeURIComponent(loc.id)}`,
      changefreq: 'weekly',
      priority: '0.6',
      lastmod: loc.lastmod || today,
    })),
  ];
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
  seoForHome,
  seoForCategory,
  seoForLocation,
  injectSeoIntoHtml,
  robotsTxt,
  sitemapXml,
};
