'use strict';

/**
 * Résolution de lieux — noms de lieux vers coordonnées GPS.
 *
 * Permet d'utiliser des noms de lieux (« Beloeil », « Montreal Downtown »)
 * à la place des coordonnées GPS {lat, lng} partout où le skill attend un
 * point. La résolution passe par l'API Geocoding de Google Maps ; les points
 * déjà exprimés en {lat, lng} sont retournés tels quels (aucun appel réseau).
 */

const { debugLog } = require('./debug');

const GEOCODE_API_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

/** Vrai si le point est déjà une coordonnée GPS exploitable {lat, lng}. */
function isCoordinates(point) {
  return (
    point != null &&
    typeof point === 'object' &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng)
  );
}

/**
 * Résout un lieu en coordonnées GPS.
 *
 * @param {string|{name?: string, lat?: number, lng?: number}} place
 *   Nom du lieu ("Beloeil"), objet avec nom ({ name: "Beloeil" }) ou
 *   coordonnées déjà résolues ({ lat, lng }, éventuellement avec `name`).
 * @param {object} [options]
 * @param {string} [options.apiKey] Clé API Google (défaut : GOOGLE_MAPS_API_KEY).
 * @param {typeof fetch} [options.fetchImpl] fetch injectable (tests).
 * @param {string} [options.geocodeBaseUrl] URL de base du service de géocodage.
 * @returns {Promise<{lat: number, lng: number, name: string|null}>}
 *   Coordonnées résolues, avec le nom du lieu si fourni (ou l'adresse formatée).
 */
async function resolvePlace(place, options = {}) {
  if (isCoordinates(place)) {
    return {
      lat: place.lat,
      lng: place.lng,
      name: typeof place.name === 'string' ? place.name : null,
    };
  }

  const name = typeof place === 'string' ? place : place?.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(
      `A place must be a name (string), an object with a name, or coordinates {lat, lng}: ${JSON.stringify(place)}`
    );
  }

  const apiKey = options.apiKey ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error('A Google Maps API key is required (apiKey option or GOOGLE_MAPS_API_KEY env var)');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.geocodeBaseUrl ?? GEOCODE_API_URL;
  const url = `${baseUrl}?address=${encodeURIComponent(name)}&key=${encodeURIComponent(apiKey)}`;

  debugLog('geocode', options, 'Requête geocode', { name });

  const response = await fetchImpl(url);
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    debugLog('geocode', options, `Erreur API ${response.status}`, details);
    throw new Error(`Google Maps Geocoding API error ${response.status}: ${details}`);
  }

  const payload = await response.json();
  debugLog('geocode', options, 'Réponse geocode', { name, status: payload.status });

  if (payload.status !== 'OK' || !Array.isArray(payload.results) || payload.results.length === 0) {
    throw new Error(`Unable to resolve place name "${name}" (status: ${payload.status ?? 'no status'})`);
  }

  const best = payload.results[0];
  const location = best.geometry?.location;
  if (!Number.isFinite(location?.lat) || !Number.isFinite(location?.lng)) {
    throw new Error(`Google Maps Geocoding API returned no coordinates for "${name}"`);
  }

  return {
    lat: location.lat,
    lng: location.lng,
    name: best.formatted_address ?? name,
  };
}

/**
 * Résout une liste de lieux (noms ou coordonnées) en parallèle.
 *
 * @param {Array} places Lieux à résoudre (cf. resolvePlace).
 * @param {object} [options] Options propagées à resolvePlace.
 * @returns {Promise<Array<{lat: number, lng: number, name: string|null}>>}
 */
function resolvePlaces(places, options = {}) {
  if (!Array.isArray(places)) {
    throw new Error('resolvePlaces requires an array of places');
  }
  return Promise.all(places.map((place) => resolvePlace(place, options)));
}

module.exports = {
  GEOCODE_API_URL,
  isCoordinates,
  resolvePlace,
  resolvePlaces,
};
