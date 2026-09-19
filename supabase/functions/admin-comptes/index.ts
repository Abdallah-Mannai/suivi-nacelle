// ============================================================
// Edge Function « admin-comptes »
//
// Creer un compte demande la cle service_role, qui ne doit jamais
// arriver dans le navigateur. Cette fonction la detient cote serveur
// et ne fait rien sans avoir verifie que l'appelant est bien un
// admin ACTIF.
//
// Deploiement :
//   supabase functions deploy admin-comptes
// (SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont fournis
//  automatiquement par la plateforme.)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (corps: unknown, statut = 200) =>
  new Response(JSON.stringify(corps), {
    status: statut,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const URL_SB    = Deno.env.get('SUPABASE_URL')!;
const CLE_ANON  = Deno.env.get('SUPABASE_ANON_KEY')!;
const CLE_ADMIN = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DOMAINE   = Deno.env.get('LOGIN_DOMAINE') ?? 'nacelle.local';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ erreur: 'Méthode non autorisée' }, 405);

  // --- 1. Qui appelle ? ---
  const autorisation = req.headers.get('Authorization') ?? '';
  if (!autorisation.startsWith('Bearer ')) return json({ erreur: 'Non authentifié' }, 401);

  const clientAppelant = createClient(URL_SB, CLE_ANON, {
    global: { headers: { Authorization: autorisation } },
  });

  const { data: { user }, error: errUser } = await clientAppelant.auth.getUser();
  if (errUser || !user) return json({ erreur: 'Session invalide' }, 401);

  // --- 2. Est-il admin ? ---
  const admin = createClient(URL_SB, CLE_ADMIN);
  const { data: profil } = await admin
    .from('profils').select('role, actif').eq('id', user.id).maybeSingle();

  if (!profil || !profil.actif || profil.role !== 'admin') {
    return json({ erreur: 'Réservé à l’admin' }, 403);
  }

  // --- 3. Action demandee ---
  let corps: Record<string, unknown>;
  try { corps = await req.json(); } catch { return json({ erreur: 'Requête illisible' }, 400); }

  if (corps.action !== 'creer') return json({ erreur: 'Action inconnue' }, 400);

  const nom        = String(corps.nom ?? '').trim();
  const login      = String(corps.login ?? '').trim().toLowerCase();
  const motdepasse = String(corps.motdepasse ?? '');
  const telephone  = String(corps.telephone ?? '').trim() || null;

  if (!nom) return json({ erreur: 'Nom manquant' }, 400);
  if (!/^[a-z0-9._-]{3,}$/.test(login))
    return json({ erreur: 'Identifiant invalide (minuscules, sans espace, 3 caractères minimum)' }, 400);
  if (motdepasse.length < 8)
    return json({ erreur: 'Mot de passe trop court (8 caractères minimum)' }, 400);

  // Identifiant deja pris ?
  const { data: existant } = await admin
    .from('profils').select('id').ilike('login', login).maybeSingle();
  if (existant) return json({ erreur: `L'identifiant « ${login} » est déjà utilisé` }, 409);

  // --- 4. Creation (toujours role « nacelliste » : un seul admin) ---
  // L'e-mail d'authentification est technique : c'est l'identifiant.
  const { data: cree, error: errCreation } = await admin.auth.admin.createUser({
    email: `${login}@${DOMAINE}`,
    password: motdepasse,
    email_confirm: true,
    user_metadata: { nom, role: 'nacelliste', login },
  });

  if (errCreation || !cree?.user) {
    return json({ erreur: errCreation?.message ?? 'Création impossible' }, 400);
  }

  // Le trigger nacelle_handle_new_user a deja cree la ligne « profils ».
  // On la reecrit ici pour rester correct meme si le trigger a ete
  // desactive ou si la migration n'est pas a jour.
  const { error: errProfil } = await admin.from('profils').upsert({
    id: cree.user.id,
    nom, role: 'nacelliste', login, telephone,
    actif: true,
  });

  if (errProfil) {
    // On ne laisse pas un compte Auth sans profil : il serait
    // inutilisable et invisible dans l'ecran « Comptes ».
    await admin.auth.admin.deleteUser(cree.user.id);
    return json({ erreur: errProfil.message }, 400);
  }

  return json({ ok: true, id: cree.user.id, login });
});
