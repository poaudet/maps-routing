'use strict';

/**
 * overpass.js — Recherche de bretelles autoroutières (highway=motorway_link)
 * via OSM Overpass, pour trouver une sortie signée avant/après une plage
 * congestionnée classée autoroutière (cf. classifyJamRange, index.js).
 *
 * Migré depuis scripts/poc-nearest-highway-exit.js — POC validé en direct
 * contre le corridor I-95/GW Bridge (voir Handover.md). Restructuré ici en
 * DEUX requêtes indépendantes (une par côté de la plage) plutôt qu'une seule
 * requête servant les deux directions : chaque côté a sa propre cible (le
 * début ou la fin de la plage), sa propre boîte englobante, et son propre
 * filtre de direction (amont pour "avant la plage", aval pour "après").
 *
 * Sortie d'un appel : la meilleure sortie trouvée (ou null si aucune
 * candidate signée ou à direction concordante). La résolution du repli
 * (bretelle non trouvée d'un côté → utiliser la borne d'étape du jam) n'est
 * PAS gérée ici : c'est à l'appelant de décider quoi faire d'un résultat
 * null, propre à chaque côté.
 */

const { debugLog } = require('./debug');
const { haversineMeters } = require('./registry');

const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const DEFAULT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours — la topologie routière change rarement.
const USER_AGENT = 'MonProjetCarto/1.0 (mapsrouting@live.com)';

/** Boîte englobante {south, west, north, east} autour d'UN point cible. */
function computeBoundingBox(point, paddingMeters) {
  const latPad = paddingMeters / 111320;
  const lngPad = paddingMeters / (111320 * Math.cos((point.lat * Math.PI) / 180));
  return {
    south: point.lat - latPad,
    west: point.lng - lngPad,
    north: point.lat + latPad,
    east: point.lng + lngPad,
  };
}

/** Clé de cache : bbox arrondie à 4 décimales (~11 m) pour absorber le bruit flottant. */
function bboxCacheKey(bbox) {
  const round = (n) => n.toFixed(4);
  return `${round(bbox.south)},${round(bbox.west)},${round(bbox.north)},${round(bbox.east)}`;
}

/** Interroge Overpass avec ré-essais (backoff exponentiel) sur erreurs transitoires. */
async function fetchOverpassWithRetry(overpassUrl, query, fetchImpl, options = {}) {
  const { maxRetries = 3, initialDelayMs = 2000 } = options;
  const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetchImpl(overpassUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
      body: query,
    });
    if (response.ok) {
      return response.json();
    }
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxRetries) {
      const details = await response.text().catch(() => '');
      throw new Error(`Overpass API error ${response.status}: ${details}`);
    }
    await new Promise((resolve) => setTimeout(resolve, initialDelayMs * 2 ** attempt));
  }
}

/** Interroge Overpass pour les bretelles (highway=motorway_link) dans une boîte englobante. */
async function fetchMotorwayLinkExits(bbox, overpassUrl, options = {}) {
  const { fetchImpl = globalThis.fetch, cache = null, cacheMaxAgeMs = DEFAULT_CACHE_MAX_AGE_MS } = options;

  const cacheKey = bboxCacheKey(bbox);
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < cacheMaxAgeMs) {
      return cached.exits;
    }
  }

  const query = `[out:json][timeout:25];
way["highway"="motorway_link"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
out center;`;

  debugLog('overpass', options, 'Requête bretelles', { bbox });
  const payload = await fetchOverpassWithRetry(overpassUrl, query, fetchImpl);

  const exits = (payload.elements || [])
    .filter((el) => el.type === 'way' && el.center)
    .map((el) => ({ id: el.id, lat: el.center.lat, lng: el.center.lon, tags: el.tags || {} }));

  if (cache) {
    cache.set(cacheKey, { fetchedAt: Date.now(), exits });
  }
  debugLog('overpass', options, `${exits.length} bretelle(s) trouvée(s)`);
  return exits;
}

/** Géométrie complète (nœuds) d'un ensemble ciblé de voies — requête séparée
 * de la découverte, pour ne pas demander `out geom` sur tous les candidats bruts. */
async function fetchWayGeometries(wayIds, overpassUrl, fetchImpl = globalThis.fetch) {
  if (wayIds.length === 0) return {};
  const query = `[out:json][timeout:25];
way(id:${wayIds.join(',')});
out geom;`;
  const payload = await fetchOverpassWithRetry(overpassUrl, query, fetchImpl);
  const geometries = {};
  for (const el of payload.elements || []) {
    if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2) {
      geometries[el.id] = el.geometry.map((n) => ({ lat: n.lat, lng: n.lon }));
    }
  }
  return geometries;
}

