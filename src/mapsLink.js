'use strict';

/**
 * Couche de Sortie — lien Google Maps par option proposée.
 *
 * Construit une URL Google Maps Directions (`?api=1`) pour chaque option
 * retournée à l'utilisateur (route recommandée et alternatives). Les points
 * de cheminement intermédiaires (`stepAnchors`/`anchor`) sont forcés en tant
 * que `waypoints` de l'URL afin que l'itinéraire ouvert dans Google Maps
 * corresponde exactement à l'option évaluée par l'optimiseur, plutôt que de
 * laisser Google Maps recalculer un itinéraire potentiellement différent
 * entre l'origine et la destination.
 */

const GOOGLE_MAPS_DIRECTIONS_URL = 'https://www.google.com/maps/dir/?api=1';

/** Nombre maximal de waypoints acceptés par l'URL Google Maps Directions. */
const MAX_WAYPOINTS = 25;

function formatLatLng(point) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    return null;
  }
  return `${point.lat},${point.lng}`;
}

/**
 * Construit l'URL Google Maps Directions pour un itinéraire donné, en
 * imposant les points de cheminement fournis (`waypoints`) pour forcer le
 * tracé exact de l'option (au lieu du recalcul par défaut de Google Maps).
 *
 * @param {{lat: number, lng: number}} origin Point de départ.
 * @param {{lat: number, lng: number}} destination Point d'arrivée.
 * @param {Array<{lat: number, lng: number}>} [waypoints] Points de
 *   cheminement intermédiaires forcés, dans l'ordre du trajet. Tronqués à
 *   `MAX_WAYPOINTS` (limite de l'URL Google Maps Directions).
 * @returns {string|null} URL Google Maps Directions, ou `null` si l'origine
 *   ou la destination sont invalides.
 */
function buildGoogleMapsRouteUrl(origin, destination, waypoints = []) {
  const originParam = formatLatLng(origin);
  const destinationParam = formatLatLng(destination);
  if (!originParam || !destinationParam) {
    return null;
  }

  const params = new URLSearchParams();
  params.set('origin', originParam);
  params.set('destination', destinationParam);
  params.set('travelmode', 'driving');

  const waypointParams = (waypoints || [])
    .map(formatLatLng)
    .filter(Boolean)
    .slice(0, MAX_WAYPOINTS);
  if (waypointParams.length > 0) {
    params.set('waypoints', waypointParams.join('|'));
  }

  return `${GOOGLE_MAPS_DIRECTIONS_URL}&${params.toString()}`;
}

module.exports = { GOOGLE_MAPS_DIRECTIONS_URL, MAX_WAYPOINTS, buildGoogleMapsRouteUrl };
