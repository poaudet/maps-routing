'use strict';

/**
 * maps-routing — compétence de micro-reroutage (OpenClaw).
 *
 * Orchestre les 4 couches :
 *  1. Données       : route-cache.json (src/registry.js)
 *  2. Interrogation : API Google Maps Routes (src/routesApi.js)
 *  3. Logique       : optimiseur avec biais (src/optimizer.js)
 *  4. Apprentissage : boucle de rétroaction (src/learning.js)
 */

const { loadRegistry, DEFAULT_REGISTRY_PATH } = require('./src/registry');
const { fetchRouteAlternatives, detectHighTraffic } = require('./src/routesApi');
const { optimizeSegment } = require('./src/optimizer');
const { updateRegistry } = require('./src/learning');
const { fetchAlternativesMatrix, rankMatrixAlternatives } = require('./src/osrm');

/**
 * Évalue un segment entre deux points intermédiaires et retourne l'option
 * privilégiant les corridors connus de l'utilisateur. Si le trafic détecté
 * dépasse le seuil de congestion (duration vs staticDuration free-flow),
 * interroge la matrice OSRM (ou autre fournisseur) pour trouver des
 * alternatives plus rapides et les réinjecte dans l'optimiseur.
 *
 * @param {{lat: number, lng: number}} pointA Point intermédiaire de départ.
 * @param {{lat: number, lng: number}} pointB Point intermédiaire d'arrivée.
 * @param {object} [options]
 * @param {string} [options.apiKey] Clé API Google (défaut : GOOGLE_MAPS_API_KEY).
 * @param {typeof fetch} [options.fetchImpl] fetch injectable (tests).
 * @param {string} [options.registryPath] Chemin du fichier route-cache.json.
 * @param {number} [options.toleranceRatio] Budget de tolérance flou (défaut : 0.05).
 * @param {number} [options.congestionRatio] Seuil de trafic élevé (défaut : 0.25).
 * @param {Array<{lat: number, lng: number}>} [options.matrixWaypoints] Points
 *   intermédiaires pour la matrice OSRM (défaut : [pointA, pointB]).
 * @param {string} [options.osrmBaseUrl] Serveur OSRM ou fournisseur alternatif.
 * @returns {Promise<{selected: object, candidates: Array, fastest: object,
 *   matchedCorridor: object|null, reason: string, traffic: object,
 *   alternatives: Array|null}>}
 */
async function planSegment(pointA, pointB, options = {}) {
  const registry = loadRegistry(options.registryPath ?? DEFAULT_REGISTRY_PATH);
  const routes = await fetchRouteAlternatives(pointA, pointB, options);

  // Détection de trafic élevé sur la route sélectionnable la plus rapide.
  const fastest = routes.reduce((best, route) =>
    route.durationSeconds < best.durationSeconds ? route : best
  );
  const traffic = detectHighTraffic(fastest, options.congestionRatio);

  // Trafic élevé : matrice d'alternatives OSRM, réinjectée dans l'optimiseur.
  let alternatives = null;
  let pool = routes;
  if (traffic.congested) {
    const waypoints = options.matrixWaypoints ?? [pointA, pointB];
    const matrix = await fetchAlternativesMatrix(waypoints, options);
    alternatives = rankMatrixAlternatives(matrix.durations, {
      currentDurationSeconds: fastest.durationSeconds,
    });
    pool = routes.concat(
      alternatives.map((alt) => ({
        index: routes.length + alt.viaIndex,
        description: `OSRM alternative via waypoint ${alt.viaIndex}`,
        durationSeconds: alt.durationSeconds,
        staticDurationSeconds: alt.durationSeconds,
        distanceMeters: null,
        polyline: null,
        stepAnchors: [waypoints[alt.viaIndex]].filter(Boolean),
        source: 'osrm',
      }))
    );
  }

  const result = optimizeSegment(pool, registry, { pointA, pointB }, options);
  return { ...result, traffic, alternatives };
}

module.exports = {
  planSegment,
  updateRegistry,
  registry: require('./src/registry'),
  routesApi: require('./src/routesApi'),
  optimizer: require('./src/optimizer'),
  osrm: require('./src/osrm'),
};
