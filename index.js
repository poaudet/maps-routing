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

const { loadRegistry, DEFAULT_REGISTRY_PATH, findCorridorsForSegment, haversineMeters } = require('./src/registry');
const {
  fetchRouteAlternatives,
  detectHighTraffic,
  findCongestedRanges,
} = require('./src/routesApi');
const { optimizeSegment, optionMatchesCorridor } = require('./src/optimizer');
const { updateRegistry } = require('./src/learning');
const { fetchAlternativesMatrix, rankMatrixAlternatives, fetchOsrmRouteAlternatives } = require('./src/osrm');
const { resolvePlaces } = require('./src/geocode');
const { debugLog } = require('./src/debug');
const { buildGoogleMapsRouteUrl } = require('./src/mapsLink');
const { findHighwayExit, findNearestRouteIndex } = require('./src/overpass');

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

/** Déplace un point de distM mètres selon un cap donné (degrés). */
function offsetLatLng(point, headingDeg, distM) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const delta = distM / R;
  const theta = toRad(headingDeg);
  const phi1 = toRad(point.lat);
  const lambda1 = toRad(point.lng);
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
  );
  const lambda2 =
    lambda1 + Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
    );
  return { lat: toDeg(phi2), lng: ((toDeg(lambda2) + 540) % 360) - 180 };
}

/**
 * Distance (haversine) d'un point à un segment de ligne.
 * Approxime en calculant la distance au point de segment le plus proche
 * (start, end, ou milieu).
 */
function distancePointToSegment(pt, segStart, segEnd) {
  const mid = {
    lat: (segStart.lat + segEnd.lat) / 2,
    lng: (segStart.lng + segEnd.lng) / 2,
  };
  return Math.min(
    haversineMeters(pt, segStart),
    haversineMeters(pt, segEnd),
    haversineMeters(pt, mid)
  );
}

/**
 * Vrai si le point tombe à l'intérieur du corridor du bouchon
 * (segment de range.start à range.end + buffer latéral).
 * Exclut les waypoints qui risqueraient de ramener la route vers le bouchon.
 */
function isPointInJamCorridor(pt, jamStart, jamEnd, bufferMeters = 200) {
  const distToSegment = distancePointToSegment(pt, jamStart, jamEnd);
  return distToSegment <= bufferMeters;
}

/**
 * Trouve les étapes d'une leg dont la plage d'index (le long de la
 * polyligne décodée de la leg) chevauche celle de la plage congestionnée.
 *
 * @param {number} indexSlack Tolérance en NOMBRE DE POINTS (pas en mètres)
 *   pour absorber un arrondi à la frontière d'une étape.
 * @returns {number[]} Index des étapes chevauchantes (peut être vide).
 */
function findOverlappingStepIndexes(range, steps, points, indexSlack = 2) {
  if (range.startIndex === undefined || range.endIndex === undefined || !points || points.length === 0) {
    return [];
  }
  const overlapping = [];
  steps.forEach((step, index) => {
    if (!step.start || !step.end) return;
    const stepStartIndex = findNearestRouteIndex(step.start, points).index;
    const stepEndIndex = findNearestRouteIndex(step.end, points).index;
    const lo = Math.min(stepStartIndex, stepEndIndex) - indexSlack;
    const hi = Math.max(stepStartIndex, stepEndIndex) + indexSlack;
    if (range.startIndex <= hi && range.endIndex >= lo) {
      overlapping.push(index);
    }
  });
  return overlapping;
}

/** Vrai si l'étape marque une entrée sur autoroute : MERGE, ou un
 * RAMP_LEFT/RAMP_RIGHT immédiatement suivi d'un MERGE (rampe d'accès). */
function isHighwayEntryStep(steps, index) {
  const step = steps[index];
  if (!step) return false;
  if (step.maneuver === 'MERGE') return true;
  if (step.maneuver === 'RAMP_LEFT' || step.maneuver === 'RAMP_RIGHT') {
    return steps[index + 1]?.maneuver === 'MERGE';
  }
  return false;
}

