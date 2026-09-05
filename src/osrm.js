'use strict';

/**
 * Matrice d'alternatives — OSRM (ou autre fournisseur compatible).
 *
 * Quand la couche d'interrogation détecte un trafic élevé (duration ≫
 * staticDuration), le skill interroge le service table d'OSRM pour obtenir
 * une matrice de durées entre les points intermédiaires et dénicher des
 * alternatives à réacheminer vers l'optimiseur.
 */

const { debugLog } = require('./debug');

const DEFAULT_OSRM_BASE_URL = 'https://router.project-osrm.org';

/** Normalise une coordonnée {lat, lng} (OSRM attend lng,lat). */
function toOsrmCoordinate(point) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    throw new Error(`Invalid OSRM waypoint coordinates: ${JSON.stringify(point)}`);
  }
  return `${point.lng},${point.lat}`;
}

/**
 * Récupère une matrice de durées (secondes) entre points intermédiaires via
 * l'API table d'OSRM.
 *
 * @param {Array<{lat: number, lng: number}>} coordinates Points intermédiaires (min. 2).
 * @param {object} [options]
 * @param {string} [options.baseUrl] URL de base du serveur OSRM (ou autre fournisseur).
 * @param {typeof fetch} [options.fetchImpl] Implémentation de fetch (injectable pour les tests).
 * @returns {Promise<{durations: number[][], sources: Array, destinations: Array}>}
 */
async function fetchAlternativesMatrix(coordinates, options = {}) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error('fetchAlternativesMatrix requires at least 2 waypoints');
  }
  const baseUrl = options.baseUrl ?? DEFAULT_OSRM_BASE_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const coords = coordinates.map(toOsrmCoordinate).join(';');
  const url = `${baseUrl}/table/v1/driving/${coords}?annotations=duration`;

  debugLog('osrm', options, 'Requête table', { url, waypoints: coordinates });

  const response = await fetchImpl(url);
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    debugLog('osrm', options, `Erreur API ${response.status}`, details);
    throw new Error(`OSRM table API error ${response.status}: ${details}`);
  }

  const payload = await response.json();
  debugLog('osrm', options, 'Réponse table', payload);
  if (payload.code !== 'Ok' || !Array.isArray(payload.durations)) {
    throw new Error(`OSRM table API unexpected response: ${payload.code ?? 'no code'}`);
  }

  return {
    durations: payload.durations,
    sources: payload.sources ?? [],
    destinations: payload.destinations ?? [],
  };
}

/**
 * Compare la durée de l'itinéraire actuel à la matrice OSRM et retourne les
 * alternatives plus rapides que `currentDurationSeconds` (défaut : meilleure
 * durée directe origine → destination de la matrice).
 *
 * @param {number[][]} durations Matrice de durées OSRM (lignes = sources).
 *   Convention : indice 0 = origine, indice 1 = destination, les autres
 *   indices sont des points intermédiaires candidats.
 * @param {object} [options]
 * @param {number} [options.originIndex] Indice du point de départ (défaut : 0).
 * @param {number} [options.destinationIndex] Indice du point d'arrivée (défaut : 1).
 * @param {number} [options.currentDurationSeconds] Durée de référence à battre
 *   (défaut : durée directe origine → destination de la matrice).
 * @param {boolean} [options.includeDirect] Inclut la liaison directe comme
 *   alternative (utile quand la matrice ne contient que les bornes d'un
 *   segment congestionné).
 * @returns {Array<{viaIndex: number, durationSeconds: number, gainSeconds: number}>}
 *   Alternatives triées par durée croissante.
 */
function rankMatrixAlternatives(durations, options = {}) {
  if (!Array.isArray(durations) || durations.length < 2) {
    throw new Error('rankMatrixAlternatives requires a durations matrix with at least 2 entries');
  }
  const originIndex = options.originIndex ?? 0;
  const destinationIndex = options.destinationIndex ?? 1;
  const reference =
    options.currentDurationSeconds ?? durations[originIndex]?.[destinationIndex];

  if (!Number.isFinite(reference)) {
    debugLog('osrm', options, 'Aucune durée de référence valide dans la matrice');
    return [];
  }

  const alternatives = [];
  const directDuration = durations[originIndex]?.[destinationIndex];
  if (options.includeDirect && Number.isFinite(directDuration) && directDuration < reference) {
    alternatives.push({
      viaIndex: null,
      durationSeconds: directDuration,
      gainSeconds: reference - directDuration,
    });
  }
  for (let via = 0; via < durations.length; via += 1) {
    if (via === originIndex || via === destinationIndex) {
      continue;
    }
    const legA = durations[originIndex]?.[via];
    const legB = durations[via]?.[destinationIndex];
    if (!Number.isFinite(legA) || !Number.isFinite(legB)) {
      continue;
    }
    const durationSeconds = legA + legB;
    if (durationSeconds < reference) {
      alternatives.push({
        viaIndex: via,
        durationSeconds,
        gainSeconds: reference - durationSeconds,
      });
    }
  }
  const ranked = alternatives.sort((a, b) => a.durationSeconds - b.durationSeconds);
  debugLog('osrm', options, 'Alternatives classées', { referenceSeconds: reference, alternatives: ranked });
  return ranked;
}

module.exports = {
  DEFAULT_OSRM_BASE_URL,
  fetchAlternativesMatrix,
  rankMatrixAlternatives,
};
