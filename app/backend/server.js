const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Словарь сервисов (как в оригинальном коде)
const SERVICE_LOOKUP = {
  21: "детский сад", 22: "школа", 23: "дом детского творчества", 25: "детские лагеря",
  26: "среднее специальное учебное заведение", 27: "высшее учебное заведение",
  28: "поликлиника", 29: "детская поликлиника", 30: "стоматологическая клиника",
  31: "фельдшерско-акушерский пункт", 32: "женская консультация", 33: "реабилитационный центр",
  34: "аптека", 35: "больница", 36: "роддом", 37: "детская больница", 38: "хоспис",
  39: "станция скорой медицинской помощи", 40: "травматологические пункты", 41: "морг",
  42: "диспансер", 44: "дом престарелых", 45: "центр занятости населения",
  46: "детские дома-интернаты", 47: "многофункциональные центры (мфц)", 48: "библиотека",
  49: "дворец культуры", 50: "музей", 51: "театр", 56: "кинотеатр", 57: "торговый центр",
  58: "аквапарк", 59: "стадион", 60: "ледовая арена", 61: "кафе", 62: "ресторан",
  63: "бар/паб", 64: "столовая", 65: "булочная", 67: "бассейн", 68: "спортивный зал",
  69: "каток", 73: "скалодром", 78: "полицейский участок", 79: "пожарная станция",
  81: "железнодорожный вокзал", 86: "автовокзал", 88: "выход метро", 89: "супермаркет",
  90: "продукты (магазин у дома)", 91: "рынок", 92: "хозяйственные товары",
  93: "одежда и обувь", 94: "бытовая техника", 95: "книжный магазин", 96: "детские товары",
  97: "спортивный магазин", 98: "почтовое отделение", 99: "пункт выдачи",
  100: "отделение банка", 101: "банкомат", 102: "адвокат", 103: "нотариальная контора",
  104: "парикмахер", 105: "салон красоты", 106: "общественная баня",
  107: "ветеринарная клиника", 108: "зоомагазин", 110: "гостиница", 111: "хостел",
  112: "база отдыха", 113: "памятник", 114: "церковь", 143: "санаторий", 132: "промышленная зона", 116: "котельная"
};

// Функция для нормализации сервисов
function normalizeServicesField(raw) {
  if (!raw) return [];

  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'object') {
    items = [raw];
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      items = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      if (raw.includes(':')) {
        const [service, capacity] = raw.split(':');
        if (!isNaN(service)) {
          items = [{ service: parseInt(service), capacity: parseInt(capacity) }];
        }
      } else if (!isNaN(raw)) {
        items = [parseInt(raw)];
      }
    }
  } else if (typeof raw === 'number') {
    items = [raw];
  }

  const out = [];
  for (const item of items) {
    if (typeof item === 'number') {
      out.push({
        service_id: item,
        service_name: SERVICE_LOOKUP[item] || `Неизвестный (ID ${item})`,
        capacity: null
      });
    } else if (typeof item === 'object') {
      const sid = item.service || item.service_id || item.id;
      const cap = item.capacity || item.cap;

      if (sid !== undefined) {
        out.push({
          service_id: sid,
          service_name: SERVICE_LOOKUP[sid] || `Неизвестный (ID ${sid})`,
          capacity: cap || null
        });
      }
    }
  }
  return out;
}

// Функция для форматирования сервисов в HTML
function formatServicesForHtml(services) {
  if (!services || services.length === 0) return '-';

  return services.map(s => {
    if (s.capacity !== null && s.capacity !== undefined) {
      return `${s.service_name} (вместимость ${s.capacity})`;
    }
    return s.service_name;
  }).join(', ');
}

// Генерация демо данных (как в оригинальном блокноте)
function generateDemoData() {
  const buildings = [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[37.615, 55.755], [37.616, 55.755], [37.616, 55.756], [37.615, 55.756], [37.615, 55.755]]]
      },
      properties: {
        is_living_text: 'да',
        building_levels: 5,
        population: 120,
        services: [{ service_id: 57, service_name: 'торговый центр', capacity: 200 }],
        height_m: 15,
        color: [80, 200, 120, 115],
        services_html: 'торговый центр (вместимость 200)',
        building_levels_text: '5',
        population_text: '120'
      }
    },
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[37.617, 55.7555], [37.618, 55.7555], [37.618, 55.756], [37.617, 55.756], [37.617, 55.7555]]]
      },
      properties: {
        is_living_text: 'нет',
        building_levels: 2,
        population: 0,
        services: [{ service_id: 57, service_name: 'торговый центр', capacity: 50 }],
        height_m: 6,
        color: [110, 175, 245, 115],
        services_html: 'торговый центр (вместимость 50)',
        building_levels_text: '2',
        population_text: '-'
      }
    },
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[37.613, 55.753], [37.614, 55.753], [37.614, 55.754], [37.613, 55.754], [37.613, 55.753]]]
      },
      properties: {
        is_living_text: 'да',
        building_levels: 9,
        population: 300,
        services: [{ service_id: 22, service_name: 'школа', capacity: 500 }],
        height_m: 27,
        color: [238, 208, 79, 150],
        services_html: 'школа (вместимость 500)',
        building_levels_text: '9',
        population_text: '300'
      }
    },
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[37.619, 55.757], [37.620, 55.757], [37.620, 55.758], [37.619, 55.758], [37.619, 55.757]]]
      },
      properties: {
        is_living_text: 'нет',
        building_levels: 3,
        population: 0,
        services: [{ service_id: 35, service_name: 'больница', capacity: 150 }],
        height_m: 9,
        color: [230, 107, 162, 150],
        services_html: 'больница (вместимость 150)',
        building_levels_text: '3',
        population_text: '-'
      }
    }
  ];

  return {
    type: 'FeatureCollection',
    features: buildings
  };
}

// API эндпоинты
app.get('/api/buildings', (req, res) => {
  try {
    // Возвращаем пустой массив вместо демо-данных
    res.json({
      type: 'FeatureCollection',
      features: []
    });
  } catch (error) {
    console.error('Error generating buildings data:', error);
    res.status(500).json({ error: 'Failed to generate buildings data' });
  }
});

// Эндпоинт для загрузки реальных GeoJSON файлов
app.post('/api/upload-geojson', (req, res) => {
  // В будущем можно реализовать загрузку файлов
  res.json({ message: 'Upload endpoint not implemented yet' });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// CORS для всех маршрутов
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// Раздача статических файлов ПОСЛЕ всех API роутов
const distPath = path.join(__dirname, '../map-3d-app/dist');
if (fs.existsSync(distPath)) {
  // Статические файлы с заголовками для отключения кэша для HTML и JS
  app.use(express.static(distPath, {
    setHeaders: (res, path) => {
      if (path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } else if (path.endsWith('.js') || path.endsWith('.css')) {
        // Отключаем кэш для JS и CSS файлов, чтобы изменения применялись сразу
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Last-Modified', new Date().toUTCString());
        res.setHeader('ETag', '');
      }
    }
  }));
  
  // SPA fallback - все остальные маршруты возвращают index.html
  app.use((req, res, next) => {
    // Пропускаем API маршруты
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Для всех остальных маршрутов возвращаем index.html
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log('Available endpoints:');
  console.log('  GET /api/buildings - Get buildings data');
  console.log('  GET /api/health - Health check');
});
