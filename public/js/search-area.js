'use strict';

/**
 * District phrases for the four Mapfix areas.
 * A hit is a whole word (or a two-word alias), never a substring —
 * «свято» must not become Святошин.
 * Keys match MAPFIX_AREAS in public/js/mapfix-app.js.
 */
const AREA_FORMS = [
  {
    key: 'sviatoshyn',
    forms: [
      'святошин',
      'святошино',
      'святошина',
      'святошину',
      'святошином',
      'святошині',
      'святошинський',
      'святошинська',
      'святошинське',
      'святошинської',
      'святошинському',
      'святошинським',
      'святошинську',
      'святошинські',
      'святошинських',
      'sviatoshyn',
      'svyatoshyn',
      'sviatoshino',
      'svyatoshino',
      'sviatoshyni',
      'svyatoshyni',
      'sviatoshynskyi',
      'svyatoshynskyi',
    ],
  },
  {
    key: 'borshchahivka',
    forms: [
      'борщагівка',
      'борщагівки',
      'борщагівці',
      'борщагівку',
      'борщагівкою',
      'борщагівко',
      'borshchahivka',
      'borschagivka',
      'borshchahivtsi',
      'borschagivtsi',
      'borshchahivky',
      'borschagivky',
      'borshchahivku',
      'borschagivku',
    ],
  },
  {
    key: 'akademmistechko',
    forms: [
      'академмістечко',
      'академмістечка',
      'академмістечку',
      'академмістечком',
      'академістечко',
      'академістечка',
      'академістечку',
      'академістечком',
      'академгородок',
      'академгородка',
      'академгородку',
      'akademmistechko',
      'akademmistetchko',
      'akademmistechku',
      'akademgorodok',
    ],
  },
  {
    key: 'kotsiubynske',
    forms: [
      'коцюбинське',
      'коцюбинського',
      'коцюбинському',
      'коцюбинським',
      'коцюбинська',
      'коцюбинської',
      'коцюбинську',
      'коцюбинські',
      'коцюбинських',
      'kotsiubynske',
      'kotsyubynske',
      'kotsiubinske',
      'kotsyubinske',
      'kotsiubynskomu',
      'kotsyubynskomu',
      'kotsiubynskogo',
      'kotsyubynskogo',
    ],
  },
];

const MULTI_WORD = [
  { key: 'akademmistechko', tokens: ['академ', 'містечко'] },
  { key: 'akademmistechko', tokens: ['академ', 'городок'] },
  { key: 'akademmistechko', tokens: ['akadem', 'mistechko'] },
];

const AREA_PREPS = new Set([
  'на',
  'у',
  'в',
  'по',
  'біля',
  'коло',
  'поблизу',
  'з',
  'із',
  'зі',
  'до',
  'від',
  'около',
]);
const AREA_TRAIL = new Set(['район', 'районі', 'району', 'районом', 'рн']);

function normalizeAreaText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ALIAS_TO_KEY = new Map();
for (const area of AREA_FORMS) {
  for (const form of area.forms) ALIAS_TO_KEY.set(form, area.key);
}

/**
 * Pull a district out of a search phrase.
 * «на Святошині» → area sviatoshyn, rest empty.
 * «СТО Святошин» → area sviatoshyn, rest «сто».
 */
function extractSearchArea(text) {
  const norm = normalizeAreaText(text);
  if (!norm) return { area: null, rest: '' };
  const tokens = norm.split(' ').filter(Boolean);
  const drop = new Set();
  let area = null;

  for (let i = 0; i < tokens.length; i++) {
    if (drop.has(i)) continue;
    for (const multi of MULTI_WORD) {
      if (i + multi.tokens.length > tokens.length) continue;
      let same = true;
      for (let k = 0; k < multi.tokens.length; k++) {
        if (tokens[i + k] !== multi.tokens[k]) {
          same = false;
          break;
        }
      }
      if (!same) continue;
      area = area || multi.key;
      for (let k = 0; k < multi.tokens.length; k++) drop.add(i + k);
      break;
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    if (drop.has(i)) continue;
    const key = ALIAS_TO_KEY.get(tokens[i]);
    if (!key) continue;
    area = area || key;
    drop.add(i);
    if (i > 0 && !drop.has(i - 1) && (AREA_PREPS.has(tokens[i - 1]) || AREA_TRAIL.has(tokens[i - 1]))) {
      drop.add(i - 1);
    }
    if (i + 1 < tokens.length && !drop.has(i + 1) && AREA_TRAIL.has(tokens[i + 1])) {
      drop.add(i + 1);
    }
  }

  const rest = tokens.filter((_, i) => !drop.has(i)).join(' ');
  return { area, rest };
}

const api = { extractSearchArea, AREA_FORMS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.MapfixSearchArea = api;
}
