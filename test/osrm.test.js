'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_OSRM_BASE_URL,
  fetchAlternativesMatrix,
  rankMatrixAlternatives,
} = require('../src/osrm');

const WAYPOINTS = [
  { lat: 45.5668, lng: -73.2032 }, // origin (Beloeil)
  { lat: 45.5019, lng: -73.5674 }, // destination (Montreal)
  { lat: 45.52, lng: -73.39 },     // intermediate alternative
];

test('fetchAlternativesMatrix requests the OSRM table with lng,lat ordering', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        code: 'Ok',
        durations: [
          [0, 2400, 900],
          [2200, 0, 1400],
          [850, 1500, 0],
        ],
        sources: [],
        destinations: [],
      }),
    };
  };

  const matrix = await fetchAlternativesMatrix(WAYPOINTS, { fetchImpl });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith(`${DEFAULT_OSRM_BASE_URL}/table/v1/driving/`));
  assert.ok(calls[0].includes('-73.2032,45.5668;-73.5674,45.5019;-73.39,45.52'));
  assert.ok(calls[0].includes('annotations=duration'));
  assert.equal(matrix.durations.length, 3);
});

test('fetchAlternativesMatrix surfaces API errors and unexpected payloads', async () => {
  await assert.rejects(
    fetchAlternativesMatrix(WAYPOINTS, {
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
    }),
    /500/
  );
  await assert.rejects(
    fetchAlternativesMatrix(WAYPOINTS, {
      fetchImpl: async () => ({ ok: true, json: async () => ({ code: 'NoTable' }) }),
    }),
    /NoTable/
  );
});

test('fetchAlternativesMatrix validates waypoints', async () => {
  await assert.rejects(fetchAlternativesMatrix([WAYPOINTS[0]]), /at least 2/);
  await assert.rejects(
    fetchAlternativesMatrix([{ lat: Number.NaN, lng: 0 }, WAYPOINTS[1]], { fetchImpl: async () => ({}) }),
    /Invalid OSRM waypoint/
  );
});

test('rankMatrixAlternatives finds via-routes faster than the direct reference', () => {
  // Matrice asymétrique : origin → destination direct = 2400 s (congested),
  // origin → via (900) + via → destination (1200) = 2100 s.
  const durations = [
    [0, 2400, 900],
    [2200, 0, 1400],
    [850, 1200, 0],
  ];
  const alternatives = rankMatrixAlternatives(durations);
  assert.deepEqual(alternatives, [{ viaIndex: 2, durationSeconds: 2100, gainSeconds: 300 }]);

  // Une durée de référence explicite (trafic Google) peut remplacer la diagonale.
  const vsGoogle = rankMatrixAlternatives(durations, { currentDurationSeconds: 2150 });
  assert.deepEqual(vsGoogle, [{ viaIndex: 2, durationSeconds: 2100, gainSeconds: 50 }]);
});

test('rankMatrixAlternatives returns nothing when no via beats the reference', () => {
  const durations = [
    [0, 1800, 900],
    [1700, 0, 1600],
    [850, 1500, 0], // via total = 900 + 1500 = 2400 > 1800
  ];
  assert.deepEqual(rankMatrixAlternatives(durations), []);
});

test('rankMatrixAlternatives skips unreachable entries and validates the matrix', () => {
  const durations = [
    [0, 2400, null],
    [2200, 0, 1400],
    [null, 1200, 0], // via joignable dans un sens seulement → ignoré
  ];
  assert.deepEqual(rankMatrixAlternatives(durations), []);
  assert.throws(() => rankMatrixAlternatives([[0]]), /at least 2/);
  // Référence directe injoignable : aucune alternative calculable.
  assert.deepEqual(rankMatrixAlternatives([[0, null], [null, 0]]), []);
});
