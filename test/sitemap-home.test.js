'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const seo = require('../seo.js');

function card(i, extra) {
  return {
    id: `loc-${i}`,
    title: `Майстер ${String(i).padStart(2, '0')}`,
    cat: 'home',
    lat: 50.45,
    lng: 30.52,
    ...extra,
  };
}

test('sitemap keeps the home canonical URL and drops /?page=N', () => {
  const locations = Array.from({ length: 30 }, (_, i) => card(i));
  const xml = seo.sitemapXml({
    categories: [{ key: 'home' }, { key: 'auto' }],
    locations,
  });
  assert.match(xml, /<loc>https:\/\/www\.mapfix\.com\.ua\/<\/loc>/);
  assert.equal(xml.includes('/?page='), false);
  assert.equal(xml.includes('?page='), true);
  assert.match(xml, /<loc>https:\/\/www\.mapfix\.com\.ua\/kyiv\/home\?page=2<\/loc>/);
  assert.match(xml, /<loc>https:\/\/www\.mapfix\.com\.ua\/kyiv\/home<\/loc>/);
  assert.match(xml, /<loc>https:\/\/www\.mapfix\.com\.ua\/p\/loc-0<\/loc>/);
  assert.match(xml, /<loc>https:\/\/www\.mapfix\.com\.ua\/register\.html<\/loc>/);
  const homePages = xml.match(/mapfix\.com\.ua\/\?page=\d+/g) || [];
  assert.deepEqual(homePages, []);
});
