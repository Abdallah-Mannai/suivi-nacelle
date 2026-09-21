// ============================================================
// nacelliste.js — ecran mobile du nacelliste :
// sa tournee du jour, ajout d'interventions (adresse BAN ou
// « lat;lng »), optimisation de l'itineraire (OSRM), demarrage de
// la tournee avec partage de position, boutons « Termine » et
// « Copier le lien client ».
// ============================================================

const NacellisteApp = (() => {

  // Envoi de la position : ~25 s (compromis batterie / fluidite).
  const ENVOI_POSITION_MS = 25000;
  // Re-calcul des ETA pendant la tournee : toutes les 3 min (on
  // menage le serveur OSRM public).
  const RECALCUL_ETA_MS = 3 * 60 * 1000;
  // Duree maxi de la glisse du camion entre deux fixes GPS.
  const GLISSE_MAX_MS = 8000;
  // Apres une manipulation manuelle de la carte, on laisse la main
  // au nacelliste pendant 30 s avant de re-suivre le camion.
  const REPIT_MANUEL_MS = 30000;

  let profil = null;
  let tournee = null;
  let interventions = [];
  let parametres = { temps_intervention_min: 20 };

  let carte = null;
  let calquePoints = null;
  let calqueRoute = null;
  let marqueurMoi = null;

  let watchId = null;
  let enPause = false;
  let dernierEnvoi = 0;
  let dernierePosition = null;
  // Animation du camion (meme principe que la page client) :
  let geometrieCourante = null;      // dernier trace OSRM affiche
  let posAffichee = null;            // position (logique) du camion
  let animationId = null;
  let dernierFixA = 0;               // date du fixe GPS precedent
  let derniereManipCarte = 0;        // derniere manipulation manuelle
  let timerEta = null;
  let recalculEnCours = false;
  let reordonnancementEnCours = false;
  let idEnDeplacement = null;

  // ---------- utilitaires ----------

  const $ = (id) => document.getElementById(id);

  function echap(texte) {
    const div = document.createElement('div');
    div.textContent = String(texte ?? '');
    return div.innerHTML;
  }

  // Date du jour en France, au format YYYY-MM-DD (colonne tournees.date).
  function dateDuJour() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  }

  function heure(dateIso) {
    if (!dateIso) return '—';
    return new Date(dateIso).toLocaleTimeString('fr-FR',
      { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  }

  function message(texte, type = 'info') {
    const el = $('nac-message');
    el.textContent = texte;
    el.className = `msg msg-${type}`;
    if (!texte) el.classList.add('hidden');
  }

  // ---------- chargement ----------

  async function init(p) {
    profil = p;

    const { data: par } = await sb.from('parametres').select('*').eq('id', 1).maybeSingle();
    if (par) parametres = par;

    await chargerTournee();
    await chargerInterventions();

    initCarte();
    brancherEvenements();
    rendre();

    // Page rechargee en pleine tournee : on reprend le suivi.
    if (tournee.statut === 'en_cours') activerSuivi();
  }

  async function chargerTournee() {
    const jour = dateDuJour();
    const { data: existante } = await sb
      .from('tournees').select('*')
      .eq('nacelliste_id', profil.id).eq('date', jour)
      .maybeSingle();

    if (existante) { tournee = existante; return; }

    const { data: creee, error } = await sb
      .from('tournees')
      .insert({ nacelliste_id: profil.id, date: jour })
      .select().single();

    if (error) {
      // Course avec un autre onglet : l'index unique a gagne, on relit.
      const { data: relue } = await sb
        .from('tournees').select('*')
        .eq('nacelliste_id', profil.id).eq('date', jour).maybeSingle();
      tournee = relue;
    } else {
      tournee = creee;
    }
  }

  async function chargerInterventions() {
    const { data } = await sb
      .from('interventions').select('*')
      .eq('tournee_id', tournee.id)
      .eq('supprimee', false)          // les supprimees restent en base (trace admin)
      .order('ordre', { ascending: true })
      .order('created_at', { ascending: true });
    interventions = data || [];
  }

  // ---------- carte ----------

  function initCarte() {
    carte = L.map('carte-nacelliste').setView([46.6, 2.4], 6);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(carte);
    calquePoints = L.layerGroup().addTo(carte);
    calqueRoute = L.layerGroup().addTo(carte);

    // Manipulation MANUELLE de la carte (glisser, molette, doigt) :
    // on suspend le suivi automatique du camion quelque temps.
    const noterManip = () => { derniereManipCarte = Date.now(); };
    carte.on('dragstart', noterManip);
    carte.getContainer().addEventListener('wheel', noterManip, { passive: true });
    carte.getContainer().addEventListener('touchstart', noterManip, { passive: true });
  }

  function icone(numero, statut) {
    const fait = statut === 'faite';
    const enCours = statut === 'en_cours';
    const contenu = fait ? '✓' : (enCours ? '▶' : numero);
    return L.divIcon({
      className: '',
      html: `<div class="marqueur ${fait ? 'marqueur-fait' : ''} ${enCours ? 'marqueur-encours' : ''}">${contenu}</div>`,
      iconSize: [30, 30], iconAnchor: [15, 15],
    });
  }

  function rendreCarte(geometrie) {
    calquePoints.clearLayers();
    if (geometrie) calqueRoute.clearLayers();

    const bornes = [];
    for (const itv of interventions) {
      bornes.push([itv.lat, itv.lng]);
      L.marker([itv.lat, itv.lng], { icon: icone(itv.ordre || '•', itv.statut) })
        .bindPopup(`${echap(itv.client_nom || 'Client')}<br>${echap(itv.adresse)}`)
        .addTo(calquePoints);
    }

    if (geometrie) {
      L.polyline(geometrie, { color: '#E8710A', weight: 5, opacity: 0.85 }).addTo(calqueRoute);
      geometrie.forEach((p) => bornes.push(p));
      geometrieCourante = geometrie;   // sert de rail a la glisse du camion
    }
    if (dernierePosition) bornes.push([dernierePosition.lat, dernierePosition.lng]);

    // Recadrage global : pas pendant que le nacelliste manipule la
    // carte, ni en pleine tournee une fois le camion affiche (la, le
    // suivi discret — suivreCamion — s'en charge).
    const manipRecente = Date.now() - derniereManipCarte < REPIT_MANUEL_MS;
    const suiviCamion = tournee.statut === 'en_cours' && posAffichee;
    if (bornes.length && !manipRecente && !suiviCamion) {
      carte.fitBounds(bornes, { padding: [30, 30], maxZoom: 15 });
    }
  }

  // ---------- camion anime (meme rendu que la page client) ----------

  // Sommet du trace le plus proche d'un point.
  function plusProcheSurTrace(chemin, p) {
    let index = 0;
    let dist = Infinity;
    for (let k = 0; k < chemin.length; k++) {
      const d = haversine({ lat: chemin[k][0], lng: chemin[k][1] }, p);
      if (d < dist) { dist = d; index = k; }
    }
    return { index, dist };
  }

  // Fait glisser le camion le long d'une suite de points, a vitesse
  // constante, pendant dureeMs (pas de saut d'un fixe GPS a l'autre).
  function glisserCamion(points, dureeMs) {
    if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
    if (!marqueurMoi || points.length < 2) return;

    const cumuls = [0];
    for (let k = 1; k < points.length; k++) {
      cumuls.push(cumuls[k - 1] + haversine(
        { lat: points[k - 1][0], lng: points[k - 1][1] },
        { lat: points[k][0], lng: points[k][1] }));
    }
    const total = cumuls[cumuls.length - 1];
    if (total < 1) { marqueurMoi.setLatLng(points[points.length - 1]); return; }

    const debut = performance.now();
    const pas = (maintenant) => {
      const fraction = Math.min((maintenant - debut) / dureeMs, 1);
      const cible = fraction * total;
      let k = 1;
      while (k < cumuls.length - 1 && cumuls[k] < cible) k++;
      const f = (cible - cumuls[k - 1]) / Math.max(cumuls[k] - cumuls[k - 1], 0.001);
      marqueurMoi.setLatLng([
        points[k - 1][0] + (points[k][0] - points[k - 1][0]) * f,
        points[k - 1][1] + (points[k][1] - points[k - 1][1]) * f,
      ]);
      if (fraction < 1) animationId = requestAnimationFrame(pas);
      else animationId = null;
    };
    animationId = requestAnimationFrame(pas);
  }

  // Suivi discret : on recentre sur le camion seulement s'il sort du
  // cadre ET que le nacelliste n'a pas touche la carte recemment.
  function suivreCamion(pos) {
    if (tournee.statut !== 'en_cours') return;
    if (Date.now() - derniereManipCarte < REPIT_MANUEL_MS) return;
    const cadre = carte.getBounds().pad(-0.25);
    if (!cadre.contains([pos.lat, pos.lng])) {
      carte.panTo([pos.lat, pos.lng], { animate: true });
    }
  }

  function rendreMaPosition() {
    if (!dernierePosition) return;
    const cible = { lat: dernierePosition.lat, lng: dernierePosition.lng };
    const maintenant = Date.now();
    const depuisDernierFix = maintenant - dernierFixA;
    dernierFixA = maintenant;

    if (!marqueurMoi) {
      marqueurMoi = L.marker([cible.lat, cible.lng], {
        icon: L.divIcon({ className: '', html: '<div class="marqueur-camion">🚚</div>',
                          iconSize: [38, 38], iconAnchor: [19, 19] }),
        zIndexOffset: 1000,
      }).addTo(carte);
      posAffichee = cible;
      suivreCamion(cible);
      return;
    }

    if (haversine(posAffichee, cible) < 8) { posAffichee = cible; return; }

    // Glisse le long du trace routier entre l'ancienne et la nouvelle
    // position ; a defaut (hors trace), petite glisse directe.
    let points = [[posAffichee.lat, posAffichee.lng], [cible.lat, cible.lng]];
    if (geometrieCourante) {
      const i = plusProcheSurTrace(geometrieCourante, posAffichee);
      const j = plusProcheSurTrace(geometrieCourante, cible);
      if (j.index > i.index && i.dist < 80 && j.dist < 80) {
        points = [[posAffichee.lat, posAffichee.lng],
                  ...geometrieCourante.slice(i.index + 1, j.index + 1)];
      }
    }
    // La glisse dure au plus jusqu'au fixe GPS suivant (pour ne pas
    // trainer derriere la realite).
    const duree = Math.min(Math.max(depuisDernierFix, 1000), GLISSE_MAX_MS);
    glisserCamion(points, duree);
    posAffichee = cible;
    suivreCamion(cible);
  }

  // ---------- rendu liste + boutons ----------

  function rendre() {
    $('nac-date').textContent = new Date().toLocaleDateString('fr-FR',
      { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });

    const badge = $('nac-statut');
    const libelles = { preparee: 'préparée', en_cours: 'en cours', terminee: 'terminée' };
    badge.textContent = libelles[tournee.statut];
    badge.className = `badge badge-${tournee.statut}`;

    const terminee = tournee.statut === 'terminee';
    // Une intervention peut tomber a tout moment : l'ajout reste
    // possible meme tournee terminee (elle sera alors rouverte).
    $('nac-bloc-ajout').classList.remove('hidden');
    $('btn-optimiser').classList.toggle('hidden', terminee);
    $('btn-demarrer').classList.toggle('hidden', tournee.statut !== 'preparee');
    $('btn-pause').classList.toggle('hidden', tournee.statut !== 'en_cours');
    $('btn-terminer-tournee').classList.toggle('hidden', tournee.statut !== 'en_cours');

    const conteneur = $('liste-interventions');
    if (!interventions.length) {
      conteneur.innerHTML = '<p class="centre note">Aucune intervention pour l’instant.<br>Ajoutez vos clients du jour ci-dessus.</p>';
      rendreCarte(null);
      return;
    }

    const tri = interventions.slice().sort((a, b) => (a.ordre - b.ordre));
    const restantesTriees = tri.filter((i) => i.statut !== 'faite');
    const reordonnable = !terminee && restantesTriees.length > 1;

    const entete = reordonnable
      ? '<p class="note note-reordonner">✋ Glissez-déposez une carte ou utilisez ▲▼ pour changer l’ordre de passage — le trajet et les ETA se recalculent.</p>'
      : '';

    conteneur.innerHTML = entete + tri.map((itv) => {
      const fait = itv.statut === 'faite';
      const enCours = itv.statut === 'en_cours';
      const posRestante = restantesTriees.findIndex((i) => i.id === itv.id);
      const fleches = (!fait && reordonnable) ? `
          <div class="reordonner">
            <button class="btn-fleche act-monter" title="Monter" ${posRestante === 0 ? 'disabled' : ''}>▲</button>
            <button class="btn-fleche act-descendre" title="Descendre" ${posRestante === restantesTriees.length - 1 ? 'disabled' : ''}>▼</button>
          </div>` : '';
      const pastille = fait ? '✓' : (enCours ? '▶' : (itv.ordre || '•'));
      const etaCellule = fait ? heure(itv.faite_at)
        : (enCours ? 'en cours' : (itv.eta ? '≈ ' + heure(itv.eta) : ''));
      const actions = fait ? `
            <span class="note">Terminée ✅ — lien client désactivé</span>
            <button class="btn btn-petit btn-lien act-revenir">↩️ Revenir</button>
            <button class="btn btn-petit btn-lien act-supprimer">🗑️ Supprimer</button>
          ` : enCours ? `
            <button class="btn btn-petit btn-primary act-terminer">✅ Terminé</button>
            <button class="btn btn-petit btn-secondaire act-copier">🔗 Copier le lien client</button>
            <button class="btn btn-petit btn-lien act-revenir">↩️ Revenir</button>
            <button class="btn btn-petit btn-lien act-supprimer">🗑️ Supprimer</button>
          ` : `
            <button class="btn btn-petit btn-primary act-commencer">▶️ Je commence</button>
            <button class="btn btn-petit btn-secondaire act-copier">🔗 Copier le lien client</button>
            <button class="btn btn-petit btn-secondaire act-terminer">✅ Terminé</button>
            <button class="btn btn-petit btn-lien act-supprimer">🗑️ Supprimer</button>
          `;
      return `
      <div class="carte-bloc intervention ${fait ? 'intervention-faite' : ''} ${enCours ? 'intervention-encours' : ''}" data-id="${itv.id}"
           ${(!fait && reordonnable) ? 'draggable="true"' : ''}>
        <div class="intervention-entete">
          <span class="pastille ${fait ? 'pastille-faite' : ''} ${enCours ? 'pastille-encours' : ''}">${pastille}</span>
          <div class="intervention-infos">
            <div class="intervention-nom">${echap(itv.client_nom || 'Client')}${enCours ? ' <span class="badge badge-en_cours">en cours</span>' : ''}</div>
            <div class="intervention-adresse">${echap(itv.adresse)}</div>
          </div>
          <div class="intervention-eta">${etaCellule}</div>
          ${fleches}
        </div>
        <div class="intervention-actions">${actions}</div>
      </div>`;
    }).join('');

    conteneur.querySelectorAll('.act-copier').forEach((b) =>
      b.addEventListener('click', (e) => copierLien(idDe(e))));
    conteneur.querySelectorAll('.act-commencer').forEach((b) =>
      b.addEventListener('click', (e) => commencerIntervention(idDe(e))));
    conteneur.querySelectorAll('.act-terminer').forEach((b) =>
      b.addEventListener('click', (e) => terminerIntervention(idDe(e))));
    conteneur.querySelectorAll('.act-revenir').forEach((b) =>
      b.addEventListener('click', (e) => revenirIntervention(idDe(e))));
    conteneur.querySelectorAll('.act-supprimer').forEach((b) =>
      b.addEventListener('click', (e) => supprimerIntervention(idDe(e))));
    conteneur.querySelectorAll('.act-monter').forEach((b) =>
      b.addEventListener('click', (e) => deplacerIntervention(idDe(e), -1)));
    conteneur.querySelectorAll('.act-descendre').forEach((b) =>
      b.addEventListener('click', (e) => deplacerIntervention(idDe(e), +1)));
    brancherGlisserDeposer(conteneur);

    rendreCarte(null);
  }

  function idDe(e) {
    return e.target.closest('.intervention').dataset.id;
  }

  // ---------- ajout ----------

  async function ajouterIntervention(e) {
    e.preventDefault();
    message('');
    const btn = $('btn-ajouter');
    btn.disabled = true;

    try {
      const saisie = $('itv-adresse').value.trim();
      let lat, lng, adresse;

      const coords = parseLatLng(saisie);
      if (coords) {
        ({ lat, lng } = coords);
        adresse = `${lat.toFixed(6)};${lng.toFixed(6)}`;
        if (!dansLaZone(lat, lng)) throw new Error('Coordonnées hors zone (France métropolitaine attendue).');
      } else {
        const geo = await geocoderAdresse(saisie);
        ({ lat, lng } = geo);
        adresse = geo.label;
      }

      const ordreMax = interventions.reduce((m, i) => Math.max(m, i.ordre || 0), 0);
      const { data, error } = await sb.from('interventions').insert({
        tournee_id: tournee.id,
        ordre: ordreMax + 1,
        client_nom: $('itv-nom').value.trim() || null,
        adresse, lat, lng,
        infos_avant: $('itv-avant').value.trim() || null,
        infos_apres: $('itv-apres').value.trim() || null,
      }).select().single();
      if (error) throw new Error(error.message);

      interventions.push(data);
      $('form-intervention').reset();

      // Ajout sur une tournee terminee : on la ROUVRE automatiquement
      // (en_cours si le GPS tourne encore, sinon preparee — il faudra
      // re-appuyer sur « Demarrer »). Le trigger serveur reactive les
      // liens clients des arrets non faits.
      if (tournee.statut === 'terminee') {
        const nouveau = (watchId !== null) ? 'en_cours' : 'preparee';
        const { data: rouverte, error: eTournee } = await sb.from('tournees')
          .update({ statut: nouveau }).eq('id', tournee.id).select().single();
        if (eTournee) throw new Error(eTournee.message);
        tournee = rouverte;
        if (tournee.statut === 'en_cours') activerSuivi();
        message('Nouvelle intervention ajoutée — tournée rouverte.', 'ok');
      } else {
        message(`Intervention ajoutée : ${adresse}`, 'ok');
      }
      rendre();
    } catch (err) {
      message(err.message, 'erreur');
    } finally {
      btn.disabled = false;
    }
  }

  // Suppression DOUCE : jamais de vrai DELETE. L'intervention passe
  // supprimee = TRUE (le trigger serveur horodate, note l'auteur et
  // coupe le lien client) ; elle disparait de la liste, de la carte
  // et des calculs, mais l'admin garde la trace et peut restaurer.
  async function supprimerIntervention(id) {
    if (!confirm('Supprimer cette intervention ?')) return;
    const { error } = await sb.from('interventions')
      .update({ supprimee: true }).eq('id', id);
    if (error) { message(error.message, 'erreur'); return; }
    interventions = interventions.filter((i) => i.id !== id);
    rendre();
    recalculerEtas();   // itineraire + ETA recalcules sans cet arret
    message('Intervention supprimée — l’admin en garde la trace et peut la restaurer.', 'ok');
  }

  // ---------- reordonnancement manuel ----------
  // L'itineraire optimise n'est qu'une PROPOSITION : le nacelliste
  // peut changer l'ordre a la main (fleches ▲▼ ou glisser-deposer).
  // On sauve le nouvel ordre, puis on recalcule le trace routier et
  // les ETA dans CET ordre — sans jamais re-optimiser dans son dos.

  // Arrets non termines (a_faire + en_cours) dans l'ordre affiche.
  function restantesDansLOrdre() {
    return interventions.filter((i) => i.statut !== 'faite')
      .sort((a, b) => a.ordre - b.ordre);
  }

  // Meme liste, mais pour la ROUTE et les ETA : l'arret « en cours »
  // passe devant (c'est la que le nacelliste se trouve).
  function restantesPourRoute() {
    return interventions.filter((i) => i.statut !== 'faite')
      .sort((a, b) =>
        ((b.statut === 'en_cours') - (a.statut === 'en_cours')) || (a.ordre - b.ordre));
  }

  // Deplace une intervention « a faire » d'un cran (fleches ▲▼).
  function deplacerIntervention(id, delta) {
    const restantes = restantesDansLOrdre();
    const idx = restantes.findIndex((i) => i.id === id);
    const cible = idx + delta;
    if (idx < 0 || cible < 0 || cible >= restantes.length) return;
    [restantes[idx], restantes[cible]] = [restantes[cible], restantes[idx]];
    appliquerNouvelOrdre(restantes);
  }

  // Glisser-deposer (souris / desktop ; sur mobile les fleches font foi).
  function brancherGlisserDeposer(conteneur) {
    conteneur.querySelectorAll('.intervention[draggable="true"]').forEach((el) => {
      el.addEventListener('dragstart', (e) => {
        idEnDeplacement = el.dataset.id;
        el.classList.add('en-deplacement');
        e.dataTransfer.effectAllowed = 'move';
        // Firefox exige un setData pour demarrer le drag.
        e.dataTransfer.setData('text/plain', el.dataset.id);
      });
      el.addEventListener('dragend', () => {
        idEnDeplacement = null;
        el.classList.remove('en-deplacement');
      });
      el.addEventListener('dragover', (e) => {
        if (idEnDeplacement && idEnDeplacement !== el.dataset.id) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!idEnDeplacement || idEnDeplacement === el.dataset.id) return;
        const restantes = restantesDansLOrdre();
        const de = restantes.findIndex((i) => i.id === idEnDeplacement);
        const vers = restantes.findIndex((i) => i.id === el.dataset.id);
        idEnDeplacement = null;
        if (de < 0 || vers < 0) return;
        const [deplacee] = restantes.splice(de, 1);
        restantes.splice(vers, 0, deplacee);
        appliquerNouvelOrdre(restantes);
      });
    });
  }

  // Renumerote tout (les « faites » gardent le debut, les restantes
  // prennent la suite dans l'ordre demande), sauve en base, puis
  // recale trace + ETA dans ce nouvel ordre.
  async function appliquerNouvelOrdre(restantesOrdonnees) {
    if (reordonnancementEnCours) return;   // pas de sauvegardes croisees
    reordonnancementEnCours = true;
    try {
      const faites = interventions.filter((i) => i.statut === 'faite')
        .sort((a, b) => new Date(a.faite_at || 0) - new Date(b.faite_at || 0));
      let n = 0;
      const nouvelOrdre = new Map();
      for (const i of faites) nouvelOrdre.set(i.id, ++n);
      for (const i of restantesOrdonnees) nouvelOrdre.set(i.id, ++n);

      await Promise.all(interventions.map((itv) =>
        sb.from('interventions').update({ ordre: nouvelOrdre.get(itv.id) }).eq('id', itv.id)));
      interventions.forEach((itv) => { itv.ordre = nouvelOrdre.get(itv.id); });
      rendre();
    } finally {
      reordonnancementEnCours = false;
    }
    await recalculerRouteOrdreCourant();
  }

  // Rappel OSRM dans l'ordre COURANT (celui choisi a la main) :
  // nouveau trace + nouvelles ETA, ordre inchange.
  async function recalculerRouteOrdreCourant() {
    const restantes = restantesPourRoute();
    if (!restantes.length) return;
    try {
      const depart = dernierePosition
        || await positionActuelle()
        || { lat: restantes[0].lat, lng: restantes[0].lng };
      const route = await itineraireOsrm(depart, restantes.map((i) => ({ lat: i.lat, lng: i.lng })));
      const etas = calculerEtas(new Date(), route.durees, parametres.temps_intervention_min);
      await Promise.all(restantes.map((itv, k) =>
        sb.from('interventions').update({ eta: etas[k].toISOString() }).eq('id', itv.id)));
      restantes.forEach((itv, k) => { itv.eta = etas[k].toISOString(); });
      rendre();
      rendreCarte(route.geometrie);
      message('Nouvel ordre enregistré — trajet et ETA recalculés.', 'ok');
    } catch (err) {
      // OSRM injoignable : l'ordre est quand meme sauve.
      message(`Nouvel ordre enregistré. ${err.message}`, 'info');
    }
  }

  // ---------- optimisation + ETA ----------

  function positionActuelle(timeoutMs = 6000) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
      );
    });
  }

  async function optimiser() {
    // L'arret « en cours » n'est pas re-melange : il reste en tete
    // (le nacelliste y est) ; on optimise le reste.
    const enCoursActuels = interventions.filter((i) => i.statut === 'en_cours');
    const restantes = interventions.filter((i) => i.statut === 'a_faire');
    if (!restantes.length && !enCoursActuels.length) { message('Aucune intervention à optimiser.', 'info'); return; }

    const btn = $('btn-optimiser');
    btn.disabled = true;
    btn.textContent = 'Calcul…';
    message('');

    try {
      // Point de depart : ma position si le GPS repond, sinon le
      // premier point saisi.
      const premierPoint = enCoursActuels[0] || restantes[0];
      const depart = dernierePosition
        || await positionActuelle()
        || { lat: premierPoint.lat, lng: premierPoint.lng };

      const ordreIdx = ordonnerPoints(
        enCoursActuels[0] ? { lat: enCoursActuels[0].lat, lng: enCoursActuels[0].lng } : depart,
        restantes.map((i) => ({ lat: i.lat, lng: i.lng })));
      const ordonnees = [...enCoursActuels, ...ordreIdx.map((k) => restantes[k])];

      // Numerotation continue : les « faites » gardent le debut,
      // les restantes prennent la suite dans l'ordre optimise.
      const faites = interventions.filter((i) => i.statut === 'faite')
        .sort((a, b) => new Date(a.faite_at || 0) - new Date(b.faite_at || 0));
      let n = 0;
      const nouvelOrdre = new Map();
      for (const i of faites) nouvelOrdre.set(i.id, ++n);
      for (const i of ordonnees) nouvelOrdre.set(i.id, ++n);

      // Vrai trace routier + durees de conduite.
      const route = await itineraireOsrm(depart, ordonnees.map((i) => ({ lat: i.lat, lng: i.lng })));
      const etas = calculerEtas(new Date(), route.durees, parametres.temps_intervention_min);

      // Sauvegarde ordre + ETA.
      await Promise.all(interventions.map((itv) => {
        const maj = { ordre: nouvelOrdre.get(itv.id) };
        const pos = ordonnees.findIndex((o) => o.id === itv.id);
        if (pos >= 0) maj.eta = etas[pos].toISOString();
        return sb.from('interventions').update(maj).eq('id', itv.id);
      }));

      interventions.forEach((itv) => {
        itv.ordre = nouvelOrdre.get(itv.id);
        const pos = ordonnees.findIndex((o) => o.id === itv.id);
        if (pos >= 0) itv.eta = etas[pos].toISOString();
      });

      rendre();
      rendreCarte(route.geometrie);
      const km = (route.distance / 1000).toFixed(1);
      message(`Itinéraire optimisé : ${ordonnees.length} arrêts, ${km} km de route. C’est une proposition — réordonnez à la main si besoin.`, 'ok');
    } catch (err) {
      message(err.message, 'erreur');
    } finally {
      btn.disabled = false;
      btn.textContent = '🧭 Ré-optimiser (auto)';
    }
  }

  // Recalcul leger des ETA en cours de tournee (position qui bouge,
  // client termine) : OSRM depuis la derniere position, dans l'ordre
  // deja etabli (pas de re-optimisation surprise pour le nacelliste).
  async function recalculerEtas() {
    if (recalculEnCours || !dernierePosition || tournee.statut !== 'en_cours') return;
    const restantes = restantesPourRoute();
    if (!restantes.length) return;

    recalculEnCours = true;
    try {
      const route = await itineraireOsrm(dernierePosition,
        restantes.map((i) => ({ lat: i.lat, lng: i.lng })));
      const etas = calculerEtas(new Date(), route.durees, parametres.temps_intervention_min);
      await Promise.all(restantes.map((itv, k) =>
        sb.from('interventions').update({ eta: etas[k].toISOString() }).eq('id', itv.id)));
      restantes.forEach((itv, k) => { itv.eta = etas[k].toISOString(); });
      rendre();
      rendreCarte(route.geometrie);
    } catch (_) {
      // OSRM indisponible : on garde les ETA precedentes.
    } finally {
      recalculEnCours = false;
    }
  }

  // ---------- tournee : demarrer / pause / terminer ----------

  async function demarrer() {
    const { data, error } = await sb.from('tournees')
      .update({ statut: 'en_cours' }).eq('id', tournee.id).select().single();
    if (error) { message(error.message, 'erreur'); return; }
    tournee = data;

    // Menage de la trace GPS ancienne (>48 h) — meilleur moment :
    // personne n'attend cette requete.
    sb.rpc('nettoyer_positions').then(() => {}, () => {});

    activerSuivi();
    rendre();
  }

  function activerSuivi() {
    $('nac-suivi-actif').classList.remove('hidden');

    if (!navigator.geolocation) {
      message('GPS non disponible sur cet appareil — la tournée continue en mode progression, sans position live.', 'erreur');
      return;
    }

    if (watchId !== null) return;
    watchId = navigator.geolocation.watchPosition(
      async (p) => {
        dernierePosition = { lat: p.coords.latitude, lng: p.coords.longitude };
        rendreMaPosition();
        if (enPause || tournee.statut !== 'en_cours') return;
        const maintenant = Date.now();
        if (maintenant - dernierEnvoi < ENVOI_POSITION_MS) return;
        dernierEnvoi = maintenant;
        await sb.from('positions').insert({
          nacelliste_id: profil.id,
          tournee_id: tournee.id,
          lat: dernierePosition.lat,
          lng: dernierePosition.lng,
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          message('Autorisation GPS refusée — la tournée continue en mode progression, sans position live. Les clients verront quand même l’avancement.', 'erreur');
        } else {
          message('Signal GPS perdu — nouvelle tentative automatique…', 'info');
        }
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );

    if (!timerEta) timerEta = setInterval(recalculerEtas, RECALCUL_ETA_MS);
    // Premier calcul rapide des que la position arrive.
    setTimeout(recalculerEtas, 8000);
  }

  function desactiverSuivi() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (timerEta) { clearInterval(timerEta); timerEta = null; }
    $('nac-suivi-actif').classList.add('hidden');
  }

  function basculerPause() {
    enPause = !enPause;
    $('btn-pause').textContent = enPause ? '▶️ Reprendre GPS' : '⏸️ Pause GPS';
    $('nac-suivi-actif').innerHTML = enPause
      ? '⏸️ Suivi de position en pause'
      : '<span class="point-vert"></span> Suivi de position activé';
  }

  // « Je commence » : cet arret passe en_cours. Un SEUL arret en
  // cours a la fois : l'eventuel autre repasse « a faire ».
  async function commencerIntervention(id) {
    const autre = interventions.find((i) => i.statut === 'en_cours' && i.id !== id);
    if (autre) {
      const { data: dAutre, error: eAutre } = await sb.from('interventions')
        .update({ statut: 'a_faire' }).eq('id', autre.id).select().single();
      if (eAutre) { message(eAutre.message, 'erreur'); return; }
      interventions = interventions.map((i) => (i.id === autre.id ? dAutre : i));
    }
    const { data, error } = await sb.from('interventions')
      .update({ statut: 'en_cours' }).eq('id', id).select().single();
    if (error) { message(error.message, 'erreur'); return; }
    interventions = interventions.map((i) => (i.id === id ? data : i));
    rendre();
    recalculerEtas();
    message(autre
      ? 'Intervention commencée — la précédente « en cours » est repassée « à faire ».'
      : 'Intervention commencée — le client voit « le nacelliste est arrivé ».', 'ok');
  }

  // « Revenir » : rouvre un arret (faite ou en_cours -> a_faire).
  // Si l'arret etait « faite », le trigger serveur REACTIVE son lien
  // client, et le changement est journalise en base.
  async function revenirIntervention(id) {
    const itv = interventions.find((i) => i.id === id);
    if (!itv) return;
    const etaitFaite = itv.statut === 'faite';
    const question = etaitFaite
      ? 'Rouvrir cet arrêt ?\nIl repasse « à faire » et le lien client est RÉACTIVÉ.'
      : 'Remettre cet arrêt « à faire » ?';
    if (!confirm(question)) return;

    const { data, error } = await sb.from('interventions')
      .update({ statut: 'a_faire' }).eq('id', id).select().single();
    if (error) { message(error.message, 'erreur'); return; }
    interventions = interventions.map((i) => (i.id === id ? data : i));
    rendre();
    recalculerEtas();
    message(etaitFaite
      ? 'Arrêt rouvert — le lien client est de nouveau actif.'
      : 'Arrêt remis « à faire ».', 'ok');
  }

  async function terminerIntervention(id) {
    if (!confirm('Marquer cette intervention comme terminée ?\nLe lien client affichera « terminé » et sera désactivé.')) return;
    const { data, error } = await sb.from('interventions')
      .update({ statut: 'faite' }).eq('id', id).select().single();
    if (error) { message(error.message, 'erreur'); return; }

    interventions = interventions.map((i) => (i.id === id ? data : i));
    rendre();
    recalculerEtas();

    if (!interventions.some((i) => i.statut !== 'faite')) {
      message('Tous les clients sont faits 🎉 — vous pouvez terminer la tournée.', 'ok');
    }
  }

  async function terminerTournee() {
    const restantes = interventions.filter((i) => i.statut !== 'faite').length;
    const avertissement = restantes
      ? `Il reste ${restantes} intervention(s) non faite(s).\n`
      : '';
    if (!confirm(`${avertissement}Terminer la tournée ?\nLe suivi GPS s’arrête. Les liens des arrêts non faits restent valables.`)) return;

    const { data, error } = await sb.from('tournees')
      .update({ statut: 'terminee' }).eq('id', tournee.id).select().single();
    if (error) { message(error.message, 'erreur'); return; }
    tournee = data;

    desactiverSuivi();
    await chargerInterventions();
    rendre();
    message('Tournée terminée. Suivi GPS arrêté — les liens des arrêts non faits restent actifs.', 'ok');
  }

  // ---------- lien client ----------

  async function copierLien(id) {
    const itv = interventions.find((i) => i.id === id);
    if (!itv) return;
    const url = new URL(`client.html?t=${itv.token}`, window.location.href).href;
    try {
      await navigator.clipboard.writeText(url);
      message('Lien client copié — à donner au client sur place.', 'ok');
    } catch (_) {
      // Vieil Android sans clipboard API : on montre le lien.
      prompt('Copiez le lien client :', url);
    }
  }

  // ---------- evenements ----------

  function brancherEvenements() {
    $('form-intervention').addEventListener('submit', ajouterIntervention);
    $('btn-optimiser').addEventListener('click', optimiser);
    $('btn-demarrer').addEventListener('click', demarrer);
    $('btn-pause').addEventListener('click', basculerPause);
    $('btn-terminer-tournee').addEventListener('click', terminerTournee);
  }

  return { init };
})();
