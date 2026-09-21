// ============================================================
// admin.js — ecran admin : comptes nacellistes (via l'Edge
// Function « admin-comptes »), tournees du jour, carte globale
// temps reel, parametres.
// ============================================================

const AdminApp = (() => {

  let profil = null;
  let carte = null;
  let marqueurs = new Map();   // nacelliste_id -> L.marker
  let nomsNacellistes = new Map();
  let carteInitialisee = false;
  let canalTempsReel = null;

  const $ = (id) => document.getElementById(id);

  function echap(texte) {
    const div = document.createElement('div');
    div.textContent = String(texte ?? '');
    return div.innerHTML;
  }

  function dateDuJour() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  }

  function heure(dateIso) {
    if (!dateIso) return '—';
    return new Date(dateIso).toLocaleTimeString('fr-FR',
      { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  }

  function message(texte, type = 'info') {
    const el = $('admin-message');
    el.textContent = texte;
    el.className = `msg msg-${type}`;
    if (!texte) el.classList.add('hidden');
  }

  // ---------- init + onglets ----------

  async function init(p) {
    profil = p;

    document.querySelectorAll('.onglet').forEach((btn) => {
      btn.addEventListener('click', () => afficherOnglet(btn.dataset.onglet));
    });

    $('form-compte').addEventListener('submit', creerCompte);
    $('form-parametres').addEventListener('submit', enregistrerParametres);

    await Promise.all([chargerTournees(), chargerComptes(), chargerParametres()]);
    abonnerTempsReel();
  }

  function afficherOnglet(nom) {
    document.querySelectorAll('.onglet').forEach((b) =>
      b.classList.toggle('actif', b.dataset.onglet === nom));
    document.querySelectorAll('.panneau').forEach((s) =>
      s.classList.toggle('hidden', s.id !== `onglet-${nom}`));

    if (nom === 'carte') initCarteGlobale();
    if (nom === 'tournees') chargerTournees();
  }

  // ---------- tournees du jour ----------

  async function chargerTournees() {
    const jour = dateDuJour();
    const { data: tournees } = await sb
      .from('tournees')
      .select('id, statut, demarree_at, terminee_at, nacelliste_id, profils(nom)')
      .eq('date', jour)
      .order('created_at');

    const conteneur = $('admin-tournees');
    if (!tournees || !tournees.length) {
      conteneur.innerHTML = '<p class="centre note">Aucune tournée aujourd’hui.</p>';
      return;
    }

    const { data: itvs } = await sb
      .from('interventions')
      .select('id, tournee_id, ordre, client_nom, adresse, statut, eta, faite_at, supprimee, supprimee_at, supprimee_par')
      .in('tournee_id', tournees.map((t) => t.id))
      .order('ordre');

    // Noms des auteurs de suppression (nacelliste ou admin).
    const { data: profs } = await sb.from('profils').select('id, nom');
    const nomDe = new Map((profs || []).map((p) => [p.id, p.nom]));

    const libelles = { preparee: 'préparée', en_cours: 'en cours', terminee: 'terminée' };
    const libellesItv = { a_faire: 'à faire', en_cours: 'en cours', faite: 'faite' };
    conteneur.innerHTML = tournees.map((t) => {
      const toutes = (itvs || []).filter((i) => i.tournee_id === t.id);
      const liste = toutes.filter((i) => !i.supprimee);
      const supprimees = toutes.filter((i) => i.supprimee);
      const faites = liste.filter((i) => i.statut === 'faite').length;
      nomsNacellistes.set(t.nacelliste_id, t.profils?.nom || '?');
      return `
      <div class="carte-bloc">
        <div class="intervention-entete">
          <div class="intervention-infos">
            <div class="intervention-nom">🚚 ${echap(t.profils?.nom || '?')}</div>
            <div class="note">${faites}/${liste.length} interventions faites
              ${t.demarree_at ? ` — départ ${heure(t.demarree_at)}` : ''}
              ${t.terminee_at ? ` — fin ${heure(t.terminee_at)}` : ''}</div>
          </div>
          <span class="badge badge-${t.statut}">${libelles[t.statut]}</span>
        </div>
        ${liste.map((i) => `
          <div class="admin-itv ${i.statut === 'faite' ? 'intervention-faite' : ''}">
            <span class="pastille pastille-petite ${i.statut === 'faite' ? 'pastille-faite' : (i.statut === 'en_cours' ? 'pastille-encours' : '')}">${i.statut === 'faite' ? '✓' : (i.statut === 'en_cours' ? '▶' : (i.ordre || '•'))}</span>
            <span class="admin-itv-adresse">${echap(i.client_nom ? i.client_nom + ' — ' : '')}${echap(i.adresse)}</span>
            <span class="intervention-eta">${i.statut === 'faite' ? heure(i.faite_at) : (i.eta ? '≈ ' + heure(i.eta) : '')}</span>
          </div>`).join('')}
        ${supprimees.length ? `
        <details class="sous-details">
          <summary>🗑️ ${supprimees.length} intervention${supprimees.length > 1 ? 's' : ''} supprimée${supprimees.length > 1 ? 's' : ''} (trace)</summary>
          ${supprimees.map((i) => `
          <div class="admin-itv intervention-faite" data-id="${i.id}">
            <span class="pastille pastille-petite">🗑️</span>
            <span class="admin-itv-adresse">${echap(i.client_nom ? i.client_nom + ' — ' : '')}${echap(i.adresse)}
              <br><span class="note">était « ${libellesItv[i.statut] || i.statut} » — supprimée par
              ${echap(nomDe.get(i.supprimee_par) || '?')} à ${heure(i.supprimee_at)}</span></span>
            <button class="btn btn-petit btn-secondaire act-restaurer">↩️ Restaurer</button>
          </div>`).join('')}
        </details>` : ''}
      </div>`;
    }).join('');

    conteneur.querySelectorAll('.act-restaurer').forEach((b) =>
      b.addEventListener('click', (e) => restaurerIntervention(
        e.target.closest('[data-id]').dataset.id)));
  }

  // Restauration (admin uniquement — verrouille par trigger serveur) :
  // l'arret revient dans la liste du nacelliste, lien client reactive
  // si l'arret n'est pas fait.
  async function restaurerIntervention(id) {
    if (!confirm('Restaurer cette intervention ?\nElle revient dans la tournée du nacelliste.')) return;
    const { error } = await sb.from('interventions')
      .update({ supprimee: false }).eq('id', id);
    message(error ? error.message : 'Intervention restaurée.', error ? 'erreur' : 'ok');
    chargerTournees();
  }

  // ---------- carte globale temps reel ----------

  function initCarteGlobale() {
    if (!carteInitialisee) {
      carte = L.map('carte-admin').setView([46.6, 2.4], 6);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(carte);
      carteInitialisee = true;
    }
    setTimeout(() => carte.invalidateSize(), 100);
    chargerDernieresPositions();
  }

  function poserMarqueur(nacellisteId, lat, lng, capturedAt) {
    const nom = nomsNacellistes.get(nacellisteId) || 'Nacelliste';
    const texte = `${nom} — ${heure(capturedAt)}`;
    if (marqueurs.has(nacellisteId)) {
      marqueurs.get(nacellisteId).setLatLng([lat, lng]).setPopupContent(texte);
    } else {
      const m = L.marker([lat, lng], {
        icon: L.divIcon({ className: '', html: `<div class="marqueur-moi">🚚</div>`,
                          iconSize: [34, 34], iconAnchor: [17, 17] }),
      }).bindPopup(texte).bindTooltip(nom, { permanent: true, direction: 'bottom', offset: [0, 14] });
      m.addTo(carte);
      marqueurs.set(nacellisteId, m);
    }
  }

  async function chargerDernieresPositions() {
    // Dernieres positions recentes (12 h), la plus fraiche par nacelliste.
    const depuis = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const { data } = await sb
      .from('positions')
      .select('nacelliste_id, lat, lng, captured_at')
      .gte('captured_at', depuis)
      .order('captured_at', { ascending: false })
      .limit(200);

    const vues = new Set();
    const bornes = [];
    for (const p of data || []) {
      if (vues.has(p.nacelliste_id)) continue;
      vues.add(p.nacelliste_id);
      poserMarqueur(p.nacelliste_id, p.lat, p.lng, p.captured_at);
      bornes.push([p.lat, p.lng]);
    }
    if (bornes.length) carte.fitBounds(bornes, { padding: [40, 40], maxZoom: 13 });
  }

  function abonnerTempsReel() {
    canalTempsReel = sb
      .channel('admin-live')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'positions' },
        (evt) => {
          const p = evt.new;
          if (carteInitialisee) poserMarqueur(p.nacelliste_id, p.lat, p.lng, p.captured_at);
        })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'interventions' },
        () => {
          if (!$('onglet-tournees').classList.contains('hidden')) chargerTournees();
        })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'tournees' },
        () => {
          if (!$('onglet-tournees').classList.contains('hidden')) chargerTournees();
        })
      .subscribe();
  }

  // ---------- comptes ----------

  async function chargerComptes() {
    const { data: comptes } = await sb
      .from('profils')
      .select('id, nom, login, role, actif, telephone')
      .eq('role', 'nacelliste')
      .order('nom');

    const conteneur = $('admin-comptes-liste');
    if (!comptes || !comptes.length) {
      conteneur.innerHTML = '<p class="centre note">Aucun nacelliste. Créez les comptes de Hamda, Lheoui, Klach et Zitouni ci-dessus.</p>';
      return;
    }

    conteneur.innerHTML = comptes.map((c) => `
      <div class="carte-bloc intervention-entete" data-id="${c.id}">
        <div class="intervention-infos">
          <div class="intervention-nom">${echap(c.nom)} ${c.actif ? '' : '<span class="badge badge-inactif">désactivé</span>'}</div>
          <div class="note">identifiant : ${echap(c.login || '?')} — 📞 ${echap(c.telephone || 'non renseigné')}</div>
        </div>
        <button class="btn btn-petit btn-secondaire act-telephone" title="Modifier le téléphone">📞</button>
        <button class="btn btn-petit ${c.actif ? 'btn-danger' : 'btn-secondaire'} act-basculer">
          ${c.actif ? 'Désactiver' : 'Réactiver'}
        </button>
      </div>`).join('');

    conteneur.querySelectorAll('.act-basculer').forEach((b) =>
      b.addEventListener('click', async (e) => {
        const ligne = e.target.closest('[data-id]');
        const compte = comptes.find((c) => c.id === ligne.dataset.id);
        await sb.from('profils').update({ actif: !compte.actif }).eq('id', compte.id);
        chargerComptes();
      }));

    conteneur.querySelectorAll('.act-telephone').forEach((b) =>
      b.addEventListener('click', async (e) => {
        const ligne = e.target.closest('[data-id]');
        const compte = comptes.find((c) => c.id === ligne.dataset.id);
        const saisie = prompt(`Téléphone de ${compte.nom} (montré au client dans l’onglet Contact) :`,
          compte.telephone || '');
        if (saisie === null) return;
        const { error } = await sb.from('profils')
          .update({ telephone: saisie.trim() || null }).eq('id', compte.id);
        message(error ? error.message : 'Téléphone mis à jour.', error ? 'erreur' : 'ok');
        chargerComptes();
      }));
  }

  async function creerCompte(e) {
    e.preventDefault();
    message('');
    const btn = $('btn-creer-compte');
    btn.disabled = true;
    btn.textContent = 'Création…';

    try {
      const { data: { session } } = await sb.auth.getSession();
      const reponse = await fetch(`${SUPABASE_URL}/functions/v1/admin-comptes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          action: 'creer',
          nom: $('cpt-nom').value.trim(),
          login: $('cpt-login').value.trim(),
          motdepasse: $('cpt-mdp').value,
          telephone: $('cpt-tel').value.trim(),
        }),
      });
      const resultat = await reponse.json();
      if (!reponse.ok) throw new Error(resultat.erreur || 'Création impossible.');

      message(`Compte « ${resultat.login} » créé. Transmettez l’identifiant et le mot de passe au nacelliste.`, 'ok');
      $('form-compte').reset();
      chargerComptes();
    } catch (err) {
      message(err.message, 'erreur');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Créer le compte';
    }
  }

  // ---------- parametres ----------

  async function chargerParametres() {
    const { data } = await sb.from('parametres').select('*').eq('id', 1).maybeSingle();
    if (!data) return;
    $('par-temps').value = data.temps_intervention_min;
    $('par-seuil').value = data.seuil_retard_min;
    $('par-tel').value = data.telephone_contact;
    $('par-avant').value = data.infos_avant_defaut;
    $('par-apres').value = data.infos_apres_defaut;
  }

  async function enregistrerParametres(e) {
    e.preventDefault();
    const { error } = await sb.from('parametres').update({
      temps_intervention_min: parseInt($('par-temps').value, 10),
      seuil_retard_min: parseInt($('par-seuil').value, 10),
      telephone_contact: $('par-tel').value.trim(),
      infos_avant_defaut: $('par-avant').value.trim(),
      infos_apres_defaut: $('par-apres').value.trim(),
      updated_at: new Date().toISOString(),
    }).eq('id', 1);

    message(error ? error.message : 'Paramètres enregistrés.', error ? 'erreur' : 'ok');
  }

  return { init };
})();
