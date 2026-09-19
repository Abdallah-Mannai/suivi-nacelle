// ============================================================
// Edge Function « suivi-client » — l'UNIQUE porte d'entree du client.
//
// Le client final n'a pas de compte : il arrive avec un token long et
// imprevisible (genere par la base, 48 caracteres hexadecimaux).
// Cette fonction detient la cle service_role cote serveur et renvoie,
// pour un token valide, STRICTEMENT le minimum :
//   - la derniere position du nacelliste (un seul point),
//   - l'ETA chez CE client, la progression (« a X arrets »),
//   - les infos avant / apres, les telephones de contact
//     (nacelliste + responsable),
//   - les AUTRES arrets de la tournee sous forme STRICTEMENT
//     anonyme : lat/lng arrondis a 3 decimales (~100 m) + statut,
//     tries par latitude pour ne pas trahir l'ordre de passage.
// JAMAIS l'adresse, le nom, le token ou l'ETA d'un autre client.
// Un token inconnu/expire ne renvoie RIEN.
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

  // Le nacelliste de la tournee : prenom + telephone (onglet Contact).
  const { data: nacelliste } = await admin
    .from('profils')
    .select('nom, telephone')
    .eq('id', tournee.nacelliste_id)
    .maybeSingle();

  const telephoneNacelliste = nacelliste?.telephone || null;

  // Intervention faite : message « termine » + infos apres + numeros.
  if (itv.statut === 'faite') {
    return json({
      etat: 'termine',
      faite_at: itv.faite_at,
      infos_apres: itv.infos_apres || params?.infos_apres_defaut || '',
      telephone,
      telephone_nacelliste: telephoneNacelliste,
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

  // Les AUTRES arrets de la tournee, ANONYMISES au maximum :
  //   - lat/lng arrondis a 3 decimales (~100 m) : impossible de
  //     retrouver une adresse precise,
  //   - statut fait / a_faire (pour griser les arrets deja faits),
  //   - RIEN d'autre (ni nom, ni adresse, ni token, ni ETA, ni id),
  //   - tries par latitude puis longitude : l'ORDRE du tableau ne
  //     revele pas l'ordre de passage de la tournee.
  const { data: autres } = await admin
    .from('interventions')
    .select('id, lat, lng, statut')
    .eq('tournee_id', itv.tournee_id);

  const arrondi = (x: number) => Math.round(x * 1000) / 1000;
  const autresArrets = (autres ?? [])
    .filter((a) => a.id !== itv.id)
    .map((a) => ({
      lat: arrondi(a.lat),
      lng: arrondi(a.lng),
      statut: a.statut === 'faite' ? 'fait' : 'a_faire',
    }))
    .sort((a, b) => (a.lat - b.lat) || (a.lng - b.lng));

  return json({
    etat: 'suivi',
    tournee_statut: tournee.statut,                 // preparee | en_cours
    nacelliste_nom: nacelliste?.nom ?? 'Le nacelliste',
    position: pos ? { lat: pos.lat, lng: pos.lng, captured_at: pos.captured_at } : null,
    eta: itv.eta,
    arrets_avant: count ?? 0,
    destination: { lat: itv.lat, lng: itv.lng },    // l'adresse DU client lui-meme
    autres_arrets: autresArrets,                    // points anonymes (voir ci-dessus)
    infos_avant: itv.infos_avant || params?.infos_avant_defaut || '',
    seuil_retard_min: params?.seuil_retard_min ?? 15,
    telephone,                                      // responsable (retard + onglet Contact)
    telephone_nacelliste: telephoneNacelliste,      // onglet Contact
  });
});
