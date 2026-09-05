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

/** Vrai si l'URL appelée est l'API Google Maps Routes (hôte exact). */
function isGoogleRoutesUrl(url) {
  return new URL(String(url)).hostname === 'routes.googleapis.com';
}

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
  assert.equal(result.osrmAlternatives, null);
  assert.ok(result.selected.stepAnchors.length === 2, 'steps conservés dans la sélection');

  // Réponse JSON : route recommandée + alternatives proposées à l'utilisateur.
  assert.equal(result.recommended.description, 'Chemin de Beloeil');
  assert.equal(result.recommended.source, 'google');
  assert.equal(result.recommended.matchedCorridorId, 'corridor-beloeil-home-work');
  assert.match(result.recommended.reason, /Biais registre/);
  assert.equal(
    result.recommended.googleMapsUrl,
    'https://www.google.com/maps/dir/?api=1&origin=45.5668%2C-73.2032&destination=45.5019%2C-73.5674' +
      '&travelmode=driving&waypoints=45.5403%2C-73.4466%7C45.52%2C-73.5'
  );
  assert.equal(result.alternatives.length, 1);
  assert.deepEqual(result.alternatives[0], {
    source: 'google',
    index: 0,
    description: 'A-40 rapide',
    durationSeconds: 1500,
    staticDurationSeconds: 1500,
    distanceMeters: 32000,
    deltaSeconds: -50,
    matchedCorridorId: null,
    googleMapsUrl:
      'https://www.google.com/maps/dir/?api=1&origin=45.5668%2C-73.2032&destination=45.5019%2C-73.5674' +
      '&travelmode=driving&waypoints=45.6%2C-73.5',
  });
});

