'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildGoogleMapsRouteUrl, MAX_WAYPOINTS } = require('../src/mapsLink');

const ORIGIN = { lat: 45.5668, lng: -73.2032 };
const DESTINATION = { lat: 45.5019, lng: -73.5674 };

test('buildGoogleMapsRouteUrl builds a Directions URL with origin, destination and travelmode', () => {
  const url = buildGoogleMapsRouteUrl(ORIGIN, DESTINATION);
  assert.equal(
    url,
    'https://www.google.com/maps/dir/?api=1&origin=45.5668%2C-73.2032&destination=45.5019%2C-73.5674&travelmode=driving'
  );
});

test('buildGoogleMapsRouteUrl forces the exact route by encoding waypoints in order', () => {
  const waypoints = [
    { lat: 45.5403, lng: -73.4466 },
    { lat: 45.52, lng: -73.5 },
  ];
  const url = buildGoogleMapsRouteUrl(ORIGIN, DESTINATION, waypoints);
  assert.match(url, /waypoints=45\.5403%2C-73\.4466%7C45\.52%2C-73\.5$/);
});

test('buildGoogleMapsRouteUrl ignores invalid waypoints and caps at MAX_WAYPOINTS', () => {
  const manyWaypoints = Array.from({ length: MAX_WAYPOINTS + 10 }, (_, i) => ({ lat: i, lng: i }));
  const url = buildGoogleMapsRouteUrl(ORIGIN, DESTINATION, [null, ...manyWaypoints, { lat: NaN, lng: 1 }]);
  const waypointsParam = new URL(url).searchParams.get('waypoints');
  assert.equal(waypointsParam.split('|').length, MAX_WAYPOINTS);
});

test('buildGoogleMapsRouteUrl returns null when origin or destination is invalid', () => {
  assert.equal(buildGoogleMapsRouteUrl(null, DESTINATION), null);
  assert.equal(buildGoogleMapsRouteUrl(ORIGIN, { lat: NaN, lng: 1 }), null);
});
