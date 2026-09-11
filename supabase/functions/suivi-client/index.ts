// ============================================================
// Edge Function « suivi-client » — l'UNIQUE porte d'entree du client.
//
// Le client final n'a pas de compte : il arrive avec un token long et
// imprevisible (genere par la base, 48 caracteres hexadecimaux).
// Cette fonction detient la cle service_role cote serveur et renvoie,
// pour un token valide, STRICTEMENT le minimum :
//   - la derniere position du nacelliste (un seul point),
//   - l'ETA chez CE client, la progression (« a X arrets »),
//   - les infos avant / apres, le telephone de contact.
// JAMAIS la liste des autres interventions, ni leurs adresses, ni
// quoi que ce soit d'autre. Un token inconnu/expire ne renvoie RIEN.
//
// Deploiement (PUBLIQUE : le client n'a pas de JWT) :
//   supabase functions deploy suivi-client --no-verify-jwt
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
const CLE_ADMIN = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ erreur: 'Méthode non autorisée' }, 405);

  let corps: Record<string, unknown>;
  try { corps = await req.json(); } catch { return json({ etat: 'invalide' }, 400); }

  // Un vrai token fait 48 caracteres hexadecimaux : tout le reste est
  // rejete sans meme interroger la base (pas d'enumeration possible,
  // la recherche se fait sur un index unique).
  const token = String(corps.token ?? '');
  if (!/^[0-9a-f]{32,64}$/.test(token)) return json({ etat: 'invalide' }, 404);

  const admin = createClient(URL_SB, CLE_ADMIN);

  const { data: itv } = await admin
    .from('interventions')
    .select('id, tournee_id, ordre, statut, faite_at, token_actif, eta, infos_avant, infos_apres, lat, lng')
    .eq('token', token)
    .maybeSingle();

  if (!itv) return json({ etat: 'invalide' }, 404);

  const { data: tournee } = await admin
    .from('tournees')
    .select('statut, nacelliste_id')
    .eq('id', itv.tournee_id)
    .maybeSingle();

  const { data: params } = await admin
    .from('parametres')
    .select('telephone_contact, seuil_retard_min, infos_avant_defaut, infos_apres_defaut')
    .eq('id', 1)
    .maybeSingle();

  const telephone = params?.telephone_contact ?? '0615324767';

  // Tournee terminee = fin de journee : le lien est mort, on ne
  // renvoie plus AUCUNE donnee (test n°6 du cahier des charges).
  if (!tournee || tournee.statut === 'terminee') {
    return json({ etat: 'expire' }, 410);
  }

  // Intervention faite : message « termine » + infos apres + numero.
  if (itv.statut === 'faite') {
    return json({
      etat: 'termine',
      faite_at: itv.faite_at,
      infos_apres: itv.infos_apres || params?.infos_apres_defaut || '',
      telephone,
    });
  }

  // Token desactive manuellement (sans etre « faite ») : lien mort.
  if (!itv.token_actif) return json({ etat: 'expire' }, 410);

  // --- Suivi live ---
  // Derniere position du nacelliste sur CETTE tournee (un seul point).
  const { data: pos } = await admin
    .from('positions')
    .select('lat, lng, captured_at')
    .eq('tournee_id', itv.tournee_id)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Progression : combien d'arrets restants AVANT ce client, sans
  // jamais reveler qui ils sont ni ou ils sont.
  const { count } = await admin
    .from('interventions')
    .select('id', { count: 'exact', head: true })
    .eq('tournee_id', itv.tournee_id)
    .eq('statut', 'a_faire')
    .lt('ordre', itv.ordre);

  // Le nom du nacelliste (prenom seul suffit au client).
  const { data: nacelliste } = await admin
    .from('profils')
    .select('nom')
    .eq('id', tournee.nacelliste_id)
    .maybeSingle();

  return json({
    etat: 'suivi',
    tournee_statut: tournee.statut,                 // preparee | en_cours
    nacelliste_nom: nacelliste?.nom ?? 'Le nacelliste',
    position: pos ? { lat: pos.lat, lng: pos.lng, captured_at: pos.captured_at } : null,
    eta: itv.eta,
    arrets_avant: count ?? 0,
    destination: { lat: itv.lat, lng: itv.lng },    // l'adresse DU client lui-meme
    infos_avant: itv.infos_avant || params?.infos_avant_defaut || '',
    seuil_retard_min: params?.seuil_retard_min ?? 15,
    telephone,                                      // affiche cote client SEULEMENT si retard
  });
});
