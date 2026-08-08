'use strict';
/**
 * Seed / merge «Їжа» category into data.json masterCatalog.
 */
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

function svc(...names) {
  return names.map((name) => ({ name }));
}

const FOOD = {
  name: '🍽️ Їжа',
  icon: '🍽️',
  subcats: {
    cakes: {
      name: 'Замовлення тортів',
      tags: ['торт', 'бенто', 'весільний торт', 'дитячий торт', 'начинка', 'кремовий торт'],
      items: svc(
        'Торт на день народження (від 1 кг)',
        'Бенто-торт',
        'Дитячий торт з фігурками',
        'Весільний / ювілейний торт',
        'Торт без цукру / ПП',
        'Торт на замовлення (індивідуальний дизайн)',
        'Капкейки до торту (набір 6 шт)',
        'Дегустація начинок'
      ),
    },
    bakery: {
      name: 'Замовлення випічки',
      tags: ['випічка', 'хліб', 'круасан', 'печиво', 'пиріжки', 'шарлотка'],
      items: svc(
        'Домашній хліб (за буханець)',
        'Пиріжки з начинкою (від 10 шт)',
        'Круасани / слойки (набір)',
        'Печиво асорті (від 0,5 кг)',
        'Шарлотка / пиріг до чаю',
        'Булочки з корицею (набір)',
        'Святкова випічка на замовлення',
        'Безглютенова випічка'
      ),
    },
    semifinished: {
      name: 'Замовлення домашніх напівфабрикатів',
      tags: ['напівфабрикати', 'пельмені', 'вареники', 'котлети', 'заморозка'],
      items: svc(
        'Пельмені домашні (1 кг)',
        'Вареники з картоплею / вишнею (1 кг)',
        'Котлети / тефтелі (1 кг)',
        'Голубці (набір)',
        'Млинці з начинкою (набір)',
        'Сирники (набір)',
        'Фарш / фаршировані перці',
        'Набір напівфабрикатів «на тиждень»'
      ),
    },
    lunch_delivery: {
      name: 'Доставка комплексних обідів',
      tags: ['обід', 'комплекс', 'ланч', 'доставка їжі', 'офіс'],
      items: svc(
        'Комплексний обід (1 порція)',
        'Обід в офіс (від 5 порцій)',
        'Щоденна підписка на обіди (5 днів)',
        'Суп + друге + салат',
        'Дієтичний / ПП обід',
        'Дитячий обід',
        'Обід для заходів (від 10 осіб)',
        'Доставка обіду додому'
      ),
    },
    marshmallow: {
      name: 'Виготовлення зефірних композицій',
      tags: ['зефір', 'зефірна композиція', 'маршмелоу', 'букет з зефіру'],
      items: svc(
        'Зефірна композиція (мала)',
        'Зефірна композиція (середня)',
        'Зефірний букет',
        'Зефір на паличці (набір)',
        'Зефірні цифри / літери',
        'Зефір у подарунковому пакуванні',
        'Зефір на замовлення (кольори / смаки)',
        'Майстер-клас із зефіру'
      ),
    },
    gift_boxes: {
      name: 'Виготовлення подарункових наборів їстівних',
      tags: ['подарунковий набір', 'бокс', 'їстівний подарунок', 'солодкий бокс'],
      items: svc(
        'Солодкий бокс (малий)',
        'Солодкий бокс (великий)',
        'Подарунковий набір до свята',
        'Корпоративний їстівний бокс',
        'Бокс «сніданок у ліжко»',
        'Бокс із медом / варенням / чаєм',
        'Індивідуальний набір за побажанням',
        'Пакування + листівка'
      ),
    },
    catering: {
      name: 'Кейтеринг і фуршети',
      tags: ['кейтеринг', 'фуршет', 'банкет', 'канапе', 'кава-брейк'],
      items: svc(
        'Фуршетна тарілка (на особу)',
        'Кава-брейк (на особу)',
        'Канапе / брускети (набір)',
        'Кейтеринг на день народження',
        'Кейтеринг для офісу / презентації',
        'Солодкий стіл (candy bar)',
        'Обслуговування заходу (від 10 осіб)',
        'Оренда посуду / сервірування'
      ),
    },
    chocolate: {
      name: 'Шоколад і цукерки ручної роботи',
      tags: ['шоколад', 'цукерки', 'трюфелі', 'шоколадні фігурки'],
      items: svc(
        'Набір цукерок ручної роботи',
        'Трюфелі асорті',
        'Шоколадні фігурки / букви',
        'Плитка шоколаду з начинкою',
        'Шоколадний фонтан (оренда + обслуговування)',
        'Подарунковий шоколадний бокс',
        'Веганський / без цукру шоколад',
        'Майстер-клас із шоколаду'
      ),
    },
    preserves: {
      name: 'Домашні заготовки та варення',
      tags: ['варення', 'соління', 'консервація', 'мед', 'соуси'],
      items: svc(
        'Варення / джем (банка)',
        'Мед з пасіки (банка)',
        'Соління / маринади (банка)',
        'Домашній соус / аджика',
        'Сухофрукти / горіхові мікси',
        'Набір заготовок у подарунок',
        'Компот / морс (літрова банка)',
        'Сезонний набір консервації'
      ),
    },
    healthy: {
      name: 'ЗОЖ / ПП кухня на замовлення',
      tags: ['пп', 'зож', 'healthy', 'без цукру', 'раціон'],
      items: svc(
        'ПП-торт / десерт',
        'Раціон на день (3 прийоми)',
        'Раціон на тиждень',
        'Смузі / детокс-напої (набір)',
        'Протеїнові снеки / батончики',
        'Безлактозні / безглютенові страви',
        'Веганське меню на замовлення',
        'Консультація по раціону + меню'
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
    return k === 'food' || n.includes('їжа') || n.includes('еда');
  });

  if (existingKey && existingKey !== 'food') {
    console.log('Found existing food-like category as', existingKey, '— merging into food key');
  }

  // Prefer stable key `food`
  if (existingKey && existingKey !== 'food') {
    delete data.masterCatalog[existingKey];
  }

  const prev = data.masterCatalog.food;
  if (prev?.subcats) {
    // Keep any admin-added subcats/services not in seed
    for (const [subKey, sub] of Object.entries(prev.subcats)) {
      if (!FOOD.subcats[subKey]) {
        FOOD.subcats[subKey] = sub;
        continue;
      }
      const byName = new Set(
        (FOOD.subcats[subKey].items || []).map((i) => String(i.name || '').toLowerCase())
      );
      for (const item of sub.items || []) {
        if (item?.name && !byName.has(String(item.name).toLowerCase())) {
          FOOD.subcats[subKey].items.push(item);
        }
      }
    }
  }

  data.masterCatalog.food = FOOD;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');

  const subs = Object.keys(FOOD.subcats).length;
  const services = Object.values(FOOD.subcats).reduce((n, s) => n + (s.items?.length || 0), 0);
  console.log(`OK: food category saved (${subs} subcats, ${services} services)`);
}

main();
