'use strict';

/**
 * POC — Stratégie B (OSM Overpass) : recherche de bretelles autoroutières
 * (highway=motorway_link) le long d'un corridor A→B, puis classement par
 * proximité à un point cible (ex. l'emplacement d'un bouchon).
 *
 * Objectif : valider qu'Overpass retourne des données de bretelles utilisables
 * avant d'intégrer cette approche dans la logique de détour de index.js.
 * PAS intégré au service principal — script autonome, exécuté en CLI.
 *
 * Usage :
 *   GOOGLE_MAPS_API_KEY=xxx node scripts/poc-nearest-highway-exit.js \
 *     <pointA> <pointB> <cible> [--padding=500] [--limit=5] [--overpass-url=...]
 *
 *   pointA / pointB / cible : "lat,lng" ou nom de lieu (résolu via geocode.js)
 *
 * Limites connues (POC, pas encore résolues) :
 *   - Instance Overpass publique : rate-limited, parfois indisponible.
 *   - `out center` donne le centre de la boîte englobante de la voie, pas
 *     forcément le point de raccordement réel à l'autoroute.
 *   - Aucune vérification de direction/sens de circulation : une bretelle
 *     trouvée peut être du mauvais côté du corridor.
 */

const { resolvePlaces } = require('../src/geocode');
const { fetchRouteAlternatives } = require('../src/routesApi');
const { haversineMeters } = require('../src/registry');

const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

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

  // Conversion approximative mètres -> degrés (suffisant pour un padding).
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

/**
 * Interroge Overpass pour les bretelles (highway=motorway_link) dans une
 * boîte englobante. `out center` retourne un point représentatif par voie
 * sans avoir à décoder sa géométrie complète.
 */
async function fetchMotorwayLinkExits(bbox, overpassUrl, fetchImpl = globalThis.fetch) {
  const query = `[out:json][timeout:25];
way["highway"="motorway_link"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
out center;`;

  const response = await fetchImpl(overpassUrl, {
    method: 'POST',
    headers: { 
      'Content-Type': 'text/plain',
      "User-Agent": "MonProjetCarto/1.0 (poaudet@live.com)"
     },
    body: query,
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`Overpass API error ${response.status}: ${details}`);
  }

  const payload = await response.json();
  return (payload.elements || [])
    .filter((el) => el.type === 'way' && el.center)
    .map((el) => ({
      id: el.id,
      lat: el.center.lat,
      lng: el.center.lon,
      tags: el.tags || {},
    }));
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

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: node scripts/poc-nearest-highway-exit.js <pointA> <pointB> <cible> [--padding=500] [--limit=5] [--overpass-url=...]');
    console.error('  pointA / pointB / cible : "lat,lng" ou nom de lieu');
    process.exitCode = 1;
    return;
  }

  const [pointARaw, pointBRaw, targetRaw, ...flags] = args;
  const padding = Number(parseFlag(flags, 'padding', '500'));
  const limit = Number(parseFlag(flags, 'limit', '5'));
  const overpassUrl = parseFlag(flags, 'overpass-url', DEFAULT_OVERPASS_URL);

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

  const bbox = computeBoundingBox(routePoints, padding);
  console.log(`\nBoîte englobante (padding ${padding} m) :`, bbox);

  console.log('\nRequête Overpass pour les bretelles (highway=motorway_link)...');
  const exits = await fetchMotorwayLinkExits(bbox, overpassUrl);
  console.log(`  ${exits.length} bretelle(s) trouvée(s) dans la boîte englobante`);

  if (exits.length === 0) {
    console.log('\nAucune bretelle trouvée. Essayez un padding plus large (--padding=1000).');
    return;
  }

  const ranked = rankExitsByDistance(exits, target).slice(0, limit);
  console.log(`\nTop ${ranked.length} bretelle(s) la/les plus proche(s) de la cible :`);
  for (const [i, exit] of ranked.entries()) {
    const label = [
      exit.tags.ref ? `sortie ${exit.tags.ref}` : null,
      exit.tags.name ? `"${exit.tags.name}"` : null,
    ].filter(Boolean).join(', ');
    console.log(
      `  ${i + 1}. ${exit.distanceMeters.toFixed(0)} m — ` +
      `way ${exit.id} (${exit.lat.toFixed(7)}, ${exit.lng.toFixed(7)})` +
      (label ? ` — ${label}` : '') +
      `\n     https://www.openstreetmap.org/way/${exit.id}`
    );
  }
}

main().catch((error) => {
  console.error('\nErreur :', error.message);
  process.exitCode = 1;
});