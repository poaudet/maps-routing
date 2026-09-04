'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planSegment } = require('../index');
const { detectHighTraffic } = require('../src/routesApi');

const POINT_A = { lat: 45.5668, lng: -73.2032 };
const POINT_B = { lat: 45.5019, lng: -73.5674 };

function tmpRegistryPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-segment-'));
  const registryPath = path.join(dir, 'route-cache.json');
  fs.copyFileSync(path.join(__dirname, '..', 'route-cache.json'), registryPath);
  return registryPath;
}

/**
 * Réponse typique de l'API Google Maps Directions/Routes : durée en temps
 * réel (duration), durée free-flow (staticDuration) et étapes (steps).
 */
function googleRoutesResponse({ duration, staticDuration, description }) {
  return {
    description,
    duration: `${duration}s`,
    staticDuration: `${staticDuration}s`,
    distanceMeters: 33500,
    polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
    legs: [
      {
        steps: [
          {
            endLocation: { latLng: { latitude: 45.5403, longitude: -73.4466 } },
            navigationInstruction: { maneuver: 'MERGE', instructions: 'Merge onto A-20 E' },
          },
          {
            endLocation: { latLng: { latitude: 45.52, longitude: -73.5 } },
            navigationInstruction: { maneuver: 'EXIT', instructions: 'Take exit 90' },
          },
        ],
      },
    ],
  };
}

test('detectHighTraffic compares duration to free-flow staticDuration', () => {
  const fluid = { durationSeconds: 1500, staticDurationSeconds: 1500 };
  const busy = { durationSeconds: 2200, staticDurationSeconds: 1500 }; // +47 %
  assert.equal(detectHighTraffic(fluid).congested, false);
  assert.equal(detectHighTraffic(busy).congested, true);
  assert.equal(detectHighTraffic(busy).delaySeconds, 700);
  assert.equal(detectHighTraffic(busy, 0.5).congested, false); // seuil personnalisé
});

test('planSegment selects the registered corridor from a mocked Google response (fluid traffic)', async () => {
  const registryPath = tmpRegistryPath();
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      routes: [
        // Route la plus rapide mais inconnue du registre.
        {
          description: 'A-40 rapide',
          duration: '1500s',
          staticDuration: '1500s',
          distanceMeters: 32000,
          polyline: { encodedPolyline: 'unknown' },
          legs: [{ steps: [{ endLocation: { latLng: { latitude: 45.6, longitude: -73.5 } } }] }],
        },
        // Corridor préféré : +3.3 % → dans le budget de tolérance de +5 %.
        googleRoutesResponse({ duration: 1550, staticDuration: 1500, description: 'Chemin de Beloeil' }),
      ],
    }),
  });

  const result = await planSegment(POINT_A, POINT_B, { apiKey: 'demo', fetchImpl, registryPath });

  assert.equal(result.selected.description, 'Chemin de Beloeil');
  assert.equal(result.matchedCorridor.id, 'corridor-beloeil-home-work');
  assert.match(result.reason, /Biais registre/);
  assert.equal(result.traffic.congested, false); // pas de trafic élevé → pas d'appel OSRM
  assert.equal(result.alternatives, null);
  assert.ok(result.selected.stepAnchors.length === 2, 'steps conservés dans la sélection');
});

test('planSegment detects high traffic and pulls faster alternatives from the OSRM matrix', async () => {
  const registryPath = tmpRegistryPath();
  const waypoint = { lat: 45.52, lng: -73.39 };

  const fetchImpl = async (url) => {
    if (String(url).includes('routes.googleapis.com')) {
      // Trafic élevé : duration 2400 s vs staticDuration 1500 s (+60 %).
      return {
        ok: true,
        json: async () => ({
          routes: [
            {
              description: 'A-20 congestionnée',
              duration: '2400s',
              staticDuration: '1500s',
              distanceMeters: 33500,
              polyline: { encodedPolyline: 'congested' },
              legs: [{ steps: [{ endLocation: { latLng: { latitude: 45.6, longitude: -73.5 } } }] }],
            },
          ],
        }),
      };
    }
    // Matrice OSRM (asymétrique) : origin → waypoint (900) + waypoint → destination (1200) = 2100 s.
    assert.ok(String(url).includes('/table/v1/driving/'));
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

  const result = await planSegment(POINT_A, POINT_B, {
    apiKey: 'demo',
    fetchImpl,
    registryPath,
    matrixWaypoints: [POINT_A, POINT_B, waypoint],
  });

  assert.equal(result.traffic.congested, true);
  assert.equal(result.traffic.delaySeconds, 900);
  assert.deepEqual(result.alternatives, [{ viaIndex: 2, durationSeconds: 2100, gainSeconds: 300 }]);
  assert.equal(result.selected.source, 'osrm'); // l'alternative OSRM bat la route congestionnée
  assert.equal(result.selected.durationSeconds, 2100);
  assert.equal(result.matchedCorridor, null);
  assert.match(result.reason, /plus rapide/);
});

test('planSegment skips the OSRM matrix when traffic stays under the congestion threshold', async () => {
  const registryPath = tmpRegistryPath();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => ({
        routes: [
          googleRoutesResponse({ duration: 1600, staticDuration: 1500, description: 'Fluide' }), // +6.7 %
        ],
      }),
    };
  };

  const result = await planSegment(POINT_A, POINT_B, { apiKey: 'demo', fetchImpl, registryPath });

  assert.equal(result.traffic.congested, false);
  assert.equal(result.alternatives, null);
  assert.equal(calls.length, 1, 'un seul appel réseau (Google) — OSRM non sollicité');
  assert.ok(calls[0].includes('routes.googleapis.com'));
});
