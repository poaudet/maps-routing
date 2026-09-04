'use strict';

/**
 * Couche d'Apprentissage — Boucle de rétroaction.
 *
 * Quand l'utilisateur indique à l'agent qu'il a pris (ou préfère) une
 * nouvelle alternative non répertoriée, `updateRegistry` formate ce nouveau
 * corridor et l'ajoute de façon permanente au registre route-cache.json.
 * Un feedback répété sur un corridor existant renforce celui-ci
 * (feedbackCount) au lieu de créer un doublon.
 */

const {
  DEFAULT_REGISTRY_PATH,
  DEFAULT_ANCHOR_TOLERANCE_METERS,
  loadRegistry,
  saveRegistry,
  findCorridorsForSegment,
  anchorsMatch,
} = require('./registry');

const REQUIRED_FIELDS = ['pointA', 'pointB', 'anchor'];

function validateFeedback(feedbackData) {
  if (!feedbackData || typeof feedbackData !== 'object') {
    throw new Error('feedbackData must be an object');
  }
  for (const field of REQUIRED_FIELDS) {
    if (!feedbackData[field]) {
      throw new Error(`feedbackData.${field} is required`);
    }
  }
  for (const point of ['pointA', 'pointB']) {
    const anchor = feedbackData[point].anchor ?? feedbackData[point];
    if (typeof anchor.lat !== 'number' || typeof anchor.lng !== 'number') {
      throw new Error(`feedbackData.${point} must provide anchor coordinates {lat, lng}`);
    }
  }
  if (typeof feedbackData.anchor.lat !== 'number' || typeof feedbackData.anchor.lng !== 'number') {
    throw new Error('feedbackData.anchor must provide coordinates {lat, lng}');
  }
}

function normalizePoint(point) {
  const anchor = point.anchor ?? point;
  return {
    name: point.name ?? null,
    anchor: { lat: anchor.lat, lng: anchor.lng },
  };
}

/**
 * Enregistre le feedback utilisateur dans le registre.
 *
 * @param {object} feedbackData Données du feedback de l'utilisateur.
 * @param {{name?: string, anchor: {lat: number, lng: number}}} feedbackData.pointA Point A du segment.
 * @param {{name?: string, anchor: {lat: number, lng: number}}} feedbackData.pointB Point B du segment.
 * @param {{lat: number, lng: number}} feedbackData.anchor Ancrage exact du corridor emprunté.
 * @param {string} [feedbackData.name] Nom lisible du corridor.
 * @param {string} [feedbackData.class] Classe du corridor (défaut : "preferred").
 * @param {string} [feedbackData.polylineHint] Polyligne encodée de l'alternative choisie.
 * @param {string} [feedbackData.corridorClass] Alias accepté pour `class`.
 * @param {object} [options]
 * @param {string} [options.registryPath] Chemin du fichier route-cache.json.
 * @param {number} [options.anchorToleranceMeters] Rayon d'appariement pour détecter un corridor existant.
 * @param {Date} [options.now] Horodatage injectable (tests).
 * @returns {{ corridor: object, created: boolean, registryPath: string }} Le corridor créé ou renforcé.
 */
function updateRegistry(feedbackData, options = {}) {
  validateFeedback(feedbackData);

  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const anchorToleranceMeters = options.anchorToleranceMeters ?? DEFAULT_ANCHOR_TOLERANCE_METERS;
  const now = options.now ?? new Date();

  const registry = loadRegistry(registryPath);
  const pointA = normalizePoint(feedbackData.pointA);
  const pointB = normalizePoint(feedbackData.pointB);

  // Feedback répété : renforcer le corridor existant plutôt que créer un doublon.
  const existing = findCorridorsForSegment(registry, pointA.anchor, pointB.anchor, anchorToleranceMeters).find(
    (corridor) => anchorsMatch(corridor.anchor, feedbackData.anchor, anchorToleranceMeters)
  );

  if (existing) {
    existing.feedbackCount = (existing.feedbackCount ?? 1) + 1;
    existing.lastUsedAt = now.toISOString();
    if (feedbackData.polylineHint) {
      existing.polylineHint = feedbackData.polylineHint;
    }
    if (feedbackData.name) {
      existing.name = feedbackData.name;
    }
    saveRegistry(registry, registryPath);
    return { corridor: existing, created: false, registryPath };
  }

  const corridor = {
    id:
      feedbackData.id ??
      `corridor-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name:
      feedbackData.name ??
      `${pointA.name ?? 'Point A'} → ${pointB.name ?? 'Point B'}`,
    class: feedbackData.class ?? feedbackData.corridorClass ?? 'preferred',
    between: { pointA, pointB },
    anchor: { lat: feedbackData.anchor.lat, lng: feedbackData.anchor.lng },
    polylineHint: feedbackData.polylineHint ?? null,
    feedbackCount: 1,
    lastUsedAt: now.toISOString(),
  };

  registry.corridors.push(corridor);
  saveRegistry(registry, registryPath);
  return { corridor, created: true, registryPath };
}

module.exports = { updateRegistry, validateFeedback };
