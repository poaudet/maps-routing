'use strict';

/**
 * Couche Logique — Optimiseur avec biais.
 *
 * Compare les options proposées par l'API pour un segment, applique un budget
 * de tolérance flou (par défaut +5 % de temps par rapport à la meilleure
 * durée en conditions réelles) et, si plusieurs options restent viables dans
 * cette fenêtre, privilégie strictement celle dont l'ancrage ou la géométrie
 * correspond à un corridor déjà enregistré dans route-cache.json.
 */

const {
  DEFAULT_ANCHOR_TOLERANCE_METERS,
  findCorridorsForSegment,
  anchorsMatch,
} = require('./registry');

/** Budget de tolérance flou par défaut : +5 % sur la meilleure durée. */
const DEFAULT_TOLERANCE_RATIO = 0.05;

/**
 * Vrai si l'option correspond au corridor : polygone/polyligne identique, ou
 * ancrage du corridor à proximité de la géométrie de la route (étapes).
 */
function optionMatchesCorridor(option, corridor, toleranceMeters = DEFAULT_ANCHOR_TOLERANCE_METERS) {
  if (corridor.polylineHint && option.polyline && corridor.polylineHint === option.polyline) {
    return true;
  }
  if (!corridor.anchor) {
    return false;
  }
  return (option.stepAnchors || []).some((stepAnchor) =>
    anchorsMatch(stepAnchor, corridor.anchor, toleranceMeters)
  );
}

/**
 * Évalue les routes candidates pour un segment et choisit la meilleure.
 *
 * @param {Array} routes Options normalisées retournées par routesApi.fetchRouteAlternatives.
 * @param {object} registry Registre chargé depuis route-cache.json.
 * @param {object} segment Extrémités du segment : { pointA: {lat,lng}, pointB: {lat,lng} }.
 * @param {object} [options]
 * @param {number} [options.toleranceRatio] Budget de tolérance flou (0.05 = +5 %).
 * @param {number} [options.anchorToleranceMeters] Rayon d'appariement des ancrages.
 * @returns {{ selected: object, candidates: Array, fastest: object, matchedCorridor: object|null, reason: string }}
 */
function optimizeSegment(routes, registry, segment, options = {}) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error('optimizeSegment requires at least one candidate route');
  }

  const toleranceRatio = options.toleranceRatio ?? DEFAULT_TOLERANCE_RATIO;
  const anchorToleranceMeters = options.anchorToleranceMeters ?? DEFAULT_ANCHOR_TOLERANCE_METERS;

  const fastest = routes.reduce((best, route) =>
    route.durationSeconds < best.durationSeconds ? route : best
  );
  const budgetSeconds = fastest.durationSeconds * (1 + toleranceRatio);

  const candidates = routes
    .filter((route) => route.durationSeconds <= budgetSeconds)
    .sort((a, b) => a.durationSeconds - b.durationSeconds);

  const segmentCorridors = findCorridorsForSegment(
    registry,
    segment.pointA,
    segment.pointB,
    anchorToleranceMeters
  );

  for (const candidate of candidates) {
    const matchedCorridor = segmentCorridors.find((corridor) =>
      optionMatchesCorridor(candidate, corridor, anchorToleranceMeters)
    );
    if (matchedCorridor) {
      return {
        selected: candidate,
        candidates,
        fastest,
        matchedCorridor,
        reason:
          `Biais registre : "${matchedCorridor.name}" (${matchedCorridor.id}) ` +
          `est viable dans le budget de tolérance (+${Math.round(toleranceRatio * 100)} %).`,
      };
    }
  }

  return {
    selected: candidates[0],
    candidates,
    fastest,
    matchedCorridor: null,
    reason: 'Aucun corridor enregistré viable : sélection de la route la plus rapide.',
  };
}

module.exports = {
  DEFAULT_TOLERANCE_RATIO,
  optionMatchesCorridor,
  optimizeSegment,
};
