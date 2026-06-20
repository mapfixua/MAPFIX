/**
 * Mapfix — модуль каталогу (трирівнева ієрархія).
 *
 * Структура: Категорія → Підкатегорія → Послуга (name + price)
 * Джерело правди: data.json → masterCatalog
 * Фронтенд завантажує каталог і локації через GET /api/data (без кешу).
 */
'use strict';

/**
 * @param {Record<string, object>} masterCatalog
 * @returns {{ ok: boolean, errors: string[], stats: { cats: number, subcats: number, services: number } }}
 */
function validateCatalogHierarchy(masterCatalog) {
  const errors = [];
  const stats = { cats: 0, subcats: 0, services: 0 };

  if (!masterCatalog || typeof masterCatalog !== 'object') {
    errors.push('masterCatalog відсутній або не є об\'єктом');
    return { ok: false, errors, stats };
  }

  for (const [catKey, cat] of Object.entries(masterCatalog)) {
    stats.cats++;
    if (!cat?.name) errors.push(`Категорія "${catKey}": відсутнє поле name`);
    if (!cat?.subcats || typeof cat.subcats !== 'object') {
      errors.push(`Категорія "${catKey}": відсутнє або некоректне subcats`);
      continue;
    }

    for (const [subKey, sub] of Object.entries(cat.subcats)) {
      stats.subcats++;
      if (!sub?.name) errors.push(`Підкатегорія "${catKey}.${subKey}": відсутнє поле name`);
      if (!Array.isArray(sub.items)) {
        errors.push(`Підкатегорія "${catKey}.${subKey}": items має бути масивом`);
        continue;
      }

      sub.items.forEach((item, idx) => {
        stats.services++;
        if (!item?.name) {
          errors.push(`Послуга "${catKey}.${subKey}[${idx}]": відсутнє поле name`);
        }
        if (!item?.price) {
          errors.push(`Послуга "${catKey}.${subKey}[${idx}]": відсутнє поле price`);
        }
      });
    }
  }

  return { ok: errors.length === 0, errors, stats };
}

if (typeof module !== 'undefined' && module.exports) {
  const fs = require('fs');
  const path = require('path');
  const DATA_FILE = path.join(__dirname, 'data.json');

  function loadFromDataJson() {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }

  module.exports = {
    validateCatalogHierarchy,
    loadMasterCatalog: () => loadFromDataJson().masterCatalog,
    loadFullData: loadFromDataJson,
  };
}
