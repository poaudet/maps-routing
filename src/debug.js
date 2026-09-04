'use strict';

/**
 * Journal de débogage du skill de routage.
 *
 * Désactivé par défaut. Activé globalement via la variable d'environnement
 * MAPS_ROUTING_DEBUG (truthy), ou par appel via l'option `debug` (booléen ou
 * fonction de journalisation) transmise aux couches du skill. Les messages
 * sont préfixés par couche : [google], [osrm], [optimizer], [learning],
 * [registry], [planSegment].
 */

function isTruthy(value) {
  return (
    value === true ||
    typeof value === 'function' ||
    (typeof value === 'string' && !['', '0', 'false', 'off'].includes(value.toLowerCase()))
  );
}

/** Vrai si le débogage est actif (option d'appel ou variable d'environnement). */
function isDebugEnabled(options = {}) {
  return isTruthy(options.debug) || isTruthy(process.env.MAPS_ROUTING_DEBUG);
}

/**
 * Écrit un message de débogage si activé.
 *
 * @param {string} layer Couche émettrice (ex: 'google', 'osrm', 'optimizer').
 * @param {object} [options] Options d'appel propagées (`debug`).
 * @param {string} message Message lisible.
 * @param {*} [data] Données optionnelles sérialisées en JSON (réponses, etc.).
 */
function debugLog(layer, options, message, data) {
  if (!isDebugEnabled(options)) {
    return;
  }
  const sink = typeof options.debug === 'function' ? options.debug : console.error;
  const line = `[maps-routing:${layer}] ${message}`;
  if (data === undefined) {
    sink(line);
  } else {
    sink(`${line} ${JSON.stringify(data)}`);
  }
}

module.exports = { isDebugEnabled, debugLog };
