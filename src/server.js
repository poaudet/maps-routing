'use strict';

/**
 * API REST — serveur HTTP du skill de micro-reroutage.
 *
 * Expose les couches du skill en JSON sur HTTP, sans dépendance externe
 * (module node:http). La sortie console est préservée : chaque requête est
 * journalisée, le résultat de chaque planification (route recommandée +
 * alternatives) est affiché, et le journal de débogage des couches reste
 * actif (option `debug` ou variable d'environnement MAPS_ROUTING_DEBUG).
 *
 * Points d'entrée :
 *   GET  /health     → { status: 'ok' }
 *   GET  /corridors  → { corridors: [...] } (registre route-cache.json)
 *   POST /plan       → { pointA, pointB, ...options }
 *                      Réponse planSegment : { recommended, alternatives, ... }
 *                      pointA/pointB acceptent coordonnées {lat,lng} ou noms
 *                      de lieux ("Beloeil", { "name": "Beloeil" }).
 *   POST /feedback   → { pointA, pointB, anchor, name?, ... }
 *                      Réponse updateRegistry : { corridor, created, registryPath }
 */

const http = require('node:http');

const { loadRegistry, DEFAULT_REGISTRY_PATH } = require('./registry');
const { updateRegistry } = require('./learning');

const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 1024 * 1024;

/** Envoie une réponse JSON (Content-Type application/json). */
function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Lit et parse le corps JSON d'une requête (limite : MAX_BODY_BYTES). */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Affiche sur la console la route recommandée et les alternatives d'une planification. */
function consoleLogPlan(result) {
  console.log(
    `[maps-routing:rest] Route recommandée : ${result.recommended.description} ` +
      `(${result.recommended.durationSeconds ?? '?'} s) — ${result.recommended.reason}`
  );
  for (const alt of result.alternatives) {
    console.log(
      `[maps-routing:rest] Alternative [${alt.source}] ` +
        `${alt.description ?? alt.name ?? alt.corridorId} (${alt.durationSeconds ?? '?'} s)`
    );
  }
}

/**
 * Crée le serveur HTTP de l'API REST (sans lancer l'écoute).
 *
 * @param {object} [options] Options propagées à planSegment / updateRegistry
 *   (apiKey, registryPath, debug, fetchImpl pour les tests, etc.).
 * @returns {http.Server}
 */
function createServer(options = {}) {
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const { planSegment } = require('..');

  const routes = {
    'GET /health': (req, res) => sendJson(res, 200, { status: 'ok' }),
    'GET /corridors': (req, res) => {
      const registry = loadRegistry(registryPath);
      sendJson(res, 200, registry);
    },
    'POST /plan': async (req, res) => {
      const body = await readJsonBody(req);
      if (body.pointA === undefined || body.pointB === undefined) {
        sendJson(res, 400, {
          error: 'pointA and pointB are required (coordinates {lat, lng} or place names)',
        });
        return;
      }
      const {
        pointA,
        pointB,
        matrixWaypoints,
        toleranceRatio,
        congestionRatio,
        anchorToleranceMeters,
        osrmBaseUrl,
        geocodeBaseUrl,
        debug,
      } = body;
      const callOptions = {
        ...options,
        matrixWaypoints,
        toleranceRatio,
        congestionRatio,
        anchorToleranceMeters,
        osrmBaseUrl,
        geocodeBaseUrl,
        debug: debug ?? options.debug,
      };
      const result = await planSegment(pointA, pointB, callOptions);
      consoleLogPlan(result);
      sendJson(res, 200, result);
    },
    'POST /feedback': async (req, res) => {
      const body = await readJsonBody(req);
      const result = updateRegistry(body, options);
      console.log(
        `[maps-routing:rest] Feedback enregistré : ${result.corridor.name} ` +
          `(${result.corridor.id}, ${result.created ? 'créé' : 'renforcé'})`
      );
      sendJson(res, result.created ? 201 : 200, result);
    },
  };

  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const routeKey = `${req.method} ${pathname}`;
    console.log(`[maps-routing:rest] ${req.method} ${pathname}`);
    try {
      const handler = routes[routeKey];
      if (!handler) {
        sendJson(res, 404, { error: 'Not found', path: pathname, method: req.method });
        return;
      }
      await handler(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[maps-routing:rest] Erreur sur ${routeKey} : ${message}`);
      const statusCode = /required|must be|Invalid|too large/i.test(message) ? 400 : 500;
      sendJson(res, statusCode, { error: message });
    }
  });
}

/**
 * Crée le serveur et le met en écoute.
 *
 * @param {object} [options] Options propagées à createServer.
 * @param {number} [options.port] Port d'écoute (défaut : 3000).
 * @returns {Promise<http.Server>} Serveur en écoute.
 */
function startServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const server = createServer(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      console.log(
        `[maps-routing:rest] API REST en écoute sur http://localhost:${port} ` +
          '(GET /health, GET /corridors, POST /plan, POST /feedback)'
      );
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer({ port: Number(process.env.PORT) || DEFAULT_PORT });
}

module.exports = { createServer, startServer, DEFAULT_PORT };
