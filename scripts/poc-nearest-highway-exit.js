'use strict';

/**
 * POC — Stratégie B (OSM Overpass) : recherche de bretelles autoroutières
 * (highway=motorway_link) le long d'un corridor A→B, classées par proximité
 * à un point cible (ex. un bouchon), puis filtrées/annotées par :
 *   - position amont/aval par rapport à la cible (le long de la route) ;
 *   - concordance de direction (cap initial de la bretelle vs cap local
 *     de la route à ce point).
 *
 * PAS intégré au service principal — script autonome, exécuté en CLI.
 *
 * Usage :
 *   GOOGLE_MAPS_API_KEY=xxx node scripts/poc-nearest-highway-exit.js \
 *     <pointA> <pointB> <cible> \
 *     [--padding=500] [--limit=5] \
 *     [--direction-candidates=15] [--direction-threshold-deg=60] \
 *     [--overpass-url=...] [--no-cache] [--cache-path=...] [--cache-max-age-days=30]
 *
 *   pointA / pointB / cible : "lat,lng" ou nom de lieu (résolu via geocode.js)
 *
 * Limites connues (POC, pas encore résolues) :
 *   - `out center` donne le centre de la boîte englobante de la voie, pas
 *     forcément le point de raccordement réel à l'autoroute.
 *   - Amont/aval : suppose que routePoints suit l'ordre pointA -> pointB
 *     (vrai — decodePolyline préserve l'ordre, les legs sont concaténés
 *     dans l'ordre). Ne gère que le sens A->B, pas B->A.
 *   - Concordance de direction (cap initial vs cap local de la route) :
 *     VALIDÉE COMME SIGNAL FAIBLE SEULEMENT — empiriquement, way 9702654
 *     (39 m de la cible, tags destination="Palisades Parkway;Fort Lee",
 *     destination:ref="US 9W", junction:ref="72", turn:lanes="left") est
 *     une VRAIE sortie signée que l'heuristique de cap rejetait à tort.
 *     Cause : une sortie de voie de gauche diverge fortement du cap de
 *     l'autoroute par construction — la divergence de cap n'implique PAS
 *     une mauvaise direction. destination/destination:ref/junction:ref
 *     est un signal bien plus fiable ; voir classifyExit().
 */

const fs = require('node:fs');
const path = require('node:path');

const { resolvePlaces } = require('../src/geocode');
const { fetchRouteAlternatives } = require('../src/routesApi');
const { haversineMeters } = require('../src/registry');

const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const DEFAULT_CACHE_PATH = path.join(__dirname, '.cache', 'overpass-exits.json');
const DEFAULT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours — la topologie routière change rarement.
const USER_AGENT = 'MonProjetCarto/1.0 (mapsrouting@live.com)';

/** Parse un argument CLI en {lat,lng} si possible, sinon le laisse tel quel (nom de lieu). */
function parsePointArg(raw) {
  const match = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (match) {
    return { lat: Number(match[1]), lng: Number(match[2]) };
  }
  return raw.trim();
}

