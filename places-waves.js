'use strict';

/**
 * Wave A — empty high-demand subcategories, mapped onto existing catalog keys.
 * One Text Search query per target. Tiles multiply this count.
 */
const WAVES = {
  A: {
    id: 'A',
    label: 'Хвиля A: сантехнік, кондиціонери, стоматологія, телефони, компʼютери, ветеринар, пекарня',
    targets: [
      {
        key: 'plumber',
        cat: 'home',
        sub: 'plumber',
        query: 'сантехнік',
      },
      {
        key: 'ac_climate',
        cat: 'home',
        sub: 'ac_climate',
        query: 'ремонт кондиціонерів',
      },
      {
        key: 'dentistry',
        cat: 'medical',
        sub: 'dentistry',
        query: 'стоматологія',
      },
      {
        key: 'phones',
        cat: 'repair',
        sub: 'phones',
        query: 'ремонт телефонів',
      },
      {
        key: 'computers',
        cat: 'repair',
        sub: 'computers',
        query: 'ремонт компʼютерів',
      },
      {
        key: 'vet',
        cat: 'pets',
        sub: 'vet',
        query: 'ветеринарна клініка',
      },
      {
        key: 'bakery',
        cat: 'food',
        sub: 'bakery',
        query: 'пекарня',
        bakeryOnly: true,
      },
    ],
  },
};

const CAFE_TYPES = new Set([
  'restaurant',
  'cafe',
  'bar',
  'coffee_shop',
  'meal_takeaway',
  'meal_delivery',
]);

function getWave(name) {
  const id = String(name || 'A').trim().toUpperCase();
  const wave = WAVES[id];
  if (!wave) {
    const known = Object.keys(WAVES).join(', ');
    throw new Error(`Невідома хвиля "${name}". Доступні: ${known}`);
  }
  return wave;
}

function looksLikeBakery(place) {
  const types = new Set((place?.types || []).map((t) => String(t || '').toLowerCase()));
  const title = String(place?.title || place?.displayName || '').toLowerCase();
  const nameBakery = /пекар|хліб|випіч|булоч|кондитер|baker|bakery/.test(title);
  const nameCafe = /кафе|ресторан|кав.?яр|coffee|bistro|бістро|бар\b/.test(title);
  if (types.has('bakery') && !nameCafe) return true;
  if (types.has('bakery') && nameBakery) return true;
  if (nameBakery && !nameCafe && ![...types].some((t) => CAFE_TYPES.has(t) && t !== 'bakery')) return true;
  return false;
}

module.exports = {
  WAVES,
  getWave,
  looksLikeBakery,
};
