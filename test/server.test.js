'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../src/server');

const POINT_A = { lat: 45.5668, lng: -73.2032 };
const POINT_B = { lat: 45.5019, lng: -73.5674 };

function tmpRegistryPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
  const registryPath = path.join(dir, 'route-cache.json');
  fs.copyFileSync(path.join(__dirname, '..', 'route-cache.json'), registryPath);
  return registryPath;
}

/** Démarre le serveur sur un port éphémère et retourne { server, baseUrl }. */
async function listen(options) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/** fetchImpl factice : géocodage + Google Maps Routes (trafic fluide). */
function fakeFetchImpl({ calls = [] } = {}) {
  return async (url) => {
    const href = String(url);
    calls.push(href);
    if (new URL(href).hostname === 'maps.googleapis.com') {
      const address = new URL(href).searchParams.get('address');
      const coords =
        address === 'Beloeil'
          ? { lat: 45.5668, lng: -73.2032 }
          : { lat: 45.5019, lng: -73.5674 };
      return {
        ok: true,
        json: async () => ({
          status: 'OK',
          results: [
            { formatted_address: `${address}, QC, Canada`, geometry: { location: coords } },
          ],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        routes: [
          {
            description: 'A-40 rapide',
            duration: '1500s',
            staticDuration: '1500s',
            distanceMeters: 32000,
            polyline: { encodedPolyline: 'unknown' },
            legs: [{ steps: [{ endLocation: { latLng: { latitude: 45.6, longitude: -73.5 } } }] }],
          },
          {
            description: 'Chemin de Beloeil',
            duration: '1550s',
            staticDuration: '1500s',
            distanceMeters: 33500,
            polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
            legs: [{ steps: [{ endLocation: { latLng: { latitude: 45.5403, longitude: -73.4466 } } }] }],
          },
        ],
      }),
    };
  };
}

test('GET /health returns a JSON ok status', async () => {
  const { server, baseUrl } = await listen({ registryPath: tmpRegistryPath() });
  try {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    server.close();
  }
});

test('POST /plan returns a JSON response with recommended route and alternatives', async () => {
  const calls = [];
  const { server, baseUrl } = await listen({
    apiKey: 'demo',
    registryPath: tmpRegistryPath(),
    fetchImpl: fakeFetchImpl({ calls }),
  });
  try {
    const response = await fetch(`${baseUrl}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointA: POINT_A, pointB: POINT_B }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);

    const body = await response.json();
    assert.equal(body.recommended.description, 'Chemin de Beloeil');
    assert.equal(body.recommended.source, 'google');
    assert.equal(body.recommended.matchedCorridorId, 'corridor-beloeil-home-work');
    assert.match(body.recommended.reason, /Biais registre/);
    assert.equal(body.alternatives.length, 1);
    assert.equal(body.alternatives[0].description, 'A-40 rapide');
    assert.equal(body.alternatives[0].deltaSeconds, -50);
    assert.deepEqual(body.points, { pointA: { ...POINT_A, name: null }, pointB: { ...POINT_B, name: null } });
    // Trafic fluide : aucun appel de géocodage ni OSRM.
    assert.equal(calls.length, 1);
  } finally {
    server.close();
  }
});

test('POST /plan accepts place names instead of GPS coordinates', async () => {
  const calls = [];
  const { server, baseUrl } = await listen({
    apiKey: 'demo',
    registryPath: tmpRegistryPath(),
    fetchImpl: fakeFetchImpl({ calls }),
  });
  try {
    const response = await fetch(`${baseUrl}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointA: 'Beloeil', pointB: { name: 'Montreal Downtown' } }),
    });
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.deepEqual(body.points, {
      pointA: { lat: 45.5668, lng: -73.2032, name: 'Beloeil, QC, Canada' },
      pointB: { lat: 45.5019, lng: -73.5674, name: 'Montreal Downtown, QC, Canada' },
    });
    assert.equal(body.recommended.description, 'Chemin de Beloeil');
    assert.equal(body.alternatives.length, 1);
    // 2 géocodages + 1 computeRoutes.
    assert.equal(calls.length, 3);
    assert.ok(calls.filter((url) => url.includes('geocode')).length === 2);
  } finally {
    server.close();
  }
});

test('POST /plan returns 400 when pointA or pointB is missing', async () => {
  const { server, baseUrl } = await listen({ apiKey: 'demo', registryPath: tmpRegistryPath() });
  try {
    const response = await fetch(`${baseUrl}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointA: POINT_A }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /pointA and pointB/);
  } finally {
    server.close();
  }
});

test('POST /plan returns a JSON error when planning fails', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const { server, baseUrl } = await listen({
    apiKey: 'demo',
    registryPath: tmpRegistryPath(),
    fetchImpl,
  });
  try {
    const response = await fetch(`${baseUrl}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointA: POINT_A, pointB: POINT_B }),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.error, /500/);
  } finally {
    server.close();
  }
});

test('POST /feedback registers a corridor and returns JSON', async () => {
  const registryPath = tmpRegistryPath();
  const { server, baseUrl } = await listen({ registryPath });
  try {
    const response = await fetch(`${baseUrl}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pointA: { name: 'Beloeil', anchor: POINT_A },
        pointB: { name: 'Montreal Downtown', anchor: POINT_B },
        anchor: { lat: 45.52, lng: -73.39 },
        name: 'Nouvelle alternative Rive-Sud',
      }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.created, true);
    assert.equal(body.corridor.name, 'Nouvelle alternative Rive-Sud');
    assert.equal(body.registryPath, registryPath);

    // Le corridor est bien persisté dans le registre.
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.ok(registry.corridors.some((corridor) => corridor.name === 'Nouvelle alternative Rive-Sud'));
  } finally {
    server.close();
  }
});

test('GET /corridors returns the registry as JSON', async () => {
  const { server, baseUrl } = await listen({ registryPath: tmpRegistryPath() });
  try {
    const response = await fetch(`${baseUrl}/corridors`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.corridors));
    assert.ok(body.corridors.some((corridor) => corridor.id === 'corridor-beloeil-home-work'));
  } finally {
    server.close();
  }
});

test('GET /web returns the HTML UI for the plan endpoint', async () => {
  const { server, baseUrl } = await listen({ registryPath: tmpRegistryPath() });
  try {
    const response = await fetch(`${baseUrl}/web`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const body = await response.text();
    assert.match(body, /<!DOCTYPE html>/i);
    assert.match(body, /\/plan/);
    assert.match(body, /pointA/);
    assert.match(body, /pointB/);
  } finally {
    server.close();
  }
});

test('unknown routes return a JSON 404', async () => {
  const { server, baseUrl } = await listen({ registryPath: tmpRegistryPath() });
  try {
    const response = await fetch(`${baseUrl}/nope`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.match(body.error, /Not found/);
  } finally {
    server.close();
  }
});
