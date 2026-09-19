// ============================================================
// client.js — page publique du client final (client.html?t=<token>).
//
// Pas de compte, pas de librairie Supabase : la page interroge
// UNIQUEMENT l'Edge Function « suivi-client » avec son token, toutes
// les 10 secondes. La fonction ne renvoie que le strict minimum (une
// position, une ETA, une progression) — jamais les autres clients.
// ============================================================

(() => {
  const INTERVALLE_MS = 10000;

  const $ = (id) => document.getElementById(id);

  const token = new URLSearchParams(window.location.search).get('t') || '';

  let carte = null;
  let marqueurNacelliste = null;
  let marqueurDestination = null;
  let calqueAutresArrets = null;
  let carteCadree = false;
  let timer = null;

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

  function telephoneLisible(tel) {
    return String(tel || '').replace(/(\d{2})(?=\d)/g, '$1 ').trim();
  }

  function initCarte(destination) {
    if (carte) return;
    carte = L.map('carte-client').setView([destination.lat, destination.lng], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(carte);

    marqueurDestination = L.marker([destination.lat, destination.lng], {
      icon: L.divIcon({ className: '', html: '<div class="marqueur marqueur-maison">🏠</div>',
                        iconSize: [30, 30], iconAnchor: [15, 15] }),
    }).bindPopup('Chez vous').addTo(carte);

    calqueAutresArrets = L.layerGroup().addTo(carte);
  }

  // Les autres arrets de la tournee : la fonction serveur ne fournit
  // QUE des coordonnees arrondies + un statut — on les dessine donc
  // en simples ronds gris muets (pas de popup, pas d'interaction).
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

  function majCarte(donnees) {
    initCarte(donnees.destination);
    majAutresArrets(donnees.autres_arrets);

    if (donnees.position) {
      const pos = [donnees.position.lat, donnees.position.lng];
      if (!marqueurNacelliste) {
        marqueurNacelliste = L.marker(pos, {
          icon: L.divIcon({ className: '', html: '<div class="marqueur-moi">🚚</div>',
                            iconSize: [34, 34], iconAnchor: [17, 17] }),
          zIndexOffset: 1000,
        }).bindPopup(donnees.nacelliste_nom).addTo(carte);
      } else {
        marqueurNacelliste.setLatLng(pos);
      }
      if (!carteCadree) {
        carte.fitBounds([pos, [donnees.destination.lat, donnees.destination.lng]],
          { padding: [40, 40], maxZoom: 14 });
        carteCadree = true;
      }
    }
  }

  function majSuivi(donnees) {
    montrer('cli-suivi');

    // Ligne de statut + progression.
    const statutTexte = $('cli-statut-texte');
    const progression = $('cli-progression');
    if (donnees.tournee_statut === 'preparee') {
      statutTexte.textContent = `${donnees.nacelliste_nom} prépare sa tournée`;
      progression.textContent = 'La tournée n’a pas encore démarré.';
    } else if (donnees.arrets_avant === 0) {
      statutTexte.textContent = `${donnees.nacelliste_nom} arrive chez vous 🚚`;
      progression.textContent = 'Vous êtes le prochain arrêt !';
    } else {
      statutTexte.textContent = `${donnees.nacelliste_nom} est en route`;
      progression.textContent = `Il y a ${donnees.arrets_avant} arrêt${donnees.arrets_avant > 1 ? 's' : ''} avant vous.`;
    }

    $('cli-eta').textContent = donnees.eta ? `≈ ${heure(donnees.eta)}` : 'bientôt disponible';
    $('cli-infos-avant').textContent = donnees.infos_avant || '';

    // Onglet Contact : nacelliste (si renseigne) + responsable,
    // tous deux cliquables (tel:), pendant TOUTE la tournee.
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

    // Retard : ETA depassee de plus de X minutes -> numero de contact.
    const enRetard = donnees.eta &&
      Date.now() > new Date(donnees.eta).getTime() + donnees.seuil_retard_min * 60000;
    $('cli-retard').classList.toggle('hidden', !enRetard);
    if (enRetard) {
      const lien = $('cli-tel-retard');
      lien.textContent = telephoneLisible(donnees.telephone);
      lien.href = `tel:${donnees.telephone}`;
    }

    majCarte(donnees);
  }

  function majTermine(donnees) {
    montrer('cli-termine');
    $('cli-infos-apres').textContent = donnees.infos_apres || '';
    const lien = $('cli-tel-termine');
    lien.textContent = `📞 ${telephoneLisible(donnees.telephone)}`;
    lien.href = `tel:${donnees.telephone}`;
    if (timer) { clearInterval(timer); timer = null; }   // plus rien a suivre
  }

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
    else {
      montrer('cli-invalide');
      if (timer) { clearInterval(timer); timer = null; }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!token) { montrer('cli-invalide'); return; }
    rafraichir();
    timer = setInterval(rafraichir, INTERVALLE_MS);
  });
})();
