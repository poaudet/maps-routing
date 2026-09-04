'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { updateRegistry } = require('../src/learning');
const { loadRegistry } = require('../src/registry');

function tmpRegistryPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'learning-')), 'route-cache.json');
}

const NOW = new Date('2026-09-04T20:00:00.000Z');

function makeFeedback() {
  return {
    pointA: { name: 'Beloeil', anchor: { lat: 45.5668, lng: -73.2032 } },
    pointB: { name: 'Montreal Downtown', anchor: { lat: 45.5019, lng: -73.5674 } },
    anchor: { lat: 45.5403, lng: -73.4466 },
    name: 'Beloeil home-to-work route',
    polylineHint: 'new-polyline',
  };
}

test('updateRegistry writes a new corridor permanently to the registry', () => {
  const registryPath = tmpRegistryPath();
  const { corridor, created } = updateRegistry(makeFeedback(), { registryPath, now: NOW });

  assert.equal(created, true);
  assert.ok(corridor.id.startsWith('corridor-'));
  assert.equal(corridor.class, 'preferred');
  assert.equal(corridor.feedbackCount, 1);
  assert.equal(corridor.lastUsedAt, NOW.toISOString());
  assert.equal(corridor.between.pointA.name, 'Beloeil');
  assert.deepEqual(corridor.anchor, { lat: 45.5403, lng: -73.4466 });

  const persisted = loadRegistry(registryPath);
  assert.equal(persisted.corridors.length, 1);
  assert.equal(persisted.corridors[0].id, corridor.id);
  assert.ok(fs.existsSync(registryPath), 'registry file must exist on disk');
});

test('updateRegistry reinforces an existing corridor on repeated feedback instead of duplicating it', () => {
  const registryPath = tmpRegistryPath();
  const first = updateRegistry(makeFeedback(), { registryPath, now: NOW });
  const second = updateRegistry(makeFeedback(), {
    registryPath,
    now: new Date('2026-09-05T08:00:00.000Z'),
  });

  assert.equal(second.created, false);
  assert.equal(second.corridor.id, first.corridor.id);
  assert.equal(second.corridor.feedbackCount, 2);

  const persisted = loadRegistry(registryPath);
  assert.equal(persisted.corridors.length, 1);
});

test('updateRegistry accepts points without a nested anchor and a custom class', () => {
  const registryPath = tmpRegistryPath();
  const { corridor } = updateRegistry(
    {
      pointA: { lat: 45.0, lng: -73.0 },
      pointB: { lat: 45.5, lng: -73.5 },
      anchor: { lat: 45.25, lng: -73.25 },
      corridorClass: 'scenic',
    },
    { registryPath, now: NOW }
  );
  assert.equal(corridor.class, 'scenic');
  assert.equal(corridor.name, 'Point A → Point B');
  assert.deepEqual(corridor.between.pointA.anchor, { lat: 45.0, lng: -73.0 });
});

test('updateRegistry rejects malformed feedback', () => {
  const registryPath = tmpRegistryPath();
  assert.throws(() => updateRegistry(null, { registryPath }), /object/);
  assert.throws(() => updateRegistry({ pointB: {}, anchor: {} }, { registryPath }), /pointA/);
  assert.throws(
    () =>
      updateRegistry(
        {
          pointA: { anchor: { lat: 'x', lng: 0 } },
          pointB: { anchor: { lat: 0, lng: 0 } },
          anchor: { lat: 0, lng: 0 },
        },
        { registryPath }
      ),
    /pointA/
  );
  assert.throws(
    () =>
      updateRegistry(
        {
          pointA: { anchor: { lat: 0, lng: 0 } },
          pointB: { anchor: { lat: 0, lng: 0 } },
          anchor: { lat: null, lng: 0 },
        },
        { registryPath }
      ),
    /anchor/
  );
});
