'use strict';

/**
 * Interface web — page HTML servie par GET /web.
 *
 * UI minimaliste (sans dépendance externe, HTML/JS inline) pour interagir
 * avec le point d'entrée POST /plan : saisie des points intermédiaires
 * pointA/pointB (nom de lieu ou « lat,lng »), toutes les options de la
 * planification (toleranceRatio, congestionRatio, anchorToleranceMeters,
 * matrixWaypoints, departureTime, osrmBaseUrl, geocodeBaseUrl, debug),
 * appel de planSegment via l'API REST, puis affichage de la route
 * recommandée, des alternatives (avec les liens Google Maps), de l'état du
 * trafic et des alternatives OSRM.
 */

const WEB_PAGE = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>maps-routing — Planification de segment</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 720px;
    margin: 2rem auto;
    padding: 0 1rem;
  }
  h1 { font-size: 1.4rem; }
  form { display: grid; gap: 0.75rem; margin-bottom: 1.5rem; }
  label { font-weight: 600; font-size: 0.9rem; }
  input, button, textarea {
    font: inherit;
    padding: 0.5rem 0.75rem;
    border: 1px solid #888;
    border-radius: 6px;
    background: Canvas;
    color: CanvasText;
  }
  textarea { width: 100%; resize: vertical; }
  details {
    border: 1px solid #888;
    border-radius: 8px;
    padding: 0.75rem 1rem;
  }
  summary { cursor: pointer; font-weight: 600; font-size: 0.95rem; }
  details .grid {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    margin-top: 0.75rem;
  }
  details .grid > div { display: grid; gap: 0.25rem; align-content: start; }
  .checkbox { display: flex; gap: 0.5rem; align-items: center; font-size: 0.9rem; }
  .checkbox input { width: auto; }
  button {
    cursor: pointer;
    font-weight: 600;
    background: #1a73e8;
    color: #fff;
    border: none;
  }
  button:disabled { opacity: 0.6; cursor: wait; }
  .hint { font-weight: 400; color: #777; font-size: 0.8rem; }
  #error { color: #d93025; white-space: pre-wrap; }
  .card {
    border: 1px solid #888;
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 0.75rem;
  }
  .card.recommended { border-color: #1a73e8; border-width: 2px; }
  .card h2, .card h3 { margin: 0 0 0.5rem; font-size: 1.05rem; }
  .meta { color: #777; font-size: 0.85rem; }
  .badge {
    display: inline-block;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    background: #8882;
    margin-left: 0.4rem;
  }
  a { color: #1a73e8; }
</style>
</head>
<body>
<h1>🗺️ maps-routing — Planification de segment</h1>
<form id="plan-form">
  <div>
    <label for="pointA">Point A (départ)</label><br>
    <input id="pointA" name="pointA" required placeholder="Beloeil ou 45.5668,-73.2032" size="40">
    <div class="hint">Nom de lieu ou coordonnées « lat,lng ».</div>
  </div>
  <div>
    <label for="pointB">Point B (arrivée)</label><br>
    <input id="pointB" name="pointB" required placeholder="Montreal Downtown ou 45.5019,-73.5674" size="40">
  </div>
  <details>
    <summary>Options avancées (toutes les options de POST /plan)</summary>
    <div class="grid">
      <div>
        <label for="toleranceRatio">Tolérance (ratio)</label>
        <input id="toleranceRatio" name="toleranceRatio" type="number" step="0.01" min="0" placeholder="0.05">
        <div class="hint">Budget de tolérance flou (défaut : 0.05 = +5 %).</div>
      </div>
      <div>
        <label for="congestionRatio">Seuil de congestion (ratio)</label>
        <input id="congestionRatio" name="congestionRatio" type="number" step="0.01" min="0" placeholder="0.25">
        <div class="hint">Seuil de trafic élevé (défaut : 0.25 = +25 %).</div>
      </div>
      <div>
        <label for="anchorToleranceMeters">Tolérance d'ancrage (m)</label>
        <input id="anchorToleranceMeters" name="anchorToleranceMeters" type="number" step="1" min="0" placeholder="500">
        <div class="hint">Rayon de correspondance d'un ancrage de corridor.</div>
      </div>
      <div>
        <label for="departureTime">Heure de départ</label>
        <input id="departureTime" name="departureTime" type="datetime-local">
        <div class="hint">Estimation du trafic à ce moment (Google Maps Routes).</div>
      </div>
      <div>
        <label for="osrmBaseUrl">Serveur OSRM</label>
        <input id="osrmBaseUrl" name="osrmBaseUrl" type="url" placeholder="https://router.project-osrm.org" size="30">
        <div class="hint">Serveur OSRM ou fournisseur alternatif.</div>
      </div>
      <div>
        <label for="geocodeBaseUrl">Service de géocodage</label>
        <input id="geocodeBaseUrl" name="geocodeBaseUrl" type="url" placeholder="https://maps.googleapis.com" size="30">
        <div class="hint">Service de géocodage alternatif.</div>
      </div>
      <div>
        <label for="matrixWaypoints">Waypoints matrice OSRM</label>
        <textarea id="matrixWaypoints" name="matrixWaypoints" rows="3" placeholder="Beloeil&#10;45.55,-73.4&#10;Montreal Downtown"></textarea>
        <div class="hint">Un waypoint par ligne (« lat,lng » ou nom de lieu) ; une seule ligne : séparateur « ; » (défaut : pointA, pointB).</div>
      </div>
      <div>
        <label class="checkbox" for="debug"><input id="debug" name="debug" type="checkbox"> Journal de débogage</label>
        <div class="hint">Active le journal de débogage de chaque couche (console serveur).</div>
      </div>
    </div>
  </details>
  <div><button id="submit" type="submit">Planifier</button></div>
</form>
<p id="error" role="alert"></p>
<section id="result" hidden>
  <h2>Route recommandée</h2>
  <div id="recommended"></div>
  <div id="traffic"></div>
  <h2>Alternatives</h2>
  <div id="alternatives"></div>
  <div id="osrm"></div>
</section>
<script>
// Convertit la saisie en point accepté par POST /plan : {lat, lng} si la
// valeur ressemble à « lat,lng », sinon le nom de lieu tel quel (chaîne).
function parsePoint(raw) {
  const match = raw.trim().match(/^(-?\\d+(?:\\.\\d+)?)\\s*,\\s*(-?\\d+(?:\\.\\d+)?)$/);
  if (match) return { lat: Number(match[1]), lng: Number(match[2]) };
  return raw.trim();
}

// Liste de waypoints, un par ligne (chacun : « lat,lng » ou un nom de lieu) ;
// une ligne sans retour accepte plusieurs noms de lieux séparés par des
// points-virgules (la virgule ne peut servir de séparateur : « lat,lng » en
// contient déjà une).
function parseWaypoints(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const items = trimmed.includes('\\n') ? trimmed.split(/\\r?\\n/) : trimmed.split(';');
  const points = items.map((item) => item.trim()).filter(Boolean).map(parsePoint);
  return points.length > 0 ? points : undefined;
}

// Nombre saisi dans un champ optionnel (undefined si vide ou invalide).
function parseOptionalNumber(id) {
  const raw = document.getElementById(id).value.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

// Chaîne saisie dans un champ optionnel (undefined si vide).
function parseOptionalText(id) {
  const raw = document.getElementById(id).value.trim();
  return raw || undefined;
}

// Corps JSON de POST /plan : pointA/pointB + toutes les options renseignées
// (les champs vides sont omis pour laisser les valeurs par défaut du serveur).
function buildPlanRequest() {
  const body = {
    pointA: parsePoint(document.getElementById('pointA').value),
    pointB: parsePoint(document.getElementById('pointB').value),
  };
  const matrixWaypoints = parseWaypoints(document.getElementById('matrixWaypoints').value);
  if (matrixWaypoints) body.matrixWaypoints = matrixWaypoints;
  for (const key of ['toleranceRatio', 'congestionRatio', 'anchorToleranceMeters']) {
    const value = parseOptionalNumber(key);
    if (value !== undefined) body[key] = value;
  }
  for (const key of ['osrmBaseUrl', 'geocodeBaseUrl']) {
    const value = parseOptionalText(key);
    if (value !== undefined) body[key] = value;
  }
  const departureTime = document.getElementById('departureTime').value;
  if (departureTime) body.departureTime = new Date(departureTime).toISOString();
  if (document.getElementById('debug').checked) body.debug = true;
  return body;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '?';
  const minutes = Math.round(seconds / 60);
  return minutes + ' min';
}

function trafficInfo(traffic) {
  if (!traffic) return null;
  const info = document.createElement('p');
  info.className = 'meta';
  info.textContent = traffic.congested
    ? '⚠️ Trafic élevé détecté (+' + Math.round((traffic.ratio ?? 0) * 100) + ' %, retard ' +
      formatDuration(traffic.delaySeconds) + ') — matrice OSRM interrogée.'
    : 'Trafic fluide (+' + Math.round((traffic.ratio ?? 0) * 100) + ' %).';
  return info;
}

function routeCard(route, { recommended = false } = {}) {
  const card = document.createElement('div');
  card.className = 'card' + (recommended ? ' recommended' : '');

  const title = document.createElement('h3');
  title.textContent = route.description || route.name || route.corridorId || 'Route';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = route.source || 'google';
  title.appendChild(badge);
  card.appendChild(title);

  const meta = document.createElement('p');
  meta.className = 'meta';
  const parts = ['Durée : ' + formatDuration(route.durationSeconds)];
  if (route.deltaSeconds !== undefined && route.deltaSeconds !== null) {
    const sign = route.deltaSeconds >= 0 ? '+' : '-';
    parts.push('Δ ' + sign + formatDuration(Math.abs(route.deltaSeconds)));
  }
  if (route.matchedCorridorId) parts.push('Corridor : ' + route.matchedCorridorId);
  if (route.gainSeconds != null) {
    parts.push('Gain : ' + formatDuration(route.gainSeconds));
  }
  meta.textContent = parts.join(' — ');
  card.appendChild(meta);

  if (route.reason) {
    const reason = document.createElement('p');
    reason.textContent = route.reason;
    card.appendChild(reason);
  }

  if (route.googleMapsUrl) {
    const link = document.createElement('a');
    link.href = route.googleMapsUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Ouvrir dans Google Maps';
    card.appendChild(link);
  }

  return card;
}

document.getElementById('plan-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = document.getElementById('submit');
  const error = document.getElementById('error');
  const result = document.getElementById('result');
  error.textContent = '';
  result.hidden = true;
  document.getElementById('traffic').replaceChildren();
  document.getElementById('osrm').replaceChildren();
  submit.disabled = true;
  submit.textContent = 'Planification…';
  try {
    const response = await fetch('/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPlanRequest()),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Erreur ' + response.status);

    const recommended = document.getElementById('recommended');
    recommended.replaceChildren(routeCard(body.recommended, { recommended: true }));

    const traffic = trafficInfo(body.traffic);
    if (traffic) document.getElementById('traffic').replaceChildren(traffic);

    const alternatives = document.getElementById('alternatives');
    if (body.alternatives && body.alternatives.length > 0) {
      alternatives.replaceChildren(...body.alternatives.map((alt) => routeCard(alt)));
    } else {
      const none = document.createElement('p');
      none.className = 'meta';
      none.textContent = 'Aucune alternative.';
      alternatives.replaceChildren(none);
    }

    if (body.osrmAlternatives && body.osrmAlternatives.length > 0) {
      const osrmSection = document.getElementById('osrm');
      const heading = document.createElement('h2');
      heading.textContent = 'Alternatives OSRM (matrice)';
      const list = document.createElement('p');
      list.className = 'meta';
      list.textContent = body.osrmAlternatives
        .map(
          (alt) =>
            'Waypoint ' + alt.viaIndex + ' : ' + formatDuration(alt.durationSeconds) +
            (alt.gainSeconds != null ? ' (gain ' + formatDuration(alt.gainSeconds) + ')' : '')
        )
        .join(' — ');
      osrmSection.replaceChildren(heading, list);
    }
    result.hidden = false;
  } catch (err) {
    error.textContent = err.message || String(err);
  } finally {
    submit.disabled = false;
    submit.textContent = 'Planifier';
  }
});
</script>
</body>
</html>
`;

module.exports = { WEB_PAGE };
