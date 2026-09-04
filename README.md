# maps-routing

Compétence de micro-reroutage (routing skill) pour agent autonome (framework OpenClaw).
Le système calcule des options entre des points intermédiaires, privilégie les routes
connues de l'utilisateur grâce à un biais de sélection, et apprend de nouvelles routes
via une boucle de rétroaction.

## Architecture (4 couches)

1. **Couche de Données — Registre dynamique** (`route-cache.json`, `src/registry.js`)
   Registre en lecture/écriture des segments « préférés » de l'utilisateur. Chaque
   corridor possède une classe, des coordonnées d'ancrage exactes (lat,lng) et
   s'applique entre un point A et un point B spécifiques.

2. **Couche d'Interrogation — API Google Maps Routes** (`src/routesApi.js`)
   Pour un segment entre deux points intermédiaires, interroge `computeRoutes` avec
   un **masque de champ** (`X-Goog-FieldMask`) limité à `duration` (temps réel),
   `staticDuration` (conditions fluides / free-flow), la distance et la géométrie.

3. **Couche Logique — Optimiseur avec biais** (`src/optimizer.js`)
   Applique un budget de tolérance flou (par défaut **+5 %** sur la meilleure durée).
   Si plusieurs options restent viables dans cette fenêtre, l'optimiseur privilégie
   **strictement** l'option dont l'ancrage ou la géométrie correspond à un corridor
   déjà enregistré dans `route-cache.json`.

4. **Couche d'Apprentissage — Boucle de rétroaction** (`src/learning.js`)
   `updateRegistry(feedbackData)` formate un nouveau corridor issu d'un feedback
   utilisateur et l'écrit de façon permanente dans le registre. Un feedback répété
   renforce le corridor existant (`feedbackCount`) au lieu de créer un doublon.

### Détection de trafic et matrice d'alternatives (OSRM)

`detectHighTraffic` compare la durée en temps réel (`duration`) au temps en
conditions fluides (`staticDuration`, free-flow) : au-delà d'un seuil de
congestion (défaut **+25 %**), `planSegment` interroge automatiquement le
service `table` d'**OSRM** (`src/osrm.js`, ou un autre fournisseur via
`osrmBaseUrl`) pour obtenir une matrice de durées entre points intermédiaires.
Les alternatives plus rapides que la route congestionnée sont réinjectées dans
l'optimiseur (`planSegment` retourne alors `traffic` et `osrmAlternatives`).

### Réponse JSON : route recommandée et alternatives

`planSegment` retourne une réponse JSON structurée permettant à l'utilisateur
de choisir entre plusieurs sources d'alternatives :

- **`recommended`** : la route recommandée par l'optimiseur (`source`,
  `description`, `durationSeconds`, `staticDurationSeconds`, `distanceMeters`,
  `matchedCorridorId`, `reason`).
- **`alternatives`** : toutes les autres options, triées par durée —
  alternatives **Google Maps** (`source: "google"`, avec `deltaSeconds` par
  rapport à la recommandation), alternatives **OSRM** (`source: "osrm"`, avec
  `viaIndex` et `gainSeconds`) sur les segments à trafic élevé, et corridors du
  **registre** (`source: "registry"`, avec `corridorId`) applicables au segment
  mais non retournés par l'API.

Les champs `selected`, `candidates`, `fastest`, `matchedCorridor`, `reason` et
`traffic` restent exposés pour compatibilité.

## Format du registre (`route-cache.json`)

```json
{
  "version": 1,
  "updatedAt": "2026-09-04T00:00:00.000Z",
  "corridors": [
    {
      "id": "corridor-beloeil-home-work",
      "name": "Beloeil home-to-work route",
      "class": "preferred",
      "between": {
        "pointA": { "name": "Beloeil", "anchor": { "lat": 45.5668, "lng": -73.2032 } },
        "pointB": { "name": "Montreal Downtown", "anchor": { "lat": 45.5019, "lng": -73.5674 } }
      },
      "anchor": { "lat": 45.5403, "lng": -73.4466 },
      "polylineHint": "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
      "feedbackCount": 3,
      "lastUsedAt": "2026-09-01T12:30:00.000Z"
    }
  ]
}
```

## Utilisation

```js
const { planSegment, updateRegistry } = require('./index');

// 1. Planifier un segment (interrogation API + biais registre)
const result = await planSegment(
  { lat: 45.5668, lng: -73.2032 },   // Point A
  { lat: 45.5019, lng: -73.5674 },   // Point B
  { apiKey: process.env.GOOGLE_MAPS_API_KEY }
);
console.log(result.recommended.description, result.recommended.reason);
// L'utilisateur peut choisir parmi toutes les alternatives (Google, OSRM, registre) :
for (const alt of result.alternatives) {
  console.log(`[${alt.source}]`, alt.description ?? alt.name, alt.durationSeconds);
}
if (result.traffic.congested) {
  console.log('Trafic élevé détecté, alternatives OSRM :', result.osrmAlternatives);
}

// 2. Boucle de rétroaction : l'utilisateur préfère une nouvelle alternative
updateRegistry({
  pointA: { name: 'Beloeil', anchor: { lat: 45.5668, lng: -73.2032 } },
  pointB: { name: 'Montreal Downtown', anchor: { lat: 45.5019, lng: -73.5674 } },
  anchor: { lat: 45.52, lng: -73.39 },
  name: 'Nouvelle alternative Rive-Sud',
});
```

La clé API Google est fournie via l'option `apiKey` ou la variable d'environnement
`GOOGLE_MAPS_API_KEY`. La tolérance floue se règle avec l'option `toleranceRatio`
(défaut : `0.05`).

## Débogage

Le journal de débogage (désactivé par défaut) montre la requête et la réponse
de chaque couche : `[maps-routing:google]`, `[maps-routing:osrm]`,
`[maps-routing:optimizer]`, `[maps-routing:learning]`, `[maps-routing:planSegment]`.

```sh
# Activation globale
MAPS_ROUTING_DEBUG=1 node app.js
```

```js
// Ou par appel (une fonction peut recevoir les lignes de journal)
await planSegment(pointA, pointB, { debug: true });
await planSegment(pointA, pointB, { debug: (line) => logger.debug(line) });
```

## Tests

```sh
npm test
```
