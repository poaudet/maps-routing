# Suggested Next Steps

Ce fichier propose des pistes d'évolution pour la compétence de micro-reroutage
(routing skill) après l'implémentation des 4 couches (registre, API Google Maps
Routes, optimiseur avec biais, boucle de rétroaction) et de la détection de
trafic avec matrice d'alternatives OSRM.

## 1. Robustesse opérationnelle

- **Retry et timeout réseau** : ajouter des timeouts (AbortController) et une
  politique de retry avec backoff exponentiel sur les appels Google Maps Routes
  et OSRM (`fetchRouteAlternatives`, `fetchAlternativesMatrix`).
- **Dégradation gracieuse** : si OSRM est indisponible, conserver la sélection
  Google et journaliser l'échec au lieu de faire échouer `planSegment`.
- **Cache des réponses API** : mémoriser les alternatives par segment pendant
  quelques minutes pour limiter la consommation de quota Google/OSRM lors de
  replanifications rapprochées.

## 2. Qualité de l'appariement de corridors

- **Appariement géométrique réel** : remplacer le `polylineHint` exact par une
  similarité de polylignes (décodage + distance de Fréchet ou Hausdorff) pour
  reconnaître un corridor même si l'API renvoie une encodage différent.
- **Score de confiance du registre** : pondérer le biais de sélection par
  `feedbackCount` et la fraîcheur (`lastUsedAt`) des corridors.
- **Tolérances adaptatives** : ajuster `anchorToleranceMeters` et
  `toleranceRatio` selon la densité du segment (urbain vs autoroute).

## 3. Apprentissage et boucle de rétroaction

- **Oubli progressif (decay)** : faire décroître le poids des corridors non
  utilisés depuis longtemps pour éviter l'accumulation de routes obsolètes.
- **Feedback négatif** : permettre à l'utilisateur de signaler un corridor à
  éviter (`class: "avoid"`) et l'exclure dans l'optimiseur.
- **Fusion de corridors** : détecter les corridors quasi identiques (ancrages
  proches sur le même segment) et les fusionner automatiquement.
- **Apprentissage implicite** : enregistrer automatiquement comme candidat un
  itinéraire OSRM choisi plusieurs fois de suite (avec confirmation avant
  promotion en `preferred`).

## 4. Couverture et intégration OpenClaw

- **Segments multi-points** : chaîner `planSegment` sur un itinéraire complet
  (A→B→C→D) et optimiser globalement avec la matrice OSRM.
- **Modes de transport** : étendre au-delà de `DRIVE` (vélo, marche, transport
  en commun) avec des seuils de congestion adaptés.
- **Interface agent** : exposer la compétence via le protocole de skills
  OpenClaw (déclaration d'intents : planifier un segment, enregistrer un
  feedback, lister les corridors).
- **Observabilité** : journaliser les décisions de l'optimiseur (raison,
  budget, corridor correspondant) dans un format exploitable par l'agent.

## 5. Sécurité et configuration

- **Gestion de la clé API** : documenter l'usage de `GOOGLE_MAPS_API_KEY` via
  un gestionnaire de secrets et ne jamais committer de clé (cf. `.gitignore`).
- **Validation stricte du registre** : ajouter un schéma JSON (ex. JSON Schema)
  pour valider `route-cache.json` au chargement et refuser les entrées
  corrompues.
- **Fournisseur OSRM auto-hébergé** : prévoir la configuration d'un serveur
  OSRM privé (`osrmBaseUrl`) pour maîtriser les données de déplacement.
