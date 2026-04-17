import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { GeoJsonLayer } from '@deck.gl/layers';
import Map, { type MapRef } from 'react-map-gl/maplibre';
import { MaplibreTerradrawControl } from '@watergis/maplibre-gl-terradraw';
import * as turf from '@turf/turf';
import intersect from '@turf/intersect';

// Стабильные публичные стили карт (CARTO)
const BASEMAP = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  none: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json', // по умолчанию
} as const;

const TERRAIN_SOURCE_ID = 'terrain-source';
const HILLSHADE_SOURCE_ID = 'hillshade-source';
const TERRAIN_LAYER_ID = 'terrain-hillshade';
const TERRAIN_TILES_URL = 'https://demotiles.maplibre.org/terrain-tiles/tiles.json';
const PERSISTED_LAYOUT_KEY = 'campLayoutState';

interface Map3DProps {
  data?: {
    buildings: any[]; // ожидается массив GeoJSON Feature
  };
}

// Типы для генератора вахтового городка
interface CampBuilding {
  id: string;
  function: 'dormitory' | 'canteen' | 'medical' | 'admin' | 'utility' | 'storage' | 'bathhouse' | 'checkpoint' | 'shop' | 'sports_hall';
  moduleType: string;
  footprint: [number, number]; // [width, length] в метрах
  floors: number;
  capacity: number; // человек или посадочных мест
  fireClass: string; // класс пожарной опасности
  color: [number, number, number, number];
  position?: [number, number]; // [lon, lat]
  rotation?: number; // градусы
}

interface CampRules {
  fireBreaks: { [key: string]: { [key: string]: number } }; // расстояния между классами
  sanitaryBuffers: { [key: string]: number }; // санитарные разрывы
  minRoadWidth: number;
  minFireAccess: number;
}

// Структура площадки для генерации
interface SelectedSite {
  type: 'Feature';
  geometry: GeoJSON.Polygon;
  properties: {};
}

/** Обрезает полигоны зданий и дорог по границе выбранной площадки (не вылезают за синюю рамку). */
function clipPolygonalFeaturesToSite(features: any[], site: SelectedSite | null): any[] {
  if (!site?.geometry) return features;

  let siteFeat: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
  try {
    siteFeat = turf.feature(site.geometry) as GeoJSON.Feature<GeoJSON.Polygon>;
  } catch {
    return features;
  }

  const next: any[] = [];
  for (const f of features) {
    const g = f?.geometry;
    if (!g) continue;
    if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') {
      next.push(f);
      continue;
    }
    try {
      const feat = turf.feature(g as GeoJSON.Polygon | GeoJSON.MultiPolygon, f.properties);
      const clipped = intersect(feat as any, siteFeat as any);
      if (!clipped?.geometry) continue;
      if (turf.area(clipped) < 0.05) continue;
      next.push({ ...f, geometry: clipped.geometry });
    } catch {
      next.push(f);
    }
  }
  return next;
}

// CampInput зарезервирован для будущих расширений

// Геометрические функции для работы в метрах
const R = 6378137; // радиус Земли в метрах
const DEG = Math.PI / 180;

type LngLat = [number, number];
type Pt = [number, number]; // meters (WebMercator)

const ROAD_W = 6; // м (базовый проезд/пожарный проезд)
const DRIVEWAY_W = 3; // м (подъезды к зданиям)
const ROAD_KEEP_OUT = 6;      // м: минимальная "нестроевая" полоса вокруг оси дороги
const BUILDING_KEEP_OUT = 2;  // м: отступ от существующих зданий
const MAX_SLOPE = 0.06;       // 6% максимальный уклон

type Keepout = { ringM: Pt[]; kind: 'road' | 'building' | 'steep' };

type GeoContext = {
  keepouts: Keepout[];
  roadAxis?: { centerLL: LngLat; bearingRad: number }; // если нашли "главную" существующую дорогу
  hasTerrain: boolean;
};

function ringLngLatToM(ring: [number, number][]) {
  return ring.map(lngLatToM) as Pt[];
}

function segIntersects(a: Pt, b: Pt, c: Pt, d: Pt) {
  const cross = (p: Pt, q: Pt, r: Pt) => (q[0]-p[0])*(r[1]-p[1]) - (q[1]-p[1])*(r[0]-p[0]);
  const onSeg = (p: Pt, q: Pt, r: Pt) =>
    Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0]) &&
    Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1]);

  const o1 = cross(a, b, c);
  const o2 = cross(a, b, d);
  const o3 = cross(c, d, a);
  const o4 = cross(c, d, b);

  if ((o1 === 0 && onSeg(a, c, b)) || (o2 === 0 && onSeg(a, d, b)) ||
      (o3 === 0 && onSeg(c, a, d)) || (o4 === 0 && onSeg(c, b, d))) return true;

  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function ptToSegDist(p: Pt, a: Pt, b: Pt) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const c1 = vx*wx + vy*wy;
  if (c1 <= 0) return Math.hypot(p[0]-a[0], p[1]-a[1]);
  const c2 = vx*vx + vy*vy;
  if (c2 <= c1) return Math.hypot(p[0]-b[0], p[1]-b[1]);
  const t = c1 / c2;
  const proj: Pt = [a[0] + t*vx, a[1] + t*vy];
  return Math.hypot(p[0]-proj[0], p[1]-proj[1]);
}

function polygonsIntersect(r1: Pt[], r2: Pt[]) {
  for (let i = 0; i < r1.length - 1; i++) {
    const a = r1[i], b = r1[i+1];
    for (let j = 0; j < r2.length - 1; j++) {
      const c = r2[j], d = r2[j+1];
      if (segIntersects(a, b, c, d)) return true;
    }
  }
  return false;
}

function polygonMinDistanceMeters(r1: Pt[], r2: Pt[]) {
  if (polygonsIntersect(r1, r2)) return 0;

  let best = Infinity;
  for (let i = 0; i < r1.length - 1; i++) {
    const p = r1[i];
    for (let j = 0; j < r2.length - 1; j++) {
      best = Math.min(best, ptToSegDist(p, r2[j], r2[j+1]));
    }
  }
  for (let i = 0; i < r2.length - 1; i++) {
    const p = r2[i];
    for (let j = 0; j < r1.length - 1; j++) {
      best = Math.min(best, ptToSegDist(p, r1[j], r1[j+1]));
    }
  }
  return best;
}


// Утилиты для размещения зданий
const requiredFireBreak = (a: any, b: any) => {
  const c1 = a.fireClass || a.properties?.fireClass || 'C0';
  const c2 = b.fireClass || b.properties?.fireClass || 'C0';
  return (
    CAMP_RULES.fireBreaks?.[c1]?.[c2] ??
    CAMP_RULES.fireBreaks?.[c2]?.[c1] ??
    10
  );
};

/** Минимальное расстояние между контурами нового и существующих зданий (пожарные разрывы). */
function validateFireBreaksForPolygon(
  newRingLL: [number, number][],
  newFireClass: string,
  existingBuildings: any[],
  selectedSite: SelectedSite | null
): { ok: true } | { ok: false; message: string } {
  const newRingM = ringLngLatToM(newRingLL);
  const newStub = { fireClass: newFireClass };

  if (selectedSite) {
    try {
      const newFeat = turf.polygon([newRingLL]);
      if (!turf.booleanWithin(newFeat as any, selectedSite as any)) {
        return { ok: false, message: 'Здание должно полностью находиться внутри выбранной площадки.' };
      }
    } catch {
      return { ok: false, message: 'Не удалось проверить вхождение в площадку.' };
    }
  }

  for (const other of existingBuildings) {
    if (!other?.geometry || other.geometry.type !== 'Polygon') continue;
    const ring = other.geometry.coordinates[0] as [number, number][];
    if (ring.length < 4) continue;
    const otherRingM = ringLngLatToM(ring);
    const req = requiredFireBreak(newStub, other);
    const dist = polygonMinDistanceMeters(newRingM, otherRingM);
    if (dist < req) {
      return {
        ok: false,
        message: `В зоне пожарного разрыва (${req} м от фасада соседнего здания) размещение запрещено. Сейчас расстояние ${dist.toFixed(1)} м.`,
      };
    }
  }
  return { ok: true };
}


function roadCorridor(center: [number, number], lengthM: number, widthM: number, rotationDeg: number) {
  const ring = rectRingLngLat(center, [lengthM, widthM], rotationDeg);

  // Проверка корректности данных
  if (!ring || ring.length < 4) {
    console.warn('Invalid road ring generated:', ring);
    return null;
  }

  // Проверка что все координаты валидные
  for (const [lng, lat] of ring) {
    if (!isFinite(lng) || !isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
      console.warn('Invalid road coordinates:', lng, lat);
      return null;
    }
  }

  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { kind: 'road', width_m: widthM }
  };
}

function corridorBetweenPoints(
  start: [number, number],
  end: [number, number],
  widthM: number,
  kind: 'road' | 'driveway' | 'connector' = 'road'
) {
  const startM = lngLatToM(start);
  const endM = lngLatToM(end);
  const lengthM = Math.hypot(endM[0] - startM[0], endM[1] - startM[1]);

  if (!isFinite(lengthM) || lengthM < 1) return null;

  const center = mToLngLat([(startM[0] + endM[0]) / 2, (startM[1] + endM[1]) / 2]);
  const angleDeg = Math.atan2(endM[1] - startM[1], endM[0] - startM[0]) / DEG;
  const corridor = roadCorridor(center, lengthM, widthM, angleDeg);

  if (corridor) {
    corridor.properties.kind = kind;
    corridor.properties.width_m = widthM;
  }

  return corridor;
}

function detectLayerIds(map: any) {
  const layers = map.getStyle()?.layers ?? [];
  const roadLayerIds = layers
    .filter((l: any) => l.type === 'line' && /road|street|highway|bridge|tunnel/i.test(l.id))
    .map((l: any) => l.id);

  const buildingLayerIds = layers
    .filter((l: any) => (l.type === 'fill' || l.type === 'fill-extrusion') && /building/i.test(l.id))
    .map((l: any) => l.id);

  return { roadLayerIds, buildingLayerIds };
}

function syncTerrainLayers(map: any, enabled: boolean) {
  if (!map?.getStyle) return;

  const hasTerrainSource = Boolean(map.getSource?.(TERRAIN_SOURCE_ID));
  if (enabled && !hasTerrainSource) {
    map.addSource(TERRAIN_SOURCE_ID, {
      type: 'raster-dem',
      url: TERRAIN_TILES_URL,
      tileSize: 256,
      maxzoom: 14,
    });
  }

  const hasHillshadeSource = Boolean(map.getSource?.(HILLSHADE_SOURCE_ID));
  if (enabled && !hasHillshadeSource) {
    map.addSource(HILLSHADE_SOURCE_ID, {
      type: 'raster-dem',
      url: TERRAIN_TILES_URL,
      tileSize: 256,
      maxzoom: 14,
    });
  }

  const hasHillshadeLayer = Boolean(map.getLayer?.(TERRAIN_LAYER_ID));
  if (enabled && !hasHillshadeLayer) {
    map.addLayer({
      id: TERRAIN_LAYER_ID,
      type: 'hillshade',
      source: HILLSHADE_SOURCE_ID,
      paint: {
        'hillshade-exaggeration': 0.35,
        'hillshade-shadow-color': '#39424e',
        'hillshade-highlight-color': '#f2f0df',
        'hillshade-accent-color': '#8b937f',
      }
    });
  }

  if (enabled && map.getSource?.(TERRAIN_SOURCE_ID)) {
    map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1.2 });
    return;
  }

  map.setTerrain(null);
  if (map.getLayer?.(TERRAIN_LAYER_ID)) {
    map.removeLayer(TERRAIN_LAYER_ID);
  }
}

function ringToM(ringLL: [number, number][]): Pt[] {
  return ringLL.map(lngLatToM) as Pt[];
}

