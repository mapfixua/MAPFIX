'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const seo = require('../seo.js');

const PROFI = {
  id: 'loc-profi-dental',
  title: 'ПРОФІ ДЕНТАЛ',
  address: 'вулиця Борщагівська, 206, Київ, Україна, 03058',
  lat: 50.4426414,
  lng: 30.4351333,
  cat: 'medical',
  phone: '+380441111111',
};

const MYKILSKA = {
  id: 'loc-mykilska',
  title: 'Сервіс на Микільській Борщагівці',
  address: 'вулиця Якуба Коласа, 25, Микільська Борщагівка, Київ',
  lat: 50.4369325,
  lng: 30.382677,
  cat: 'repair',
  phone: '+380442222222',
};

const MYKILSKA_SHORT_I = {
  id: 'loc-mykilska-spelling',
  title: 'Фора на Микільскій Борщагівці',
  address: 'вулиця Якуба Коласа, 25 м-н, Фора, Микільска Борщагівка, Київ, 03148',
  lat: 50.4369,
  lng: 30.3827,
  cat: 'repair',
};

const LOCALITY = {
  id: 'loc-borshchahivka-word',
  title: 'Майстер на Борщагівці',
  address: 'смт Борщагівка, вул. Соборна, 5',
  lat: 50.43,
  lng: 30.34,
  cat: 'home',
};

function itemNames(locations) {
  const decision = seo.resolveSeoRequest({
    pathname: '/kyiv/borshchahivka',
    query: {},
    catalog: {},
    locations,
  });
  assert.equal(decision.notFound, undefined);
  const built = seo.buildSeo(decision.landing, { masterCatalog: {}, mockLocations: locations });
  const graph = seo.jsonLdGraph(built, decision.landing, { mockLocations: locations });
  const list = graph['@graph'].find((node) => node['@type'] === 'ItemList');
  if (!list) return [];
  return list.itemListElement.map((row) => row.item.name);
}

test('Борщагівська street is not the Борщагівка locality', () => {
  assert.equal(seo.AREA_RADIUS_KM.borshchahivka, 3.5);
  assert.equal(seo.AREA_RADIUS_KM.sviatoshyn, 2);
  assert.equal(seo.AREA_RADIUS_KM.akademmistechko, 1.5);
  assert.equal(seo.AREA_RADIUS_KM.kotsiubynske, 3);
  assert.deepEqual(seo.SITEMAP_AREAS, ['sviatoshyn', 'borshchahivka', 'akademmistechko', 'kotsiubynske']);

  assert.equal(seo.locationInArea(PROFI, 'borshchahivka'), false);
  assert.equal(seo.primaryDistrict(PROFI), 'kyiv');
  for (const address of [
    'борщаг',
    'вул. Борщагівська, 10',
    'вулиця Борщагівську, 12',
    'пров. Борщагівський, 3',
    'Борщагівської, 5',
  ]) {
    assert.equal(
      seo.locationInArea({ id: 'x', title: 'X', address, lat: 50.45, lng: 30.52 }, 'borshchahivka'),
      false,
      address
    );
  }

  assert.equal(seo.locationInArea(MYKILSKA, 'borshchahivka'), true);
  assert.equal(seo.locationInArea(MYKILSKA_SHORT_I, 'borshchahivka'), true);
  assert.equal(seo.locationInArea(LOCALITY, 'borshchahivka'), true);
  assert.equal(
    seo.locationInArea(
      {
        id: 'loc-case',
        title: 'На Борщагівці',
        address: 'на Борщагівці, вул. Соборна',
        lat: 50.5,
        lng: 30.5,
      },
      'borshchahivka'
    ),
    true
  );
  assert.equal(
    seo.primaryDistrict({
      id: 'inside-radius',
      title: 'У радіусі',
      address: 'вулиця Борщагівська, 1',
      lat: 50.4378,
      lng: 30.338,
    }),
    'borshchahivka'
  );
});

test('ПРОФІ ДЕНТАЛ is absent from the Борщагівка ItemList', () => {
  const names = itemNames([PROFI, MYKILSKA, LOCALITY]);
  assert.ok(names.includes('Сервіс на Микільській Борщагівці'));
  assert.ok(names.includes('Майстер на Борщагівці'));
  assert.equal(names.includes('ПРОФІ ДЕНТАЛ'), false);
});

test('map client uses the same Борщагівка locality pattern as seo.js', () => {
  const root = path.join(__dirname, '..');
  const serverRe = fs.readFileSync(path.join(root, 'seo.js'), 'utf8').match(/borshchahivka:\s*(\/[^/\n]+\/[a-z]*)/);
  const clientRe = fs
    .readFileSync(path.join(root, 'public/js/mapfix-app.js'), 'utf8')
    .match(/borshchahivka:\s*(\/[^/\n]+\/[a-z]*)/);
  assert.ok(serverRe && clientRe);
  assert.equal(clientRe[1], serverRe[1]);
  assert.equal(serverRe[1], '/борщагів(?:к|ц)/i');
});