/** Vrai si l'étape marque une sortie d'autoroute : un RAMP_LEFT/RAMP_RIGHT
 * qui n'est PAS immédiatement suivi d'un MERGE (sinon c'est une bretelle
 * d'échangeur interne à l'autoroute, pas une sortie). */
function isHighwayExitStep(steps, index) {
  const step = steps[index];
  if (!step) return false;
  if (step.maneuver !== 'RAMP_LEFT' && step.maneuver !== 'RAMP_RIGHT') return false;
  return steps[index + 1]?.maneuver !== 'MERGE';
}

/**
 * Cherche la plage autoroutière englobant l'étape `stepIndex` : remonte
 * jusqu'à la première entrée, descend jusqu'à la première sortie. Si l'une
 * des deux recherches n'aboutit pas avant une extrémité de la leg, l'étape
 * n'est pas considérée autoroutière.
 *
 * @returns {{entryIndex: number, exitIndex: number}|null}
 */
function findHighwaySpan(steps, stepIndex) {
  let entryIndex = null;
  for (let i = stepIndex; i >= 0; i -= 1) {
    if (isHighwayEntryStep(steps, i)) {
      entryIndex = i;
      break;
    }
  }
  if (entryIndex === null) return null;

  let exitIndex = null;
  for (let i = stepIndex; i < steps.length; i += 1) {
    if (isHighwayExitStep(steps, i)) {
      exitIndex = i;
      break;
    }
  }
  if (exitIndex === null) return null;

  return { entryIndex, exitIndex };
}

function classifyJamRange(range, leg, options = {}) {
  const steps = leg.steps || [];
  const overlapping = findOverlappingStepIndexes(range, steps, leg.points || [], options.stepOverlapIndexSlack);

  // Bornes du (des) étape(s) que le jam chevauche directement — utilisées
  // à la fois comme itinéraire direct (jam non autoroutier) et comme repli
  // par côté quand Overpass ne trouve pas de sortie (jam autoroutier).
  const jamStepStartPoint = overlapping.length > 0 ? steps[overlapping[0]]?.start ?? null : null;
  const jamStepEndPoint =
    overlapping.length > 0 ? steps[overlapping[overlapping.length - 1]]?.end ?? null : null;

  for (const stepIndex of overlapping) {
    const span = findHighwaySpan(steps, stepIndex);
    if (span) {
      const paddedEntryIndex = Math.max(0, span.entryIndex - 1);
      const paddedExitIndex = Math.min(steps.length - 1, span.exitIndex + 1);
      return {
        isHighway: true,
        spanStartPoint: steps[paddedEntryIndex]?.start ?? null,
        spanEndPoint: steps[paddedExitIndex]?.end ?? null,
        jamStepStartPoint,
        jamStepEndPoint,
      };
    }
  }
  return { isHighway: false, spanStartPoint: null, spanEndPoint: null, jamStepStartPoint, jamStepEndPoint };
}

/**
 * Fusionne les plages congestionnées consécutives séparées par un écart
 * (segment à vitesse NORMALE) d'au plus `maxGapM` mètres entre la fin de
 * l'une et le début de la suivante. Suppose que `ranges` arrive dans
 * l'ordre de la route (vrai aujourd'hui : les intervalles sont ordonnés
 * par leg, les legs sont dans l'ordre) — DOIT être appelé avant tout tri
 * par délai, sous peine de fusionner des plages non adjacentes sur la route.
 *
 * Ne mute jamais les objets d'entrée : chaque plage émise (fusionnée ou
 * non) est une copie fraîche, donc un appel répété sur le même tableau
 * `ranges` reste sans effet de bord et produit toujours le même résultat.
 *
 * @param {Array<{start: object, end: object, durationSeconds: number, staticDurationSeconds: number}>} ranges
 * @param {number} maxGapM Écart maximal (mètres) entre deux plages pour les fusionner.
 * @returns {Array<object>} Plages fusionnées, toujours dans l'ordre de la route.
 */
