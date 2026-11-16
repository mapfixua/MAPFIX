'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const seo = require('../seo.js');

const catalog = {
  medical: {
    name: 'Медичні та Оздоровчі послуги',
    subcats: {
      dentistry: { name: 'Стоматологія' },
      therapy: { name: 'Терапія та Сімейний лікар' },
    },
  },
  home: {
    name: 'Дім',
    subcats: { plumber: { name: 'Послуги сантехніка' } },
  },
  beauty: {
    name: 'Краса',
    subcats: { nails: { name: 'Нігтьовий сервіс' }, barber: { name: 'Барбершоп' } },
  },
};

const weekdays = {
  Пн: '09:00 - 19:00',
  Вт: '09:00 - 19:00',
  Ср: '09:00 - 19:00',
  Чт: '09:00 - 19:00',
  Пт: '09:00 - 19:00',
  Сб: 'Вихідний',
  Нд: 'Вихідний',
};

function dental(overrides = {}) {
  return {
    id: 'loc-imp-dent',
    title: 'Дента Люкс',
    text: 'Імпортовано з Google Maps (Київ / Коцюбинське).',
    cat: 'medical',
    subcats: ['dentistry'],
    address: 'вул. Доківська, 7, Коцюбинське',
    phone: '+380671112233',
    schedule: weekdays,
    prices: {},
    reviews: [{ rating: 5, text: 'Чудовий лікар', source: 'google_maps' }],
    rating: 4.9,
    reviewsCount: 120,
    ...overrides,
  };
}

test('import stubs are recognized and master descriptions are not', () => {
  assert.equal(seo.isImportTemplateText(''), true);
  assert.equal(seo.isImportTemplateText('   '), true);
  assert.equal(seo.isImportTemplateText('Імпортовано з Google Maps (Київ / Коцюбинське).'), true);
  assert.equal(seo.isImportTemplateText('Імпортовано з Google Maps'), true);
  assert.equal(seo.isImportTemplateText('Знайдено на Google Maps'), true);
  assert.equal(seo.isImportTemplateText('Знайдено на Google Maps.'), true);
  assert.equal(seo.isImportTemplateText('Імпортовано з Google Places'), true);
  assert.equal(seo.isImportTemplateText('Імпортовано з OpenStreetMap (node/5392817834)'), true);
  assert.equal(seo.isImportTemplateText('Тип: car_repair, point_of_interest, service, establishment'), true);
  assert.equal(seo.isImportTemplateText('Імпортовано з Google Maps, працюємо з 2010 року.'), false);
  assert.equal(seo.isImportTemplateText('Тип: beauty_salon Сайт: https://example.com'), false);
  assert.equal(seo.isImportTemplateText('09:00-23:00'), false);
  assert.equal(seo.isImportTemplateText('Міняю змішувачі'), false);
});

test('master-written description is kept verbatim', () => {
  const loc = dental({
    id: 'master-1',
    text: 'Міняю змішувачі і підключаю техніку.',
    cat: 'home',
    subcats: ['plumber'],
  });
  assert.equal(seo.publicCardText(loc, catalog), 'Міняю змішувачі і підключаю техніку.');
  const html = seo.crawlerHtml(seo.buildSeo({ loc: loc.id }, { masterCatalog: catalog, mockLocations: [loc] }), { loc: loc.id }, {
    masterCatalog: catalog,
    mockLocations: [loc],
  });
  assert.match(html, /Міняю змішувачі і підключаю техніку/);
  assert.doesNotMatch(html, /Імпортовано з Google Maps/);
});

test('import stub becomes a factual Ukrainian paragraph', () => {
  const loc = dental();
  const text = seo.publicCardText(loc, catalog);
  assert.equal(
    text,
    'Стоматологічна клініка «Дента Люкс» на вул. Доківська, 7, Коцюбинське. Працює пн–пт 9:00–19:00. Телефонуйте напряму, без посередників і комісій.'
  );
  assert.equal(seo.publicCardText(loc, catalog), text);
  assert.doesNotMatch(text, /Google/i);
  assert.doesNotMatch(text, /відгук/i);
  assert.doesNotMatch(text, /грн/);
  assert.doesNotMatch(text, /671112233/);
  assert.doesNotMatch(text, /4\.9/);
  assert.doesNotMatch(text, /120/);

  const html = seo.crawlerHtml(seo.buildSeo({ loc: loc.id }, { masterCatalog: catalog, mockLocations: [loc] }), { loc: loc.id }, {
    masterCatalog: catalog,
    mockLocations: [loc],
  });
  assert.match(html, /Стоматологічна клініка «Дента Люкс»/);
  assert.doesNotMatch(html, /Імпортовано з Google Maps/);
  assert.doesNotMatch(html, /Знайдено на Google Maps/);
  assert.doesNotMatch(html, /Чудовий лікар/);

  const graph = seo.jsonLdGraph(
    seo.buildSeo({ loc: loc.id }, { masterCatalog: catalog, mockLocations: [loc] }),
    { loc: loc.id },
    { masterCatalog: catalog, mockLocations: [loc] }
  );
  const biz = graph['@graph'].find((node) => node['@type'] === 'LocalBusiness');
  const json = JSON.stringify(graph);
  assert.match(biz.description, /Стоматологічна клініка/);
  assert.equal(json.includes('aggregateRating'), false);
  assert.equal(json.includes('AggregateRating'), false);
  assert.equal(json.includes('Чудовий лікар'), false);
});

