// ============================================================
// client.js — page publique du client final (client.html?t=<token>).
//
// Pas de compte, pas de librairie Supabase : la page interroge
// UNIQUEMENT l'Edge Function « suivi-client » avec son token, toutes
// les 10 secondes. La fonction ne renvoie que le strict minimum (une
// position, une ETA, une progression, des points anonymes) — jamais
// l'identite des autres clients.
//
// Camion anime : entre deux positions (polling 10 s), le camion 🚚
// GLISSE le long du trace routier OSRM qui le relie au client, au
// lieu de sauter d'un point a l'autre. La route affichee est celle
// nacelliste -> CE client (coordonnees que le client possede deja).
// ============================================================

(() => {
  const INTERVALLE_MS   = 10000;
  const OSRM_URL        = 'https://router.project-osrm.org/route/v1/driving/';
  const ECART_ROUTE_M   = 80;             // GPS a plus de 80 m de la route -> recalcul
  const ROUTE_AGE_MAX_MS = 3 * 60 * 1000; // et au plus un recalcul toutes les 3 min
  const DUREE_GLISSE_MS = 9000;           // glisse entre deux positions (< polling)

  const $ = (id) => document.getElementById(id);

  const token = new URLSearchParams(window.location.search).get('t') || '';

  let carte = null;
  let marqueurCamion = null;
  let marqueurDestination = null;
  let calqueAutresArrets = null;
  let polylineRoute = null;
  let carteCadree = false;
  let timer = null;

  let destination = null;       // { lat, lng } — le point DU client
  let route = null;             // [[lat,lng], ...] trace OSRM camion -> client
  let routeCalculeeA = 0;
  let routeEnCalcul = false;
  let posAffichee = null;       // derniere position (logique) du camion
  let animationId = null;

  // ---------- utilitaires ----------

  function montrer(idVisible) {
    for (const id of ['cli-chargement', 'cli-invalide', 'cli-termine', 'cli-suivi']) {
      $(id).classList.toggle('hidden', id !== idVisible);
    }
  }

  function heure(dateIso) {
    if (!dateIso) return '—';
    return new Date(dateIso).toLocaleTimeString('fr-FR',
      { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  }

  // « 14:30 » -> « 14h30 » (plus naturel en francais).
  function heureFr(dateIso) {
    return heure(dateIso).replace(':', 'h');
  }

  function telephoneLisible(tel) {
    return String(tel || '').replace(/(\d{2})(?=\d)/g, '$1 ').trim();
  }

  function haversine(a, b) {
    const R = 6371000;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
              Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Sommet du trace le plus proche d'un point (la geometrie OSRM
  // « full » est assez dense pour s'en contenter).
  function indexPlusProche(chemin, p) {
    let index = 0;
    let dist = Infinity;
    for (let k = 0; k < chemin.length; k++) {
      const d = haversine({ lat: chemin[k][0], lng: chemin[k][1] }, p);
      if (d < dist) { dist = d; index = k; }
    }
    return { index, dist };
  }

  // ---------- carte ----------

  function initCarte(dest) {
    if (carte) return;
    destination = dest;
    carte = L.map('carte-client', { zoomControl: false })
      .setView([dest.lat, dest.lng], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(carte);

    marqueurDestination = L.marker([dest.lat, dest.lng], {
      icon: L.divIcon({ className: '', html: '<div class="marqueur marqueur-maison">🏠</div>',
                        iconSize: [30, 30], iconAnchor: [15, 15] }),
    }).bindPopup('Chez vous').addTo(carte);

    calqueAutresArrets = L.layerGroup().addTo(carte);
  }

  // Les autres arrets de la tournee : la fonction serveur ne fournit
  // QUE des coordonnees arrondies + un statut — de simples ronds gris
  // muets (pas de popup, pas d'interaction).
  function majAutresArrets(arrets) {
    calqueAutresArrets.clearLayers();
    for (const a of arrets || []) {
      const fait = a.statut === 'fait';
      L.circleMarker([a.lat, a.lng], {
        radius: 6,
        color: '#64748B',
        weight: 2,
        opacity: fait ? 0.35 : 0.9,
        fillColor: '#94A3B8',
        fillOpacity: fait ? 0.25 : 0.75,
        interactive: false,
      }).addTo(calqueAutresArrets);
    }
  }

  // ---------- route OSRM camion -> client ----------

  async function assurerRoute(depuis) {
    if (routeEnCalcul || !destination) return false;
    routeEnCalcul = true;
    try {
      const coords = `${depuis.lng.toFixed(6)},${depuis.lat.toFixed(6)};` +
                     `${destination.lng.toFixed(6)},${destination.lat.toFixed(6)}`;
      const reponse = await fetch(`${OSRM_URL}${coords}?overview=full&geometries=geojson&steps=false`);
      if (!reponse.ok) return false;
      const donnees = await reponse.json();
      if (donnees.code !== 'Ok' || !donnees.routes?.length) return false;

      route = donnees.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      routeCalculeeA = Date.now();

      if (!polylineRoute) {
        polylineRoute = L.polyline(route, {
          color: '#E8710A', weight: 5, opacity: 0.8, lineJoin: 'round',
        }).addTo(carte);
      } else {
        polylineRoute.setLatLngs(route);
      }
      if (!carteCadree) {
        carte.fitBounds(route, { padding: [50, 50], maxZoom: 15 });
        carteCadree = true;
      }
      return true;
    } catch (_) {
      return false;      // OSRM injoignable : on garde l'ancien trace
    } finally {
      routeEnCalcul = false;
    }
  }

  // ---------- animation du camion ----------

  // Fait glisser le camion le long d'une suite de points, a vitesse
  // constante, pendant dureeMs.
  function glisserLeLong(points, dureeMs) {
    if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
    if (!marqueurCamion || points.length < 2) return;

    // Longueurs cumulees pour interpoler a distance constante.
    const cumuls = [0];
    for (let k = 1; k < points.length; k++) {
      cumuls.push(cumuls[k - 1] + haversine(
        { lat: points[k - 1][0], lng: points[k - 1][1] },
        { lat: points[k][0], lng: points[k][1] }));
    }
    const total = cumuls[cumuls.length - 1];
    if (total < 1) { marqueurCamion.setLatLng(points[points.length - 1]); return; }

    const debut = performance.now();
    const pas = (maintenant) => {
      const fraction = Math.min((maintenant - debut) / dureeMs, 1);
      const cible = fraction * total;
      let k = 1;
      while (k < cumuls.length - 1 && cumuls[k] < cible) k++;
      const f = (cible - cumuls[k - 1]) / Math.max(cumuls[k] - cumuls[k - 1], 0.001);
      marqueurCamion.setLatLng([
        points[k - 1][0] + (points[k][0] - points[k - 1][0]) * f,
        points[k - 1][1] + (points[k][1] - points[k - 1][1]) * f,
      ]);
      if (fraction < 1) animationId = requestAnimationFrame(pas);
      else animationId = null;
    };
    animationId = requestAnimationFrame(pas);
  }

  async function majPositionCamion(cible, nomNacelliste) {
    if (!marqueurCamion) {
      marqueurCamion = L.marker([cible.lat, cible.lng], {
        icon: L.divIcon({ className: '', html: '<div class="marqueur-camion">🚚</div>',
                          iconSize: [38, 38], iconAnchor: [19, 19] }),
        zIndexOffset: 1000,
      }).bindPopup(nomNacelliste).addTo(carte);
      posAffichee = cible;
      await assurerRoute(cible);
      return;
    }

    // Route absente, trop vieille, ou camion qui s'en ecarte (il va
    // peut-etre chez un autre client d'abord) : on recalcule le trace
    // routier depuis sa vraie position vers CE client.
    const ecart = route ? indexPlusProche(route, cible).dist : Infinity;
    if (!route || ecart > ECART_ROUTE_M || Date.now() - routeCalculeeA > ROUTE_AGE_MAX_MS) {
      await assurerRoute(cible);
    }

    if (haversine(posAffichee, cible) < 8) { posAffichee = cible; return; }

    // Glisse le long de la route entre l'ancienne et la nouvelle
    // position ; a defaut (hors route), petite glisse directe.
    let points = [[posAffichee.lat, posAffichee.lng], [cible.lat, cible.lng]];
    if (route) {
      const i = indexPlusProche(route, posAffichee).index;
      const j = indexPlusProche(route, cible).index;
      if (j > i) points = [[posAffichee.lat, posAffichee.lng], ...route.slice(i + 1, j + 1)];
    }
    glisserLeLong(points, DUREE_GLISSE_MS);
    posAffichee = cible;
  }

  // ---------- bandeau bas (bottom sheet) ----------

  function majBandeau(donnees) {
    const icone = $('cli-statut-icone');
    const titre = $('cli-statut-titre');
    const sous = $('cli-statut-sous');
    const n = donnees.arrets_avant;

    if (donnees.tournee_statut === 'preparee') {
      icone.textContent = '🕓';
      titre.textContent = `${donnees.nacelliste_nom} prépare sa tournée`;
      sous.textContent = 'Le suivi en direct démarre avec la tournée.';
    } else if (donnees.tournee_statut === 'terminee') {
      // Arret non fait sur une tournee close : le lien reste valable,
      // le suivi reprendra si la tournee redemarre.
      icone.textContent = '🕓';
      titre.textContent = 'Votre intervention est reprogrammée';
      sous.textContent = 'La tournée du nacelliste est terminée pour le moment. Contactez-nous pour plus d’informations.';
    } else if (donnees.mon_statut === 'en_cours') {
      icone.textContent = '🔧';
      titre.textContent = 'Le nacelliste est arrivé';
      sous.textContent = 'Intervention en cours chez vous.';
    } else if (n === 0) {
      icone.textContent = '🚚';
      titre.textContent = 'En route vers vous';
      sous.textContent = 'Vous êtes le prochain arrêt !';
    } else {
      icone.textContent = '⏳';
      titre.textContent = 'Le nacelliste est en intervention avant vous';
      sous.textContent = `Il y a ${n} arrêt${n > 1 ? 's' : ''} avant vous.`;
    }

    // Barre de progression : arrets deja faits avant moi / total avant
    // moi (+1 pour « chez vous », rempli quand le nacelliste est la).
    const total = donnees.arrets_avant_total ?? 0;
    let pourcent;
    if (donnees.tournee_statut === 'preparee') pourcent = 0;
    else if (donnees.mon_statut === 'en_cours') pourcent = 100;
    else pourcent = Math.round(100 * (total - n) / (total + 1));
    $('cli-progression-barre').style.width = `${Math.max(4, pourcent)}%`;

    // ETA « vers 14h30 » (masquee quand il est deja la, ou quand la
    // tournee ne roule pas : preparee / terminee).
    const etaVisible = donnees.mon_statut !== 'en_cours' &&
      donnees.tournee_statut === 'en_cours';
    $('cli-eta-bloc').classList.toggle('hidden', !etaVisible);
    $('cli-eta').textContent = donnees.eta ? `vers ${heureFr(donnees.eta)}` : 'bientôt disponible';

    // Retard : ETA depassee de plus de X minutes -> numero mis en avant.
    const enRetard = etaVisible && donnees.eta &&
      Date.now() > new Date(donnees.eta).getTime() + donnees.seuil_retard_min * 60000;
    $('cli-retard').classList.toggle('hidden', !enRetard);
    if (enRetard) {
      const lien = $('cli-tel-retard');
      lien.textContent = telephoneLisible(donnees.telephone);
      lien.href = `tel:${donnees.telephone}`;
    }

    // Onglet Contact : nacelliste (si renseigne) + responsable.
    const telNacelliste = donnees.telephone_nacelliste;
    $('cli-contact-nacelliste').classList.toggle('hidden', !telNacelliste);
    if (telNacelliste) {
      const lienNac = $('cli-tel-nacelliste');
      lienNac.textContent = `📞 ${telephoneLisible(telNacelliste)}`;
      lienNac.href = `tel:${telNacelliste}`;
    }
    const lienResp = $('cli-tel-responsable');
    lienResp.textContent = `📞 ${telephoneLisible(donnees.telephone)}`;
    lienResp.href = `tel:${donnees.telephone}`;

    $('cli-infos-avant').textContent = donnees.infos_avant || '';
  }

  // ---------- etats ----------

  function majSuivi(donnees) {
    montrer('cli-suivi');
    initCarte(donnees.destination);
    carte.invalidateSize();
    majAutresArrets(donnees.autres_arrets);
    majBandeau(donnees);
    if (donnees.position) {
      majPositionCamion(
        { lat: donnees.position.lat, lng: donnees.position.lng },
        donnees.nacelliste_nom);
      if (!carteCadree) {
        carte.fitBounds([[donnees.position.lat, donnees.position.lng],
                         [destination.lat, destination.lng]],
          { padding: [50, 50], maxZoom: 14 });
        carteCadree = true;
      }
    }
  }

  function majTermine(donnees) {
    montrer('cli-termine');
    $('cli-infos-apres').textContent = donnees.infos_apres || '';

    const telNac = donnees.telephone_nacelliste;
    const lienNac = $('cli-tel-termine-nacelliste');
    lienNac.classList.toggle('hidden', !telNac);
    if (telNac) {
      lienNac.textContent = `📞 Nacelliste — ${telephoneLisible(telNac)}`;
      lienNac.href = `tel:${telNac}`;
    }
    const lien = $('cli-tel-termine');
    lien.textContent = `📞 ${telephoneLisible(donnees.telephone)}`;
    lien.href = `tel:${donnees.telephone}`;
    // On continue d'interroger : « Revenir » cote nacelliste peut
    // rouvrir l'arret (le lien redevient alors un suivi live).
  }

  // ---------- polling ----------

  async function rafraichir() {
    let reponse;
    try {
      reponse = await fetch(`${SUPABASE_URL}/functions/v1/suivi-client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({ token }),
      });
    } catch (_) {
      return;   // reseau coupe : on garde l'affichage, prochain essai dans 10 s
    }

    let donnees;
    try { donnees = await reponse.json(); } catch (_) { return; }

    if (donnees.etat === 'suivi')        majSuivi(donnees);
    else if (donnees.etat === 'termine') majTermine(donnees);
    else if (donnees.etat === 'expire') {
      // Token CONNU mais desactive : on affiche l'ecran « lien plus
      // actif » mais on continue d'interroger — une reactivation
      // (arret rouvert) fait revivre le suivi sans recharger.
      montrer('cli-invalide');
    } else {
      // Token inconnu : lien reellement invalide, on arrete la.
      montrer('cli-invalide');
      if (timer) { clearInterval(timer); timer = null; }
    }
  }

  // ---------- demarrage ----------

  document.addEventListener('DOMContentLoaded', () => {
    if (!token) { montrer('cli-invalide'); return; }

    // Panneaux Contact / Infos du bandeau (exclusifs).
    $('btn-contact').addEventListener('click', () => {
      $('panneau-contact').classList.toggle('hidden');
      $('panneau-infos').classList.add('hidden');
    });
    $('btn-infos').addEventListener('click', () => {
      $('panneau-infos').classList.toggle('hidden');
      $('panneau-contact').classList.add('hidden');
    });

    rafraichir();
    timer = setInterval(rafraichir, INTERVALLE_MS);
  });
})();
