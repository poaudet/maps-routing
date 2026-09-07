'use strict';

/**
 * Couche d'Interrogation — API Google Maps Routes.
 *
 * Interroge l'API Routes (computeRoutes) pour un segment entre deux points
 * intermédiaires afin d'obtenir les alternatives disponibles. La requête
 * utilise un masque de champ (Field Mask) limité à la durée en temps réel
 * (`duration`), au temps en conditions fluides (`staticDuration`), à la
 * distance et à la géométrie (polyline + étapes) nécessaire à l'appariement
 * des corridors du registre.
 */
const { decodePolyline } = require('./decodePolyline');
const { debugLog } = require('./debug');

const ROUTES_API_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * Masque de champ : uniquement les données dont l'optimiseur a besoin.
 * Inclure la géométrie permet de comparer les options aux corridors connus.
 */
const FIELD_MASK = [
  'routes.duration',
  'routes.staticDuration',
  'routes.distanceMeters',
  'routes.description',
  'routes.polyline.encodedPolyline',
  'routes.legs.duration',
  'routes.legs.staticDuration',
  'routes.legs.startLocation',
  'routes.legs.endLocation',
  'routes.legs.polyline.encodedPolyline',
  'routes.legs.travelAdvisory.speedReadingIntervals',
].join(',');

function toLatLngLiteral(point) {
  if (
    !point ||
    !Number.isFinite(point.lat) ||
    !Number.isFinite(point.lng) ||
    point.lat < -90 ||
    point.lat > 90 ||
    point.lng < -180 ||
    point.lng > 180
  ) {
    throw new Error(`Invalid waypoint coordinates: ${JSON.stringify(point)}`);
  }
  return {
    location: {
      latLng: {
        latitude: point.lat,
        longitude: point.lng,
      },
    },
  };
}

/** Seuil de congestion par défaut : +25 % entre durée réelle et durée free-flow. */
const DEFAULT_CONGESTION_RATIO = 0.25;

/** Convertit une durée au format protobuf ("1234s" ou secondes numériques) en secondes. */
function parseDurationSeconds(duration) {
  if (typeof duration === 'number') {
    return duration;
  }
  if (typeof duration === 'string') {
    const match = duration.match(/^(-?\d+(?:\.\d+)?)s$/);
    if (match) {
      return Number(match[1]);
    }
  }
  throw new Error(`Unrecognized duration format: ${JSON.stringify(duration)}`);
}

/**
 * Convertit une heure de départ (`Date`, timestamp numérique, ou chaîne
 * ISO 8601 / RFC 3339) en chaîne RFC 3339 attendue par le champ
 * `departureTime` de l'API Routes.
 */
function toDepartureTimeString(departureTime) {
  if (departureTime instanceof Date) {
    if (Number.isNaN(departureTime.getTime())) {
      throw new Error(`Invalid departureTime: ${JSON.stringify(departureTime)}`);
    }
    return departureTime.toISOString();
  }
  if (typeof departureTime === 'number') {
    const date = new Date(departureTime);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid departureTime: ${JSON.stringify(departureTime)}`);
    }
    return date.toISOString();
  }
  if (typeof departureTime === 'string' && departureTime.trim() !== '') {
    const date = new Date(departureTime);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid departureTime: ${JSON.stringify(departureTime)}`);
    }
    return date.toISOString();
  }
  throw new Error(`Invalid departureTime: ${JSON.stringify(departureTime)}`);
}

/** Normalise une route brute de l'API en option exploitable par l'optimiseur. */
function normalizeLocation(location) {
  const latLng = location?.latLng;
  if (!latLng || !Number.isFinite(latLng.latitude) || !Number.isFinite(latLng.longitude)) {
    return null;
  }
  return { lat: latLng.latitude, lng: latLng.longitude };
}

