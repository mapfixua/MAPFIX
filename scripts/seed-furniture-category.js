'use strict';
/**
 * Seed / merge «Меблі» category into data.json masterCatalog.
 */
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

function svc(...names) {
  return names.map((name) => ({ name }));
}

const FURNITURE = {
  name: '🪑 Меблі',
  icon: '🪑',
  subcats: {
    custom_furniture: {
      name: 'Виготовлення меблів під замовлення',
      tags: ['меблі на замовлення', 'столяр', 'індивідуальні меблі', 'деревʼяні меблі'],
      items: svc(
        'Шафа-купе під замовлення',
        'Кухонний гарнітур під розміри',
        'Стіл / стілець на замовлення',
        'Ліжко / спальний гарнітур',
        'Стінка / стелаж під замовлення',
        'Дитячі меблі під замовлення',
        'Меблі з масиву дерева',
        'Замір + проєкт + виготовлення'
      ),
    },
    assembly: {
      name: 'Збирання меблів',
      tags: ['збирання меблів', 'збірка IKEA', 'монтаж меблів'],
      items: svc(
        'Збирання шафи / комоду',
        'Збирання кухні',
        'Збирання ліжка / дивана',
        'Збирання офісних меблів',
        'Збирання меблів IKEA / JYSK тощо',
        'Демонтаж старих меблів',
        'Перенесення + збирання в новій кімнаті',
        'Термінове збирання (день у день)'
      ),
    },
    kitchen: {
      name: 'Кухні під замовлення',
      tags: ['кухня', 'кухонний гарнітур', 'фасади', 'стільниця'],
      items: svc(
        'Проєктування кухні',
        'Кухня під ключ',
        'Заміна фасадів кухні',
        'Монтаж стільниці',
        'Вбудована техніка (встановлення)',
        'Фартух / стінова панель',
        'Ремонт кухонних меблів',
        'Замір кухні з виїздом'
      ),
    },
    wardrobes: {
      name: 'Шафи та гардеробні',
      tags: ['шафа-купе', 'гардеробна', 'вбудована шафа'],
      items: svc(
        'Шафа-купе під стелю',
        'Вбудована шафа в нішу',
        'Гардеробна кімната під ключ',
        'Розсувні системи / двері купе',
        'Наповнення шафи (полиці, штанги)',
        'Дзеркальні фасади',
        'Ремонт механізму шафи-купе',
        'Замір і 3D-ескіз'
      ),
    },
    upholstery: {
      name: 'Перетяжка та ремонт мʼяких меблів',
      tags: ['перетяжка', 'диван', 'оббивка', 'ремонт меблів'],
      items: svc(
        'Перетяжка дивана',
        'Перетяжка крісла / стільця',
        'Заміна поролону / наповнювача',
        'Ремонт механізму розкладання',
        'Заміна пружинного блоку',
        'Хімчистка мʼяких меблів',
        'Реставрація антикварних меблів',
        'Підбір тканини / шкіри'
      ),
    },
    restoration: {
      name: 'Реставрація та ремонт корпусних меблів',
      tags: ['реставрація', 'ремонт меблів', 'фарбування меблів', 'лакування'],
      items: svc(
        'Ремонт корпусних меблів',
        'Фарбування / тонування меблів',
        'Лакування / покриття маслом',
        'Заміна фурнітури (петлі, напрямні)',
        'Ремонт стільниці / фасаду',
        'Підклеювання / зміцнення каркасу',
        'Реставрація деревʼяних меблів',
        'Оновлення старих меблів «під новий інтерʼєр»'
      ),
    },
    installation: {
      name: 'Монтаж і встановлення меблів',
      tags: ['монтаж', 'кріплення до стіни', 'навісні меблі'],
      items: svc(
        'Монтаж навісних шаф',
        'Кріплення TV-тумби / полиць до стіни',
        'Встановлення дзеркал / панелей',
        'Монтаж барної стійки',
        'Анкерне кріплення важких меблів',
        'Вирівнювання меблів по рівню',
        'Підключення підсвітки меблів',
        'Монтаж після доставки магазину'
      ),
    },
    office: {
      name: 'Офісні та комерційні меблі',
      tags: ['офісні меблі', 'ресепшн', 'торгове обладнання'],
      items: svc(
        'Офісні столи / перегородки',
        'Ресепшн під замовлення',
        'Стелажі для складу / магазину',
        'Торгове обладнання / вітрини',
        'Збирання офісного комплекту',
        'Меблі для кафе / салону',
        'Проєкт розстановки офісу',
        'Корпоративне замовлення меблів'
      ),
    },
    mattress_soft: {
      name: 'Матраци та мʼякі меблі',
      tags: ['матрац', 'диван', 'крісло', 'ортопедичний'],
      items: svc(
        'Підбір ортопедичного матраца',
        'Матрац на замовлення',
        'Диван під замовлення',
        'Крісло / пуф на замовлення',
        'Заміна чохлів мʼяких меблів',
        'Доставка і підйом матраца',
        'Утилізація старого матраца / дивана',
        'Консультація з жорсткості матраца'
      ),
    },
    delivery: {
      name: 'Доставка та підйом меблів',
      tags: ['доставка меблів', 'підйом на поверх', 'вантажники'],
      items: svc(
        'Доставка меблів по місту',
        'Підйом на поверх без ліфта',
        'Занос у квартиру / офіс',
        'Пакування меблів для переїзду',
        'Вивіз старих меблів',
        'Міжміська доставка меблів',
        'Послуги вантажників (погодинно)',
        'Доставка + збирання комплектом'
      ),
    },
  },
};

function main() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!data.masterCatalog || typeof data.masterCatalog !== 'object') {
    throw new Error('masterCatalog missing');
  }

  const existingKey = Object.keys(data.masterCatalog).find((k) => {
    const n = String(data.masterCatalog[k]?.name || '').toLowerCase();
    return k === 'furniture' || n.includes('мебл');
  });

  if (existingKey && existingKey !== 'furniture') {
    console.log('Found existing furniture-like category as', existingKey, '— replacing with furniture');
    delete data.masterCatalog[existingKey];
  }

  const prev = data.masterCatalog.furniture;
  if (prev?.subcats) {
    for (const [subKey, sub] of Object.entries(prev.subcats)) {
      if (!FURNITURE.subcats[subKey]) {
        FURNITURE.subcats[subKey] = sub;
        continue;
      }
      const byName = new Set(
        (FURNITURE.subcats[subKey].items || []).map((i) => String(i.name || '').toLowerCase())
      );
      for (const item of sub.items || []) {
        if (item?.name && !byName.has(String(item.name).toLowerCase())) {
          FURNITURE.subcats[subKey].items.push(item);
        }
      }
    }
  }

  data.masterCatalog.furniture = FURNITURE;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');

  const subs = Object.keys(FURNITURE.subcats).length;
  const services = Object.values(FURNITURE.subcats).reduce((n, s) => n + (s.items?.length || 0), 0);
  console.log(`OK: furniture category saved (${subs} subcats, ${services} services)`);
}

main();
