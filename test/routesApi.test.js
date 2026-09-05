'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROUTES_API_URL,
  FIELD_MASK,
  parseDurationSeconds,
  toDepartureTimeString,
  normalizeRoute,
  findCongestedStepRanges,
  fetchRouteAlternatives,
} = require('../src/routesApi');

const ORIGIN = { lat: 45.5668, lng: -73.2032 };
const DESTINATION = { lat: 45.5019, lng: -73.5674 };

test('field mask targets duration and staticDuration', () => {
  assert.ok(FIELD_MASK.includes('routes.duration'));
  assert.ok(FIELD_MASK.includes('routes.staticDuration'));
  assert.ok(FIELD_MASK.includes('routes.legs.steps.staticDuration'));
  assert.ok(!FIELD_MASK.includes('routes.legs.steps.duration'));
});

test('parseDurationSeconds accepts protobuf strings and numbers', () => {
  assert.equal(parseDurationSeconds('1234s'), 1234);
  assert.equal(parseDurationSeconds('1234.5s'), 1234.5);
  assert.equal(parseDurationSeconds(600), 600);
  assert.throws(() => parseDurationSeconds('12 min'), /duration/);
});

test('fetchRouteAlternatives posts the field mask and normalizes alternatives', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({
        routes: [
          {
            description: 'via A-20',
            duration: '1800s',
            staticDuration: '1500s',
            distanceMeters: 32000,
            polyline: { encodedPolyline: 'abc' },
            legs: [
              {
                steps: [
                  { endLocation: { latLng: { latitude: 45.54, longitude: -73.44 } } },
                ],
              },
            ],
          },
        ],
      }),
    };
  };

  const routes = await fetchRouteAlternatives(ORIGIN, DESTINATION, {
    apiKey: 'test-key',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ROUTES_API_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'test-key');
  assert.equal(calls[0].init.headers['X-Goog-FieldMask'], FIELD_MASK);

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.computeAlternativeRoutes, true);
  assert.equal(body.origin.location.latLng.latitude, ORIGIN.lat);
  assert.equal(body.destination.location.latLng.longitude, DESTINATION.lng);

  assert.equal(routes.length, 1);
  assert.equal(routes[0].durationSeconds, 1800);
  assert.equal(routes[0].staticDurationSeconds, 1500);
  assert.equal(routes[0].polyline, 'abc');
  assert.deepEqual(routes[0].stepAnchors, [{ lat: 45.54, lng: -73.44 }]);
});

test('fetchRouteAlternatives requires an API key', async () => {
  await assert.rejects(
    fetchRouteAlternatives(ORIGIN, DESTINATION, { apiKey: '', fetchImpl: async () => ({}) }),
    /API key/
  );
});

test('fetchRouteAlternatives rejects invalid coordinates', async () => {
  await assert.rejects(
    fetchRouteAlternatives({ lat: 123, lng: 0 }, DESTINATION, { apiKey: 'k', fetchImpl: async () => ({}) }),
    /Invalid waypoint/
  );
});

test('fetchRouteAlternatives surfaces API errors', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'forbidden' });
  await assert.rejects(
    fetchRouteAlternatives(ORIGIN, DESTINATION, { apiKey: 'k', fetchImpl }),
    /403/
  );
});

test('normalizeRoute defaults description and handles missing legs', () => {
  const route = normalizeRoute({ duration: '60s', staticDuration: '55s' }, 0);
  assert.equal(route.description, 'route-0');
  assert.deepEqual(route.stepAnchors, []);
});

test('findCongestedStepRanges returns the exact boundaries around busy steps', () => {
  const route = normalizeRoute({
    duration: '600s',
    staticDuration: '450s',
    legs: [
      {
        startLocation: { latLng: { latitude: 45, longitude: -73 } },
        steps: [
          {
            startLocation: { latLng: { latitude: 45, longitude: -73 } },
            endLocation: { latLng: { latitude: 45.1, longitude: -73.1 } },
            duration: '100s',
            staticDuration: '100s',
          },
          {
            startLocation: { latLng: { latitude: 45.1, longitude: -73.1 } },
            endLocation: { latLng: { latitude: 45.2, longitude: -73.2 } },
            duration: '200s',
            staticDuration: '100s',
          },
          {
            startLocation: { latLng: { latitude: 45.2, longitude: -73.2 } },
            endLocation: { latLng: { latitude: 45.3, longitude: -73.3 } },
            duration: '250s',
            staticDuration: '100s',
          },
        ],
      },
    ],
  }, 0);

  assert.deepEqual(findCongestedStepRanges(route), [{
    start: { lat: 45.1, lng: -73.1 },
    end: { lat: 45.3, lng: -73.3 },
    durationSeconds: 450,
    staticDurationSeconds: 200,
  }]);
});

test('toDepartureTimeString normalizes strings, numbers and Date instances', () => {
  assert.equal(toDepartureTimeString('2024-06-01T14:30:00Z'), '2024-06-01T14:30:00.000Z');
  assert.equal(toDepartureTimeString(new Date('2024-06-01T14:30:00Z')), '2024-06-01T14:30:00.000Z');
  assert.equal(toDepartureTimeString(1717252200000), new Date(1717252200000).toISOString());
  assert.throws(() => toDepartureTimeString('not-a-date'), /Invalid departureTime/);
  assert.throws(() => toDepartureTimeString(''), /Invalid departureTime/);
});

test('fetchRouteAlternatives includes departureTime in the request body when provided', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ routes: [] }) };
  };

  await fetchRouteAlternatives(ORIGIN, DESTINATION, {
    apiKey: 'test-key',
    fetchImpl,
    departureTime: '2024-06-01T14:30:00Z',
  });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.departureTime, '2024-06-01T14:30:00.000Z');
});

test('fetchRouteAlternatives omits departureTime when not provided', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ routes: [] }) };
  };

  await fetchRouteAlternatives(ORIGIN, DESTINATION, { apiKey: 'test-key', fetchImpl });

  const body = JSON.parse(calls[0].init.body);
  assert.equal('departureTime' in body, false);
});