function normalizeRoute(route, index, origin) {
  let previousEnd = origin ?? null;
  const legs = (route.legs || []).map((leg, legIndex) => {
    const legStart = normalizeLocation(leg.startLocation) || previousEnd;
    const legEnd = normalizeLocation(leg.endLocation) || null;
    if (legEnd) {
      previousEnd = legEnd;
    }
    return {
      index: legIndex,
      start: legStart,
      end: legEnd,
      durationSeconds:
        leg.duration === undefined ? null : parseDurationSeconds(leg.duration),
      staticDurationSeconds:
        leg.staticDuration === undefined ? null : parseDurationSeconds(leg.staticDuration),
      // Géométrie + densité de trafic de la leg (extraComputations TRAFFIC_ON_POLYLINE).
      polyline: leg.polyline?.encodedPolyline ?? null,
      speedReadingIntervals: leg.travelAdvisory?.speedReadingIntervals ?? [],
      // Bornes locales pour findCongestedRangesFromIntervals.
      points: leg.polyline?.encodedPolyline ? decodePolyline(leg.polyline.encodedPolyline) : [],
    };
  });

  return {
    index,
    description: route.description || `route-${index}`,
    durationSeconds: parseDurationSeconds(route.duration),
    staticDurationSeconds: parseDurationSeconds(route.staticDuration),
    distanceMeters: route.distanceMeters ?? null,
    polyline: route.polyline?.encodedPolyline ?? null,
    stepAnchors: legs.map((leg) => leg.end).filter(Boolean),
    legs,
  };
}

/**
 * Récupère les alternatives de routage entre deux points intermédiaires.
 *
 * @param {{lat: number, lng: number}} origin Point intermédiaire de départ.
 * @param {{lat: number, lng: number}} destination Point intermédiaire d'arrivée.
 * @param {object} [options]
 * @param {string} [options.apiKey] Clé API Google (défaut : process.env.GOOGLE_MAPS_API_KEY).
 * @param {string} [options.fieldMask] Masque de champ à envoyer (X-Goog-FieldMask).
 * @param {string|Date} [options.departureTime] Heure de départ souhaitée (ISO 8601 / RFC 3339,
 *   ou instance `Date`) utilisée par l'API pour estimer le trafic prévu. Uniquement transmise
 *   à l'API Google (ignorée par le lien Google Maps généré, cf. src/mapsLink.js).
 * @param {typeof fetch} [options.fetchImpl] Implémentation de fetch (injectable pour les tests).
 * @returns {Promise<Array>} Options normalisées (duration, staticDuration, géométrie).
 */
async function fetchRouteAlternatives(origin, destination, options = {}) {
  const apiKey = options.apiKey ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error('A Google Maps API key is required (apiKey option or GOOGLE_MAPS_API_KEY env var)');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const fieldMask = options.fieldMask ?? FIELD_MASK;

  const body = {
    origin: toLatLngLiteral(origin),
    destination: toLatLngLiteral(destination),
    ...(Array.isArray(options.intermediates) && options.intermediates.length > 0
      ? { intermediates: options.intermediates.map(toLatLngLiteral) }
      : {}),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    computeAlternativeRoutes: true,
    extraComputations: ['TRAFFIC_ON_POLYLINE'],
    ...(options.routeModifiers ? { routeModifiers: options.routeModifiers } : {}),
  };

  if (options.departureTime !== undefined && options.departureTime !== null) {
    body.departureTime = toDepartureTimeString(options.departureTime);
  }

  debugLog('google', options, 'Requête computeRoutes', {
    origin,
    destination,
    fieldMask,
    departureTime: body.departureTime,
    intermediates: body.intermediates,
    routeModifiers: body.routeModifiers,
  });

  const response = await fetchImpl(ROUTES_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    debugLog('google', options, `Erreur API ${response.status}`, details);
    throw new Error(`Google Maps Routes API error ${response.status}: ${details}`);
  }

  const payload = await response.json();
  debugLog('google', options, 'Réponse computeRoutes', payload);

  const routes = (payload.routes || []).map((route, index) => normalizeRoute(route, index, origin));
  debugLog('google', options, `${routes.length} route(s) normalisée(s)`, routes.map((route) => ({
    description: route.description,
    durationSeconds: route.durationSeconds,
    staticDurationSeconds: route.staticDurationSeconds,
    distanceMeters: route.distanceMeters,
  })));
  return routes;
}

/** Vitesses considérées comme congestionnées dans speedReadingIntervals. */
const CONGESTED_SPEEDS = new Set(['SLOW', 'TRAFFIC_JAM']);