function lineBearingRad(line: any): number | null {
  const coords = line.geometry?.coordinates;
  if (!coords) return null;

  // LineString: [[lng,lat],...]
  const pts: [number, number][] =
    line.geometry.type === 'LineString'
      ? coords
      : line.geometry.type === 'MultiLineString'
        ? coords.flat()
        : [];

  if (pts.length < 2) return null;

  const a = lngLatToM(pts[0]);
  const b = lngLatToM(pts[pts.length - 1]);
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

function lineCenterLL(line: any): [number, number] | null {
  try {
    const c = turf.center(line).geometry.coordinates as [number, number];
    return c;
  } catch {
    return null;
  }
}

function slopeOK(map: any, ll: [number, number]): boolean {
  if (!map?.queryTerrainElevation) return true;
  const e0 = map.queryTerrainElevation(ll, { exaggerated: false });
  if (e0 == null) return true;

  // шаг 10м в Mercator
  const m0 = lngLatToM(ll);
  const step = 10;

  const eE = map.queryTerrainElevation(mToLngLat([m0[0] + step, m0[1]]), { exaggerated: false });
  const eN = map.queryTerrainElevation(mToLngLat([m0[0], m0[1] + step]), { exaggerated: false });

  if (eE == null || eN == null) return true;

  const sx = Math.abs(eE - e0) / step;
  const sy = Math.abs(eN - e0) / step;
  return Math.max(sx, sy) <= MAX_SLOPE;
}

function buildGeoContext(map: any, selectedSite: any): GeoContext {
  const { roadLayerIds, buildingLayerIds } = detectLayerIds(map);

  // bbox площадки -> pixel bbox
  const [minLng, minLat, maxLng, maxLat] = turf.bbox(selectedSite);
  const p1 = map.project([minLng, minLat]);
  const p2 = map.project([maxLng, maxLat]);

  const rendered = map.queryRenderedFeatures([p1, p2], {
    layers: [...roadLayerIds, ...buildingLayerIds],
  });

  // фильтр по пересечению с площадкой
  const inSite = rendered.filter((f: any) => {
    try {
      return turf.booleanIntersects(selectedSite as any, f as any);
    } catch {
      return false;
    }
  });

  const keepouts: Keepout[] = [];

  // 1) дороги -> буфер в метрах (keepout)
  const roadLines = inSite.filter((f: any) => roadLayerIds.includes(f.layer?.id));
  let bestRoad: { len: number; feat: any } | null = null;

  for (const rf of roadLines) {
    // keepout-полоса вокруг линии
    if (rf.geometry?.type === 'LineString' || rf.geometry?.type === 'MultiLineString') {
      const buf = turf.buffer(rf as any, ROAD_KEEP_OUT / 2, { units: 'meters' }) as any;
      const ring = buf?.geometry?.coordinates?.[0] as [number, number][] | undefined;
      if (ring?.length) keepouts.push({ ringM: ringToM(ring), kind: 'road' });

      // выбираем "главную" дорогу по длине
      const len = turf.length(rf as any, { units: 'kilometers' });
      if (!bestRoad || len > bestRoad.len) bestRoad = { len, feat: rf };
    }
  }

  // 2) существующие здания -> буфер (keepout)
  const bldPolys = inSite.filter((f: any) => buildingLayerIds.includes(f.layer?.id));
  for (const bf of bldPolys) {
    if (bf.geometry?.type === 'Polygon' || bf.geometry?.type === 'MultiPolygon') {
      const buf = turf.buffer(bf as any, BUILDING_KEEP_OUT, { units: 'meters' }) as any;
      const ring = buf?.geometry?.coordinates?.[0] as [number, number][] | undefined;
      if (ring?.length) keepouts.push({ ringM: ringToM(ring), kind: 'building' });
    }
  }

  // 3) terrain support
  const hasTerrain = typeof map.queryTerrainElevation === 'function' && !!map.getTerrain?.();

  // 4) ось планировки: если есть "главная" дорога внутри площадки — используем её
  let roadAxis: GeoContext['roadAxis'] | undefined;
  if (bestRoad) {
    const bearingRad = lineBearingRad(bestRoad.feat);
    const centerLL = lineCenterLL(bestRoad.feat);
    if (bearingRad != null && centerLL) roadAxis = { bearingRad, centerLL };
  }

  return { keepouts, roadAxis, hasTerrain };
}

function siteMainBearingDeg(selectedSite: any) {
  const ring = selectedSite.geometry.coordinates[0] as [number, number][];
  let bestLen = -1;
  let bestA: Pt | null = null;
  let bestB: Pt | null = null;

  for (let i = 0; i < ring.length - 1; i++) {
    const aM = lngLatToM(ring[i]);
    const bM = lngLatToM(ring[i+1]);
    const len = Math.hypot(bM[0]-aM[0], bM[1]-aM[1]);
    if (len > bestLen) {
      bestLen = len; bestA = aM; bestB = bM;
    }
  }
  if (!bestA || !bestB) return 0;
  return (Math.atan2(bestB[1]-bestA[1], bestB[0]-bestA[0]) / DEG);
}

function generateCampMasterplan(plan: any[], selectedSite: any, _campHeadcount: number, geoContext: GeoContext | null, map: any) {
  const siteCenter = turf.center(selectedSite).geometry.coordinates as [number, number];
  const bearing = geoContext?.roadAxis?.bearingRad ?? siteMainBearingDeg(selectedSite);

  // 1) формируем набор зданий
  const dorms = plan.filter(p => p.function === 'dormitory');
  const core = plan.filter(p => ['canteen','medical','admin','bathhouse','shop', 'sports_hall'].includes(p.function));
  const tail = plan.filter(p => ['storage','utility','checkpoint'].includes(p.function));

  // 2) каркас дорожной сети: магистраль + соединители зон
  const mainRoad = roadCorridor(siteCenter, 300, 8, bearing); // 300м длина, 8м ширина
  const roads: any[] = mainRoad ? [mainRoad] : [];

  // 3) размещаем блоки БЕЗ fallback
  const placed: any[] = [];
  const unplaced: any[] = [];

  const placeList = (
    list: any[],
    start: [number, number],
    _stepX: number,
    _stepY: number,
    cols: number,
    networkAnchor: [number, number],
    addDriveways: boolean = false
  ) => {
    const zonePlaced: any[] = [];

    for (const b of list) {
      // поиск подходящей позиции
      let placedPos: [number, number] | null = null;
      const tries = 500; // больше попыток
      const base = start;
      const dxM = b.footprint[0] + requiredFireBreak(b, b) + (addDriveways ? 6 : 0); // +6м для подъездов
      const dyM = b.footprint[1] + requiredFireBreak(b, b) + ROAD_W;

      for (let t = 0; t < tries; t++) {
        const rr = Math.floor(t / cols);
        const cc = t % cols;

        const baseM = lngLatToM(base);
        const candM: Pt = [baseM[0] + cc * dxM, baseM[1] - rr * dyM];
        const candLL = mToLngLat(candM);

        if (canPlaceAt(candLL, b, placed, selectedSite, roads, geoContext, map)) {
          placedPos = candLL;
          break;
        }
      }

      if (placedPos) {
        const nextBuilding = { ...b, position: placedPos };
        placed.push(nextBuilding);
        zonePlaced.push(nextBuilding);
      } else {
        unplaced.push(b); // НЕ размещаем в центр!
      }
    }

    const zoneConnector = corridorBetweenPoints(networkAnchor, siteCenter, ROAD_W, 'connector');
    if (zoneConnector) {
      roads.push(zoneConnector);
    }

    // Добавляем подъезды от каждого здания к общей оси зоны, чтобы сеть была связной
    if (addDriveways && roads.length > 0) {
      for (const building of zonePlaced) {
        if (!building.position) continue;

        const driveway = corridorBetweenPoints(building.position, networkAnchor, DRIVEWAY_W, 'driveway');
        if (driveway) {
          roads.push(driveway);
        }
      }
    }
  };

  // 4) Стартовые точки зон
  const centerM = lngLatToM(siteCenter);
  const resStart = mToLngLat([centerM[0] - 120, centerM[1] - 30]);   // жилые слева
  const admStart = mToLngLat([centerM[0] + 80, centerM[1] + 60]);    // админ справа
  const utilStart = mToLngLat([centerM[0] + 140, centerM[1] - 100]); // утилиты сзади

  // Жилые: компактно (3 колонки) + подъезды к каждому зданию
  placeList(dorms, resStart, 1, 1, 3, resStart, true);

  // Админ/общественные "сбоку" (1–2 колонки) + подъезды к каждому зданию
  placeList(core, admStart, 1, 1, 2, admStart, true);

  // Склад/утилиты ещё дальше + подъезды к каждому зданию
  placeList(tail, utilStart, 1, 1, 2, utilStart, true);

  console.log(`Placed=${placed.length}, Unplaced=${unplaced.length}`);

  return { placed, roads, unplaced };
}

// Геометрический предикат "можно поставить сюда"
function intersectsKeepouts(newRingM: Pt[], ctx: GeoContext | null) {
  if (!ctx) return false;
  for (const ko of ctx.keepouts) {
    if (polygonsIntersect(newRingM, ko.ringM)) return true;
  }
  return false;
}

function canPlaceAt(
  pos: [number, number],
  building: any,
  placed: any[],
  selectedSite: any,
  roadFeatures: any[],
  geoContext: GeoContext | null,
  map: any
) {
  const newRingLL = rectRingLngLat(pos, building.footprint, building.rotation ?? 0);
  const newRingM = ringLngLatToM(newRingLL);

  // A) уклон
  if (geoContext?.hasTerrain && !slopeOK(map, pos)) return false;

  // B) внутри площадки
  const newFeatLL = turf.polygon([newRingLL]);
  if (!turf.booleanWithin(newFeatLL as any, selectedSite as any)) return false;

  // C) запретные зоны из карты (дороги/существующие здания)
  if (intersectsKeepouts(newRingM, geoContext)) return false;

  // D) ваши внутренние дороги (keepout)
  for (const rf of roadFeatures) {
    const rrLL = rf.geometry.coordinates[0] as [number, number][];
    const rrM = ringLngLatToM(rrLL);
    if (polygonsIntersect(newRingM, rrM)) return false;
  }

  // E) противопожарные разрывы (контур-контур)
  for (const pb of placed) {
    const req = requiredFireBreak(building, pb);
    const pbRingLL = rectRingLngLat(pb.position, pb.footprint, pb.rotation ?? 0);
    const pbRingM = ringLngLatToM(pbRingLL);
    const dist = polygonMinDistanceMeters(newRingM, pbRingM);
    if (dist < req) return false;
  }

  return true;
}

function lngLatToM([lng, lat]: [number, number]): [number, number] {
  const x = R * lng * DEG;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
  return [x, y];
}

function mToLngLat([x, y]: [number, number]): [number, number] {
  const lng = (x / R) / DEG;
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / DEG;
  return [lng, lat];
}

// Создание прямоугольника в lng/lat по центру, размерам и повороту
function rectRingLngLat(
  center: [number, number],
  footprint: [number, number],     // [длина, ширина] в метрах
  rotationDeg: number = 0
): [number, number][] {
  const [cx, cy] = lngLatToM(center);
  const [L, W] = footprint; // L - длина, W - ширина
  const hx = L / 2, hy = W / 2;
  const t = rotationDeg * DEG;
  const c = Math.cos(t), s = Math.sin(t);

  // Создаем точки прямоугольника в метрах
  const ptsM: [number, number][] = [
    [-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy], [-hx, -hy],
  ].map(([dx, dy]) => [cx + dx * c - dy * s, cy + dx * s + dy * c]);

  // Конвертируем обратно в lng/lat
  return ptsM.map(mToLngLat);
}

// Генерация кандидатных точек внутри полигона площадки
function buildCandidates(site: SelectedSite, stepM: number = 12): [number, number][] {
  const bbox = turf.bbox(site);
  const center = turf.center(site).geometry.coordinates as [number, number];
  const lat0 = center[1] * DEG;

  // Коэффициенты конверсии метров в градусы
  const mToLat = (m: number) => m / 111320;
  const mToLng = (m: number) => m / (111320 * Math.cos(lat0));

  const stepLat = mToLat(stepM);
  const stepLng = mToLng(stepM);

  const candidates: [number, number][] = [];

  // Генерируем сетку внутри bbox
  for (let lat = bbox[1]; lat <= bbox[3]; lat += stepLat) {
    for (let lng = bbox[0]; lng <= bbox[2]; lng += stepLng) {
      const point = turf.point([lng, lat]);
      // Проверяем, что точка внутри полигона площадки
      if (turf.booleanPointInPolygon(point, site)) {
        candidates.push([lng, lat]);
      }
    }
  }

  return candidates;
}

// Скоринг размещения (чем выше - тем лучше)



// Нормализуем Feature: добавляем стабильный идентификатор, если его нет
function normalizeBuildings(input: any[]): any[] {
  return (input || []).map((f, idx) => {
    const props = f?.properties ?? {};
    const existingId = props.__id ?? props.id ?? f.id;
    return {
      ...f,
      properties: {
        ...props,
        __id: existingId ?? `bld-${idx}`,
      },
    };
  });
}

function getBuildingSanitaryBufferMeters(feature: any): number {
  const fn = feature?.properties?.function ?? feature?.properties?.building_type;

  if (fn === 'medical') return CAMP_RULES.sanitaryBuffers.medical ?? 0;
  if (fn === 'utility' || fn === 'technical') return CAMP_RULES.sanitaryBuffers.diesel ?? 0;
  if (fn === 'storage') return CAMP_RULES.sanitaryBuffers.waste ?? 0;

  return 0;
}

function getBuildingKeepoutWidthMeters(feature: any): number {
  const fireClass = feature?.properties?.fireClass ?? 'C0';
  const fireBreakVariants = Object.values(CAMP_RULES.fireBreaks?.[fireClass] ?? {});
  const maxFireBreak = fireBreakVariants.length ? Math.max(...fireBreakVariants) : 0;
  const sanitaryBuffer = getBuildingSanitaryBufferMeters(feature);

  return Math.max(maxFireBreak, sanitaryBuffer);
}

function getFeatureColor(feature: any): [number, number, number, number] {
  const color = feature?.properties?.color;
  if (Array.isArray(color) && color.length >= 3) {
    return [color[0], color[1], color[2], color[3] ?? 255];
  }

  return [180, 180, 180, 255];
}

// DEMO_BOUNDARIES убран - boundary-mask слой удален

// Демо здания с 3D параметрами как в блокноте
// Точный ViewState как в блокноте
// Стили карт заменены на BASEMAP константу выше

// Правила размещения по ГОСТ Р 58760 и СП 4.13130
const CAMP_RULES: CampRules = {
  // Противопожарные разрывы (метры) по СП 4.13130
  fireBreaks: {
    'C0': { 'C0': 6, 'C1': 8, 'C2': 10, 'C3': 12 }, // Жилые здания
    'C1': { 'C0': 8, 'C1': 8, 'C2': 10, 'C3': 12 }, // Общественные
    'C2': { 'C0': 10, 'C1': 10, 'C2': 10, 'C3': 15 }, // Производственные
    'C3': { 'C0': 12, 'C1': 12, 'C2': 15, 'C3': 15 }  // Склады ГСМ
  },
  // Санитарные разрывы (метры)
  sanitaryBuffers: {
    'waste': 50,      // Контейнерная площадка ТКО
    'diesel': 100,    // ДЭС/ГСМ
    'sewage': 50,     // Очистные сооружения
    'medical': 20     // Медпункт
  },
  minRoadWidth: 6,    // Минимальная ширина проезда (м)
  minFireAccess: 4    // Минимальный подъезд пожарной техники (м)
};

// Типовые модули по ГОСТ Р 58760 (мобильные здания)
const MODULE_CATALOG: CampBuilding[] = [
  {
    id: 'dorm-20',
    function: 'dormitory',
    moduleType: 'Жилой модуль 20 мест',
    footprint: [12, 6], // 12x6 метров
    floors: 2,
    capacity: 20,
    fireClass: 'C0',
    color: [80, 200, 120, 255]
  },
  {
    id: 'dorm-12',
    function: 'dormitory',
    moduleType: 'Жилой модуль 12 мест',
    footprint: [9, 6],
    floors: 1,
    capacity: 12,
    fireClass: 'C0',
    color: [100, 180, 140, 255]
  },
  {
    id: 'canteen-50',
    function: 'canteen',
    moduleType: 'Столовая 50 посадочных мест',
    footprint: [15, 8],
    floors: 1,
    capacity: 50,
    fireClass: 'C1',
    color: [255, 180, 100, 255]
  },
  {
    id: 'medical',
    function: 'medical',
    moduleType: 'Медпункт',
    footprint: [8, 6],
    floors: 1,
    capacity: 10,
    fireClass: 'C1',
    color: [255, 100, 100, 255]
  },
  {
    id: 'admin',
    function: 'admin',
    moduleType: 'Администрация/диспетчерская',
    footprint: [10, 6],
    floors: 1,
    capacity: 5,
    fireClass: 'C1',
    color: [150, 150, 255, 255]
  },
  {
    id: 'diesel-100kw',
    function: 'utility',
    moduleType: 'ДЭС 100 кВт',
    footprint: [6, 4],
    floors: 1,
    capacity: 0,
    fireClass: 'C2',
    color: [100, 100, 100, 255]
  },
  {
    id: 'storage',
    function: 'storage',
    moduleType: 'Склад продовольствия',
    footprint: [12, 6],
    floors: 1,
    capacity: 0,
    fireClass: 'C1',
    color: [180, 140, 100, 255]
  },
  {
    id: 'bathhouse',
    function: 'bathhouse',
    moduleType: 'Баня',
    footprint: [10, 8],
    floors: 1,
    capacity: 20, // одновременная вместимость
    fireClass: 'C1',
    color: [100, 200, 255, 255]
  },
  {
    id: 'checkpoint',
    function: 'checkpoint',
    moduleType: 'Контрольно-пропускной пункт',
    footprint: [6, 4],
    floors: 1,
    capacity: 2, // количество постов
    fireClass: 'C1',
    color: [255, 200, 100, 255]
  },
  {
    id: 'shop',
    function: 'shop',
    moduleType: 'Магазин',
    footprint: [12, 8],
    floors: 1,
    capacity: 0,
    fireClass: 'C1',
    color: [255, 150, 200, 255]
  },
  {
    id: 'sports-hall',
    function: 'sports_hall',
    moduleType: 'Спортивный зал',
    footprint: [18, 12],
    floors: 1,
    capacity: 0,
    fireClass: 'C1',
    color: [120, 180, 255, 255]
  }
];

function getModulesByFunction(fn: CampBuilding['function']) {
  return MODULE_CATALOG
    .filter(module => module.function === fn)
    .sort((a, b) => (b.capacity || 0) - (a.capacity || 0));
}

function buildModulesForCapacity(
  fn: CampBuilding['function'],
  requiredCapacity: number,
  idPrefix: string
): CampBuilding[] {
  const variants = getModulesByFunction(fn).filter(module => module.capacity > 0);
  if (!variants.length || requiredCapacity <= 0) return [];

  const result: CampBuilding[] = [];
  let remainingCapacity = requiredCapacity;
  let guard = 0;

  while (remainingCapacity > 0 && guard < 200) {
    const variant = variants.find(module => module.capacity <= remainingCapacity) ?? variants[0];
    result.push({
      ...variant,
      id: `${idPrefix}-${result.length + 1}`,
      rotation: 0
    });
    remainingCapacity -= variant.capacity;
    guard += 1;
  }

  return result;
}

function buildRepeatedModules(
  fn: CampBuilding['function'],
  count: number,
  idPrefix: string
): CampBuilding[] {
  const [baseModule] = getModulesByFunction(fn);
  if (!baseModule || count <= 0) return [];

  return Array.from({ length: count }, (_, index) => ({
    ...baseModule,
    id: `${idPrefix}-${index + 1}`,
    rotation: 0
  }));
}

const INITIAL_VIEW_STATE = {
  longitude: 37.615,
  latitude: 55.755,
  zoom: 16,
  pitch: 45,  // Наклон камеры 45 градусов как в блокноте
  bearing: 0,
  padding: { top: 0, bottom: 0, left: 0, right: 0 },
} as any;

const Map3D: React.FC<Map3DProps> = ({ data }) => {
  const [editMode, setEditMode] = useState<boolean>(false);
  const [webGLError, setWebGLError] = useState<string | null>(null);

  // Состояние генератора вахтового городка
  const [campHeadcount, setCampHeadcount] = useState<number>(50);
  const [functionalComposition, setFunctionalComposition] = useState<'basic' | 'extended' | 'modified'>('basic'); // Функциональный состав: основной, расширенный, модифицированный
  const [adminBuildingsCount, setAdminBuildingsCount] = useState<number>(1); // Количество административных зданий (для модифицированной конфигурации)
  const [generatedBuildings, setGeneratedBuildings] = useState<any[]>([]);
  const [violations, setViolations] = useState<any[]>([]);
  const [showViolations, setShowViolations] = useState<boolean>(false);

  // Состояние для рисования площадки
  const mapRef = React.useRef<MapRef | null>(null);
  const drawCtrlRef = React.useRef<any>(null);
  const terraRef = React.useRef<any>(null);
  const startedRef = React.useRef(false);
  const [selectedSite, setSelectedSite] = useState<SelectedSite | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [viewState, setViewState] = useState<any>(INITIAL_VIEW_STATE);
  const [roadsData, setRoadsData] = useState<any[]>([]);
  const [geoContext, setGeoContext] = useState<GeoContext | null>(null);
  const [unplacedBuildings, setUnplacedBuildings] = useState<any[]>([]);

  // Состояние для пользовательских зданий и дорог
  const [userBuildings, setUserBuildings] = useState<any[]>([]);
  const [userRoads, setUserRoads] = useState<any[]>([]);
  const [drawingMode, setDrawingMode] = useState<'building' | 'road' | null>(null);
  const [showBuildingTypeSelector, setShowBuildingTypeSelector] = useState<boolean>(false);
  const [selectedBuildingType, setSelectedBuildingType] = useState<'residential' | 'administrative' | 'technical' | 'bathhouse' | 'checkpoint' | 'medical' | 'shop' | 'sportsHall' | null>(null);
  const [placingBuilding, setPlacingBuilding] = useState<boolean>(false);
  const [showDrawingSection, setShowDrawingSection] = useState<boolean>(true); // Выпадающий список для рисования объектов
  const [showCampGeneratorSection, setShowCampGeneratorSection] = useState<boolean>(true); // Выпадающий список для генератора вахтового городка
  const [showSiteSection, setShowSiteSection] = useState<boolean>(true); // Выпадающий список для площадки строительства
  const [siteWidth, setSiteWidth] = useState<number>(200); // Ширина площадки в метрах
  const [siteLength, setSiteLength] = useState<number>(200); // Длина площадки в метрах
  const [waitingForSiteClick, setWaitingForSiteClick] = useState<boolean>(false); // Режим ожидания клика для создания площадки
  const [showTerrainRelief, setShowTerrainRelief] = useState<boolean>(true);
  const [layoutSavedAt, setLayoutSavedAt] = useState<string | null>(null);
  const [hasLoadedSavedLayout, setHasLoadedSavedLayout] = useState<boolean>(false);

  // Единый переключатель интерактивности: либо карта, либо DeckGL
  const deckInteractive = editMode && !drawMode && !placingBuilding && !waitingForSiteClick; // только когда двигаем здания и не размещаем новое

  // ViewState обновляем только из Map (единственный источник истины)
  const handleMove = useCallback((e: any) => {
    const v = e.viewState;
    setViewState(prev =>
      prev.longitude === v.longitude &&
      prev.latitude === v.latitude &&
      prev.zoom === v.zoom &&
      prev.bearing === v.bearing &&
      prev.pitch === v.pitch
        ? prev
        : v
    );
  }, []);

  // Загрузка пользовательских объектов из localStorage
  useEffect(() => {
    try {
      const savedBuildings = localStorage.getItem('userBuildings');
      const savedRoads = localStorage.getItem('userRoads');
      const savedLayout = localStorage.getItem(PERSISTED_LAYOUT_KEY);
      
      // Фильтруем старые демо-здания (с ID начинающимися с 'demo-')
      if (savedBuildings) {
        const buildings = JSON.parse(savedBuildings);
        const filteredBuildings = buildings.filter((b: any) => 
          !b.properties?.__id?.startsWith('demo-')
        );
        if (filteredBuildings.length !== buildings.length) {
          // Если были удалены демо-здания, сохраняем отфильтрованный список
          localStorage.setItem('userBuildings', JSON.stringify(filteredBuildings));
        }
        setUserBuildings(filteredBuildings);
      }
      
      if (savedRoads) {
        setUserRoads(JSON.parse(savedRoads));
      }

      if (savedLayout) {
        const layout = JSON.parse(savedLayout);
        setSelectedSite(layout.selectedSite ?? null);
        setGeneratedBuildings(layout.generatedBuildings ?? []);
        setRoadsData(layout.generatedRoads ?? []);
        setUnplacedBuildings(layout.unplacedBuildings ?? []);
        setViolations(layout.violations ?? []);
        setLayoutSavedAt(layout.savedAt ?? null);
      }
    } catch (error) {
      console.error('Ошибка загрузки из localStorage:', error);
    } finally {
      setHasLoadedSavedLayout(true);
    }
  }, []);

  // Сохранение пользовательских объектов в localStorage
  useEffect(() => {
    try {
      localStorage.setItem('userBuildings', JSON.stringify(userBuildings));
    } catch (error) {
      console.error('Ошибка сохранения зданий:', error);
    }
  }, [userBuildings]);

  useEffect(() => {
    try {
      localStorage.setItem('userRoads', JSON.stringify(userRoads));
    } catch (error) {
      console.error('Ошибка сохранения дорог:', error);
    }
  }, [userRoads]);

  const saveLayoutSnapshot = useCallback(() => {
    try {
      const savedAt = new Date().toISOString();
      localStorage.setItem(PERSISTED_LAYOUT_KEY, JSON.stringify({
        selectedSite,
        generatedBuildings,
        generatedRoads: roadsData,
        unplacedBuildings,
        violations,
        savedAt,
      }));
      setLayoutSavedAt(savedAt);
    } catch (error) {
      console.error('Ошибка сохранения варианта:', error);
    }
  }, [selectedSite, generatedBuildings, roadsData, unplacedBuildings, violations]);

  useEffect(() => {
    if (!hasLoadedSavedLayout) return;
    saveLayoutSnapshot();
  }, [hasLoadedSavedLayout, saveLayoutSnapshot]);

  // Добавление TerraDraw контрола напрямую в карту
  const onMapLoad = React.useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    // Защита от двойного маунта в StrictMode
    if (drawCtrlRef.current) return;

    const ctrl = new MaplibreTerradrawControl({
      modes: ['polygon', 'select', 'delete-selection', 'delete'],
      open: true
    });

    map.addControl(ctrl, 'top-left');

    drawCtrlRef.current = ctrl;
    terraRef.current = ctrl.getTerraDrawInstance?.();
    syncTerrainLayers(map, showTerrainRelief);

  }, [showTerrainRelief]);

  // Очистка при размонтировании
  React.useEffect(() => {
    return () => {
      const map = mapRef.current?.getMap();
      if (map && drawCtrlRef.current) {
        map.removeControl(drawCtrlRef.current);
      }
      drawCtrlRef.current = null;
      terraRef.current = null;
      startedRef.current = false;
    };
  }, []);


  // Старт рисования площадки
  // Выход из режима рисования
  const stopDrawSite = useCallback(() => {
    const ctrl = drawCtrlRef.current;
    const td = terraRef.current;

    if (ctrl && typeof ctrl.setMode === 'function') {
      ctrl.setMode('select'); // Переключаем в режим выбора (без рисования)
    }
    if (td && typeof td.setMode === 'function') {
      td.setMode('select'); // Переключаем в режим выбора
    }

    setDrawMode(false);
  }, []);

  const startDrawSite = useCallback(() => {
    // Отменяем другие режимы
    setWaitingForSiteClick(false);
    
    const ctrl = drawCtrlRef.current;
    const td = terraRef.current;

    if (!ctrl || !td) return;

    // ВАЖНО: при включении режима рисования отключаем режим редактирования
    if (editMode) {
      setEditMode(false);
      setSelectedBuildingId(null); // Сбрасываем выделение здания
      setIsDragging(false);
    }

    // Гарантированный старт один раз
    if (!startedRef.current && typeof td.start === 'function') {
      td.start();
      startedRef.current = true;
    }

    // Держим панель инструмента открытой
    ctrl.open?.();

    // ВАЖНО: режим ставим через control (синхронизация кнопок), и дублируем в td
    ctrl.setMode?.('polygon');
    td.setMode?.('polygon');

    setDrawMode(true);
  }, [editMode]);

  // Конфигурация типов зданий
  const buildingTypes = {
    residential: {
      name: 'Жилое здание',
      icon: '🏠',
      size: 0.0001, // размер в градусах (примерно 10x10 метров)
      height: 6, // высота в метрах (2 этажа * 3м)
      color: [100, 150, 200, 200],
      floors: 2, // максимум 2 этажа
      population: 200, // максимум 200 человек (модульное здание)
      maxPopulation: 200,
      fireClass: 'C0' as const,
    },
    administrative: {
      name: 'Административное',
      icon: '🏢',
      size: 0.00008,
      height: 3, // высота в метрах (1 этаж * 3м)
      color: [200, 200, 100, 200],
      floors: 1, // 1 этаж
      population: 0,
      fireClass: 'C1' as const,
    },
    technical: {
      name: 'Техническое',
      icon: '🏭',
      size: 0.00012,
      height: 3, // высота в метрах (1 этаж * 3м)
      color: [150, 150, 150, 200],
      floors: 1, // 1 этаж
      population: 0,
      fireClass: 'C2' as const,
    },
    bathhouse: {
      name: 'Баня',
      icon: '🛁',
      size: 0.0001,
      height: 3, // высота в метрах (1 этаж * 3м)
      color: [100, 200, 255, 200],
      floors: 1, // 1 этаж
      population: 0,
      fireClass: 'C0' as const,
    },
    checkpoint: {
      name: 'КПП',
      icon: '🚧',
      size: 0.00006,
      height: 3, // высота в метрах (1 этаж * 3м)
      color: [255, 200, 100, 200],
      floors: 1, // 1 этаж
      population: 0,
      fireClass: 'C1' as const,
    },
    medical: {
      name: 'Медицинский пункт',
      icon: '🏥',
      size: 0.00008,
      height: 3, // высота в метрах (1 этаж * 3м)
      color: [255, 100, 100, 200],
      floors: 1, // 1 этаж
      population: 0,
      fireClass: 'C1' as const,
    },
    shop: {
      name: 'Магазин',
      icon: '🏪',
      size: 0.0001,
      height: 3, // высота в метрах (1 этаж * 3м)
      color: [255, 150, 200, 200],
      floors: 1, // 1 этаж
      population: 0,
      fireClass: 'C1' as const,
    },
    sportsHall: {
      name: 'Спортивный зал',
      icon: '🏟️',
      size: 0.00014,
      height: 6,
      color: [120, 180, 255, 200],
      floors: 1,
      population: 0,
      fireClass: 'C1' as const,
    }
  };

  // Функции для управления рисованием зданий и дорог
  const startDrawingBuilding = useCallback(() => {
    // Отменяем другие режимы
    setWaitingForSiteClick(false);
    // Показываем селектор типов зданий
    setShowBuildingTypeSelector(true);
  }, []);

  const selectBuildingType = useCallback((type: 'residential' | 'administrative' | 'technical' | 'bathhouse' | 'checkpoint' | 'medical' | 'shop' | 'sportsHall') => {
    setSelectedBuildingType(type);
    setShowBuildingTypeSelector(false);
    setPlacingBuilding(true);
    
    // Отключаем режим редактирования
    if (editMode) {
      setEditMode(false);
      setSelectedBuildingId(null);
      setIsDragging(false);
    }
  }, [editMode]);

  const cancelBuildingPlacement = useCallback(() => {
    setPlacingBuilding(false);
    setSelectedBuildingType(null);
    setShowBuildingTypeSelector(false);
  }, []);

  const cancelSitePlacement = useCallback(() => {
    setWaitingForSiteClick(false);
  }, []);

  const startDrawingRoad = useCallback(() => {
    // Отменяем другие режимы
    setWaitingForSiteClick(false);
    
    const ctrl = drawCtrlRef.current;
    const td = terraRef.current;
    if (!ctrl || !td) return;

    if (editMode) {
      setEditMode(false);
      setSelectedBuildingId(null);
      setIsDragging(false);
    }

    if (!startedRef.current && typeof td.start === 'function') {
      td.start();
      startedRef.current = true;
    }

    ctrl.open?.();
    // Для дорог используем polygon, так как line может быть недоступен
    ctrl.setMode?.('polygon');
    td.setMode?.('polygon');
    setDrawingMode('road');
    setDrawMode(true);
  }, [editMode]);

  const stopDrawing = useCallback(() => {
    const ctrl = drawCtrlRef.current;
    const td = terraRef.current;
    if (ctrl && typeof ctrl.setMode === 'function') {
      ctrl.setMode('select');
    }
    if (td && typeof td.setMode === 'function') {
      td.setMode('select');
    }
    setDrawingMode(null);
    setDrawMode(false);
  }, []);


  const clearAllUserObjects = useCallback(() => {
    if (window.confirm('Удалить все добавленные здания и дороги?')) {
      setUserBuildings([]);
      setUserRoads([]);
    }
  }, []);

  function buildExportFeatureCollection() {
    const features: any[] = [];

    if (selectedSite) {
      features.push({
        type: 'Feature',
        geometry: selectedSite.geometry,
        properties: {
          object_type: 'site'
        }
      });
    }

    features.push(
      ...allBuildingsData.map(b => ({
        ...b,
        properties: {
          ...b.properties,
          object_type: 'building'
        }
      }))
    );

    features.push(
      ...allRoadsData.map(r => ({
        ...r,
        properties: {
          ...r.properties,
          object_type: 'road'
        }
      }))
    );

    return {
      type: 'FeatureCollection',
      features
    };
  }

  // Экспорт зданий и дорог в GeoJSON
  function exportData() {
    const dataStr = JSON.stringify(buildExportFeatureCollection(), null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `map-data-${new Date().toISOString().split('T')[0]}.geojson`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // Импорт зданий и дорог из GeoJSON файла
  function importData(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const data = JSON.parse(text);

        if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
          const importedBuildings: any[] = [];
          const importedRoads: any[] = [];
          let importedSite: SelectedSite | null = null;

          data.features.forEach((feature: any) => {
            if (feature.type === 'Feature' && feature.geometry) {
              const objType = feature.properties?.object_type || 
                             (feature.properties?.building_type ? 'building' : feature.geometry.type === 'LineString' ? 'road' : 'building');

              if (objType === 'site' && feature.geometry.type === 'Polygon') {
                importedSite = {
                  type: 'Feature',
                  geometry: feature.geometry,
                  properties: {}
                };
              } else if (objType === 'road' || feature.geometry.type === 'LineString') {
                // Это дорога
                let roadGeometry = feature.geometry;
                if (roadGeometry.type === 'LineString') {
                  const coords = roadGeometry.coordinates as [number, number][];
                  const line = turf.lineString(coords);
                  const buffered = turf.buffer(line, 0.00005, { units: 'kilometers' });
                  roadGeometry = buffered.geometry;
                }
                const road = {
                  type: 'Feature',
                  geometry: roadGeometry,
                  properties: {
                    __id: feature.properties?.__id || `imported-road-${Date.now()}-${Math.random()}`,
                    width: feature.properties?.width || 6
                  }
                };
                importedRoads.push(road);
              } else if (objType === 'building' || feature.geometry.type === 'Polygon') {
                // Это здание
                const building = {
                  type: 'Feature',
                  geometry: feature.geometry,
                  properties: {
                    __id: feature.properties?.__id || `imported-building-${Date.now()}-${Math.random()}`,
                    height_m: feature.properties?.height_m || feature.properties?.height || 6,
                    building_levels: feature.properties?.building_levels || feature.properties?.floors || 2,
                    color: feature.properties?.color || [100, 150, 200, 200],
                    is_living_text: feature.properties?.is_living_text || 'да',
                    population: feature.properties?.population || 0,
                    services: feature.properties?.services || [],
                    services_html: feature.properties?.services_html || '-',
                    building_levels_text: (feature.properties?.building_levels || feature.properties?.floors || 2).toString(),
                    population_text: feature.properties?.population > 0 ? feature.properties?.population.toString() : '-',
                    building_type: feature.properties?.building_type || 'residential',
                    building_name: feature.properties?.building_name || feature.properties?.name || 'Жилое здание'
                  }
                };
                importedBuildings.push(building);
              }
            }
          });

          if (importedSite) {
            setSelectedSite(importedSite);
          }

          if (importedBuildings.length > 0 || importedRoads.length > 0 || importedSite) {
            setUserBuildings(prev => [...prev, ...importedBuildings]);
            setUserRoads(prev => [...prev, ...importedRoads]);
            alert(`Импортировано: ${importedBuildings.length} зданий, ${importedRoads.length} дорог${importedSite ? ', площадка обновлена' : ''}`);
          } else {
            alert('В файле не найдено объектов для импорта');
          }
        } else {
          alert('Неверный формат файла. Ожидается GeoJSON FeatureCollection');
        }
      } catch (error) {
        console.error('Ошибка импорта:', error);
        alert('Ошибка при импорте файла. Проверьте формат файла.');
      }
    };

    reader.readAsText(file);
    // Сброс input для возможности повторного выбора того же файла
    event.target.value = '';
  }
  const [useSimpleMode, setUseSimpleMode] = useState<boolean>(false);

  const [buildingsData, setBuildingsData] = useState<any[]>([]);
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStartPos, setDragStartPos] = useState<{lng: number, lat: number} | null>(null);
  const [initialBuildingCoords, setInitialBuildingCoords] = useState<any[][] | null>(null);
  const [showMapLayer, setShowMapLayer] = useState<boolean>(true);
  const [mapStyle, setMapStyle] = useState<string>('light');

  // Размещение здания на карте при клике (после buildingsData — нужны проверки разрывов)
  const placeBuildingOnMap = useCallback((lng: number, lat: number) => {
    if (!placingBuilding || !selectedBuildingType) return;

    const buildingConfig = buildingTypes[selectedBuildingType];
    const size = buildingConfig.size;

    const buildingPolygon: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[
        [lng - size / 2, lat - size / 2],
        [lng + size / 2, lat - size / 2],
        [lng + size / 2, lat + size / 2],
        [lng - size / 2, lat + size / 2],
        [lng - size / 2, lat - size / 2]
      ]]
    };

    const ringLL = buildingPolygon.coordinates[0] as [number, number][];
    const fc = (buildingConfig as { fireClass?: string }).fireClass ?? 'C0';
    const existing = [...buildingsData, ...userBuildings];
    const check = validateFireBreaksForPolygon(ringLL, fc, existing, selectedSite);
    if (check.ok === false) {
      alert(check.message);
      return;
    }

    const newBuilding = {
      type: 'Feature',
      geometry: buildingPolygon,
      properties: {
        __id: `user-building-${Date.now()}`,
        height_m: buildingConfig.height,
        building_levels: buildingConfig.floors,
        color: buildingConfig.color,
        is_living_text: selectedBuildingType === 'residential' ? 'да' : 'нет',
        population: buildingConfig.population,
        services: [],
        services_html: '-',
        building_levels_text: buildingConfig.floors.toString(),
        population_text: buildingConfig.population > 0 ? buildingConfig.population.toString() : '-',
        building_type: selectedBuildingType,
        building_name: buildingConfig.name,
        fireClass: fc,
      }
    };

    setUserBuildings(prev => [...prev, newBuilding]);
    setPlacingBuilding(false);
    setSelectedBuildingType(null);
  }, [placingBuilding, selectedBuildingType, buildingsData, userBuildings, selectedSite]);

  // Обработка завершения рисования через проверку изменений (после buildingsData — проверка пожарных разрывов)
  useEffect(() => {
    if (!drawingMode || !terraRef.current) return;

    const checkForNewFeatures = () => {
      const td = terraRef.current;
      if (!td || typeof td.getSnapshot !== 'function') return;

      const features = td.getSnapshot();
      if (features && features.length > 0) {
        const lastFeature = features[features.length - 1];
        if (lastFeature && lastFeature.geometry) {
          if (drawingMode === 'building' && lastFeature.geometry.type === 'Polygon') {
            const featureId = lastFeature.id || `temp-${Date.now()}`;
            const exists = userBuildings.some(b => b.properties?.__id === featureId);
            if (!exists) {
              const ringLL = lastFeature.geometry.coordinates[0] as [number, number][];
              const existing = [...buildingsData, ...userBuildings];
              const check = validateFireBreaksForPolygon(ringLL, 'C0', existing, selectedSite);
              if (check.ok === false) {
                alert(check.message);
                if (td && typeof td.clear === 'function') td.clear();
                setDrawingMode(null);
                return;
              }
              const newBuilding = {
                type: 'Feature',
                geometry: lastFeature.geometry,
                properties: {
                  __id: `user-building-${Date.now()}`,
                  height_m: 10,
                  building_levels: 3,
                  color: [100, 150, 200, 200],
                  is_living_text: 'да',
                  population: 0,
                  services: [],
                  services_html: '-',
                  building_levels_text: '3',
                  population_text: '0',
                  fireClass: 'C0',
                }
              };
              setUserBuildings(prev => [...prev, newBuilding]);
              setTimeout(() => {
                if (td && typeof td.clear === 'function') {
                  td.clear();
                }
              }, 100);
              setDrawingMode(null);
            }
          } else if (drawingMode === 'road' && (lastFeature.geometry.type === 'LineString' || lastFeature.geometry.type === 'Polygon')) {
            const featureId = lastFeature.id || `temp-${Date.now()}`;
            const exists = userRoads.some(r => r.properties?.__id === featureId);
            if (!exists) {
              let roadGeometry = lastFeature.geometry;
              if (roadGeometry.type === 'LineString') {
                const coords = roadGeometry.coordinates as [number, number][];
                const line = turf.lineString(coords);
                const buffered = turf.buffer(line, 0.00005, { units: 'kilometers' });
                roadGeometry = buffered.geometry;
              }
              const newRoad = {
                type: 'Feature',
                geometry: roadGeometry,
                properties: {
                  __id: `user-road-${Date.now()}`,
                  width: 6
                }
              };
              setUserRoads(prev => [...prev, newRoad]);
              setTimeout(() => {
                if (td && typeof td.clear === 'function') {
                  td.clear();
                }
              }, 100);
              setDrawingMode(null);
            }
          }
        }
      }
    };

    const interval = setInterval(checkForNewFeatures, 500);
    return () => clearInterval(interval);
  }, [drawingMode, userBuildings, userRoads, buildingsData, selectedSite]);

  /** Сброс сгенерированного вахтового городка (здания и внутренние дороги генератора). */
  const clearGeneratedCamp = useCallback(() => {
    if (!window.confirm('Удалить весь сгенерированный городок (здания и дороги генератора)? Пользовательские объекты не трогаем.')) return;
    setGeneratedBuildings([]);
    setRoadsData([]);
    setViolations([]);
    setUnplacedBuildings([]);
    setSelectedBuildingId(null);
  }, []);

  /** Удалить одно здание по выделению (сгенерированное или нарисованное). */
  const deleteSelectedBuilding = useCallback(() => {
    if (!selectedBuildingId) return;
    setGeneratedBuildings((prev) =>
      prev.filter((b) => (b.properties?.__id ?? b.properties?.id) !== selectedBuildingId)
    );
    setUserBuildings((prev) => prev.filter((b) => b.properties?.__id !== selectedBuildingId));
    setSelectedBuildingId(null);
  }, [selectedBuildingId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (!editMode || !selectedBuildingId) return;
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return;
      e.preventDefault();
      deleteSelectedBuilding();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editMode, selectedBuildingId, deleteSelectedBuilding]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    const applyTerrain = () => {
      try {
        syncTerrainLayers(map, showTerrainRelief && mapStyle !== 'none');
      } catch (error) {
        console.warn('Failed to sync terrain layers:', error);
      }
    };

    if (map.isStyleLoaded?.()) {
      applyTerrain();
    }

    map.on('styledata', applyTerrain);
    return () => {
      map.off('styledata', applyTerrain);
    };
  }, [mapStyle, showTerrainRelief]);

  // Проверяем поддержку WebGL (быстрая pre-flight проверка; не гарантирует, что DeckGL не упадёт)
  const checkWebGLSupport = useCallback(() => {
    try {
      const canvas = document.createElement('canvas');
      const gl =
        canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) {
        setWebGLError('WebGL не поддерживается в этом браузере');
        return false;
      }
      return true;
    } catch {
      setWebGLError('Ошибка инициализации WebGL');
      return false;
    }
  }, []);

  // Генератор вахтового городка с размещением внутри площадки
  const generateCamp = useCallback(() => {
    if (!selectedSite) {
      setViolations([{
        type: 'NO_SITE',
        severity: 'error',
        buildings: [],
        message: 'Не выбрана площадка: нарисуйте полигон и нажмите "Применить площадку"'
      }]);
      return;
    }

    const siteArea = Math.round(turf.area(selectedSite));
    console.log(`Генерация вахтового городка для ${campHeadcount} человек на площадке ${siteArea} м²`);

    // 1. Функциональная программа
    const [dormModule] = getModulesByFunction('dormitory');
    const [canteenModule] = getModulesByFunction('canteen');
    const [medicalModule] = getModulesByFunction('medical');
    const [bathhouseModule] = getModulesByFunction('bathhouse');
    const [shopModule] = getModulesByFunction('shop');
    const utilityModules = getModulesByFunction('utility');
    const [storageModule] = getModulesByFunction('storage');

    if (!dormModule || !canteenModule) {
      console.error('Не найдены базовые модули (жилой/столовая)');
      return;
    }

    // Расчет количества модулей на основе численности населения
    // Масштабирование общественных зданий пропорционально численности
    // Столовая: 1 на 50 человек (но минимум 1)
    const canteensNeeded = Math.max(1, Math.ceil(campHeadcount / 50));
    
    // Баня: 1 на 30 человек (но минимум 1)
    const bathhousesNeeded = Math.max(1, Math.ceil(campHeadcount / 30));
    
    // Медицинский пункт: 1 на 100 человек (но минимум 1)
    const medicalPointsNeeded = Math.max(1, Math.ceil(campHeadcount / 100));
    
    // КПП: 1 на 200 человек (но минимум 1, максимум 2)
    const checkpointsNeeded = Math.min(2, Math.max(1, Math.ceil(campHeadcount / 200)));
    
    // Административное: зависит от функционального состава
    // Для модифицированной конфигурации используем заданное количество, иначе автоматический расчет
    const adminBuildingsNeeded = functionalComposition === 'modified' 
      ? adminBuildingsCount 
      : Math.max(1, Math.ceil(campHeadcount / 200));

    // 2. Генерация кандидатных позиций внутри площадки
    const candidates = buildCandidates(selectedSite, 15); // шаг 15м для хорошего покрытия
    console.log(`Сгенерировано ${candidates.length} кандидатных позиций`);
    // 3. Формируем план зданий (без позиций)
    const plan: CampBuilding[] = [];

    plan.push(...buildModulesForCapacity('dormitory', campHeadcount, 'dorm'));
    plan.push(...buildModulesForCapacity('canteen', canteensNeeded * (canteenModule?.capacity ?? 0), 'canteen'));
    plan.push(...buildModulesForCapacity('medical', medicalPointsNeeded * (medicalModule?.capacity ?? 0), 'medical'));
    plan.push(...buildRepeatedModules('admin', adminBuildingsNeeded, 'admin'));
    plan.push(...buildModulesForCapacity('bathhouse', bathhousesNeeded * (bathhouseModule?.capacity ?? 0), 'bathhouse'));
    plan.push(...buildRepeatedModules('checkpoint', checkpointsNeeded, 'checkpoint'));
    console.log(`Расчет для ${campHeadcount} человек: жилых=${plan.filter(p => p.function === 'dormitory').length}, столовых=${plan.filter(p => p.function === 'canteen').length}, бань=${plan.filter(p => p.function === 'bathhouse').length}, медпунктов=${plan.filter(p => p.function === 'medical').length}, КПП=${checkpointsNeeded}, админ=${adminBuildingsNeeded}`);

    // Магазин (только для расширенного и модифицированного состава)
    if ((functionalComposition === 'extended' || functionalComposition === 'modified') && shopModule) {
      plan.push({
        ...shopModule,
        id: 'shop-1',
        rotation: 0
      } as CampBuilding);
    }

    // Утилиты
    utilityModules.slice(0, 2).forEach((module, index) => {
      plan.push({
        ...module,
        id: `utility-${index + 1}`,
        rotation: 0
      } as CampBuilding);
    });

    if (storageModule) {
      plan.push({
        ...storageModule,
        id: 'storage-1',
        rotation: 0
      } as CampBuilding);
    }

    // 4. Мастер-план размещения
    const map = mapRef.current?.getMap();
    const { placed, roads, unplaced } = generateCampMasterplan(plan, selectedSite, campHeadcount, geoContext, map);

    // Диагностика дубликатов позиций
    const key = (p: any) => `${p.position?.[0]?.toFixed(6)}|${p.position?.[1]?.toFixed(6)}`;
    const freq = new globalThis.Map<string, number>();
    for (const p of placed) freq.set(key(p), (freq.get(key(p)) ?? 0) + 1);
    const top = [...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5);
    console.log('Top duplicate positions:', top);

    // 5. Конвертация в GeoJSON для DeckGL
    const geoJsonBuildings = placed.map(building => ({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [rectRingLngLat(building.position, building.footprint, building.rotation || 0)]
      },
      properties: {
        __id: building.id,
        function: building.function,
        capacity: building.capacity,
        height_m: building.floors * 3, // 3 метра на этаж
        building_levels: building.floors,
        color: building.color,
        fireClass: building.fireClass,
        moduleType: building.moduleType
      }
    }));

    setRoadsData(roads); // сохраняем дороги
    setUnplacedBuildings(unplaced); // сохраняем непоместившиеся

    // 6. Валидация нормативов
    const campViolations = validateCamp(geoJsonBuildings);
    setViolations(campViolations);

    // 7. Обновление состояния
    setGeneratedBuildings(geoJsonBuildings);
    setBuildingsData(geoJsonBuildings);

    console.log(`Сгенерирован вахтовый городок: ${placed.length} зданий, ${campViolations.length} нарушений`);
  }, [campHeadcount, selectedSite, functionalComposition, adminBuildingsCount]);

  // Автоматическая генерация площадки нужного размера
  const autoGenerateCamp = useCallback(() => {
    console.log('🚀 Начинаем автоматическую генерацию площадки...');

    // Начинаем с центра карты
    const centerLng = viewState.longitude;
    const centerLat = viewState.latitude;

    // Начинаем с маленького квадрата и постепенно увеличиваем
    let size = 200; // метров по стороне
    const maxSize = 2000; // максимальный размер
    const step = 100; // шаг увеличения

    const trySize = (currentSize: number): boolean => {
      console.log(`Пробуем размер ${currentSize}м x ${currentSize}м`);

      // Создаем квадратную площадку вокруг центра
      const halfSizeM = currentSize / 2;
      const centerM = lngLatToM([centerLng, centerLat]);

      // Координаты квадрата в метрах
      const squareM: Pt[] = [
        [centerM[0] - halfSizeM, centerM[1] - halfSizeM],
        [centerM[0] + halfSizeM, centerM[1] - halfSizeM],
        [centerM[0] + halfSizeM, centerM[1] + halfSizeM],
        [centerM[0] - halfSizeM, centerM[1] + halfSizeM],
        [centerM[0] - halfSizeM, centerM[1] - halfSizeM] // закрываем кольцо
      ];

      // Конвертируем обратно в lng/lat
      const squareLL: [number, number][] = squareM.map(mToLngLat);

      // Создаем GeoJSON площадку
      const testSite: SelectedSite = {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [squareLL]
        },
        properties: {}
      };

      // Проверяем, помещаются ли здания
      const siteArea = Math.round(turf.area(testSite));
      console.log(`Тестовая площадка: ${siteArea} м²`);

      // 1. Функциональная программа (копия из generateCamp)
      const [dormModule] = getModulesByFunction('dormitory');
      const [canteenModule] = getModulesByFunction('canteen');
      const [medicalModule] = getModulesByFunction('medical');
      const [bathhouseModule] = getModulesByFunction('bathhouse');
      const [shopModule] = getModulesByFunction('shop');
      const utilityModules = getModulesByFunction('utility');
      const [storageModule] = getModulesByFunction('storage');

      if (!dormModule || !canteenModule) {
        console.error('Не найдены базовые модули');
        return false;
      }

      // Расчет количества модулей на основе численности населения (та же логика что и в generateCamp)
      const canteensNeeded = Math.max(1, Math.ceil(campHeadcount / 50));
      const bathhousesNeeded = Math.max(1, Math.ceil(campHeadcount / 30));
      const medicalPointsNeeded = Math.max(1, Math.ceil(campHeadcount / 100));
      const checkpointsNeeded = Math.min(2, Math.max(1, Math.ceil(campHeadcount / 200)));
      const adminBuildingsNeeded = Math.max(1, Math.ceil(campHeadcount / 200));
      
      const plan: CampBuilding[] = [];

      plan.push(...buildModulesForCapacity('dormitory', campHeadcount, 'dorm'));
      plan.push(...buildModulesForCapacity('canteen', canteensNeeded * (canteenModule?.capacity ?? 0), 'canteen'));
      plan.push(...buildModulesForCapacity('medical', medicalPointsNeeded * (medicalModule?.capacity ?? 0), 'medical'));
      plan.push(...buildRepeatedModules('admin', adminBuildingsNeeded, 'admin'));
      plan.push(...buildModulesForCapacity('bathhouse', bathhousesNeeded * (bathhouseModule?.capacity ?? 0), 'bathhouse'));
      plan.push(...buildRepeatedModules('checkpoint', checkpointsNeeded, 'checkpoint'));

      // Магазин (только для расширенного и модифицированного состава)
      if ((functionalComposition === 'extended' || functionalComposition === 'modified') && shopModule) {
        plan.push({
          ...shopModule,
          id: 'shop-1',
          rotation: 0
        } as CampBuilding);
      }

      utilityModules.slice(0, 2).forEach((module, index) => {
        plan.push({
          ...module,
          id: `utility-${index + 1}`,
          rotation: 0
        } as CampBuilding);
      });

      if (storageModule) {
        plan.push({
          ...storageModule,
          id: 'storage-1',
          rotation: 0
        } as CampBuilding);
      }

      // 2. Мастер-план размещения
      const map = mapRef.current?.getMap();
      const { placed, unplaced } = generateCampMasterplan(plan, testSite, campHeadcount, geoContext, map);

      console.log(`Результат: ${placed.length} размещено, ${unplaced.length} не поместилось`);

      // Если все здания поместились, используем эту площадку
      if (unplaced.length === 0) {
        console.log(`✅ Найден подходящий размер: ${currentSize}м x ${currentSize}м`);
        setSelectedSite(testSite);
        // Запускаем финальную генерацию
        setTimeout(() => generateCamp(), 100);
        return true;
      }

      return false;
    };

    // Пробуем разные размеры
    for (let currentSize = size; currentSize <= maxSize; currentSize += step) {
      if (trySize(currentSize)) {
        return; // Успех!
      }
    }

    // Если ни один размер не подошел
    console.error('❌ Не удалось найти подходящий размер площадки даже при максимальном размере');
    setViolations([{
      type: 'AUTO_GEN_FAILED',
      severity: 'error',
      buildings: [],
      message: `Не удалось подобрать площадку даже при максимальном размере ${maxSize}м x ${maxSize}м. Попробуйте увеличить максимальный размер или уменьшить количество людей.`
    }]);

  }, [viewState, campHeadcount, geoContext, generateCamp]);

  // Создание площадки в месте клика
  const placeSiteOnMap = useCallback((lng: number, lat: number) => {
    console.log('placeSiteOnMap called:', { lng, lat, waitingForSiteClick });
    if (!waitingForSiteClick) {
      console.log('placeSiteOnMap: waitingForSiteClick is false, returning');
      return;
    }

    const map = mapRef.current?.getMap();
    if (!map) {
      console.log('placeSiteOnMap: map is null');
      return;
    }

    // Используем координаты клика как центр площадки
    const center: [number, number] = [lng, lat];
    
    // Создаем прямоугольную площадку
    const ring = rectRingLngLat(center, [siteLength, siteWidth], 0);
    
    const newSite: SelectedSite = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [ring]
      },
      properties: {}
    };

    setSelectedSite(newSite);
    
    // Очищаем TerraDraw если что-то было нарисовано
    const td = terraRef.current;
    if (td && typeof td.clear === 'function') {
      td.clear();
    }

    // Строим гео-контекст из карты
    const ctx = buildGeoContext(map, newSite);
    setGeoContext(ctx);

    // Отключаем режим ожидания клика
    setWaitingForSiteClick(false);
  }, [waitingForSiteClick, siteWidth, siteLength]);

  // Активация режима ожидания клика для создания площадки
  const createSiteBySize = useCallback(() => {
    console.log('createSiteBySize: activating waiting mode');
    // Отменяем другие режимы
    setPlacingBuilding(false);
    setDrawingMode(null);
    
    // Отключаем TerraDraw, чтобы он не перехватывал клики
    const ctrl = drawCtrlRef.current;
    const td = terraRef.current;
    if (ctrl && typeof ctrl.setMode === 'function') {
      ctrl.setMode('select'); // Переключаем в режим выбора (неактивный)
    }
    if (td && typeof td.setMode === 'function') {
      td.setMode('select'); // Переключаем в режим выбора
    }
    setDrawMode(false);
    
    // Активируем режим ожидания клика
    setWaitingForSiteClick(true);
    console.log('createSiteBySize: waitingForSiteClick set to true');
  }, []);

  // Применение нарисованной площадки
  const applySite = useCallback(() => {
    const td = terraRef.current;
    const map = mapRef.current?.getMap();
    if (!td || !map) return;

    try {
      const features: any[] = td.getSnapshot();
      const lastPoly = [...features].reverse().find((f: any) => f?.geometry?.type === 'Polygon');
      const site = lastPoly ? {
        type: 'Feature' as const,
        geometry: lastPoly.geometry,
        properties: {}
      } : null;

      setSelectedSite(site);

      // После применения площадки выходим из режима рисования
      if (site) {
        stopDrawSite();
      }

      // Строим гео-контекст из карты
      if (site) {
        const ctx = buildGeoContext(map, site);
        setGeoContext(ctx);
      } else {
        setGeoContext(null);
      }
    } catch (error) {
      console.error('Ошибка применения площадки:', error);
    }
  }, []);


  // Валидация норм размещения
  const validateCamp = (buildings: any[]): any[] => {
    const violations: any[] = [];

    for (let i = 0; i < buildings.length; i++) {
      for (let j = i + 1; j < buildings.length; j++) {
        const b1 = buildings[i];
        const b2 = buildings[j];

        const c1 = b1.properties.fireClass || 'C0';
        const c2 = b2.properties.fireClass || 'C0';

        const requiredDist =
          CAMP_RULES.fireBreaks?.[c1]?.[c2] ??
          CAMP_RULES.fireBreaks?.[c2]?.[c1] ??
          10;

        const r1LL = b1.geometry.coordinates[0] as [number, number][];
        const r2LL = b2.geometry.coordinates[0] as [number, number][];

        const r1M = ringLngLatToM(r1LL);
        const r2M = ringLngLatToM(r2LL);

        const dist = polygonMinDistanceMeters(r1M, r2M);

        if (dist < requiredDist) {
          violations.push({
            type: 'fire_break',
            severity: 'error',
            buildings: [b1.properties.__id, b2.properties.__id],
            currentDistance: Math.round(dist),
            requiredDistance: requiredDist,
            position: getMidpoint(b1, b2),
          });
        }
      }
    }

    return violations;
  };

  const getMidpoint = (b1: any, b2: any): [number, number] => {
    const c1 = getCentroid(b1.geometry.coordinates[0]);
    const c2 = getCentroid(b2.geometry.coordinates[0]);
    return [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
  };

  const getCentroid = (coords: number[][]): [number, number] => {
    let x = 0, y = 0;
    coords.forEach(([lon, lat]) => { x += lon; y += lat; });
    return [x / coords.length, y / coords.length];
  };

  // 1) Pre-flight WebGL при монтировании
  useEffect(() => {
    if (!checkWebGLSupport()) {
      setUseSimpleMode(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // 2) Данные: либо из props, либо сгенерированные (без демо-данных)
  useEffect(() => {
    const incoming = data?.buildings?.length
      ? data.buildings
      : generatedBuildings.length > 0
        ? generatedBuildings
        : []; // Пустой массив вместо DEMO_BUILDINGS
    setBuildingsData(normalizeBuildings(incoming));
  }, [data, generatedBuildings]);

  // Объединяем пользовательские объекты с существующими данными
  const allBuildingsData = useMemo(() => {
    return [...buildingsData, ...userBuildings];
  }, [buildingsData, userBuildings]);

  const allRoadsData = useMemo(() => {
    return [...roadsData, ...userRoads];
  }, [roadsData, userRoads]);

  const clippedBuildingsForDisplay = useMemo(
    () => clipPolygonalFeaturesToSite(allBuildingsData, selectedSite),
    [allBuildingsData, selectedSite]
  );

  const clippedRoadsForDisplay = useMemo(
    () => clipPolygonalFeaturesToSite(allRoadsData, selectedSite),
    [allRoadsData, selectedSite]
  );

  const violationsForDisplay = useMemo(() => {
    if (!selectedSite) return violations;
    return violations.filter((v) => {
      try {
        return turf.booleanPointInPolygon(turf.point(v.position), selectedSite as any);
      } catch {
        return true;
      }
    });
  }, [violations, selectedSite]);

  const keepoutFeatures = useMemo(() => {
    const features: any[] = [];

    for (const building of clippedBuildingsForDisplay) {
      if (building?.geometry?.type !== 'Polygon') continue;

      const bufferWidth = getBuildingKeepoutWidthMeters(building);
      if (!bufferWidth) continue;

      try {
        const buffered = turf.buffer(building as any, bufferWidth, { units: 'meters' });
        if (!buffered?.geometry) continue;

        features.push({
          type: 'Feature',
          geometry: buffered.geometry,
          properties: {
            __id: `keepout-${building?.properties?.__id ?? features.length}`,
            color: getFeatureColor(building),
            kind: 'building-keepout',
            width_m: bufferWidth,
          }
        });
      } catch (error) {
        console.warn('Failed to build keepout zone for building:', error);
      }
    }

    for (const road of clippedRoadsForDisplay) {
      if (road?.geometry?.type !== 'Polygon') continue;

      try {
        const buffered = turf.buffer(road as any, ROAD_KEEP_OUT / 2, { units: 'meters' });
        if (!buffered?.geometry) continue;

        features.push({
          type: 'Feature',
          geometry: buffered.geometry,
          properties: {
            __id: `keepout-${road?.properties?.__id ?? features.length}`,
            color: getFeatureColor(road),
            kind: 'road-keepout',
            width_m: ROAD_KEEP_OUT / 2,
          }
        });
      } catch (error) {
        console.warn('Failed to build keepout zone for road:', error);
      }
    }

    return features;
  }, [clippedBuildingsForDisplay, clippedRoadsForDisplay]);

  // Собираем слои через useMemo (как в блокноте)
  const { layers, layerErrorMsg } = useMemo(() => {
    if (!clippedBuildingsForDisplay.length && !clippedRoadsForDisplay.length && !keepoutFeatures.length) {
      return { layers: [] as any[], layerErrorMsg: null as string | null };
    }

    try {
      const layers: any[] = [];

      // УБРАНА boundary-mask - она перекрывала карту белой заливкой!

      // 2. Слой выбранной площадки
      if (selectedSite) {
        const siteLayer = new GeoJsonLayer({
          id: 'selected-site',
          data: {
            type: 'Feature',
            geometry: selectedSite.geometry,
            properties: selectedSite.properties
          },
          filled: false,
          stroked: true,
          getLineColor: [0, 128, 255, 255], // синяя рамка площадки
          getLineWidth: 3,
          pickable: false
        });
        layers.push(siteLayer);
      }

      // 3. Слой нарушений (если включен)
      if (showViolations && violationsForDisplay.length > 0) {
        const violationsLayer = new GeoJsonLayer({
          id: 'violations',
          data: {
            type: 'FeatureCollection',
            features: violationsForDisplay.map(v => ({
              type: 'Feature',
              geometry: {
                type: 'Point',
                coordinates: v.position
              },
              properties: {
                type: v.type,
                severity: v.severity,
                description: `Нарушение: ${v.type}, требуется ${v.requiredDistance}м, сейчас ${v.currentDistance}м`
              }
            }))
          },
          filled: true,
          stroked: true,
          getFillColor: [255, 0, 0, 200],
          getLineColor: [255, 0, 0, 255],
          getRadius: 3,
          pickable: false,
          pointRadiusMinPixels: 5,
          pointRadiusMaxPixels: 20
        });
        layers.push(violationsLayer);
      }

      if (keepoutFeatures.length > 0) {
        const keepoutLayer = new GeoJsonLayer({
          id: 'keepout-zones',
          data: keepoutFeatures,
          filled: true,
          stroked: false,
          pickable: false,
          getFillColor: (d: any) => {
            const [r, g, b] = getFeatureColor(d);
            return [r, g, b, 70];
          },
        });
        layers.push(keepoutLayer);
      }

      // 3. 3D здания (extruded как в блокноте) - объединенные данные
      const buildingLayer = new GeoJsonLayer({
        id: 'buildings-3d',
        data: clippedBuildingsForDisplay,
        filled: true,
        stroked: true,
        extruded: true,              // 3D extrusion как в блокноте
        wireframe: false,
        pickable: true,

        getFillColor: (d: any) => {
          const id = d?.properties?.__id;
          if (selectedBuildingId && id === selectedBuildingId) {
            // выделение выбранного здания - ярче при перетаскивании
            return isDragging ? [255, 100, 100, 200] : [255, 0, 0, 180];
          }
          return d?.properties?.color || [255, 0, 0, 255]; // непрозрачный как в блокноте
        },

        getLineColor: () => (editMode ? [255, 255, 0, 160] : [0, 0, 0, 255]) as any,
        getElevation: (d: any) => d?.properties?.height_m || (d?.properties?.building_levels || 1) * 3,
        elevationScale: 1,           // как в блокноте
        lineWidthMinPixels: 1,
      } as any);
      layers.push(buildingLayer);

      // 4. Слой дорог - объединенные данные
      if (clippedRoadsForDisplay.length > 0) {
        // Валидация данных дорог перед созданием слоя
        const validRoads = clippedRoadsForDisplay.filter(road => {
          try {
            return road &&
                   road.type === 'Feature' &&
                   road.geometry &&
                   road.geometry.type === 'Polygon' &&
                   road.geometry.coordinates &&
                   road.geometry.coordinates[0] &&
                   road.geometry.coordinates[0].length >= 4; // минимум 4 точки для полигона
          } catch {
            return false;
          }
        });

        if (validRoads.length > 0) {
          try {
            const roadsLayer = new GeoJsonLayer({
              id: 'roads',
              data: validRoads,
              filled: true,
              stroked: true, // добавим обводку для видимости
              pickable: false,
              getFillColor: [180, 180, 180, 100], // более прозрачный
              getLineColor: [100, 100, 100, 150], // темная обводка
              lineWidthMinPixels: 1,
            });
        layers.push(roadsLayer);
          } catch (error) {
            console.warn('Failed to create roads layer:', error);
          }
        }
      }

      // Hover слой больше не нужен - drag работает через onDrag* события

      return { layers, layerErrorMsg: null };
    } catch (e: any) {
      console.error('Error creating layers:', e);
      return {
        layers: [],
        layerErrorMsg: 'Ошибка создания слоев',
      };
    }
  }, [clippedBuildingsForDisplay, clippedRoadsForDisplay, editMode, selectedBuildingId, isDragging, showMapLayer, mapStyle, showViolations, violationsForDisplay, selectedSite, keepoutFeatures]);

  // Если создание слоя сломалось — уходим в fallback корректно (через эффект)
  useEffect(() => {
    if (layerErrorMsg) {
      setWebGLError(layerErrorMsg);
      setUseSimpleMode(true);
    }
  }, [layerErrorMsg]);

  const isDiagnosticMode = useSimpleMode || Boolean(webGLError);

  const headerBg = editMode ? 'rgba(255, 243, 205, 0.95)' : 'rgba(255, 255, 255, 0.9)';
  const headerBorder = editMode ? '3px solid #ffc107' : 'none';
  const subText = editMode ? '#856404' : '#666';

  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh' }}>
      {/* Заголовок */}
      <header
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1001,
          background: headerBg,
          padding: '10px 20px',
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
          backdropFilter: 'blur(10px)',
          borderBottom: headerBorder,
        }}
      >

        <p
          style={{
            margin: '5px 0 0 0',
            fontSize: '14px',
            color: subText,
            textAlign: 'center',
          }}
        >
          {isDiagnosticMode
            ? 'Режим диагностики: 3D рендеринг отключен'
            : editMode
              ? 'Режим редактирования: кликните по зданию и тяните для перемещения'
              : `Карта • Pitch: ${Math.round(viewState.pitch || 0)}° • Zoom: ${(viewState.zoom || 0).toFixed(1)} • ${mapStyle === 'dark' ? 'темная' : mapStyle === 'light' ? 'светлая' : mapStyle === 'none' ? 'без' : mapStyle} карта`}
        </p>
      </header>

      {/* Панель управления */}
      <div
        style={{
          position: 'absolute',
          top: 80,
          right: 10,
          bottom: 10,
          zIndex: 1000,
          background: 'white',
          padding: '15px',
          borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          minWidth: '200px',
          maxWidth: 'min(440px, calc(100vw - 24px))',
          overflowY: 'auto',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <h3 style={{ margin: '0 0 15px 0', fontSize: '16px', fontWeight: 'bold', color: '#000000' }}>
          🗺️ Настройки карты (как в блокноте)
        </h3>

        {/* Стиль карты */}
        <div style={{ marginBottom: '15px' }}>
          <label
            style={{
              display: 'block',
              marginBottom: '5px',
              fontWeight: 'bold',
              fontSize: '14px',
            }}
          >
            Стиль карты:
          </label>
          <select
            value={mapStyle}
            onChange={(e) => setMapStyle(e.target.value)}
            style={{
              width: '100%',
              padding: '6px',
              borderRadius: '4px',
              border: '1px solid #ccc',
              fontSize: '14px',
              backgroundColor: 'white'
            }}
          >
            <option value="dark">🌙 Dark (темная карта)</option>
            <option value="light">☀️ Light (светлая карта)</option>
            <option value="none">⚪ None (белая карта)</option>
          </select>
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: '13px', color: '#000000' }}>
            <input
              type="checkbox"
              checked={showTerrainRelief}
              onChange={(e) => setShowTerrainRelief(e.target.checked)}
              style={{ marginRight: '8px' }}
              disabled={mapStyle === 'none'}
            />
            <span>Показывать рельеф местности</span>
          </label>
        </div>

        {/* Режим редактирования */}
        <div style={{ marginBottom: '15px' }}>
          <label
            style={{
              display: 'block',
              marginBottom: '5px',
              fontWeight: 'bold',
              fontSize: '14px',
            }}
          >
            Режим:
          </label>

          <button
            type="button"
            onClick={() => {
              const newEditMode = !editMode;
              setEditMode(newEditMode);

              // При включении режима редактирования отключаем режим рисования
              if (newEditMode && drawMode) {
                stopDrawSite();
              }

              // При выходе из режима редактирования сбрасываем выделение
              if (!newEditMode) {
                setSelectedBuildingId(null);
                setIsDragging(false);
              }
            }}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '4px',
              border: editMode ? '1px solid #ccc' : '1px solid #2e7d32',
              backgroundColor: editMode ? '#f5f5f5' : '#4CAF50',
              color: editMode ? '#333' : 'white',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 'bold',
            }}
            aria-pressed={editMode}
          >
            {/* На кнопке — действие по клику, а не название текущего режима (раньше путали). */}
            {editMode ? '👁️ Просмотр' : '✏️ Редактирование'}
          </button>
          <div style={{ fontSize: '11px', color: '#666', marginTop: '6px', lineHeight: 1.35 }}>
            {editMode ? (
              <>Сейчас включено: выделение и перетаскивание зданий. Нажмите «Просмотр», чтобы снова двигать карту.</>
            ) : (
              <>Сейчас: двигаете карту. Нажмите «Редактирование», чтобы кликать по зданиям.</>
            )}
          </div>
        </div>

          {/* Управление рисованием зданий и дорог */}
          <div style={{ marginTop: '15px', paddingTop: '15px', borderTop: '1px solid #ddd' }}>
            <h4 
              onClick={() => setShowDrawingSection(!showDrawingSection)}
              style={{ 
                margin: '0 0 10px 0', 
                fontSize: '14px', 
                fontWeight: 'bold', 
                color: '#000000',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                userSelect: 'none'
              }}
            >
              <span>✏️ Рисование объектов</span>
              <span style={{ fontSize: '12px', color: '#666' }}>
                {showDrawingSection ? '▼' : '▶'}
              </span>
            </h4>
            
            {showDrawingSection && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button
                onClick={startDrawingBuilding}
                disabled={placingBuilding}
                style={{
                  padding: '8px 12px',
                  borderRadius: '4px',
                  border: '1px solid #4CAF50',
                  backgroundColor: placingBuilding ? '#4CAF50' : '#f5f5f5',
                  color: placingBuilding ? 'white' : '#333',
                  cursor: placingBuilding ? 'not-allowed' : 'pointer',
                  fontSize: '12px',
                  fontWeight: 'bold'
                }}
              >
                {placingBuilding ? '🏗️ Размещение здания...' : '🏗️ Добавить здание'}
              </button>

              {/* Селектор типа здания */}
              {showBuildingTypeSelector && (
                <div style={{
                  marginTop: '8px',
                  padding: '10px',
                  backgroundColor: '#f9f9f9',
                  borderRadius: '4px',
                  border: '1px solid #ddd'
                }}>
                  <div style={{ fontSize: '11px', fontWeight: 'bold', marginBottom: '8px', color: '#333' }}>
                    Выберите тип здания:
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {Object.entries(buildingTypes).map(([key, config]) => (
                      <button
                        key={key}
                        onClick={() => selectBuildingType(key as 'residential' | 'administrative' | 'technical' | 'bathhouse' | 'checkpoint' | 'medical' | 'shop' | 'sportsHall')}
                        style={{
                          padding: '8px 12px',
                          borderRadius: '4px',
                          border: '1px solid #ccc',
                          backgroundColor: '#fff',
                          color: '#333',
                          cursor: 'pointer',
                          fontSize: '12px',
                          textAlign: 'left',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px'
                        }}
                      >
                        <span style={{ fontSize: '16px' }}>{config.icon}</span>
                        <span>{config.name}</span>
                      </button>
                    ))}
                    <button
                      onClick={cancelBuildingPlacement}
                      style={{
                        padding: '6px 12px',
                        borderRadius: '4px',
                        border: '1px solid #ccc',
                        backgroundColor: '#f5f5f5',
                        color: '#666',
                        cursor: 'pointer',
                        fontSize: '11px',
                        marginTop: '4px'
                      }}
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              )}

              {/* Индикатор режима размещения */}
              {placingBuilding && selectedBuildingType && (
                <div style={{
                  marginTop: '8px',
                  padding: '8px',
                  backgroundColor: '#e3f2fd',
                  borderRadius: '4px',
                  border: '1px solid #2196F3',
                  fontSize: '11px',
                  color: '#1976d2'
                }}>
                  <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
                    {buildingTypes[selectedBuildingType].icon} {buildingTypes[selectedBuildingType].name}
                  </div>
                  <div>Кликните на карте для размещения здания</div>
                  <button
                    onClick={cancelBuildingPlacement}
                    style={{
                      marginTop: '6px',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      border: '1px solid #f44336',
                      backgroundColor: '#f44336',
                      color: 'white',
                      cursor: 'pointer',
                      fontSize: '10px'
                    }}
                  >
                    Отменить размещение
                  </button>
                </div>
              )}

              <button
                onClick={startDrawingRoad}
                disabled={!terraRef.current || drawingMode === 'road'}
                style={{
                  padding: '8px 12px',
                  borderRadius: '4px',
                  border: '1px solid #2196F3',
                  backgroundColor: drawingMode === 'road' ? '#2196F3' : (terraRef.current ? '#f5f5f5' : '#ccc'),
                  color: drawingMode === 'road' ? 'white' : (terraRef.current ? '#333' : '#999'),
                  cursor: terraRef.current ? 'pointer' : 'not-allowed',
                  fontSize: '12px',
                  fontWeight: 'bold'
                }}
              >
                {drawingMode === 'road' ? '🛣️ Рисование дорог...' : '🛣️ Добавить дорогу'}
              </button>

              {(drawingMode === 'building' || drawingMode === 'road') && (
                <button
                  onClick={stopDrawing}
                  style={{
                    padding: '8px 12px',
                    borderRadius: '4px',
                    border: '1px solid #f44336',
                    backgroundColor: '#f44336',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 'bold'
                  }}
                >
                  ❌ Отменить рисование
                </button>
              )}

              <button
                onClick={clearAllUserObjects}
                disabled={userBuildings.length === 0 && userRoads.length === 0}
                style={{
                  padding: '8px 12px',
                  borderRadius: '4px',
                  border: '1px solid #f44336',
                  backgroundColor: (userBuildings.length > 0 || userRoads.length > 0) ? '#f44336' : '#ccc',
                  color: 'white',
                  cursor: (userBuildings.length > 0 || userRoads.length > 0) ? 'pointer' : 'not-allowed',
                  fontSize: '12px',
                  fontWeight: 'bold',
                  marginTop: '8px'
                }}
              >
                🗑️ Удалить все ({userBuildings.length + userRoads.length})
              </button>

              {/* Экспорт и импорт */}
              <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #ddd' }}>
                <h5 style={{ margin: '0 0 8px 0', fontSize: '12px', fontWeight: 'bold', color: '#000000' }}>
                  📥 Импорт / Экспорт
                </h5>

                <button
                  onClick={saveLayoutSnapshot}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '4px',
                    border: '1px solid #795548',
                    backgroundColor: '#795548',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    marginBottom: '8px'
                  }}
                >
                  💾 Сохранить вариант в приложении
                </button>
                
                <button
                  onClick={exportData}
                  disabled={!selectedSite && allBuildingsData.length === 0 && allRoadsData.length === 0}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '4px',
                    border: '1px solid #4CAF50',
                    backgroundColor: (selectedSite || allBuildingsData.length > 0 || allRoadsData.length > 0) ? '#4CAF50' : '#ccc',
                    color: 'white',
                    cursor: (selectedSite || allBuildingsData.length > 0 || allRoadsData.length > 0) ? 'pointer' : 'not-allowed',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    marginBottom: '8px'
                  }}
                >
                  💾 Экспорт в GeoJSON
                </button>

                <label
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '4px',
                    border: '1px solid #2196F3',
                    backgroundColor: '#2196F3',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    textAlign: 'center'
                  }}
                >
                  📤 Импорт из GeoJSON
                  <input
                    type="file"
                    accept=".geojson,.json"
                    onChange={importData}
                    style={{ display: 'none' }}
                  />
                </label>

                <div style={{ fontSize: '9px', color: '#666', marginTop: '6px', lineHeight: '1.3' }}>
                  Экспорт: сохраняет площадку, здания и дороги в GeoJSON файл<br />
                  Импорт: загружает площадку, здания и дороги из GeoJSON файла
                  {layoutSavedAt ? <><br />Последнее сохранение: {new Date(layoutSavedAt).toLocaleString()}</> : null}
                </div>
              </div>

              <div style={{ fontSize: '10px', color: '#666', marginTop: '8px', lineHeight: '1.3' }}>
                {placingBuilding && '🏗️ Кликните на карте для размещения здания'}
                {drawingMode === 'road' && '🛣️ Рисуйте линию на карте. Двойной клик для завершения.'}
                {!drawingMode && !placingBuilding && 'Выберите режим для добавления объектов на карту'}
              </div>
            </div>
            )}
          </div>

          {/* Генератор вахтового городка */}
          <div style={{ marginTop: '15px', paddingTop: '15px', borderTop: '1px solid #ddd' }}>
            <h4 
              onClick={() => setShowCampGeneratorSection(!showCampGeneratorSection)}
              style={{ 
                margin: '0 0 10px 0', 
                fontSize: '14px', 
                fontWeight: 'bold', 
                color: '#000000',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                userSelect: 'none'
              }}
            >
              <span>🏗️ Генератор вахтового городка</span>
              <span style={{ fontSize: '12px', color: '#666' }}>
                {showCampGeneratorSection ? '▼' : '▶'}
              </span>
            </h4>

            {showCampGeneratorSection && (
            <>
            {/* Секция площадки */}
            <div style={{ marginBottom: '15px', padding: '10px', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
              <h5 
                onClick={() => setShowSiteSection(!showSiteSection)}
                style={{ 
                  margin: '0 0 10px 0', 
                  fontSize: '12px', 
                  fontWeight: 'bold', 
                  color: '#000000',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  userSelect: 'none'
                }}
              >
                <span>🗺️ Площадка строительства</span>
                <span style={{ fontSize: '10px', color: '#666' }}>
                  {showSiteSection ? '▼' : '▶'}
                </span>
              </h5>

              {showSiteSection && (
              <>
              {/* Отображение площади площадки */}
              {selectedSite && (
                <div style={{ marginBottom: '10px', padding: '8px', backgroundColor: '#e3f2fd', borderRadius: '4px', border: '1px solid #2196F3' }}>
                  <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#1976d2', marginBottom: '4px' }}>
                    📐 Площадь площадки: {Math.round(turf.area(selectedSite))} м²
                  </div>
                </div>
              )}

              {/* Редактирование размеров площадки */}
              <div style={{ marginBottom: '10px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontSize: '11px', fontWeight: 'bold', color: '#000000' }}>
                  Ширина (м):
                </label>
                <input
                  type="number"
                  min="50"
                  max="1000"
                  step="10"
                  value={siteWidth}
                  onChange={(e) => setSiteWidth(Number(e.target.value))}
                  style={{
                    width: '100%',
                    padding: '6px',
                    borderRadius: '4px',
                    border: '1px solid #ccc',
                    fontSize: '12px'
                  }}
                />
              </div>

              <div style={{ marginBottom: '10px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontSize: '11px', fontWeight: 'bold', color: '#000000' }}>
                  Длина (м):
                </label>
                <input
                  type="number"
                  min="50"
                  max="1000"
                  step="10"
                  value={siteLength}
                  onChange={(e) => setSiteLength(Number(e.target.value))}
                  style={{
                    width: '100%',
                    padding: '6px',
                    borderRadius: '4px',
                    border: '1px solid #ccc',
                    fontSize: '12px'
                  }}
                />
              </div>

              {/* КНОПКА СОЗДАНИЯ ПЛОЩАДКИ - ВСЕГДА ВИДИМА */}
              <div style={{ marginBottom: '8px' }}>
                <button
                  onClick={createSiteBySize}
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: '4px',
                    border: 'none',
                    backgroundColor: waitingForSiteClick ? '#FF9800' : '#4CAF50',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    marginBottom: waitingForSiteClick ? '4px' : '0',
                    display: 'block' // Явно указываем display
                  }}
                >
                  {waitingForSiteClick 
                    ? `👆 Кликните на карте для размещения площадки ${siteWidth}×${siteLength} м`
                    : `📐 Создать площадку ${siteWidth}×${siteLength} м`}
                </button>
                {waitingForSiteClick && (
                  <button
                    onClick={cancelSitePlacement}
                    style={{
                      width: '100%',
                      padding: '6px',
                      borderRadius: '4px',
                      border: '1px solid #f44336',
                      backgroundColor: '#f5f5f5',
                      color: '#f44336',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: 'bold'
                    }}
                  >
                    ✖ Отменить
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
                <button
                  onClick={startDrawSite}
                  disabled={!drawCtrlRef.current}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '4px',
                    border: '1px solid #4CAF50',
                    backgroundColor: drawCtrlRef.current ? (drawMode ? '#4CAF50' : '#f5f5f5') : '#ccc',
                    color: drawCtrlRef.current ? (drawMode ? 'white' : '#333') : '#999',
                    cursor: drawCtrlRef.current ? 'pointer' : 'not-allowed',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    flex: 1
                  }}
                >
                  {drawMode ? '🖌️ Рисование активно' : '✏️ Рисовать площадку'}
                </button>

                <button
                  onClick={applySite}
                  disabled={!terraRef.current}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '4px',
                    border: '1px solid #2196F3',
                    backgroundColor: terraRef.current ? '#2196F3' : '#ccc',
                    color: 'white',
                    cursor: terraRef.current ? 'pointer' : 'not-allowed',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    flex: 1
                  }}
                >
                  ✅ Применить площадку
                </button>
              </div>

                {selectedSite && (
                <div style={{ fontSize: '10px', color: '#4CAF50', marginTop: '4px', fontWeight: 'bold' }}>
                  ✓ Площадка выбрана ({Math.round(turf.area(selectedSite))} м²)
              </div>
              )}

              <div style={{ fontSize: '10px', color: '#666', lineHeight: '1.3', marginTop: '8px' }}>
                {drawMode ?
                  '🖌️ Рисование активно: кликайте на карте для создания вершин полигона, двойной клик для завершения' :
                  '✏️ Нажмите "Рисовать площадку" чтобы активировать режим рисования полигона или создайте площадку по размерам'}
              </div>
              </>
              )}
            </div>

            <div style={{ marginBottom: '10px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', fontWeight: 'bold', color: '#000000' }}>
                Количество жителей:
              </label>
              <input
                type="number"
                min="10"
                max="500"
                value={campHeadcount}
                onChange={(e) => setCampHeadcount(Number(e.target.value))}
                style={{
                  width: '100%',
                  padding: '6px',
                  borderRadius: '4px',
                  border: '1px solid #ccc',
                  fontSize: '14px'
                }}
              />
            </div>

            <div style={{ marginBottom: '10px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', fontWeight: 'bold', color: '#000000' }}>
                Функциональный состав:
              </label>
              <select
                value={functionalComposition}
                onChange={(e) => setFunctionalComposition(e.target.value as 'basic' | 'extended' | 'modified')}
                style={{
                  width: '100%',
                  padding: '6px',
                  borderRadius: '4px',
                  border: '1px solid #ccc',
                  fontSize: '12px'
                }}
              >
                <option value="basic">1) Основной набор</option>
                <option value="extended">2) Расширенный (с магазином)</option>
                <option value="modified">3) Модифицированный (несколько админ)</option>
              </select>
              <div style={{ fontSize: '9px', color: '#666', marginTop: '4px', lineHeight: '1.3' }}>
                {functionalComposition === 'basic' && 'Общежитие, столовая, админ, баня, КПП, техздание, медпункт'}
                {functionalComposition === 'extended' && 'Основной набор + магазин'}
                {functionalComposition === 'modified' && 'Основной набор + магазин + несколько административных зданий'}
              </div>
            </div>

            {functionalComposition === 'modified' && (
              <div style={{ marginBottom: '10px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', fontWeight: 'bold', color: '#000000' }}>
                  Количество административных зданий:
                </label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={adminBuildingsCount}
                  onChange={(e) => setAdminBuildingsCount(Number(e.target.value))}
                  style={{
                    width: '100%',
                    padding: '6px',
                    borderRadius: '4px',
                    border: '1px solid #ccc',
                    fontSize: '12px'
                  }}
                />
                <div style={{ fontSize: '9px', color: '#666', marginTop: '4px' }}>
                  Для имитации работы нескольких подрядных организаций
                </div>
              </div>
            )}

            <button
              onClick={generateCamp}
              style={{
                width: '100%',
                padding: '8px',
                borderRadius: '4px',
                border: 'none',
                backgroundColor: '#4CAF50',
                color: 'white',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 'bold',
                marginBottom: '8px'
              }}
            >
              🚀 Сгенерировать городок
            </button>

            <button
              onClick={autoGenerateCamp}
              style={{
                width: '100%',
                padding: '8px',
                borderRadius: '4px',
                border: 'none',
                backgroundColor: '#2196F3',
                color: 'white',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 'bold',
                marginBottom: '8px'
              }}
            >
              🤖 АВТОГЕНЕРАЦИЯ
            </button>

            <div style={{ marginBottom: '10px' }}>
              <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: '12px', color: '#000000' }}>
                <input
                  type="checkbox"
                  checked={showViolations}
                  onChange={(e) => setShowViolations(e.target.checked)}
                  style={{ marginRight: '6px' }}
                />
                ⚠️ Показывать нарушения ({violations.length})
              </label>
            </div>

            {unplacedBuildings.length > 0 && (
              <div style={{
                marginBottom: '10px',
                padding: '8px',
                backgroundColor: '#ffebee',
                border: '1px solid #f44336',
                borderRadius: '4px',
                fontSize: '11px',
                color: '#c62828'
              }}>
                🚫 Не поместились: {unplacedBuildings.length} зданий
                <br />
                <small>Площадка слишком мала или ограничения слишком жесткие</small>
              </div>
            )}

            {generatedBuildings.length > 0 && (
              <div style={{ fontSize: '11px', color: '#666', marginTop: '8px' }}>
                📊 Сгенерировано: {generatedBuildings.length} зданий
                {violations.length > 0 && (
                  <div style={{ color: '#d32f2f', marginTop: '4px' }}>
                    ⚠️ Нарушений: {violations.length}
                  </div>
                )}
                <button
                  type="button"
                  onClick={clearGeneratedCamp}
                  style={{
                    width: '100%',
                    marginTop: '8px',
                    padding: '8px',
                    borderRadius: '4px',
                    border: '1px solid #c62828',
                    backgroundColor: '#ffebee',
                    color: '#b71c1c',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: 'bold',
                  }}
                >
                  🗑️ Удалить весь городок
                </button>
              </div>
            )}
            </>
            )}
          </div>

          {editMode && !isDiagnosticMode && (
            <div style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>
              🖱️ Кликните по зданию для выделения<br />
              🎯 Выделенное здание отмечено красным<br />
              🖱️ Зажмите и тяните выделенное здание для перемещения
              <br />
              <span style={{ color: '#b71c1c' }}>⌫ Delete / Backspace — удалить выбранное здание</span>
              {selectedBuildingId && (
                <button
                  type="button"
                  onClick={deleteSelectedBuilding}
                  style={{
                    display: 'block',
                    width: '100%',
                    marginTop: '8px',
                    padding: '6px',
                    borderRadius: '4px',
                    border: '1px solid #d32f2f',
                    backgroundColor: '#fff',
                    color: '#c62828',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  Удалить это здание
                </button>
              )}
            </div>
          )}

          {!editMode && (clippedBuildingsForDisplay.length > 0 || clippedRoadsForDisplay.length > 0) && !isDiagnosticMode && (
            <div
              style={{
                marginTop: '8px',
                padding: '8px',
                fontSize: '12px',
                color: '#856404',
                backgroundColor: '#fff8e1',
                borderRadius: '4px',
                border: '1px solid #ffc107',
              }}
            >
              Чтобы <strong>выделить здание</strong> или перетащить его, нажмите зелёную кнопку{' '}
              <strong>✏️ Редактирование</strong> в блоке «Режим» выше.
            </div>
          )}

        {/* Управление слоями (пока UI-заглушка, логика включения/выключения не реализована) */}
        <div>
          <label
            style={{
              display: 'block',
              marginBottom: '10px',
              fontWeight: 'bold',
              fontSize: '14px',
              color: '#000000',
            }}
          >
            Слои карты Земли:
          </label>

          <label style={{ display: 'flex', alignItems: 'center', marginBottom: '8px', cursor: 'pointer', color: '#000000' }}>
            <input
              type="checkbox"
              checked={showMapLayer}
              onChange={(e) => setShowMapLayer(e.target.checked)}
              style={{ marginRight: '8px' }}
            />
            <span style={{ fontSize: '14px' }}>🗺️ Mapbox карта</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', marginBottom: '8px', cursor: 'pointer', color: '#000000' }}>
            <input type="checkbox" defaultChecked={true} style={{ marginRight: '8px' }} />
            <span style={{ fontSize: '14px' }}>🏢 Здания</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', marginBottom: '8px', cursor: 'pointer', color: '#000000' }}>
            <input type="checkbox" defaultChecked={true} style={{ marginRight: '8px' }} />
            <span style={{ fontSize: '14px' }}>🛣️ Дороги</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', color: '#000000' }}>
            <input type="checkbox" defaultChecked={true} style={{ marginRight: '8px' }} />
            <span style={{ fontSize: '14px' }}>🌍 Границы</span>
          </label>
        </div>
      </div>

      {/* Легенда */}
      <div
        style={{
          position: 'absolute',
          bottom: 10,
          left: 10,
          zIndex: 1000,
          background: 'white',
          padding: '15px',
          borderRadius: '4px',
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
          maxWidth: '280px',
          maxHeight: 'min(70vh, 520px)',
          overflowY: 'auto',
        }}
      >
        <h4 style={{ margin: '0 0 10px 0', fontSize: '14px' }}>Легенда 3D карты Земли</h4>

        <div style={{ fontSize: '12px', marginBottom: '10px', color: '#666' }}>
          <div>Статус: {isDiagnosticMode ? 'Режим диагностики' : 'DeckGL активен'}</div>
          <div
            style={{
              marginTop: '5px',
              fontSize: '11px',
              color: isDiagnosticMode ? '#e74c3c' : '#4CAF50',
            }}
          >
            {isDiagnosticMode ? '⚠️ 3D недоступен' : '✅ 3D рендеринг активен'}
          </div>

          {!isDiagnosticMode && (
            <div style={{ marginTop: '5px', fontSize: '10px', color: '#666' }}>
              🗺️ {mapStyle === 'openstreetmap' ? 'OpenStreetMap' : mapStyle === 'satellite' ? 'Спутник' : mapStyle === 'terrain' ? 'Рельеф' : mapStyle} • Зданий: {clippedBuildingsForDisplay.length} • Дорог: {clippedRoadsForDisplay.length}
              {selectedBuildingId ? ` • Выбрано: ${selectedBuildingId}` : ''}
            </div>
          )}

          {webGLError && (
            <div style={{ marginTop: '6px', fontSize: '10px', color: '#c62828' }}>
              Ошибка: {webGLError}
            </div>
          )}
        </div>

        <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #ddd' }}>
          <h5 style={{ margin: '0 0 8px 0', fontSize: '12px', fontWeight: 'bold', color: '#000' }}>Типы зданий:</h5>
          {Object.entries(buildingTypes).map(([key, config]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', marginBottom: '6px' }}>
              <div 
                style={{ 
                  width: '16px', 
                  height: '16px', 
                  backgroundColor: `rgb(${config.color[0]}, ${config.color[1]}, ${config.color[2]})`, 
                  marginRight: '8px', 
                  borderRadius: '2px',
                  border: '1px solid rgba(0,0,0,0.2)'
                }} 
              />
              <span style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span>{config.icon}</span>
                <span>{config.name}</span>
                <span style={{ color: '#999', fontSize: '10px' }}>
                  ({config.floors} эт., {config.height}м, класс {(config as { fireClass?: string }).fireClass ?? '—'})
                </span>
              </span>
        </div>
          ))}
        </div>

        <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #ddd' }}>
          <h5 style={{ margin: '0 0 6px 0', fontSize: '12px', fontWeight: 'bold', color: '#c62828' }}>
            Пожароопасная зона (разрывы, м)
          </h5>
          <p style={{ fontSize: '10px', color: '#555', margin: '0 0 8px 0', lineHeight: 1.35 }}>
            Расстояние между <strong>наружными фасадами</strong> зданий разных классов пожарной опасности (СП 4.13130). В коридоре
            этой ширины у уже стоящего здания <strong>нельзя</strong> разместить другое — приложение блокирует размещение.
          </p>
          <table style={{ width: '100%', fontSize: '9px', borderCollapse: 'collapse', color: '#333' }}>
            <thead>
              <tr>
                <th style={{ border: '1px solid #ddd', padding: '3px', background: '#fafafa' }}> </th>
                {(['C0', 'C1', 'C2', 'C3'] as const).map((col) => (
                  <th key={col} style={{ border: '1px solid #ddd', padding: '3px', background: '#fafafa' }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(['C0', 'C1', 'C2', 'C3'] as const).map((row) => (
                <tr key={row}>
                  <td style={{ border: '1px solid #ddd', padding: '3px', fontWeight: 'bold', background: '#fafafa' }}>{row}</td>
                  {(['C0', 'C1', 'C2', 'C3'] as const).map((col) => (
                    <td key={col} style={{ border: '1px solid #ddd', padding: '3px', textAlign: 'center' }}>
                      {CAMP_RULES.fireBreaks[row]?.[col] ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: '10px', color: '#666', margin: '8px 0 0 0' }}>
            Мин. ширина подъезда пожарной техники: <strong>{CAMP_RULES.minFireAccess} м</strong>
          </p>
        </div>

        <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #ddd' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '5px' }}>
            <div style={{ width: '16px', height: '16px', backgroundColor: 'rgb(180, 180, 180)', marginRight: '8px', borderRadius: '2px' }} />
            <span style={{ fontSize: '11px', color: '#000000' }}>🛣️ Дороги</span>
        </div>
        </div>
      </div>

      {/* DeckGL или диагностическое сообщение */}
      {isDiagnosticMode ? (
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            backgroundColor: '#f0f0f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '2px dashed #ccc',
          }}
        >
          <div style={{ textAlign: 'center', padding: '20px', maxWidth: '600px' }}>
            <h2 style={{ color: '#666', marginBottom: '20px' }}>🛠️ Диагностика WebGL</h2>

            <div
              style={{
                backgroundColor: '#fff3cd',
                border: '2px solid #ffc107',
                borderRadius: '8px',
                padding: '15px',
                marginBottom: '20px',
              }}
            >
              <h3 style={{ color: '#856404', margin: '0 0 10px 0' }}>⚠️ ПРОБЛЕМА ОБНАРУЖЕНА</h3>
              <p style={{ color: '#856404', margin: 0, lineHeight: '1.5' }}>
                <strong>3D рендеринг отключен.</strong>
                <br />
                {webGLError ? (
                  <>
                    <strong>Сообщение:</strong> <code>{webGLError}</code>
                  </>
                ) : (
                  <>
                    <strong>Сообщение:</strong> <code>Неизвестная ошибка WebGL</code>
                  </>
                )}
                <br />
                <br />
                <strong>Рекомендации:</strong>
                <br />• проверьте WebGL в браузере и драйверы видеокарты
                <br />• попробуйте снизить нагрузку (уменьшить canvas/слои/текстуры)
                <br />• при необходимости включите браузерный флаг аппаратного ускорения
              </p>
            </div>

            <div style={{ backgroundColor: '#e8f5e8', padding: '15px', borderRadius: '8px', border: '1px solid #4CAF50' }}>
              <h4 style={{ color: '#2e7d32', margin: '0 0 10px 0' }}>✅ Что работает:</h4>
              <ul style={{ color: '#2e7d32', textAlign: 'left', margin: 0, paddingLeft: '20px' }}>
                <li>React приложение</li>
                <li>Интерфейс управления</li>
                <li>Загрузка данных</li>
              </ul>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
          {/* ПОЛНЫЙ РЕНДЕР: Map снизу + DeckGL оверлей сверху */}
            <>
              {/* Базовая карта + инструменты рисования */}
              {showMapLayer && mapStyle !== 'none' && (
                <Map
                  ref={mapRef}
                  mapStyle={mapStyle === 'dark' ? BASEMAP.dark : mapStyle === 'light' ? BASEMAP.light : BASEMAP.none}
                  initialViewState={INITIAL_VIEW_STATE}
                  onMove={handleMove}
                  onLoad={onMapLoad}
                  onClick={(e: any) => {
                    console.log('Map onClick:', { waitingForSiteClick, placingBuilding, lngLat: e.lngLat });
                    // Размещение здания при клике в режиме размещения
                    if (placingBuilding && e.lngLat) {
                      placeBuildingOnMap(e.lngLat.lng, e.lngLat.lat);
                      return;
                    }
                    // Создание площадки при клике в режиме ожидания
                    if (waitingForSiteClick && e.lngLat) {
                      console.log('Creating site at:', e.lngLat);
                      placeSiteOnMap(e.lngLat.lng, e.lngLat.lat);
                      return;
                    }
                  }}
                  // Карта двигается всегда, кроме когда DeckGL интерактивен (editMode) или размещаем здание/площадку
                  dragPan={!deckInteractive && !placingBuilding && !waitingForSiteClick}
                  scrollZoom={!deckInteractive && !placingBuilding && !waitingForSiteClick}
                  doubleClickZoom={!deckInteractive && !placingBuilding && !waitingForSiteClick}
                  touchZoomRotate={!deckInteractive && !placingBuilding && !waitingForSiteClick}
                  style={{ position: 'absolute', inset: 0, zIndex: 0, cursor: (placingBuilding || waitingForSiteClick) ? 'crosshair' : 'default' }}
                  attributionControl={false}
                />
              )}

              {/* DeckGL оверлей */}
              <DeckGL
                viewState={viewState}
                controller={false} // КРИТИЧНО: DeckGL не управляет камерой, только Map
                layers={layers}
                useDevicePixels={1}
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: '1',
                  // Когда ожидаем клик для площадки - отключаем pointerEvents, чтобы клики проходили к Map
                  pointerEvents: waitingForSiteClick ? 'none' : (deckInteractive || placingBuilding ? 'auto' : 'none')
                } as any}

                onClick={(info: any) => {
                  // Размещение здания при клике в режиме размещения
                  if (placingBuilding && info.coordinate) {
                    placeBuildingOnMap(info.coordinate[0], info.coordinate[1]);
                    return;
                  }
                  // Создание площадки при клике в режиме ожидания
                  if (waitingForSiteClick && info.coordinate) {
                    placeSiteOnMap(info.coordinate[0], info.coordinate[1]);
                    return;
                  }

                  if (!deckInteractive || isDragging) return;

                  const obj = info?.object;
                  const id = obj?.properties?.__id ?? null;

                  setSelectedBuildingId(id);
                }}

                onDragStart={(info: any) => {
                  if (!deckInteractive) return;

                  const obj = info?.object;
                  const id = obj?.properties?.__id;
                  const coord = info?.coordinate; // [lng, lat]

                  if (!id || !coord) return;

                  setSelectedBuildingId(id);
                  setIsDragging(true);
                  setDragStartPos({ lng: coord[0], lat: coord[1] });

                  // сохраняем исходную геометрию выбранного здания
                  setInitialBuildingCoords(JSON.parse(JSON.stringify(obj.geometry.coordinates)));
                }}

                onDrag={(info: any) => {
                  if (!isDragging || !selectedBuildingId || !dragStartPos || !initialBuildingCoords || !deckInteractive) return;

                  const coord = info?.coordinate; // [lng, lat]
                  if (!coord) return;

                  const deltaLng = coord[0] - dragStartPos.lng;
                  const deltaLat = coord[1] - dragStartPos.lat;

                  const updateBuilding = (b: any) => {
                      if (b?.properties?.__id !== selectedBuildingId) return b;

                      const newCoords = initialBuildingCoords.map((ring: number[][]) =>
                        ring.map(([lng, lat]) => [lng + deltaLng, lat + deltaLat])
                      );

                      return {
                        ...b,
                        geometry: { ...b.geometry, coordinates: newCoords },
                      };
                  };

                  // Обновляем оба массива - buildingsData и userBuildings
                  setBuildingsData(prev => prev.map(updateBuilding));
                  setUserBuildings(prev => prev.map(updateBuilding));
                }}

                onDragEnd={() => {
                  if (!isDragging) return;
                  setIsDragging(false);
                  setDragStartPos(null);
                  setInitialBuildingCoords(null);
                }}

                onError={(error: any) => {
                  console.error('DeckGL Error:', error);
                  setWebGLError(error?.message || 'WebGL initialization failed');
                  setUseSimpleMode(true);
                }}
              />
            </>
        </div>
      )}
    </div>
  );
};

export default Map3D;
