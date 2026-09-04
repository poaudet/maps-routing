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

const { loadRegistry, DEFAULT_REGISTRY_PATH, findCorridorsForSegment } = require('./src/registry');
const { fetchRouteAlternatives, detectHighTraffic } = require('./src/routesApi');
const { optimizeSegment, optionMatchesCorridor } = require('./src/optimizer');
const { updateRegistry } = require('./src/learning');
const { fetchAlternativesMatrix, rankMatrixAlternatives } = require('./src/osrm');
const { debugLog } = require('./src/debug');

/**
 * Évalue un segment entre deux points intermédiaires et retourne une réponse
 * JSON structurée : la route recommandée (`recommended`, privilégiant les
 * corridors connus de l'utilisateur) et la liste des `alternatives` entre
 * lesquelles l'utilisateur peut choisir — alternatives de Google Maps,
 * alternatives OSRM (segments à trafic élevé) et corridors du registre.
 * Si le trafic détecté dépasse le seuil de congestion (duration vs
 * staticDuration free-flow), interroge la matrice OSRM (ou autre fournisseur)
 * pour trouver des alternatives plus rapides et les réinjecte dans
 * l'optimiseur.
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
 * @param {boolean|function} [options.debug] Active le journal de débogage de
 *   chaque couche (réponses Google/OSRM, décision de l'optimiseur, registre) ;
 *   une fonction personnalisée peut recevoir les lignes de journal. Activable
 *   globalement via la variable d'environnement MAPS_ROUTING_DEBUG.
 * @returns {Promise<{recommended: object, alternatives: Array, selected: object,
 *   candidates: Array, fastest: object, matchedCorridor: object|null,
 *   reason: string, traffic: object, osrmAlternatives: Array|null}>}
 */
async function planSegment(pointA, pointB, options = {}) {
  debugLog('planSegment', options, 'Planification du segment', { pointA, pointB });
  const registry = loadRegistry(options.registryPath ?? DEFAULT_REGISTRY_PATH);
  const routes = await fetchRouteAlternatives(pointA, pointB, options);

  // Détection de trafic élevé sur la route sélectionnable la plus rapide.
  const fastest = routes.reduce((best, route) =>
    route.durationSeconds < best.durationSeconds ? route : best
  );
  const traffic = detectHighTraffic(fastest, options.congestionRatio);
  debugLog('planSegment', options, 'Détection de trafic', {
    description: fastest.description,
    durationSeconds: fastest.durationSeconds,
    staticDurationSeconds: fastest.staticDurationSeconds,
    traffic,
  });

  // Trafic élevé : matrice d'alternatives OSRM, réinjectée dans l'optimiseur.
  let osrmAlternatives = null;
  let pool = routes.map((route) => ({ ...route, source: route.source ?? 'google' }));
  if (traffic.congested) {
    const waypoints = options.matrixWaypoints ?? [pointA, pointB];
    debugLog('planSegment', options, 'Trafic élevé : requête de la matrice OSRM', { waypoints });
    const matrix = await fetchAlternativesMatrix(waypoints, options);
    osrmAlternatives = rankMatrixAlternatives(matrix.durations, {
      ...options,
      currentDurationSeconds: fastest.durationSeconds,
    });
    pool = pool.concat(
      osrmAlternatives.map((alt) => ({
        index: routes.length + alt.viaIndex,
        description: `OSRM alternative via waypoint ${alt.viaIndex}`,
        durationSeconds: alt.durationSeconds,
        staticDurationSeconds: alt.durationSeconds,
        distanceMeters: null,
        polyline: null,
        stepAnchors: [waypoints[alt.viaIndex]].filter(Boolean),
        source: 'osrm',
        viaIndex: alt.viaIndex,
        gainSeconds: alt.gainSeconds,
      }))
    );
  }

  const result = optimizeSegment(pool, registry, { pointA, pointB }, options);
  const matchedCorridorId = result.matchedCorridor?.id ?? null;

  const segmentCorridors = findCorridorsForSegment(
    registry,
    pointA,
    pointB,
    options.anchorToleranceMeters
  );
  const matchedCorridorIds = new Set(
    pool.flatMap((route) =>
      segmentCorridors
        .filter((corridor) => optionMatchesCorridor(route, corridor, options.anchorToleranceMeters))
        .map((corridor) => corridor.id)
    )
  );
  // Corridors du registre non retournés par l'API : proposés comme alternatives.
  const registryAlternatives = segmentCorridors
    .filter((corridor) => !matchedCorridorIds.has(corridor.id))
    .map((corridor) => ({
      source: 'registry',
      corridorId: corridor.id,
      name: corridor.name,
      class: corridor.class,
      anchor: corridor.anchor,
      feedbackCount: corridor.feedbackCount ?? null,
      lastUsedAt: corridor.lastUsedAt ?? null,
      durationSeconds: null,
      staticDurationSeconds: null,
      note: 'Corridor enregistré sans route retournée par l\u2019API pour ce segment.',
    }));

  const alternatives = pool
    .filter((route) => route !== result.selected)
    .map((route) => ({
      source: route.source,
      index: route.index,
      description: route.description,
      durationSeconds: route.durationSeconds,
      staticDurationSeconds: route.staticDurationSeconds,
      distanceMeters: route.distanceMeters ?? null,
      deltaSeconds: route.durationSeconds - result.selected.durationSeconds,
      matchedCorridorId:
        segmentCorridors.find((corridor) =>
          optionMatchesCorridor(route, corridor, options.anchorToleranceMeters)
        )?.id ?? null,
      ...(route.source === 'osrm'
        ? { viaIndex: route.viaIndex, gainSeconds: route.gainSeconds }
        : {}),
    }))
    .sort((a, b) => (a.durationSeconds ?? Infinity) - (b.durationSeconds ?? Infinity))
    .concat(registryAlternatives);

  const recommended = {
    source: result.selected.source ?? 'google',
    description: result.selected.description,
    durationSeconds: result.selected.durationSeconds,
    staticDurationSeconds: result.selected.staticDurationSeconds,
    distanceMeters: result.selected.distanceMeters ?? null,
    matchedCorridorId,
    reason: result.reason,
  };

  debugLog('planSegment', options, 'Segment planifié', {
    recommended: recommended.description,
    matchedCorridor: matchedCorridorId,
    alternativeCount: alternatives.length,
    reason: result.reason,
  });

  return {
    ...result,
    traffic,
    alternatives,
    recommended,
    osrmAlternatives,
  };
}

module.exports = {
  planSegment,
  updateRegistry,
  registry: require('./src/registry'),
  routesApi: require('./src/routesApi'),
  optimizer: require('./src/optimizer'),
  osrm: require('./src/osrm'),
};
