'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  anchorsMatch,
  haversineMeters,
  loadRegistry,
  saveRegistry,
  findCorridorsForSegment,
} = require('../src/registry');

function tmpRegistryPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'registry-')), 'route-cache.json');
}

const POINT_A = { lat: 45.5668, lng: -73.2032 };
const POINT_B = { lat: 45.5019, lng: -73.5674 };

test('haversineMeters returns 0 for identical points and sane values for distant ones', () => {
  assert.equal(haversineMeters(POINT_A, POINT_A), 0);
  const distance = haversineMeters(POINT_A, POINT_B);
  assert.ok(distance > 25000 && distance < 35000, `unexpected distance ${distance}`);
});

test('anchorsMatch respects the tolerance radius', () => {
  assert.ok(anchorsMatch(POINT_A, { lat: 45.567, lng: -73.203 }, 1500));
  assert.ok(!anchorsMatch(POINT_A, POINT_B, 1500));
  assert.ok(!anchorsMatch(POINT_A, null));
});

test('loadRegistry returns an empty registry when the file is missing', () => {
  const registry = loadRegistry(tmpRegistryPath());
  assert.deepEqual(registry.corridors, []);
});

test('loadRegistry rejects a malformed registry file', () => {
  const registryPath = tmpRegistryPath();
  fs.writeFileSync(registryPath, JSON.stringify({ corridors: 'nope' }));
  assert.throws(() => loadRegistry(registryPath), /corridors/);
});

test('saveRegistry persists and reloads corridors', () => {
  const registryPath = tmpRegistryPath();
  const registry = loadRegistry(registryPath);
  registry.corridors.push({
    id: 'c1',
    class: 'preferred',
    between: { pointA: { anchor: POINT_A }, pointB: { anchor: POINT_B } },
    anchor: { lat: 45.54, lng: -73.44 },
  });
  saveRegistry(registry, registryPath);
  const reloaded = loadRegistry(registryPath);
  assert.equal(reloaded.corridors.length, 1);
  assert.equal(reloaded.corridors[0].id, 'c1');
  assert.ok(typeof reloaded.updatedAt === 'string');
});

test('findCorridorsForSegment only matches corridors bound to the A→B segment', () => {
  const registry = {
    corridors: [
      {
        id: 'match',
        between: { pointA: { anchor: POINT_A }, pointB: { anchor: POINT_B } },
        anchor: { lat: 45.54, lng: -73.44 },
      },
      {
        id: 'other-segment',
        between: {
          pointA: { anchor: { lat: 46.0, lng: -74.0 } },
          pointB: { anchor: POINT_B },
        },
        anchor: { lat: 45.9, lng: -73.9 },
      },
    ],
  };
  const matches = findCorridorsForSegment(registry, POINT_A, POINT_B);
  assert.deepEqual(matches.map((c) => c.id), ['match']);
});
