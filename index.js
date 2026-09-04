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

const { loadRegistry, DEFAULT_REGISTRY_PATH } = require('./src/registry');
const { fetchRouteAlternatives } = require('./src/routesApi');
const { optimizeSegment } = require('./src/optimizer');
const { updateRegistry } = require('./src/learning');

/**
 * Évalue un segment entre deux points intermédiaires et retourne l'option
 * privilégiant les corridors connus de l'utilisateur.
 */
async function planSegment(pointA, pointB, options = {}) {
  const registry = loadRegistry(options.registryPath ?? DEFAULT_REGISTRY_PATH);
  const routes = await fetchRouteAlternatives(pointA, pointB, options);
  return optimizeSegment(routes, registry, { pointA, pointB }, options);
}

module.exports = {
  planSegment,
  updateRegistry,
  registry: require('./src/registry'),
  routesApi: require('./src/routesApi'),
  optimizer: require('./src/optimizer'),
};
