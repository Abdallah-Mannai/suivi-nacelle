-- ============================================================
-- Suivi Nacelle — migration v4
-- Regle des liens clients revue : le lien d'un arret reste ACTIF
-- tant que cet arret n'est pas « faite ».
--
-- 1. La fin de tournee ne desactive PLUS les liens des arrets non
--    faits (avant : tous les tokens etaient coupes -> les clients
--    non servis voyaient « lien invalide » a tort).
-- 2. La reouverture d'une tournee terminee (nouvelle intervention
--    ajoutee tard) reactive les liens des arrets non faits.
-- 3. Reparation des donnees existantes : les tokens d'arrets non
--    faits desactives par une ancienne fin de tournee sont reactives.
--
-- Note : aucune contrainte n'empeche d'INSERER une intervention sur
-- une tournee « terminee » (la RLS ne verifie que la propriete de la
-- tournee) — l'ajout tardif est donc deja permis cote base.
--
-- Additive et idempotente : re-executable sans risque.
-- A coller dans Supabase > SQL Editor.
-- ============================================================


-- ============================================================
-- 1 + 2. TRIGGER FIN / REOUVERTURE DE TOURNEE (remplace la v1)
-- ============================================================
-- - tournee -> terminee : on ne touche plus aux tokens (ceux des
--   arrets « faite » sont deja desactives par trg_intervention_faite) ;
-- - tournee terminee -> preparee / en_cours (reouverture) : on
--   REACTIVE les liens des arrets non faits, au cas ou une ancienne
--   version les aurait coupes.

CREATE OR REPLACE FUNCTION nacelle_tournee_expire_tokens()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NEW.statut IN ('preparee', 'en_cours') AND OLD.statut = 'terminee' THEN
    UPDATE interventions
       SET token_actif = TRUE
     WHERE tournee_id = NEW.id AND statut <> 'faite' AND NOT token_actif;
  END IF;
  RETURN NEW;
END; $fn$;

-- (le trigger trg_tournee_expire_tokens de la v1 pointe deja sur
--  cette fonction : pas besoin de le recreer)


-- ============================================================
-- 3. REPARATION DES DONNEES EXISTANTES
-- ============================================================
-- Seuls deux mecanismes desactivaient un token : le passage en
-- « faite » (conserve) et l'ancienne fin de tournee (supprimee).
-- Tout token inactif d'un arret non fait vient donc de l'ancien
-- comportement : on le reactive.

UPDATE interventions
   SET token_actif = TRUE
 WHERE statut <> 'faite' AND NOT token_actif;
