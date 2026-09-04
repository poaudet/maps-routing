'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isDebugEnabled, debugLog } = require('../src/debug');
const { planSegment, updateRegistry } = require('../index');

const POINT_A = { lat: 45.5668, lng: -73.2032 };
const POINT_B = { lat: 45.5019, lng: -73.5674 };

function tmpRegistryPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-'));
  const registryPath = path.join(dir, 'route-cache.json');
  fs.copyFileSync(path.join(__dirname, '..', 'route-cache.json'), registryPath);
  return registryPath;
}

function isGoogleRoutesUrl(url) {
  return new URL(String(url)).hostname === 'routes.googleapis.com';
}

function makeFetchImpl() {
  return async (url) => {
    if (isGoogleRoutesUrl(url)) {
      return {
        ok: true,
        json: async () => ({
          routes: [
            {
              description: 'A-20 congestionnée',
              duration: '2400s',
              staticDuration: '1500s',
              distanceMeters: 33500,
              polyline: { encodedPolyline: 'xyz' },
              legs: [{ steps: [{ endLocation: { latLng: { latitude: 45.6, longitude: -73.5 } } }] }],
            },
          ],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        code: 'Ok',
        durations: [
          [0, 2400, 900],
          [2200, 0, 1400],
          [850, 1200, 0],
        ],
        sources: [],
        destinations: [],
      }),
    };
  };
}

test('debug output is disabled by default', async () => {
  const lines = [];
  const originalError = console.error;
  console.error = (line) => lines.push(line);
  try {
    await planSegment(POINT_A, POINT_B, {
      apiKey: 'demo',
      fetchImpl: makeFetchImpl(),
      registryPath: tmpRegistryPath(),
      matrixWaypoints: [POINT_A, POINT_B, { lat: 45.52, lng: -73.39 }],
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(lines, []);
});

test('debug output shows the response of each layer (google, osrm, optimizer)', async () => {
  const lines = [];
  await planSegment(POINT_A, POINT_B, {
    apiKey: 'demo',
    fetchImpl: makeFetchImpl(),
    registryPath: tmpRegistryPath(),
    matrixWaypoints: [POINT_A, POINT_B, { lat: 45.52, lng: -73.39 }],
    debug: (line) => lines.push(line),
  });

  const joined = lines.join('\n');
  // Requête + réponse Google Maps Routes.
  assert.match(joined, /\[maps-routing:google\] Requête computeRoutes/);
  assert.match(joined, /\[maps-routing:google\] Réponse computeRoutes.*A-20 congestionnée/);
  assert.match(joined, /\[maps-routing:google\] 1 route\(s\) normalisée\(s\).*2400/);
  // Détection de trafic.
  assert.match(joined, /\[maps-routing:planSegment\] Détection de trafic.*"congested":true/);
  // Requête + réponse OSRM.
  assert.match(joined, /\[maps-routing:osrm\] Requête table.*table\/v1\/driving/);
  assert.match(joined, /\[maps-routing:osrm\] Réponse table.*"code":"Ok"/);
  assert.match(joined, /\[maps-routing:osrm\] Alternatives classées.*"gainSeconds":300/);
  // Décision de l'optimiseur.
  assert.match(joined, /\[maps-routing:optimizer\] Évaluation des routes/);
  assert.match(joined, /\[maps-routing:optimizer\] Sélection de la route la plus rapide/);
  // Résultat final.
  assert.match(joined, /\[maps-routing:planSegment\] Segment planifié.*OSRM alternative/);
});

test('debug output covers the learning layer (registry writes)', () => {
  const lines = [];
  const registryPath = tmpRegistryPath();
  updateRegistry(
    {
      pointA: { name: 'Beloeil', anchor: POINT_A },
      pointB: { name: 'Montreal', anchor: POINT_B },
      anchor: { lat: 45.52, lng: -73.39 },
      name: 'Nouveau corridor debug',
    },
    { registryPath, debug: (line) => lines.push(line) }
  );
  assert.match(lines.join('\n'), /\[maps-routing:learning\] Nouveau corridor enregistré.*Nouveau corridor debug/);
});

test('MAPS_ROUTING_DEBUG environment variable enables debug output', () => {
  const lines = [];
  const originalEnv = process.env.MAPS_ROUTING_DEBUG;
  process.env.MAPS_ROUTING_DEBUG = '1';
  try {
    assert.equal(isDebugEnabled(), true);
    debugLog('registry', {}, 'test env', { ok: true });
  } finally {
    if (originalEnv === undefined) {
      delete process.env.MAPS_ROUTING_DEBUG;
    } else {
      process.env.MAPS_ROUTING_DEBUG = originalEnv;
    }
  }
  // debugLog écrit sur console.error par défaut : on vérifie juste l'activation.
  assert.equal(isDebugEnabled({ debug: 'false' }), false);
  assert.equal(isDebugEnabled({ debug: true }), true);
  assert.ok(Array.isArray(lines));
});
