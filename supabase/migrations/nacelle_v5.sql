-- ============================================================
-- Suivi Nacelle — migration v5
-- Suppression DOUCE des interventions (soft delete) :
--   - le nacelliste ne fait jamais de DELETE : il passe
--     supprimee = TRUE, la ligne reste en base (trace pour l'admin) ;
--   - horodatage + auteur + coupure du lien client geres par
--     trigger, cote serveur ;
--   - RESTAURATION (supprimee -> FALSE) reservee a l'admin,
--     verrouillee par trigger (la RLS ne sait pas comparer
--     l'ancienne et la nouvelle valeur) ;
--   - suppression et restauration journalisees dans
--     interventions_journal (actions « supprimee » / « restauree »).
--
-- Additive et idempotente : re-executable sans risque.
-- A coller dans Supabase > SQL Editor.
-- ============================================================


-- ============================================================
-- 1. COLONNES
-- ============================================================

ALTER TABLE interventions ADD COLUMN IF NOT EXISTS supprimee     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE interventions ADD COLUMN IF NOT EXISTS supprimee_at  TIMESTAMPTZ;
ALTER TABLE interventions ADD COLUMN IF NOT EXISTS supprimee_par UUID REFERENCES profils(id) ON DELETE SET NULL;

-- Les listes filtrent presque toujours sur « non supprimee ».
CREATE INDEX IF NOT EXISTS idx_interventions_supprimee
  ON interventions (tournee_id) WHERE supprimee;


-- ============================================================
-- 2. TRIGGER SUPPRESSION / RESTAURATION
-- ============================================================
-- - supprimee FALSE -> TRUE : horodatage + auteur (auth.uid()) +
--   lien client desactive. Autorise pour le proprietaire (la RLS
--   garantit deja qu'il ne touche que SES interventions) et l'admin.
-- - supprimee TRUE -> FALSE (restauration) : ADMIN UNIQUEMENT ;
--   trace effacee, lien client reactive si l'arret n'est pas fait.

CREATE OR REPLACE FUNCTION nacelle_intervention_suppression()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NEW.supprimee AND NOT OLD.supprimee THEN
    NEW.supprimee_at  := NOW();
    NEW.supprimee_par := COALESCE(auth.uid(), NEW.supprimee_par);
    NEW.token_actif   := FALSE;
  ELSIF OLD.supprimee AND NOT NEW.supprimee THEN
    IF NOT est_admin() THEN
      RAISE EXCEPTION 'Seul l''administrateur peut restaurer une intervention supprimée.';
    END IF;
    NEW.supprimee_at  := NULL;
    NEW.supprimee_par := NULL;
    NEW.token_actif   := (NEW.statut <> 'faite');
  END IF;
  RETURN NEW;
END; $fn$;

DROP TRIGGER IF EXISTS trg_intervention_suppression ON interventions;
CREATE TRIGGER trg_intervention_suppression
  BEFORE UPDATE ON interventions
  FOR EACH ROW EXECUTE FUNCTION nacelle_intervention_suppression();


-- ============================================================
-- 3. JOURNAL (remplace la version v3 de la fonction)
-- ============================================================
-- En plus des changements de statut, on journalise la suppression
-- (« supprimee ») et la restauration (« restauree ») : qui, quand.

CREATE OR REPLACE FUNCTION nacelle_journal_statut()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NEW.supprimee AND NOT OLD.supprimee THEN
    INSERT INTO interventions_journal
      (intervention_id, ancien_statut, nouveau_statut, token_reactive, modifie_par)
    VALUES
      (NEW.id, OLD.statut, 'supprimee', FALSE, auth.uid());
  ELSIF OLD.supprimee AND NOT NEW.supprimee THEN
    INSERT INTO interventions_journal
      (intervention_id, ancien_statut, nouveau_statut, token_reactive, modifie_par)
    VALUES
      (NEW.id, 'supprimee', 'restauree',
       (NEW.token_actif AND NOT OLD.token_actif), auth.uid());
  ELSIF NEW.statut IS DISTINCT FROM OLD.statut THEN
    INSERT INTO interventions_journal
      (intervention_id, ancien_statut, nouveau_statut, token_reactive, modifie_par)
    VALUES
      (NEW.id, OLD.statut, NEW.statut,
       (NEW.token_actif AND NOT OLD.token_actif), auth.uid());
  END IF;
  RETURN NEW;
END; $fn$;

-- (le trigger trg_journal_statut de la v3 pointe deja sur cette
--  fonction : pas besoin de le recreer)


-- ============================================================
-- 4. REOUVERTURE DE TOURNEE (remplace la version v4)
-- ============================================================
-- La reactivation des liens a la reouverture d'une tournee ne doit
-- PAS toucher les arrets supprimes : leur lien reste mort.

CREATE OR REPLACE FUNCTION nacelle_tournee_expire_tokens()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NEW.statut IN ('preparee', 'en_cours') AND OLD.statut = 'terminee' THEN
    UPDATE interventions
       SET token_actif = TRUE
     WHERE tournee_id = NEW.id AND statut <> 'faite'
       AND NOT token_actif AND NOT supprimee;
  END IF;
  RETURN NEW;
END; $fn$;

-- (le trigger trg_tournee_expire_tokens pointe deja sur cette
--  fonction : pas besoin de le recreer)
