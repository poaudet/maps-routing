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
  'routes.legs.steps.endLocation',
  'routes.legs.steps.navigationInstruction',
].join(',');

function toLatLngLiteral(point) {
  if (
    !point ||
    typeof point.lat !== 'number' ||
    typeof point.lng !== 'number' ||
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

/** Normalise une route brute de l'API en option exploitable par l'optimiseur. */
function normalizeRoute(route, index) {
  const stepAnchors = (route.legs || [])
    .flatMap((leg) => leg.steps || [])
    .map((step) => step.endLocation?.latLng)
    .filter(Boolean)
    .map((latLng) => ({ lat: latLng.latitude, lng: latLng.longitude }));

  return {
    index,
    description: route.description || `route-${index}`,
    durationSeconds: parseDurationSeconds(route.duration),
    staticDurationSeconds: parseDurationSeconds(route.staticDuration),
    distanceMeters: route.distanceMeters ?? null,
    polyline: route.polyline?.encodedPolyline ?? null,
    stepAnchors,
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
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    computeAlternativeRoutes: true,
  };

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
    throw new Error(`Google Maps Routes API error ${response.status}: ${details}`);
  }

  const payload = await response.json();
  return (payload.routes || []).map(normalizeRoute);
}

module.exports = {
  ROUTES_API_URL,
  FIELD_MASK,
  parseDurationSeconds,
  normalizeRoute,
  fetchRouteAlternatives,
};
