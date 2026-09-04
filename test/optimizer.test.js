'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { optimizeSegment, optionMatchesCorridor } = require('../src/optimizer');

const POINT_A = { lat: 45.5668, lng: -73.2032 };
const POINT_B = { lat: 45.5019, lng: -73.5674 };
const SEGMENT = { pointA: POINT_A, pointB: POINT_B };

function makeRegistry() {
  return {
    corridors: [
      {
        id: 'corridor-beloeil',
        name: 'Beloeil home-to-work route',
        class: 'preferred',
        between: {
          pointA: { name: 'Beloeil', anchor: POINT_A },
          pointB: { name: 'Montreal Downtown', anchor: POINT_B },
        },
        anchor: { lat: 45.5403, lng: -73.4466 },
        polylineHint: 'preferred-polyline',
      },
    ],
  };
}

function makeRoutes() {
  return [
    {
      index: 0,
      description: 'fastest, unknown',
      durationSeconds: 1800,
      staticDurationSeconds: 1500,
      polyline: 'unknown-polyline',
      stepAnchors: [{ lat: 45.6, lng: -73.5 }],
    },
    {
      index: 1,
      description: 'preferred corridor, within tolerance',
      durationSeconds: 1860, // +3.3 % → inside the +5 % budget
      staticDurationSeconds: 1700,
      polyline: 'preferred-polyline',
      stepAnchors: [{ lat: 45.5405, lng: -73.4468 }],
    },
  ];
}

test('selects the registered corridor when it is viable within the fuzzy tolerance', () => {
  const result = optimizeSegment(makeRoutes(), makeRegistry(), SEGMENT);
  assert.equal(result.selected.index, 1);
  assert.equal(result.matchedCorridor.id, 'corridor-beloeil');
  assert.match(result.reason, /Biais registre/);
});

test('falls back to the fastest route when the preferred corridor exceeds the tolerance budget', () => {
  const routes = makeRoutes();
  routes[1].durationSeconds = 2200; // +22 % → outside the +5 % budget
  const result = optimizeSegment(routes, makeRegistry(), SEGMENT);
  assert.equal(result.selected.index, 0);
  assert.equal(result.matchedCorridor, null);
  assert.match(result.reason, /plus rapide/);
});

test('ignores corridors registered for a different segment', () => {
  const registry = makeRegistry();
  registry.corridors[0].between.pointA.anchor = { lat: 46.8, lng: -71.2 };
  const result = optimizeSegment(makeRoutes(), registry, SEGMENT);
  assert.equal(result.selected.index, 0);
  assert.equal(result.matchedCorridor, null);
});

test('matches a corridor via geometry (step anchors) when the polyline differs', () => {
  const routes = makeRoutes();
  routes[1].polyline = 'some-other-polyline';
  const result = optimizeSegment(routes, makeRegistry(), SEGMENT);
  assert.equal(result.selected.index, 1);
  assert.equal(result.matchedCorridor.id, 'corridor-beloeil');
});

test('matches a corridor via anchor alone when the route has no steps nearby', () => {
  const option = { polyline: 'x', stepAnchors: [{ lat: 46.0, lng: -74.0 }] };
  const corridor = makeRegistry().corridors[0];
  assert.equal(optionMatchesCorridor(option, corridor), false);
  option.stepAnchors.push({ lat: 45.5404, lng: -73.4467 });
  assert.equal(optionMatchesCorridor(option, corridor), true);
});

test('respects a custom tolerance ratio', () => {
  const result = optimizeSegment(makeRoutes(), makeRegistry(), SEGMENT, { toleranceRatio: 0.01 });
  assert.equal(result.selected.index, 0); // +3.3 % exceeds a +1 % budget
  assert.equal(result.matchedCorridor, null);
});

test('throws when no candidate route is provided', () => {
  assert.throws(() => optimizeSegment([], makeRegistry(), SEGMENT), /at least one/);
});