/** Trie les bretelles par distance croissante (haversine) à un point cible. */
function rankExitsByDistance(exits, target) {
  return exits
    .map((exit) => ({ ...exit, distanceMeters: haversineMeters(target, { lat: exit.lat, lng: exit.lng }) }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/** Index du point de la polyligne de route le plus proche d'un point donné. */
function findNearestRouteIndex(point, routePoints) {
  let bestIndex = 0;
  let bestDist = Infinity;
  for (let i = 0; i < routePoints.length; i += 1) {
    const dist = haversineMeters(point, routePoints[i]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }
  return { index: bestIndex, distanceMeters: bestDist };
}

/** Cap initial (degrés [0,360)) du point A vers le point B. */
function bearingDeg(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const deltaLambda = toRad(b.lng - a.lng);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Différence angulaire absolue entre deux caps (0-180°). */
function angleDiffDeg(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/** Cap local de la route autour d'un index donné (fenêtre de `window` points). */
function localRouteBearing(routePoints, index, window = 5) {
  const start = Math.max(0, index - window);
  const end = Math.min(routePoints.length - 1, index + window);
  if (start === end) return null;
  return bearingDeg(routePoints[start], routePoints[end]);
}

/** Cap INITIAL d'une bretelle — signal FAIBLE, voir classifyExit. */
function exitBearing(geometry, initialNodeCount = 3) {
  if (!geometry || geometry.length < 2) return null;
  const endIndex = Math.min(initialNodeCount - 1, geometry.length - 1);
  if (endIndex === 0) return null;
  return bearingDeg(geometry[0], geometry[endIndex]);
}

/** Vrai si les tags indiquent une sortie signalisée réelle. */
function hasExitSignage(tags) {
  return Boolean(tags.destination || tags['destination:ref'] || tags['junction:ref']);
}

/** Paliers de confiance validés en direct (Handover.md) : signalisation >
 * concordance de cap > incertain. */
function classifyExit(exit) {
  if (hasExitSignage(exit.tags)) return 'signee';
  if (exit.concordant === true) return 'concordant';
  return 'incertain';
}

const TIER_PRIORITY = { signee: 0, concordant: 1, incertain: 2 };

/**
 * Trouve la meilleure sortie autoroutière près de `target`, dans la
 * direction demandée le long de `routePoints`.
 *
 * @param {{lat: number, lng: number}} target Début ou fin de la plage
 *   autoroutière padée (cf. classifyJamRange, index.js).
 * @param {Array<{lat: number, lng: number}>} routePoints Polyligne décodée
 *   de la route de base, pour situer target et les candidats le long du trajet.
 * @param {'upstream'|'downstream'} direction 'upstream' = sortie AVANT
 *   target (target = début de plage) ; 'downstream' = sortie APRÈS
 *   (target = fin de plage).
 * @returns {Promise<object|null>} La meilleure sortie, ou null.
 */
async function findHighwayExit(target, routePoints, direction, options = {}) {
  const overpassUrl = options.overpassBaseUrl ?? DEFAULT_OVERPASS_URL;
  const searchRadiusMeters = options.searchRadiusMeters ?? 1500;
  const directionCandidateCount = options.directionCandidateCount ?? 15;
  const directionThresholdDeg = options.directionThresholdDeg ?? 60;

  const bbox = computeBoundingBox(target, searchRadiusMeters);
  const exits = await fetchMotorwayLinkExits(bbox, overpassUrl, options);
  if (exits.length === 0) {
    debugLog('overpass', options, 'Aucune bretelle dans la boîte englobante');
    return null;
  }

  const { index: targetIndex } = findNearestRouteIndex(target, routePoints);
  const ranked = rankExitsByDistance(exits, target).map((exit) => {
    const { index } = findNearestRouteIndex({ lat: exit.lat, lng: exit.lng }, routePoints);
    return { ...exit, routeIndex: index };
  });

  const directional = ranked
    .filter((exit) => (direction === 'upstream' ? exit.routeIndex < targetIndex : exit.routeIndex > targetIndex))
    .slice(0, directionCandidateCount);

  debugLog('overpass', options, `${directional.length} candidat(s) ${direction} retenu(s)`, { total: ranked.length });
  if (directional.length === 0) return null;

  const geometries = await fetchWayGeometries(directional.map((e) => e.id), overpassUrl, options.fetchImpl);

  const annotated = directional
    .map((exit) => {
      const geometry = geometries[exit.id];
      const wayBearing = exitBearing(geometry);
      const routeBearing = localRouteBearing(routePoints, exit.routeIndex);
      const concordant =
        wayBearing !== null && routeBearing !== null
          ? angleDiffDeg(wayBearing, routeBearing) <= directionThresholdDeg
          : null;
      return { ...exit, concordant, tier: classifyExit({ ...exit, concordant }) };
    })
    .sort((a, b) => TIER_PRIORITY[a.tier] - TIER_PRIORITY[b.tier] || a.distanceMeters - b.distanceMeters);

  const best = annotated.find((e) => e.tier === 'signee') ?? annotated.find((e) => e.tier === 'concordant');
  debugLog('overpass', options, best ? 'Sortie retenue' : 'Aucune sortie signée ou concordante',
    best ? { id: best.id, tier: best.tier } : undefined);
  return best ?? null;
}

module.exports = { DEFAULT_OVERPASS_URL, findHighwayExit, findNearestRouteIndex };