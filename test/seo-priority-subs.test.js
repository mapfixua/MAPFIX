'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const seo = require('../seo.js');

const NEW_SUBS = [
  ['medical', 'dentistry'],
  ['home', 'ac_climate'],
  ['repair', 'computers'],
  ['beauty', 'brows'],
  ['beauty', 'depilation'],
];

const CATALOG = {
  home: {
    name: 'Дім',
    subcats: {
      plumber: { name: 'Сантехнік' },
      electrician: { name: 'Електрик' },
      ac_climate: { name: 'Кондиціонери' },
    },
  },
  medical: { name: 'Медицина', subcats: { dentistry: { name: 'Стоматологія' } } },
  repair: { name: 'Ремонт', subcats: { computers: { name: 'Компʼютери' } } },
  beauty: {
    name: 'Краса',
    subcats: { brows: { name: 'Брови' }, depilation: { name: 'Депіляція' } },
  },
};

function at(id, cat, sub, lat, lng, address) {
  return {
    id,
    title: id,
    cat,
    subcats: sub ? [sub] : [],
    lat,
    lng,
    address: address || 'Київ',
  };
}

function cardHtml(loc, locations) {
  const locs = locations || [loc];
  const data = { masterCatalog: CATALOG, mockLocations: locs };
  return seo.crawlerHtml(seo.buildSeo({ loc: loc.id }, data), { loc: loc.id }, data);
}

test('priority subcategories keep the city route and the district variant', () => {
  for (const [cat, sub] of NEW_SUBS) {
    assert.ok(
      seo.PRIORITY_SUBS.some((row) => row.cat === cat && row.sub === sub),
      `${cat}/${sub}`
    );
    assert.equal(seo.canonicalPath({ cat, sub }), `/kyiv/${cat}/${sub}`);
    assert.equal(
      seo.canonicalPath({ cat, sub, area: 'kotsiubynske' }),
      `/kyiv/kotsiubynske/${cat}/${sub}`
    );
  }
  assert.equal(seo.MIN_AREA_LISTING, 2);
});

