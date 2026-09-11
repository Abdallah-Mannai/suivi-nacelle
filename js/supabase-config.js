// ============================================================
// supabase-config.js — connexion au projet Supabase DEDIE au
// suivi nacelle.
//
// A REMPLIR apres avoir cree le projet (voir README, etape 1) :
//   Supabase > Project Settings > API
//     - Project URL       -> SUPABASE_URL
//     - anon / public key -> SUPABASE_ANON_KEY
//
// La cle « anon » est PUBLIQUE par nature : elle ne donne acces qu'a
// ce que la RLS autorise pour l'utilisateur connecte. La cle
// service_role, elle, ne doit JAMAIS apparaitre ici — elle vit
// uniquement dans les secrets Supabase, cote Edge Functions.
// ============================================================

const SUPABASE_URL      = 'A_REMPLIR';   // ex. https://xxxxxxxx.supabase.co
const SUPABASE_ANON_KEY = 'A_REMPLIR';

// Les nacellistes se connectent avec un identifiant simple
// (« hamda »), pas avec une adresse e-mail : Supabase Auth exige un
// e-mail, on lui fabrique donc « hamda@nacelle.local ». Ce domaine
// n'a pas besoin d'exister : aucun message n'y est jamais envoye.
const LOGIN_DOMAINE = 'nacelle.local';

// Identifiant saisi -> e-mail technique attendu par Supabase Auth.
function loginVersEmail(saisie) {
  const s = String(saisie || '').trim().toLowerCase();
  return s.includes('@') ? s : `${s}@${LOGIN_DOMAINE}`;
}

// La page client (client.html) ne charge pas la librairie Supabase :
// elle n'utilise que l'Edge Function « suivi-client » via fetch.
var sb = null;
if (window.supabase) {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
}
