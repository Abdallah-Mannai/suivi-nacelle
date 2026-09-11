// ============================================================
// auth.js — page de connexion.
// Identifiant + mot de passe crees par l'admin.
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('form-connexion');
  const err  = document.getElementById('erreur');
  const btn  = document.getElementById('btn-connexion');

  const afficherErreur = (texte) => {
    err.textContent = texte;
    err.classList.remove('hidden');
  };

  // Deja connecte : on saute la connexion.
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) { window.location.replace('app.html'); return; }
  } catch (_) { /* configuration Supabase absente : on laisse le formulaire */ }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');

    const identifiant = document.getElementById('identifiant').value.trim();
    const motdepasse  = document.getElementById('motdepasse').value;
    if (!identifiant || !motdepasse) return;

    btn.disabled = true;
    btn.textContent = 'Connexion…';

    const { data, error } = await sb.auth.signInWithPassword({
      email: loginVersEmail(identifiant),
      password: motdepasse,
    });

    if (error) {
      afficherErreur('Identifiant ou mot de passe incorrect.');
      btn.disabled = false;
      btn.textContent = 'Se connecter';
      return;
    }

    // Un compte desactive garde ses identifiants valides cote Auth :
    // on le refuse ici, et la RLS le bloque de toute facon cote base.
    const { data: profil } = await sb
      .from('profils').select('actif').eq('id', data.user.id).maybeSingle();

    if (profil && profil.actif === false) {
      await sb.auth.signOut();
      afficherErreur('Ce compte est désactivé. Contactez votre administrateur.');
      btn.disabled = false;
      btn.textContent = 'Se connecter';
      return;
    }

    window.location.replace('app.html');
  });
});
