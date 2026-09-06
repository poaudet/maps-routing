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
const {
  fetchRouteAlternatives,
  detectHighTraffic,
  findCongestedLegRanges,
  findCongestedStepRanges,
  findCongestedRanges,
} = require('./src/routesApi');
const { optimizeSegment, optionMatchesCorridor } = require('./src/optimizer');
const { updateRegistry } = require('./src/learning');
const { fetchAlternativesMatrix, rankMatrixAlternatives } = require('./src/osrm');
const { resolvePlace, resolvePlaces } = require('./src/geocode');
const { debugLog } = require('./src/debug');
const { buildGoogleMapsRouteUrl } = require('./src/mapsLink');

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
 * @param {{lat: number, lng: number}|{name: string}|string} pointA Point
 *   intermédiaire de départ : coordonnées {lat, lng} ou nom de lieu
 *   (« Beloeil », { name: 'Beloeil' }) résolu via l'API Geocoding.
 * @param {{lat: number, lng: number}|{name: string}|string} pointB Point
 *   intermédiaire d'arrivée (mêmes formes acceptées que pointA).
 * @param {object} [options]
 * @param {string} [options.apiKey] Clé API Google (défaut : GOOGLE_MAPS_API_KEY).
 * @param {typeof fetch} [options.fetchImpl] fetch injectable (tests).
 * @param {string} [options.registryPath] Chemin du fichier route-cache.json.
 * @param {number} [options.toleranceRatio] Budget de tolérance flou (défaut : 0.05).
 * @param {number} [options.congestionRatio] Seuil de trafic élevé (défaut : 0.25).
 * @param {Array<{lat: number, lng: number}|{name: string}|string>} [options.matrixWaypoints]
 *   Points intermédiaires pour la matrice OSRM (défaut : [pointA, pointB]) ;
 *   les noms de lieux y sont aussi résolus. Lorsqu'une plage d'étapes Google
 *   est congestionnée, cette valeur est remplacée par les bornes de cette
 *   plage afin de ne réacheminer que le tronçon concerné.
 * @param {string} [options.osrmBaseUrl] Serveur OSRM ou fournisseur alternatif.
 * @param {string} [options.geocodeBaseUrl] Service de géocodage alternatif.
 * @param {boolean|function} [options.debug] Active le journal de débogage de
 *   chaque couche (réponses Google/OSRM, décision de l'optimiseur, registre) ;
 *   une fonction personnalisée peut recevoir les lignes de journal. Activable
 *   globalement via la variable d'environnement MAPS_ROUTING_DEBUG.
 * @returns {Promise<{recommended: object, alternatives: Array, selected: object,
 *   candidates: Array, fastest: object, matchedCorridor: object|null,
 *   reason: string, traffic: object, osrmAlternatives: Array|null,
 *   points: {pointA: object, pointB: object}}>}
 */
async function planSegment(pointAInput, pointBInput, options = {}) {
  debugLog('planSegment', options, 'Planification du segment', { pointA: pointAInput, pointB: pointBInput });

  // Résolution des lieux : coordonnées {lat,lng} inchangées, noms de lieux
  // résolus en coordonnées via l'API Geocoding (src/geocode.js).
  const [pointA, pointB] = await resolvePlaces([pointAInput, pointBInput], options);
  debugLog('planSegment', options, 'Lieux résolus', { pointA, pointB });

  const registry = loadRegistry(options.registryPath ?? DEFAULT_REGISTRY_PATH);
  const routes = await fetchRouteAlternatives(pointA, pointB, options);
  if (routes.length === 0) {
    throw new Error('Google Maps Routes API returned no routes for this segment');
  }

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

  // Trafic élevé : réachemine chaque groupe de legs/étapes congestionnées. Les
  // bornes viennent de la route Google (legs en priorité, puis steps en repli);
  // matrixWaypoints ne doit pas élargir le calcul à un autre segment.
  let osrmAlternatives = null;
  let pool = routes.map((route) => ({ ...route, source: route.source ?? 'google' }));
  if (traffic.congested) {
    const congestedRanges = findCongestedRanges(fastest, options.congestionRatio);
    const hasCongestedRanges = congestedRanges.length > 0;
    const reroutes = hasCongestedRanges
      ? congestedRanges
      : [
          {
            start: null,
            end: null,
            durationSeconds: fastest.durationSeconds,
          },
        ];
    osrmAlternatives = [];
    let legacyWaypoints = null;
    // Candidats de détour résolus une seule fois, réutilisés pour chaque
    // plage EN PLUS de ses bornes. Sans ces candidats, la matrice OSRM ne
    // contient jamais que l'origine et la destination, et
    // rankMatrixAlternatives (osrm.js) n'a aucun index de détour à évaluer :
    // matrixWaypoints ne peut alors jamais produire d'alternative autre que
    // la liaison directe (viaIndex: null).
    const extraVia = options.matrixWaypoints
      ? await resolvePlaces(options.matrixWaypoints, options)
      : [];
    for (const range of reroutes) {
      const waypoints = hasCongestedRanges
        ? [range.start, range.end, ...extraVia]
        : [pointA, pointB, ...extraVia];
      if (!hasCongestedRanges) legacyWaypoints = waypoints;
      debugLog('planSegment', options, 'Trafic élevé : requête de la matrice OSRM', {
        waypoints,
        segment: hasCongestedRanges ? range : null,
      });
      const matrix = await fetchAlternativesMatrix(waypoints, {
        ...options,
        baseUrl: options.osrmBaseUrl, // osrm.js reads `baseUrl`; the public option is `osrmBaseUrl`
      });
      const segmentAlternatives = rankMatrixAlternatives(matrix.durations, {
        ...options,
        currentDurationSeconds: hasCongestedRanges
          ? range.durationSeconds
          : fastest.durationSeconds,
        includeDirect: hasCongestedRanges,
      });
      osrmAlternatives.push(
        ...segmentAlternatives.map((alt) => ({
          ...alt,
          ...(hasCongestedRanges
            ? {
                segmentStart: range.start,
                segmentEnd: range.end,
                durationSeconds:
                  fastest.durationSeconds - range.durationSeconds + alt.durationSeconds,
              }
            : {}),
        }))
      );
    }
    pool = pool.concat(
      osrmAlternatives.map((alt) => {
        const viaPoint = alt.viaIndex !== null ? extraVia[alt.viaIndex - 2] : null;
        return {
          index: routes.length + alt.viaIndex,
          description:
            alt.viaIndex === null
              ? 'OSRM alternative pour le segment congestionné'
              : `OSRM alternative via ${viaPoint?.name ?? `waypoint ${alt.viaIndex}`}`,
          durationSeconds: alt.durationSeconds,
          staticDurationSeconds: alt.durationSeconds,
          distanceMeters: null,
          polyline: null,
          // Le point de détour est inséré entre les bornes du segment pour
          // que le lien Google Maps force réellement le passage par ce point
          // (sinon Google Maps recalculerait son propre itinéraire direct).
          stepAnchors: hasCongestedRanges
            ? [alt.segmentStart, viaPoint, alt.segmentEnd].filter(Boolean)
            : [legacyWaypoints?.[alt.viaIndex]].filter(Boolean),
          source: 'osrm',
          viaIndex: alt.viaIndex,
          gainSeconds: alt.gainSeconds,
        };
      })
    );
  }

  // Lien Google Maps forçant les waypoints d'une option (stepAnchors ou
  // ancrage de corridor) : garantit que l'itinéraire ouvert par l'utilisateur
  // reproduit exactement l'option évaluée entre pointA et pointB.
  const googleMapsUrlFor = (waypoints) => buildGoogleMapsRouteUrl(pointA, pointB, waypoints);

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
      // Waypoints forcés vers Google Maps : garantit que l'itinéraire ouvert
      // par l'utilisateur correspond exactement à cette option (et non à un
      // itinéraire recalculé par Google Maps entre pointA et pointB).
      googleMapsUrl: googleMapsUrlFor(route.stepAnchors),
      ...(route.source === 'osrm'
        ? { viaIndex: route.viaIndex, gainSeconds: route.gainSeconds }
        : {}),
    }))
    .sort((a, b) => (a.durationSeconds ?? Infinity) - (b.durationSeconds ?? Infinity))
    .concat(
      registryAlternatives.map((alt) => ({
        ...alt,
        googleMapsUrl: googleMapsUrlFor([alt.anchor]),
      }))
    );

  const recommended = {
    source: result.selected.source ?? 'google',
    description: result.selected.description,
    durationSeconds: result.selected.durationSeconds,
    staticDurationSeconds: result.selected.staticDurationSeconds,
    distanceMeters: result.selected.distanceMeters ?? null,
    matchedCorridorId,
    reason: result.reason,
    // Waypoints forcés (stepAnchors de la route sélectionnée) pour que le
    // lien Google Maps reproduise l'itinéraire exact recommandé.
    googleMapsUrl: googleMapsUrlFor(result.selected.stepAnchors),
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
    points: { pointA, pointB },
  };
}

module.exports = {
  planSegment,
  updateRegistry,
  registry: require('./src/registry'),
  routesApi: require('./src/routesApi'),
  optimizer: require('./src/optimizer'),
  osrm: require('./src/osrm'),
  geocode: require('./src/geocode'),
  server: require('./src/server'),
  mapsLink: require('./src/mapsLink'),
};
