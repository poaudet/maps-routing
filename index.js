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
      findCongestedRanges(fastest, options.congestionRatio),
      options.mergeRangeGapMeters ?? 1000 //500
    );
    const congestedRanges = mergedRanges
      // Micro-plages (< minDelaySeconds de retard live) : jamais rentables à
      // re-router — chaque plage coûte au moins une requête Google facturée.
      .filter((r) => r.durationSeconds - r.staticDurationSeconds >= (options.minDelaySeconds ?? 60))
      // Top-N par délai, sinon la pool inonde de micro-tronçons fantômes.
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
      // ---- Source 1 : détour sans autoroute du tronçon congestionné.
      // Les bornes d'intervalle claquent sur la chaussée autoroutière :
      // une requête posée SUR l'autoroute ignore avoidHighways (vérifié
      // empiriquement — réponse « Autoroute 15 » à free-flow 105 km/h).
      // On décale chaque borne perpendiculairement au corridor
      // (jamLateralOffsetMeters, défaut 500 m), côté gauche puis droit :
      // Google accroche alors une route locale, et le modificateur peut
      // produire un vrai détour. Toute réponse encore autoroutière
      // (description ou free-flow > 80 km/h) est rejetée.
      if (hasCongestedRanges) {
        let detourAccepted = false;
        const rangeOrder = mergedRanges.indexOf(range); // Tâche 2 : position le long de la baseline.
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
          const detour = detourRoutes[0];
          const detourFreeFlowKmh =
            detour && detour.distanceMeters > 0 && detour.staticDurationSeconds > 0
              ? (detour.distanceMeters / detour.staticDurationSeconds) * 3.6
              : 0;
          const detourIsMotorway =
            /autoroute|transcanadienne/i.test(detour?.description ?? '') ||
            detourFreeFlowKmh > 80;
          if (detour && !detourIsMotorway) {
            const detourPts = detour.legs.flatMap((l) => l.points);
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
            });
            debugLog('planSegment', options, 'Détour accepté', {
              side: side === -90 ? 'gauche' : 'droit',
              description: detour.description,
              freeFlowKmh: Math.round(detourFreeFlowKmh),
            });
            detourAccepted = true;
            break;
          }
          debugLog('planSegment', options, 'Détour ignoré (corridor autoroutier)', {
            side: side === -90 ? 'gauche' : 'droit',
            description: detour ? detour.description : null,
            freeFlowKmh: Math.round(detourFreeFlowKmh),
          });
        }
        if (detourAccepted) {
          continue; // Google a fourni le détour : pas de matrice OSRM pour ce tronçon.
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
        baseUrl: options.osrmBaseUrl, // osrm.js reads `baseUrl`; the public option is `osrmBaseUrl`
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

    // Tâche 2 : entrée combinée Tier 1. Si ≥ 2 détours Google acceptés sur
    // cette baseline, une seule entrée pool supplémentaire les combine —
    // pure arithmétique sur des prix déjà facturés (aucun appel réseau
    // supplémentaire). Seules les sources google-detour se combinent : un
    // repli matrice OSRM n'a pas de prix Google fiable pour ce tronçon.
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
        staticDurationSeconds: null, // pas de formule fournie pour le static combiné
        gainSeconds: totalGainSeconds,
      });
      debugLog('planSegment', options, 'Détours combinés (Tier 1)', {
        count: acceptedDetours.length,
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
          return {
            index: pool.length,
            description:
                alt.detourAnchors.length > 0
                  ? 'Détour sans autoroute pour le tronçon congestionné'
                  : 'Détour sans autoroute (route libre, pas de waypoint)',
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
      ...(route.source === 'osrm' ? { viaIndex: route.viaIndex } : {}),
      ...(route.gainSeconds !== undefined ? { gainSeconds: route.gainSeconds } : {}),
      ...(route.source === 'google-detour-combined' ? { combinedCount: route.combinedCount } : {}),
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
