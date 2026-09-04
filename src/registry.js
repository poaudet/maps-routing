'use strict';

/**
 * Couche de Données — Registre dynamique de corridors.
 *
 * Charge et persiste le fichier route-cache.json, qui contient les segments
 * « préférés » de l'utilisateur. Chaque corridor possède une classe, des
 * coordonnées d'ancrage exactes (lat,lng) et s'applique entre un point A et
 * un point B spécifiques.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REGISTRY_PATH = path.join(__dirname, '..', 'route-cache.json');

/** Rayon maximum (en mètres) pour considérer qu'un point correspond à un nœud ou à un ancrage. */
const DEFAULT_ANCHOR_TOLERANCE_METERS = 1500;

const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Distance orthodromique (haversine) en mètres entre deux coordonnées {lat, lng}. */
function haversineMeters(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Vrai si les deux coordonnées sont à moins de `toleranceMeters` l'une de l'autre. */
function anchorsMatch(a, b, toleranceMeters = DEFAULT_ANCHOR_TOLERANCE_METERS) {
  if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') {
    return false;
  }
  return haversineMeters(a, b) <= toleranceMeters;
}

/** Charge le registre depuis le disque. Retourne un registre vide si le fichier est absent. */
function loadRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  if (!fs.existsSync(registryPath)) {
    return { version: 1, updatedAt: new Date().toISOString(), corridors: [] };
  }
  const raw = fs.readFileSync(registryPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.corridors)) {
    throw new Error(`Invalid registry at ${registryPath}: "corridors" must be an array`);
  }
  return parsed;
}

/** Persiste le registre sur le disque (écriture atomique via fichier temporaire). */
function saveRegistry(registry, registryPath = DEFAULT_REGISTRY_PATH) {
  const payload = {
    version: registry.version || 1,
    ...registry,
    updatedAt: new Date().toISOString(),
  };
  const tmpPath = `${registryPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, registryPath);
  return payload;
}

/**
 * Retourne les corridors du registre applicables au segment A→B demandé
 * (les points A et B du corridor doivent correspondre aux extrémités du segment).
 */
function findCorridorsForSegment(registry, pointA, pointB, toleranceMeters = DEFAULT_ANCHOR_TOLERANCE_METERS) {
  return registry.corridors.filter(
    (corridor) =>
      anchorsMatch(corridor.between?.pointA?.anchor, pointA, toleranceMeters) &&
      anchorsMatch(corridor.between?.pointB?.anchor, pointB, toleranceMeters)
  );
}

module.exports = {
  DEFAULT_REGISTRY_PATH,
  DEFAULT_ANCHOR_TOLERANCE_METERS,
  haversineMeters,
  anchorsMatch,
  loadRegistry,
  saveRegistry,
  findCorridorsForSegment,
};