/** Valeur d'un flag --nom=valeur dans une liste d'arguments CLI. */
function parseFlag(flags, name, defaultValue) {
  const match = flags.find((f) => f.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : defaultValue;
}

/** Boîte englobante {south, west, north, east} d'une liste de points, avec padding en mètres. */
function computeBoundingBox(points, paddingMeters) {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const west = Math.min(...lngs);
  const east = Math.max(...lngs);

  const latPad = paddingMeters / 111320;
  const midLat = (south + north) / 2;
  const lngPad = paddingMeters / (111320 * Math.cos((midLat * Math.PI) / 180));

  return {
    south: south - latPad,
    west: west - lngPad,
    north: north + latPad,
    east: east + lngPad,
  };
}

/** Clé de cache : bbox arrondie à 4 décimales (~11 m) pour absorber le bruit flottant. */
function bboxCacheKey(bbox) {
  const round = (n) => n.toFixed(4);
  return `${round(bbox.south)},${round(bbox.west)},${round(bbox.north)},${round(bbox.east)}`;
}

function loadCache(cachePath) {
  if (!fs.existsSync(cachePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return {}; // Cache corrompu ou vide : on repart de zéro plutôt que de planter.
  }
}

/** Écriture atomique (fichier temporaire + rename), même pattern que registry.js. */
function saveCache(cache, cachePath) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmpPath, cachePath);
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
    const delayMs = initialDelayMs * 2 ** attempt;
    console.log(`  (Overpass ${response.status}, nouvelle tentative dans ${delayMs / 1000}s...)`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * Interroge Overpass pour les bretelles (highway=motorway_link) dans une
 * boîte englobante, avec cache disque (clé = bbox arrondie).
 */
async function fetchMotorwayLinkExits(bbox, overpassUrl, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    cachePath,
    cacheMaxAgeMs = DEFAULT_CACHE_MAX_AGE_MS,
    useCache = true,
  } = options;

  const cacheKey = bboxCacheKey(bbox);
  if (useCache && cachePath) {
    const cache = loadCache(cachePath);
    const cached = cache[cacheKey];
    if (cached && Date.now() - cached.fetchedAt < cacheMaxAgeMs) {
      console.log(
        `  (cache hit : ${cached.exits.length} bretelle(s), récupérées le ` +
        `${new Date(cached.fetchedAt).toISOString()})`
      );
      return cached.exits;
    }
  }

  const query = `[out:json][timeout:25];
way["highway"="motorway_link"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
out center;`;

  const payload = await fetchOverpassWithRetry(overpassUrl, query, fetchImpl);
  
  const exits = (payload.elements || [])
    .filter((el) => el.type === 'way' && el.center)
    .map((el) => ({
      id: el.id,
      lat: el.center.lat,
      lng: el.center.lon,
      tags: el.tags || {},
    }));

  if (useCache && cachePath) {
    const cache = loadCache(cachePath);
    cache[cacheKey] = { fetchedAt: Date.now(), bbox, exits };
    saveCache(cache, cachePath);
  }

  return exits;
}

/**
 * Géométrie complète (liste de nœuds) d'un ensemble ciblé de voies — requête
 * séparée de la découverte initiale, pour ne pas demander `out geom` sur les
 * centaines de candidats bruts, seulement sur ceux retenus en amont.
 */
async function fetchWayGeometries(wayIds, overpassUrl, fetchImpl = globalThis.fetch) {
  if (wayIds.length === 0) return {};
  const query = `[out:json][timeout:25];
way(id:${wayIds.join(',')});
out geom;`;

  const response = await fetchImpl(overpassUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
    body: query,
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`Overpass API error ${response.status}: ${details}`);
  }

  const payload = await response.json();
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
    .map((exit) => ({
      ...exit,
      distanceMeters: haversineMeters(target, { lat: exit.lat, lng: exit.lng }),
    }))
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
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
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

/**
 * Cap INITIAL d'une bretelle (les premiers nœuds de sa géométrie), plutôt
 * que premier->dernier : une bretelle courbe significativement avant de
 * rejoindre la rue de surface, donc son cap de fin peut être très différent
 * du cap de l'autoroute même pour une bretelle dans le bon sens. Le cap
 * initial (là où elle quitte encore l'autoroute) est plus représentatif —
 * MAIS seulement si l'ordre des nœuds va autoroute -> rue de surface, ce
 * qu'on ne vérifie pas ici (voir limites en en-tête).
 */
function exitBearing(geometry, initialNodeCount = 3) {
  if (!geometry || geometry.length < 2) return null;
  const endIndex = Math.min(initialNodeCount - 1, geometry.length - 1);
  if (endIndex === 0) return null;
  return bearingDeg(geometry[0], geometry[endIndex]);
}

/** Vrai si les tags indiquent une sortie signalisée réelle (signage OSM mappée). */
function hasExitSignage(tags) {
  return Boolean(tags.destination || tags['destination:ref'] || tags['junction:ref']);
}

/**
 * Classe une bretelle en paliers de confiance, du plus au moins fiable :
 *  - 'signee'    : tags destination/destination:ref/junction:ref présents.
 *                  Signalisation réelle mappée -> sortie confirmée. Le cap
 *                  n'est plus pertinent (voir note empirique en en-tête :
 *                  une sortie de voie de gauche peut diverger fortement du
 *                  cap de l'autoroute sans que ce soit un défaut).
 *  - 'concordant': pas de signalisation connue, mais cap initial cohérent
 *                  avec la route (signal faible, à valider manuellement).
 *  - 'incertain' : ni signalisation ni cap cohérent (signal le plus faible).
 */
function classifyExit(exit) {
  if (hasExitSignage(exit.tags)) {
    return 'signee';
  }
  if (exit.concordant === true) {
    return 'concordant';
  }
  return 'incertain';
}

const TIER_PRIORITY = { signee: 0, concordant: 1, incertain: 2 };
const TIER_LABELS = {
  signee: 'SORTIE SIGNÉE (destination/junction connus)',
  concordant: 'direction concordante (non signée)',
  incertain: 'incertain (ni signage ni direction confirmés)',
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error(
      'Usage: node scripts/poc-nearest-highway-exit.js <pointA> <pointB> <cible> ' +
      '[--padding=500] [--limit=5] [--direction-candidates=15] [--direction-threshold-deg=60] ' +
      '[--overpass-url=...] [--no-cache] [--cache-path=...] [--cache-max-age-days=30]'
    );
    console.error('  pointA / pointB / cible : "lat,lng" ou nom de lieu');
    process.exitCode = 1;
    return;
  }

  const [pointARaw, pointBRaw, targetRaw, ...flags] = args;
  const padding = Number(parseFlag(flags, 'padding', '500'));
  const limit = Number(parseFlag(flags, 'limit', '5'));
  const directionCandidateCount = Number(parseFlag(flags, 'direction-candidates', '15'));
  const directionThresholdDeg = Number(parseFlag(flags, 'direction-threshold-deg', '60'));
  const overpassUrl = parseFlag(flags, 'overpass-url', DEFAULT_OVERPASS_URL);
  const useCache = !flags.includes('--no-cache');
  const cachePath = parseFlag(flags, 'cache-path', DEFAULT_CACHE_PATH);
  const cacheMaxAgeMs = Number(parseFlag(flags, 'cache-max-age-days', '30')) * 24 * 60 * 60 * 1000;

  console.log('Résolution des points...');
  const [pointA, pointB, target] = await resolvePlaces(
    [parsePointArg(pointARaw), parsePointArg(pointBRaw), parsePointArg(targetRaw)],
    {}
  );
  console.log('  Point A :', pointA);
  console.log('  Point B :', pointB);
  console.log('  Cible   :', target);

  console.log('\nRécupération de la route A→B (Google Routes API)...');
  const routes = await fetchRouteAlternatives(pointA, pointB, {});
  if (routes.length === 0) {
    console.error('\nAucune route trouvée entre les deux points.');
    process.exitCode = 1;
    return;
  }
  const route = routes[0];
  console.log(
    `  Route : ${route.description} ` +
    `(${Math.round(route.durationSeconds / 60)} min, ${Math.round(route.distanceMeters / 1000)} km)`
  );

  const routePoints = route.legs.flatMap((leg) => leg.points);
  console.log(`  ${routePoints.length} points de polyligne décodés`);

  const targetIndex = findNearestRouteIndex(target, routePoints).index;

  const searchRadiusMeters = Number(parseFlag(flags, 'search-radius', '1500'));

  const bbox = computeBoundingBox([target], searchRadiusMeters);
  console.log(`\nBoîte englobante autour de la cible (rayon ${searchRadiusMeters} m) :`, bbox);

  console.log('\nRequête Overpass pour les bretelles (highway=motorway_link)...');
  const exits = await fetchMotorwayLinkExits(bbox, overpassUrl, {
    cachePath: useCache ? cachePath : null,
    cacheMaxAgeMs,
    useCache,
  });
  console.log(`  ${exits.length} bretelle(s) trouvée(s) dans la boîte englobante`);

  if (exits.length === 0) {
    console.log('\nAucune bretelle trouvée. Essayez un padding plus large (--padding=1000).');
    return;
  }

  // Amont = avant la cible dans le sens A->B : condition nécessaire pour un
  // détour préventif (inutile de sortir APRÈS le bouchon).
  const ranked = rankExitsByDistance(exits, target).map((exit) => {
    const { index } = findNearestRouteIndex({ lat: exit.lat, lng: exit.lng }, routePoints);
    return { ...exit, routeIndex: index, upstream: index < targetIndex };
  });

  const upstreamCandidates = ranked.filter((e) => e.upstream).slice(0, directionCandidateCount);
  console.log(
    `\n${upstreamCandidates.length} candidat(s) en amont retenu(s) pour la vérification de ` +
    `direction (sur ${ranked.filter((e) => e.upstream).length} en amont au total).`
  );

  console.log('\nRequête Overpass pour la géométrie détaillée (vérification de direction)...');
  const geometries = await fetchWayGeometries(upstreamCandidates.map((e) => e.id), overpassUrl);

  const annotated = upstreamCandidates
    .map((exit) => {
      const geometry = geometries[exit.id];
      const wayBearing = exitBearing(geometry);
      const routeBearing = localRouteBearing(routePoints, exit.routeIndex);
      const concordant =
        wayBearing !== null && routeBearing !== null
          ? angleDiffDeg(wayBearing, routeBearing) <= directionThresholdDeg
          : null;
      const withBearing = { ...exit, wayBearing, routeBearing, concordant };
      return { ...withBearing, tier: classifyExit(withBearing) };
    })
    .sort((a, b) => {
      const tierDiff = TIER_PRIORITY[a.tier] - TIER_PRIORITY[b.tier];
      return tierDiff !== 0 ? tierDiff : a.distanceMeters - b.distanceMeters;
    });

  console.log(`\nTop ${Math.min(limit, annotated.length)} candidat(s) en amont, par priorité puis distance :`);
  for (const [i, exit] of annotated.slice(0, limit).entries()) {
    const label = [
      exit.tags.ref ? `sortie ${exit.tags.ref}` : null,
      exit.tags['junction:ref'] ? `jonction ${exit.tags['junction:ref']}` : null,
      exit.tags.destination ? `vers ${exit.tags.destination}` : null,
      exit.tags.name ? `"${exit.tags.name}"` : null,
    ].filter(Boolean).join(', ');
    console.log(
      `  ${i + 1}. ${exit.distanceMeters.toFixed(0)} m — way ${exit.id} ` +
      `(${exit.lat.toFixed(5)}, ${exit.lng.toFixed(5)}) — ${TIER_LABELS[exit.tier]}` +
      (label ? ` — ${label}` : '') +
      `\n     https://www.openstreetmap.org/way/${exit.id}`
    );
  }

  const recommended = annotated.find((e) => e.tier === 'signee') ?? annotated.find((e) => e.tier === 'concordant');
  console.log('\n--- Recommandation ---');
  if (recommended) {
    console.log(
      `Bretelle recommandée : way ${recommended.id} à ${recommended.distanceMeters.toFixed(0)} m ` +
      `de la cible, en amont — ${TIER_LABELS[recommended.tier]}.\n` +
      `https://www.openstreetmap.org/way/${recommended.id}`
    );
    if (recommended.tier !== 'signee') {
      console.log(
        '(Aucune sortie signalisée trouvée parmi les candidats — recommandation basée ' +
        'sur la seule concordance de direction, à valider manuellement.)'
      );
    }
  } else {
    console.log(
      `Aucune sortie signalisée ou à direction concordante parmi les ${annotated.length} candidat(s) ` +
      `vérifiés — tous incertains. Essayez --direction-candidates plus élevé.`
    );
  }
}

main().catch((error) => {
  console.error('\nErreur :', error.message);
  process.exitCode = 1;
});