test('planSegment detects high traffic and pulls faster alternatives from the OSRM matrix', async () => {
  const registryPath = tmpRegistryPath();
  const waypoint = { lat: 45.52, lng: -73.39 };

  const fetchImpl = async (url) => {
    if (isGoogleRoutesUrl(url)) {
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
  assert.deepEqual(result.osrmAlternatives, [{ viaIndex: 2, durationSeconds: 2100, gainSeconds: 300 }]);
  assert.equal(result.selected.source, 'osrm'); // l'alternative OSRM bat la route congestionnée
  assert.equal(result.selected.durationSeconds, 2100);
  assert.equal(result.matchedCorridor, null);
  assert.match(result.reason, /plus rapide/);

  // Réponse JSON : l'alternative OSRM est recommandée, la route Google congestionnée
  // et le corridor du registre restent proposés comme alternatives.
  assert.equal(result.recommended.source, 'osrm');
  assert.equal(result.recommended.durationSeconds, 2100);
  assert.equal(result.recommended.matchedCorridorId, null);
  assert.deepEqual(result.alternatives, [
    {
      source: 'google',
      index: 0,
      description: 'A-20 congestionnée',
      durationSeconds: 2400,
      staticDurationSeconds: 1500,
      distanceMeters: 33500,
      deltaSeconds: 300,
      matchedCorridorId: null,
      googleMapsUrl:
        'https://www.google.com/maps/dir/?api=1&origin=45.5668%2C-73.2032&destination=45.5019%2C-73.5674' +
        '&travelmode=driving&waypoints=45.6%2C-73.5',
    },
    {
      source: 'registry',
      corridorId: 'corridor-beloeil-home-work',
      name: 'Beloeil home-to-work route',
      class: 'preferred',
      anchor: { lat: 45.5403, lng: -73.4466 },
      feedbackCount: 3,
      lastUsedAt: '2026-09-01T12:30:00.000Z',
      durationSeconds: null,
      staticDurationSeconds: null,
      note: 'Corridor enregistré sans route retournée par l\u2019API pour ce segment.',
      googleMapsUrl:
        'https://www.google.com/maps/dir/?api=1&origin=45.5668%2C-73.2032&destination=45.5019%2C-73.5674' +
        '&travelmode=driving&waypoints=45.5403%2C-73.4466',
    },
  ]);
});

test('planSegment reroutes only the congested Google step range', async () => {
  const registryPath = tmpRegistryPath();
  const matrixWaypoint = { lat: 46, lng: -72 };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (isGoogleRoutesUrl(url)) {
      return {
        ok: true,
        json: async () => ({
          routes: [{
            description: 'Route avec bouchon local',
            duration: '1000s',
            staticDuration: '700s',
            distanceMeters: 30000,
            legs: [{
              startLocation: { latLng: { latitude: POINT_A.lat, longitude: POINT_A.lng } },
              steps: [
                {
                  startLocation: { latLng: { latitude: POINT_A.lat, longitude: POINT_A.lng } },
                  endLocation: { latLng: { latitude: 45.55, longitude: -73.3 } },
                  duration: '200s',
                  staticDuration: '200s',
                },
                {
                  startLocation: { latLng: { latitude: 45.55, longitude: -73.3 } },
                  endLocation: { latLng: { latitude: 45.52, longitude: -73.4 } },
                  duration: '500s',
                  staticDuration: '200s',
                },
                {
                  startLocation: { latLng: { latitude: 45.52, longitude: -73.4 } },
                  endLocation: { latLng: { latitude: POINT_B.lat, longitude: POINT_B.lng } },
                  duration: '300s',
                  staticDuration: '300s',
                },
              ],
            }],
          }],
        }),
      };
    }
    assert.match(String(url), /-73\.3,45\.55;-73\.4,45\.52/);
    assert.doesNotMatch(String(url), /46,-72/);
    return {
      ok: true,
      json: async () => ({
        code: 'Ok',
        durations: [[0, 200], [200, 0]],
      }),
    };
  };

  const result = await planSegment(POINT_A, POINT_B, {
    apiKey: 'demo',
    fetchImpl,
    registryPath,
    matrixWaypoints: [POINT_A, POINT_B, matrixWaypoint],
  });

  assert.equal(calls.length, 2);
  assert.equal(result.osrmAlternatives[0].durationSeconds, 700);
  assert.equal(result.recommended.source, 'osrm');
  assert.equal(result.recommended.durationSeconds, 700);
  assert.deepEqual(result.osrmAlternatives[0].segmentStart, { lat: 45.55, lng: -73.3 });
  assert.deepEqual(result.osrmAlternatives[0].segmentEnd, { lat: 45.52, lng: -73.4 });
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
  assert.equal(result.osrmAlternatives, null);
  assert.equal(calls.length, 1, 'un seul appel réseau (Google) — OSRM non sollicité');
  assert.ok(isGoogleRoutesUrl(calls[0]));
});

test('planSegment lists every option (Google, OSRM, registry) as alternatives for the user', async () => {
  const registryPath = tmpRegistryPath();
  const waypoint = { lat: 45.52, lng: -73.39 };

  const fetchImpl = async (url) => {
    if (isGoogleRoutesUrl(url)) {
      // Trafic élevé partout : la route du registre passe par le corridor préféré
      // (ancrage 45.5403,-73.4466) mais reste congestionnée (+40 %).
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
            {
              description: 'Chemin de Beloeil congestionné',
              duration: '2300s',
              staticDuration: '1600s',
              distanceMeters: 34000,
              polyline: { encodedPolyline: 'other' },
              legs: [{ steps: [{ endLocation: { latLng: { latitude: 45.5403, longitude: -73.4466 } } }] }],
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

  const result = await planSegment(POINT_A, POINT_B, {
    apiKey: 'demo',
    fetchImpl,
    registryPath,
    matrixWaypoints: [POINT_A, POINT_B, waypoint],
  });

  // L'OSRM l'emporte (2100 s), mais l'utilisateur peut choisir parmi toutes les sources.
  assert.equal(result.recommended.source, 'osrm');
  assert.deepEqual(
    result.alternatives.map((alt) => [alt.source, alt.description ?? alt.corridorId, alt.matchedCorridorId ?? null]),
    [
      ['google', 'Chemin de Beloeil congestionné', 'corridor-beloeil-home-work'],
      ['google', 'A-20 congestionnée', null],
    ]
  );
});
