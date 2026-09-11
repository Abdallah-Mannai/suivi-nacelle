// ============================================================
// app.js — amorcage de app.html : session, profil, aiguillage
// vers la vue admin ou la vue nacelliste.
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { window.location.replace('index.html'); return; }

  const { data: profil } = await sb
    .from('profils')
    .select('id, nom, role, actif')
    .eq('id', session.user.id)
    .maybeSingle();

  if (!profil || profil.actif === false) {
    await sb.auth.signOut();
    window.location.replace('index.html');
    return;
  }

  document.getElementById('entete-nom').textContent = profil.nom || '';
  document.getElementById('btn-deconnexion').addEventListener('click', async () => {
    await sb.auth.signOut();
    window.location.replace('index.html');
  });

  document.getElementById('chargement').classList.add('hidden');

  if (profil.role === 'admin') {
    document.getElementById('vue-admin').classList.remove('hidden');
    AdminApp.init(profil);
  } else {
    document.getElementById('vue-nacelliste').classList.remove('hidden');
    NacellisteApp.init(profil);
  }
});
