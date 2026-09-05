'use strict';

/**
 * Interface web — page HTML servie par GET /web.
 *
 * UI minimaliste (sans dépendance externe, HTML/JS inline) pour interagir
 * uniquement avec le point d'entrée POST /plan : saisie des points
 * intermédiaires pointA/pointB (nom de lieu ou « lat,lng »), appel de
 * planSegment via l'API REST, puis affichage de la route recommandée et des
 * alternatives (avec les liens Google Maps).
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
  input, button {
    font: inherit;
    padding: 0.5rem 0.75rem;
    border: 1px solid #888;
    border-radius: 6px;
  }
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
  <div><button id="submit" type="submit">Planifier</button></div>
</form>
<p id="error" role="alert"></p>
<section id="result" hidden>
  <h2>Route recommandée</h2>
  <div id="recommended"></div>
  <h2>Alternatives</h2>
  <div id="alternatives"></div>
</section>
<script>
// Convertit la saisie en point accepté par POST /plan : {lat, lng} si la
// valeur ressemble à « lat,lng », sinon le nom de lieu tel quel (chaîne).
function parsePoint(raw) {
  const match = raw.trim().match(/^(-?\\d+(?:\\.\\d+)?)\\s*,\\s*(-?\\d+(?:\\.\\d+)?)$/);
  if (match) return { lat: Number(match[1]), lng: Number(match[2]) };
  return raw.trim();
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '?';
  const minutes = Math.round(seconds / 60);
  return minutes + ' min';
}

function routeCard(route, { recommended = false } = {}) {
  const card = document.createElement('div');
  card.className = 'card' + (recommended ? ' recommended' : '');

  const title = document.createElement(recommended ? 'h3' : 'h3');
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
    parts.push('Δ ' + (route.deltaSeconds >= 0 ? '+' : '') + formatDuration(Math.abs(route.deltaSeconds)).replace('?', '0 min'));
  }
  if (route.matchedCorridorId) parts.push('Corridor : ' + route.matchedCorridorId);
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
  submit.disabled = true;
  submit.textContent = 'Planification…';
  try {
    const response = await fetch('/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pointA: parsePoint(document.getElementById('pointA').value),
        pointB: parsePoint(document.getElementById('pointB').value),
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Erreur ' + response.status);

    const recommended = document.getElementById('recommended');
    recommended.replaceChildren(routeCard(body.recommended, { recommended: true }));

    const alternatives = document.getElementById('alternatives');
    if (body.alternatives && body.alternatives.length > 0) {
      alternatives.replaceChildren(...body.alternatives.map((alt) => routeCard(alt)));
    } else {
      const none = document.createElement('p');
      none.className = 'meta';
      none.textContent = 'Aucune alternative.';
      alternatives.replaceChildren(none);
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
