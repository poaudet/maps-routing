'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isCoordinates, resolvePlace, resolvePlaces } = require('../src/geocode');

const BELOEIL = { lat: 45.5668, lng: -73.2032 };

test('isCoordinates accepts {lat, lng} and rejects names or invalid shapes', () => {
  assert.equal(isCoordinates(BELOEIL), true);
  assert.equal(isCoordinates({ ...BELOEIL, name: 'Beloeil' }), true);
  assert.equal(isCoordinates('Beloeil'), false);
  assert.equal(isCoordinates({ name: 'Beloeil' }), false);
  assert.equal(isCoordinates({ lat: 45.5 }), false);
  assert.equal(isCoordinates(null), false);
});

test('resolvePlace returns {lat, lng} unchanged without any network call', async () => {
  const fetchImpl = async () => {
    throw new Error('fetch should not be called for coordinates');
  };
  const resolved = await resolvePlace(BELOEIL, { apiKey: 'demo', fetchImpl });
  assert.deepEqual(resolved, { lat: 45.5668, lng: -73.2032, name: null });
});

test('resolvePlace keeps the name of named coordinates', async () => {
  const resolved = await resolvePlace({ ...BELOEIL, name: 'Beloeil' }, { apiKey: 'demo' });
  assert.deepEqual(resolved, { lat: 45.5668, lng: -73.2032, name: 'Beloeil' });
});

test('resolvePlace resolves a place name through the Geocoding API', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => ({
        status: 'OK',
        results: [
          {
            formatted_address: 'Beloeil, QC, Canada',
            geometry: { location: { lat: 45.5668, lng: -73.2032 } },
          },
        ],
      }),
    };
  };

  const resolved = await resolvePlace('Beloeil', { apiKey: 'demo', fetchImpl });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('address=Beloeil'));
  assert.ok(calls[0].includes('key=demo'));
  assert.deepEqual(resolved, { lat: 45.5668, lng: -73.2032, name: 'Beloeil, QC, Canada' });
});

test('resolvePlace resolves a {name} object', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      status: 'OK',
      results: [
        {
          formatted_address: 'Montreal, QC, Canada',
          geometry: { location: { lat: 45.5019, lng: -73.5674 } },
        },
      ],
    }),
  });

  const resolved = await resolvePlace({ name: 'Montreal Downtown' }, { apiKey: 'demo', fetchImpl });
  assert.deepEqual(resolved, { lat: 45.5019, lng: -73.5674, name: 'Montreal, QC, Canada' });
});

test('resolvePlace throws when the place cannot be resolved', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ status: 'ZERO_RESULTS', results: [] }),
  });
  await assert.rejects(() => resolvePlace('Nowhere Land', { apiKey: 'demo', fetchImpl }), /ZERO_RESULTS/);
});

test('resolvePlace throws on API HTTP errors and invalid inputs', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'denied' });
  await assert.rejects(() => resolvePlace('Beloeil', { apiKey: 'demo', fetchImpl }), /403/);
  await assert.rejects(() => resolvePlace({}), /must be a name/);
  await assert.rejects(() => resolvePlace('Beloeil'), /API key/);
});

test('resolvePlaces resolves names and coordinates in parallel', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      status: 'OK',
      results: [
        {
          formatted_address: 'Montreal, QC, Canada',
          geometry: { location: { lat: 45.5019, lng: -73.5674 } },
        },
      ],
    }),
  });

  const [a, b] = await resolvePlaces([BELOEIL, 'Montreal'], { apiKey: 'demo', fetchImpl });
  assert.deepEqual(a, { lat: 45.5668, lng: -73.2032, name: null });
  assert.deepEqual(b, { lat: 45.5019, lng: -73.5674, name: 'Montreal, QC, Canada' });
});