test('new landing titles name the service in Ukrainian', () => {
  const dentistry = seo.seoForCategory('medical', 'Медицина', '', 'dentistry', 'Стоматологія');
  const ac = seo.seoForCategory('home', 'Дім', '', 'ac_climate', 'Кондиціонери');
  const computers = seo.seoForCategory('repair', 'Ремонт', '', 'computers', 'Компʼютери');
  const brows = seo.seoForCategory('beauty', 'Краса', '', 'brows', 'Брови');
  const depilation = seo.seoForCategory('beauty', 'Краса', '', 'depilation', 'Депіляція');
  const district = seo.seoForCategory('medical', 'Медицина', 'kotsiubynske', 'dentistry', 'Стоматологія');

  assert.match(dentistry.title.toLowerCase(), /стоматолог/);
  assert.match(dentistry.h1, /Стоматологія у Києві/);
  assert.match(ac.title.toLowerCase(), /кондиціонер/);
  assert.match(ac.h1, /Ремонт і встановлення кондиціонерів у Києві/);
  assert.match(computers.h1, /Ремонт комп'ютерів і ноутбуків у Києві/);
  assert.match(brows.h1, /Брови: корекція, ламінування/);
  assert.match(brows.title, /корекція, ламінування/);
  assert.match(depilation.h1, /Депіляція та епіляція у Києві/);
  assert.match(district.h1, /Стоматологія на Коцюбинському/);
  assert.match(district.title.toLowerCase(), /стоматолог/);
});

test('sitemap lists the new city landings and skips a thin district page', () => {
  const thin = at('solo', 'home', 'ac_climate', 50.4906, 30.3347, 'Коцюбинське');
  const categories = ['home', 'medical', 'repair', 'beauty'].map((key) => ({ key }));
  const sm = seo.sitemapXml({ categories, locations: [thin] });
  for (const [cat, sub] of NEW_SUBS) {
    assert.match(sm, new RegExp(`/kyiv/${cat}/${sub}</loc>`));
  }
  assert.equal(
    seo.buildListing({ area: 'kotsiubynske', cat: 'home', sub: 'ac_climate', page: 1 }, [thin]).noindex,
    true
  );
  assert.doesNotMatch(sm, /\/kyiv\/kotsiubynske\/home\/ac_climate/);

  const rich = [
    at('k1', 'medical', 'dentistry', 50.4906, 30.3347, 'Коцюбинське'),
    at('k2', 'medical', 'dentistry', 50.491, 30.335, 'Коцюбинське'),
    at('city', 'medical', 'dentistry', 50.45, 30.52, 'Київ, Хрещатик'),
  ];
  const richSm = seo.sitemapXml({ categories, locations: rich });
  assert.match(richSm, /\/kyiv\/kotsiubynske\/medical\/dentistry</);
  assert.match(richSm, /\/kyiv\/medical\/dentistry</);
});

test('a plumber card links to the city service, or the district when that listing is indexable', () => {
  const city = at('city-plumber', 'home', 'plumber', 50.45, 30.52, 'Київ, Хрещатик');
  const cityHtml = cardHtml(city);
  assert.match(cityHtml, /<a href="\/kyiv\/home\/plumber">Сантехнік<\/a>/);
  assert.doesNotMatch(cityHtml, /\/kyiv\/kotsiubynske\/home\/plumber/);

  const lone = at('lone', 'home', 'plumber', 50.4906, 30.3347, 'Коцюбинське');
  const loneHtml = cardHtml(lone);
  assert.match(loneHtml, /<a href="\/kyiv\/home\/plumber">Сантехнік<\/a>/);
  assert.doesNotMatch(loneHtml, /\/kyiv\/kotsiubynske\/home\/plumber/);

  const group = [
    at('k1', 'home', 'plumber', 50.4906, 30.3347, 'Коцюбинське'),
    at('k2', 'home', 'plumber', 50.491, 30.335, 'Коцюбинське'),
    city,
  ];
  const districtHtml = cardHtml(group[0], group);
  assert.match(districtHtml, /<a href="\/kyiv\/kotsiubynske\/home\/plumber">Сантехнік<\/a>/);
  const outsideHtml = cardHtml(city, group);
  assert.match(outsideHtml, /<a href="\/kyiv\/home\/plumber">Сантехнік<\/a>/);

  const duplicateOnly = group.slice(0, 2);
  const duplicateHtml = cardHtml(duplicateOnly[0], duplicateOnly);
  assert.match(duplicateHtml, /<a href="\/kyiv\/home\/plumber">Сантехнік<\/a>/);
  assert.doesNotMatch(duplicateHtml, /\/kyiv\/kotsiubynske\/home\/plumber/);

  const unknown = { ...city, id: 'unknown', subcats: ['plumber', 'not_in_catalog', 'plumber'] };
  const unknownHtml = cardHtml(unknown);
  assert.match(unknownHtml, /<a href="\/kyiv\/home\/plumber">Сантехнік<\/a>/);
  assert.match(unknownHtml, /<li>not in catalog<\/li>/);
  assert.equal(unknownHtml.match(/\/kyiv\/home\/plumber/g).length, 1);
});

test('plain category pages reuse the FAQ builder in JSON-LD and crawler HTML', () => {
  const locs = [
    at('a', 'home', 'plumber', 50.45, 30.52, 'Київ'),
    at('b', 'home', 'electrician', 50.44, 30.51, 'Київ'),
  ];
  const data = { masterCatalog: CATALOG, mockLocations: locs };
  const landing = { loc: '', cat: 'home', area: '', sub: '', page: 1 };
  const graph = seo.jsonLdGraph(seo.buildSeo(landing, data), landing, data);
  const faqs = graph['@graph'].filter((node) => node['@type'] === 'FAQPage');
  assert.equal(faqs.length, 1);
  assert.match(faqs[0].mainEntity[0].name, /у Києві/);
  assert.equal(faqs[0].mainEntity[0]['@type'], 'Question');
  const html = seo.crawlerHtml(seo.buildSeo(landing, data), landing, data);
  assert.match(html, /Як швидко знайти/);
  assert.ok(html.includes(faqs[0].mainEntity[0].name));

  const page2 = seo.jsonLdGraph(seo.buildSeo({ ...landing, page: 2 }, data), { ...landing, page: 2 }, data);
  assert.equal(page2['@graph'].some((node) => node['@type'] === 'FAQPage'), false);

  const subLanding = { loc: '', cat: 'home', area: '', sub: 'plumber', page: 1 };
  const subGraph = seo.jsonLdGraph(seo.buildSeo(subLanding, data), subLanding, data);
  assert.equal(subGraph['@graph'].some((node) => node['@type'] === 'FAQPage'), false);

  const districtLanding = { loc: '', cat: 'home', area: 'kotsiubynske', sub: 'plumber', page: 1 };
  const district = seo.areaServiceContent(
    seo.buildSeo(districtLanding, data),
    districtLanding,
    seo.buildListing(districtLanding, locs)
  );
  assert.match(district.faq[0].q, /на Коцюбинському/);
  assert.match(district.intro, /радіусі близько/);
});

test('client subcategory copy matches the server formulas', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/js/mapfix-app.js'), 'utf8');
  const rows = [
    ["Стоматологія{p} — стоматолог поруч | Mapfix", seo.seoForCategory('medical', 'Медицина', '', 'dentistry', '').title],
    [
      "Ремонт і встановлення кондиціонерів{p} | Mapfix",
      seo.seoForCategory('home', 'Дім', '', 'ac_climate', '').title,
    ],
    ["Ремонт комп'ютерів і ноутбуків{p} | Mapfix", seo.seoForCategory('repair', 'Ремонт', '', 'computers', '').title],
    ['Брови{p}: корекція, ламінування | Mapfix', seo.seoForCategory('beauty', 'Краса', '', 'brows', '').title],
    ['Депіляція та епіляція{p} | Mapfix', seo.seoForCategory('beauty', 'Краса', '', 'depilation', '').title],
  ];
  for (const [template, cityTitle] of rows) {
    const inSource = template.replace(/'/g, "\\'");
    assert.ok(app.includes(template) || app.includes(inSource), template);
    assert.equal(template.replaceAll('{p}', ' у Києві'), cityTitle);
  }
});