/**
 * Localise les plages congestionnées via les speedReadingIntervals de la leg
 * (extraComputations: TRAFFIC_ON_POLYLINE). Les indices d'intervalle portent
 * sur la polyligne de la leg ; la polyligne décodée fournit les coordonnées
 * exactes des bornes. Durées réelle/free-flow allouées proportionnellement
 * au nombre de points couverts.
 *
 * @returns {Array<{start, end, durationSeconds, staticDurationSeconds}>}
 */
function findCongestedRangesFromIntervals(route) {
  const ranges = [];
  for (const leg of route.legs || []) {
    const intervals = leg.speedReadingIntervals || [];
    const points = leg.points || [];
    if (intervals.length === 0 || points.length === 0) {
      continue;
    }
    const legDuration = leg.durationSeconds ?? 0;
    const legStatic = leg.staticDurationSeconds ?? 0;
    const secondsPerPoint = legDuration > 0 ? legDuration / points.length : 0;
    const staticPerPoint = legStatic > 0 ? legStatic / points.length : 0;

    let current = null;
    const flush = () => {
      if (current) ranges.push(current);
      current = null;
    };
    for (const interval of intervals) {
      const startIndex = Math.min(interval.startPolylinePointIndex ?? 0, points.length - 1);
      const endIndex = Math.min(interval.endPolylinePointIndex ?? startIndex, points.length - 1);
      const pointCount = endIndex - startIndex + 1;
      if (!CONGESTED_SPEEDS.has(interval.speed)) {
        flush();
        continue;
      }
      const start = points[startIndex];
      const end = points[endIndex];
      if (!start || !end) {
        flush();
        continue;
      }
      if (!current) {
        current = {
          start,
          end,
          durationSeconds: secondsPerPoint * pointCount,
          staticDurationSeconds: staticPerPoint * pointCount,
        };
      } else {
        current.end = end;
        current.durationSeconds += secondsPerPoint * pointCount;
        current.staticDurationSeconds += staticPerPoint * pointCount;
      }
    }
    flush();
  }
  return ranges.filter((range) => range.start && range.end);
}

/**
 * Plages congestionnées d'une route : priorité aux speedReadingIntervals
 * (données natives Google, aucune requête supplémentaire) ; repli sur le
 * ratio global leg-level si les intervals sont indisponibles.
 */
function findCongestedRanges(route, congestionRatio = DEFAULT_CONGESTION_RATIO) {
  const intervalRanges = findCongestedRangesFromIntervals(route);
  if (intervalRanges.length > 0) {
    return intervalRanges.map((range) => ({ ...range, origin: 'intervals' }));
  }
  // Repli : legs entièrement congestionnées selon le ratio duration/static.
  return (route.legs || [])
    .filter(
      (leg) =>
        Number.isFinite(leg.durationSeconds) &&
        Number.isFinite(leg.staticDurationSeconds) &&
        leg.staticDurationSeconds > 0 &&
        (leg.durationSeconds - leg.staticDurationSeconds) / leg.staticDurationSeconds >
          congestionRatio &&
        leg.start && leg.end
    )
    .map((leg) => ({
      origin: 'leg-fallback',
      start: leg.start,
      end: leg.end,
      durationSeconds: leg.durationSeconds,
      staticDurationSeconds: leg.staticDurationSeconds,
    }));
}

/**
 * Détecte un trafic élevé sur une option normalisée en comparant la durée en
 * temps réel (`durationSeconds`) au temps en conditions fluides
 * (`staticDurationSeconds`, free-flow).
 *
 * @param {object} route Option normalisée par normalizeRoute.
 * @param {number} [congestionRatio] Seuil de dépassement (0.25 = +25 %).
 * @returns {{ congested: boolean, ratio: number, delaySeconds: number }}
 */
function detectHighTraffic(route, congestionRatio = DEFAULT_CONGESTION_RATIO) {
  const delaySeconds = route.durationSeconds - route.staticDurationSeconds;
  const ratio = route.staticDurationSeconds > 0 ? delaySeconds / route.staticDurationSeconds : 0;
  return { congested: ratio > congestionRatio, ratio, delaySeconds };
}

module.exports = {
  ROUTES_API_URL,
  FIELD_MASK,
  DEFAULT_CONGESTION_RATIO,
  parseDurationSeconds,
  toDepartureTimeString,
  normalizeRoute,
  detectHighTraffic,
  findCongestedRangesFromIntervals,
  findCongestedRanges,
  fetchRouteAlternatives,
};