function mergeNearbyRanges(ranges, maxGapM) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return [];
  }
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && haversineMeters(previous.end, range.start) <= maxGapM) {
      previous.end = range.end;
      previous.endIndex = range.endIndex;
      previous.durationSeconds += range.durationSeconds;
      previous.staticDurationSeconds += range.staticDurationSeconds;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

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
 * @param {number} [options.mergeRangeGapMeters] Écart max. (m) pour fusionner
 *   deux plages congestionnées proches avant filtrage (défaut : 500).
 * @param {number} [options.stepOverlapIndexSlack] Tolérance en nombre de
 *   points de polyligne pour rattacher une plage congestionnée aux étapes.
 * @param {number} [options.jamLateralOffsetMeters] Décalage latéral (m) pour
 *   trouver le détour perpendiculairement au corridor (défaut : 500).
 * @param {number} [options.jamCorridorBufferMeters] Rayon de sécurité (m)
 *   autour du bouchon pour exclure les waypoints du détour (défaut : 200).
 * @param {Array<number>} [options.detourWaypointFractions] Positions (0–1)
 *   le long de la polyligne du détour pour placer les waypoints forcés
 *   (défaut : [0.25, 0.50, 0.75]). Ex. [0.33, 0.67] pour urbain.
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

  debugLog('planSegment', options, 'Intervalles de trafic', routes.map((r) => ({
    description: r.description,
    congestedIntervalCount: r.legs
      .flatMap((l) => l.speedReadingIntervals)
      .filter((i) => i.speed !== 'NORMAL').length,
  })));

  // Détection de trafic élevé sur la route sélectionnable la plus rapide.
  const fastest = routes.reduce((best, route) =>
    route.durationSeconds < best.durationSeconds ? route : best
  );
  const traffic = detectHighTraffic(fastest, options.congestionRatio);
  debugLog('planSegment', options, 'Valeurs de vitesse distinctes (route la plus rapide)', {
  values: [...new Set(fastest.legs.flatMap((l) => l.speedReadingIntervals.map((i) => i.speed)))],
});
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

  // ---- Source 3 : découverte OSRM (route?alternatives=true), non conditionnée
  // au trafic. OSRM propose des corridors distincts avec géométrie ; chaque
  // survivant est rétarifié par Google (waypoint forcé) avant d'entrer dans
  // le pool — jamais de durée OSRM brute dans l'optimiseur.
  if (options.osrmDiscovery !== false) {
    try {
      const discoveries = await fetchOsrmRouteAlternatives(pointA, pointB, {
        ...options,
        baseUrl: options.osrmBaseUrl,
        alternatives: options.osrmAlternativesCount ?? 3,
      });
      for (const [i, cand] of discoveries.entries()) {
        if (!cand.midAnchor) continue;
        const repriced = await fetchRouteAlternatives(pointA, pointB, {
          ...options,
          intermediates: [cand.midAnchor],
        });
        const priced = repriced[0];
        if (!priced) continue;
        pool.push({
          index: pool.length,
          description: `Alternative OSRM${i > 0 ? ` #${i + 1}` : ''}`,
          durationSeconds: priced.durationSeconds,
          staticDurationSeconds: priced.staticDurationSeconds,
          distanceMeters: priced.distanceMeters,
          polyline: priced.polyline,
          stepAnchors: [cand.midAnchor],
          source: 'osrm-discovery',
        });
      }
    } catch (error) {
      debugLog('planSegment', options, 'Découverte OSRM échouée (non bloquant)', {
        error: error.message,
      });
    }
  }

  if (traffic.congested) {
    const mergedRanges = mergeNearbyRanges(
      findCongestedRanges(fastest, options.congestionRatio, options),
      options.mergeRangeGapMeters ?? 1000 //500
    );
    const congestedRanges = mergedRanges
      .filter((r) => r.durationSeconds - r.staticDurationSeconds >= (options.minDelaySeconds ?? 60))
      .sort(
        (a, b) => (b.durationSeconds - b.staticDurationSeconds) -
          (a.durationSeconds - a.staticDurationSeconds)
      )
      .slice(0, options.maxRanges ?? 3);
    debugLog('planSegment', options, 'Plages congestionnées détectées', {
      count: congestedRanges.length,
      ranges: congestedRanges.map((r) => ({
        origin: r.origin ?? 'unknown',
        start: r.start,
        end: r.end,
      })),
    });
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
    // Polyligne complète de la route de base : nécessaire à findHighwayExit
    // (situer les candidats Overpass le long du trajet, amont/aval).
    const routePoints = fastest.legs.flatMap((leg) => leg.points);
    osrmAlternatives = [];
    let legacyWaypoints = null;
    const chainedSegments = [];
    const extraVia = options.matrixWaypoints
      ? await resolvePlaces(options.matrixWaypoints, options)
      : [];
    for (const range of reroutes) {
      if (hasCongestedRanges) {
        let detourAccepted = false;
        const rangeOrder = mergedRanges.indexOf(range);

        // ---- Classification (Tâche 3) : la plage est-elle autoroutière ?
        // range.leg est attaché par routesApi.js — nécessaire pour situer la
        // plage parmi les étapes de SA leg (une route peut avoir plusieurs
        // legs si des points intermédiaires sont fournis).
        const classification = range.leg
          ? classifyJamRange(range, range.leg, options)
          : { isHighway: false, spanStartPoint: null, spanEndPoint: null, jamStepStartPoint: null, jamStepEndPoint: null };

        let pointBefore = classification.jamStepStartPoint ?? range.start;
        let pointAfter = classification.jamStepEndPoint ?? range.end;
        let usedExitBefore = false;
        let usedExitAfter = false;

        // ---- Recherche de sortie Overpass (Tâche 4), uniquement si
        // autoroutier. Repli individuel par côté sur la borne d'étape du
        // jam lui-même si Overpass ne trouve rien de ce côté.
        if (classification.isHighway) {
          const [exitBefore, exitAfter] = await Promise.all([
            classification.spanStartPoint
              ? findHighwayExit(classification.spanStartPoint, routePoints, 'upstream', options).catch((error) => {
                debugLog('planSegment', options, 'Recherche de sortie amont échouée (non bloquant)', { error: error.message });
                return null;
              })
              : Promise.resolve(null),
            classification.spanEndPoint
              ? findHighwayExit(classification.spanEndPoint, routePoints, 'downstream', options).catch((error) => {
                debugLog('planSegment', options, 'Recherche de sortie aval échouée (non bloquant)', { error: error.message });
                return null;
              })
              : Promise.resolve(null),
          ]);
          if (exitBefore) {
            pointBefore = { lat: exitBefore.lat, lng: exitBefore.lng };
            usedExitBefore = true;
          }
          if (exitAfter) {
            pointAfter = { lat: exitAfter.lat, lng: exitAfter.lng };
            usedExitAfter = true;
          }
          debugLog('planSegment', options, 'Plage classée autoroutière', {
            spanStartPoint: classification.spanStartPoint,
            spanEndPoint: classification.spanEndPoint,
            usedExitBefore,
            usedExitAfter,
          });
        } else {
          debugLog('planSegment', options, 'Plage classée non autoroutière', { pointBefore, pointAfter });
        }

        // ---- Primitive point-à-point (Tâche 5), sans modificateur — chemin
        // PRIMAIRE désormais. Ne juge pas la qualité du résultat (repasser
        // par l'autoroute peut être légitime si c'est le trajet le plus
        // direct entre les deux bornes) — seul un échec de la requête
        // déclenche le repli ci-dessous.
        let detour = null;
        if (pointBefore && pointAfter) {
          try {
            const detourRoutes = await fetchRouteAlternatives(pointBefore, pointAfter, options);
            detour = detourRoutes[0] ?? null;
          } catch (error) {
            debugLog('planSegment', options, 'Primitive point-à-point échouée (non bloquant)', { error: error.message });
          }
        }

        if (detour) {
          const detourAnchors = [pointBefore, pointAfter].filter(Boolean);
          osrmAlternatives.push({
            source: 'google-detour',
            viaIndex: null,
            segmentStart: range.start,
            segmentEnd: range.end,
            detourAnchors,
            detourPolyline: detour.polyline,
            detourDistanceMeters: detour.distanceMeters,
            durationSeconds:
              fastest.durationSeconds - range.durationSeconds + detour.durationSeconds,
            staticDurationSeconds:
              (fastest.staticDurationSeconds ?? 0) -
              (range.staticDurationSeconds ?? 0) +
              (detour.staticDurationSeconds ?? 0),
            gainSeconds: range.durationSeconds - detour.durationSeconds,
            rangeOrder,
            isHighway: classification.isHighway,
            usedExitBefore,
            usedExitAfter,
          });
          debugLog('planSegment', options, 'Détour point-à-point accepté', {
            isHighway: classification.isHighway,
            usedExitBefore,
            usedExitAfter,
            description: detour.description,
          });
          detourAccepted = true;
        }

        // ---- Repli (rôle secondaire désormais) : ancienne logique de
        // décalage perpendiculaire — n'intervient QUE si la primitive
        // ci-dessus a échoué (aucune route retournée), pas pour un résultat
        // simplement jugé insatisfaisant.
        if (!detourAccepted) {
          const jamBearing = bearingDeg(range.start, range.end);
          const jamOffsetM = options.jamLateralOffsetMeters ?? 1000 //500;
          for (const side of [-90, 90]) {
            const qStart = offsetLatLng(range.start, jamBearing + side, jamOffsetM);
            const qEnd = offsetLatLng(range.end, jamBearing + side, jamOffsetM);
            let detourRoutes = [];
            try {
              detourRoutes = await fetchRouteAlternatives(qStart, qEnd, {
                ...options,
                routeModifiers: { avoidHighways: true },
              });
            } catch (error) {
              debugLog('planSegment', options, 'Détour sans autoroute refusé', {
                side: side === -90 ? 'gauche' : 'droit',
                error: error.message,
              });
            }
            const fallbackDetour = detourRoutes[0];
            const detourFreeFlowKmh =
              fallbackDetour && fallbackDetour.distanceMeters > 0 && fallbackDetour.staticDurationSeconds > 0
                ? (fallbackDetour.distanceMeters / fallbackDetour.staticDurationSeconds) * 3.6
                : 0;
            const detourIsMotorway =
              /autoroute|transcanadienne/i.test(fallbackDetour?.description ?? '') ||
              detourFreeFlowKmh > 80;
            if (fallbackDetour && !detourIsMotorway) {
              const detourPts = fallbackDetour.legs.flatMap((l) => l.points);
              const detourAnchors = (options.detourWaypointFractions ?? [0.25, 0.50, 0.75])
                .map((f) => detourPts[Math.floor(detourPts.length * f)])
                .filter(Boolean)
                .filter((pt) => !isPointInJamCorridor(pt, range.start, range.end, options.jamCorridorBufferMeters ?? 200));
              osrmAlternatives.push({
                source: 'google-detour',
                viaIndex: null,
                segmentStart: range.start,
                segmentEnd: range.end,
                detourAnchors,
                detourPolyline: fallbackDetour.polyline,
                detourDistanceMeters: fallbackDetour.distanceMeters,
                durationSeconds:
                  fastest.durationSeconds - range.durationSeconds + fallbackDetour.durationSeconds,
                staticDurationSeconds:
                  (fastest.staticDurationSeconds ?? 0) -
                  (range.staticDurationSeconds ?? 0) +
                  (fallbackDetour.staticDurationSeconds ?? 0),
                gainSeconds: range.durationSeconds - fallbackDetour.durationSeconds,
                rangeOrder,
                viaFallback: true,
              });
              debugLog('planSegment', options, 'Détour accepté (repli décalage)', {
                side: side === -90 ? 'gauche' : 'droit',
                description: fallbackDetour.description,
                freeFlowKmh: Math.round(detourFreeFlowKmh),
              });
              detourAccepted = true;
              break;
            }
            debugLog('planSegment', options, 'Détour ignoré (corridor autoroutier)', {
              side: side === -90 ? 'gauche' : 'droit',
              description: fallbackDetour ? fallbackDetour.description : null,
              freeFlowKmh: Math.round(detourFreeFlowKmh),
            });
          }
        }
        // ---- Tâche 6 : segment enchaîné "éviter les autoroutes" — toujours
        // tenté, indépendamment de la classification autoroutière/non et du
        // succès du détour primaire ci-dessus. Ancré sur les bornes d'étape
        // du jam LUI-MÊME (jamStepStartPoint/jamStepEndPoint), jamais sur une
        // sortie Overpass : le but est d'éviter l'autoroute, pas de s'ancrer
        // dessus. Alimente l'alternative unique google-detour-partial,
        // construite après la boucle — jamais discard, même en cas d'échec
        // (valeur de glisser-déposer manuel dans Google Maps).
        const chainStart = classification.jamStepStartPoint ?? range.start;
        const chainEnd = classification.jamStepEndPoint ?? range.end;
        let chainedSegment = null;
        if (chainStart && chainEnd) {
          try {
            const chainedRoutes = await fetchRouteAlternatives(chainStart, chainEnd, {
              ...options,
              routeModifiers: { avoidHighways: true },
            });
            chainedSegment = chainedRoutes[0] ?? null;
            debugLog('planSegment', options, 'Segment enchaîné (sans autoroute) obtenu', {
              rangeOrder,
              description: chainedSegment?.description,
            });
          } catch (error) {
            debugLog('planSegment', options, 'Segment enchaîné (sans autoroute) échoué (non bloquant)', {
              rangeOrder,
              error: error.message,
            });
          }
        }
        chainedSegments.push({
          rangeOrder,
          segmentStart: range.start,
          segmentEnd: range.end,
          rangeDurationSeconds: range.durationSeconds,
          chainStart,
          chainEnd,
          segment: chainedSegment,
        });
        if (detourAccepted) {
          continue; // Détour trouvé (primitive ou repli) : pas de matrice OSRM pour ce tronçon.
        }
      }
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
        baseUrl: options.osrmBaseUrl,
      });
      const segmentAlternatives = rankMatrixAlternatives(matrix.durations, {
        ...options,
        currentDurationSeconds: hasCongestedRanges
          ? (range.staticDurationSeconds ?? range.durationSeconds)
          : (fastest.staticDurationSeconds ?? fastest.durationSeconds),
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

    const acceptedDetours = osrmAlternatives
      .filter((alt) => alt.source === 'google-detour')
      .sort((a, b) => a.rangeOrder - b.rangeOrder);

    if (acceptedDetours.length >= 2) {
      const totalGainSeconds = acceptedDetours.reduce((sum, d) => sum + d.gainSeconds, 0);
      const combinedStepAnchors = acceptedDetours
        .flatMap((d) => [d.segmentStart, ...d.detourAnchors, d.segmentEnd])
        .filter(Boolean);
      osrmAlternatives.push({
        source: 'google-detour-combined',
        combinedCount: acceptedDetours.length,
        stepAnchors: combinedStepAnchors,
        durationSeconds: fastest.durationSeconds - totalGainSeconds,
        staticDurationSeconds: null,
        gainSeconds: totalGainSeconds,
      });
      debugLog('planSegment', options, 'Détours combinés (Tier 1)', {
        count: acceptedDetours.length,
        totalGainSeconds,
      });
    }
    // ---- Tâche 6 : alternative enchaînée unique, construite à partir des
    // segments collectés pendant la boucle. Toujours produite dès qu'au moins
    // un jam a été traité — même si AUCUN segment n'a abouti, la valeur reste
    // d'ancrer des waypoints que l'utilisateur peut glisser manuellement dans
    // Google Maps (décision explicite : jamais de discard silencieux).
    if (hasCongestedRanges) {
      const orderedChainedSegments = [...chainedSegments].sort((a, b) => a.rangeOrder - b.rangeOrder);
      const succeededCount = orderedChainedSegments.filter((s) => s.segment).length;
      const totalCount = orderedChainedSegments.length;
      const totalGainSeconds = orderedChainedSegments.reduce((sum, s) => {
        if (!s.segment) return sum;
        return sum + (s.rangeDurationSeconds - s.segment.durationSeconds);
      }, 0);
      const chainedStepAnchors = orderedChainedSegments
        .flatMap((s) => [s.chainStart, s.chainEnd])
        .filter(Boolean);
      const description = succeededCount === totalCount
        ? `Détour enchaîné sans autoroute pour ${succeededCount} tronçon(s) congestionné(s)`
        : succeededCount > 0
          ? `Détour enchaîné sans autoroute pour ${succeededCount}/${totalCount} tronçon(s) ` +
            `— les autres restent ancrés sur la route de base (waypoint à ajuster manuellement dans Google Maps)`
          : `Aucun détour sans autoroute trouvé pour les tronçons congestionnés ` +
            `— waypoints fournis à titre indicatif, à glisser manuellement dans Google Maps`;
      osrmAlternatives.push({
        source: 'google-detour-partial',
        stepAnchors: chainedStepAnchors,
        durationSeconds: fastest.durationSeconds - totalGainSeconds,
        staticDurationSeconds: null,
        gainSeconds: succeededCount > 0 ? totalGainSeconds : null,
        description,
        succeededCount,
        totalCount,
      });
      debugLog('planSegment', options, 'Alternative enchaînée (Tâche 6) construite', {
        succeededCount,
        totalCount,
        totalGainSeconds,
      });
    }
    pool = pool.concat(
      osrmAlternatives.map((alt) => {
        if (alt.source === 'google-detour-combined') {
          return {
            index: pool.length,
            description:
              `Détours combinés sans autoroute pour ${alt.combinedCount} tronçons congestionnés ` +
              `(délai évité : ${Math.round(alt.gainSeconds)} s)`,
            durationSeconds: alt.durationSeconds,
            staticDurationSeconds: alt.staticDurationSeconds,
            distanceMeters: null,
            polyline: null,
            stepAnchors: alt.stepAnchors,
            source: 'google-detour-combined',
            gainSeconds: alt.gainSeconds,
          };
        }
        if (alt.source === 'google-detour') {
          const description = alt.viaFallback
            ? (alt.detourAnchors.length > 0
              ? 'Détour sans autoroute pour le tronçon congestionné (repli, décalage perpendiculaire)'
              : 'Détour sans autoroute (route libre, pas de waypoint)')
            : alt.isHighway
              ? (alt.usedExitBefore || alt.usedExitAfter
                ? 'Détour via sortie autoroutière signalée'
                : 'Détour autoroutier (bornes d\u2019étape, aucune sortie Overpass trouvée)')
              : 'Détour direct pour le tronçon congestionné (hors autoroute)';
          return {
            index: pool.length,
            description,
            durationSeconds: alt.durationSeconds,
            staticDurationSeconds: alt.staticDurationSeconds,
            distanceMeters: alt.detourDistanceMeters ?? null,
            polyline: alt.detourPolyline,
            stepAnchors: [alt.segmentStart, ...alt.detourAnchors, alt.segmentEnd].filter(Boolean),
            source: 'google-detour',
            gainSeconds: alt.gainSeconds,
          };
        }
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
      ...(route.source === 'osrm' ? { viaIndex: route.viaIndex } : {}),
      ...(route.gainSeconds !== undefined ? { gainSeconds: route.gainSeconds } : {}),
      ...(route.source === 'google-detour-combined' ? { combinedCount: route.combinedCount } : {}),
      ...(route.source === 'google-detour-partial'
        ? { succeededCount: route.succeededCount, totalCount: route.totalCount }
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
  overpass: require('./src/overpass')
};