test('wording varies by id and omits phone or hours that are not on the card', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    const text = seo.publicCardText(dental({ id: `loc-imp-${i}`, text: 'Знайдено на Google Maps' }), catalog);
    if (text.startsWith('«')) seen.add('name-first');
    else if (text.includes('Графік:')) seen.add('hours-label');
    else if (text.includes('Телефон є на картці')) seen.add('phone-on-card');
    else seen.add('classic');
    assert.match(text, /на вул\. Доківська, 7, Коцюбинське/);
    assert.match(text, /пн–пт 9:00–19:00/);
    assert.doesNotMatch(text, /Google/i);
  }
  assert.equal(seen.size, 4);

  const quiet = dental({
    id: 'loc-imp-quiet',
    text: '',
    phone: '',
    schedule: {},
    workingHours: '',
    prices: { Пломба: '800 грн' },
    subcats: ['dentistry', 'therapy'],
  });
  let mentionedService = false;
  for (let i = 0; i < 24; i += 1) {
    const text = seo.publicCardText({ ...quiet, id: `quiet-${i}` }, catalog);
    assert.doesNotMatch(text, /Телефонуйте|Дзвоніть|Зателефонуйте|Телефон є/);
    assert.doesNotMatch(text, /Працює|Графік:/);
    assert.doesNotMatch(text, /800|грн/);
    if (text.includes('Терапія')) mentionedService = true;
  }
  assert.equal(mentionedService, true);
});

test('medical category and home meta no longer promise massage or price comparison', () => {
  const medical = seo.seoForCategory('medical', 'Медичні послуги', '', '', '');
  assert.match(medical.title, /Стоматологія та медичні послуги у Києві/);
  assert.match(medical.description, /Стоматологія та медичні послуги/);
  assert.match(medical.description, /медичні послуги/i);
  assert.doesNotMatch(medical.title, /Масаж/);
  assert.doesNotMatch(medical.description, /Масаж/);
  assert.doesNotMatch(seo.DEFAULT_SEO.description, /порівняйте ціни/i);
  assert.match(seo.DEFAULT_SEO.description, /безкоштовно, без комісії, напряму до майстра/);

  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '../public/js/mapfix-app.js'), 'utf8');
  assert.equal(indexHtml.includes('порівняйте ціни'), false);
  assert.equal(indexHtml.includes(seo.DEFAULT_SEO.description), true);
  assert.equal(appJs.includes('порівняйте ціни'), false);
  assert.equal(appJs.includes('Масаж, медпослуги'), false);
  assert.equal(appJs.includes('Стоматологія та медичні послуги{p}'), true);
});

test('an address without a street word is still quoted', () => {
  const loc = dental({
    id: 'loc-imp-raw-addr',
    address: 'Ореста Васкула 25/23, Київ',
    lat: 50.4574,
    lng: 30.3553,
  });
  const text = seo.publicCardText(loc, catalog);
  assert.match(text, /за адресою Ореста Васкула 25\/23, Святошин/);
  assert.doesNotMatch(text, /вул\./);
});

test('five imported cards render different paragraphs without the Google import line', () => {
  const data = require('../data.json');
  const imported = data.mockLocations.filter(
    (loc) => String(loc.id || '').startsWith('loc-imp-') && seo.isImportTemplateText(loc.text)
  );
  assert.ok(imported.length >= 5);
  const sorted = imported.slice().sort((a, b) => String(a.id).localeCompare(b.id));
  const sample = [0, 1, 2, 3, 4].map((i) => sorted[Math.floor((i * (sorted.length - 1)) / 4)]);
  const texts = sample.map((loc) => seo.publicCardText(loc, data.masterCatalog));
  assert.equal(new Set(texts).size, 5);
  for (const loc of sample) {
    const page = seo.crawlerHtml(
      seo.buildSeo({ loc: loc.id }, { masterCatalog: data.masterCatalog, mockLocations: [loc] }),
      { loc: loc.id },
      { masterCatalog: data.masterCatalog, mockLocations: [loc] }
    );
    assert.equal(page.includes('Імпортовано з Google Maps'), false);
    assert.equal(page.includes('Знайдено на Google Maps'), false);
    assert.match(page, /«/);
  }
});
