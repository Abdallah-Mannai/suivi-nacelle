-- ============================================================
-- Suivi Nacelle — migration v6
-- LISTE CONTINUE : fin de la « tournee par jour ».
--
-- Probleme corrige : les interventions etaient rattachees a une
-- tournee liee a la DATE du jour. Le nacelliste qui preparait ses
-- interventions le soir retombait le lendemain sur une tournee
-- vide — tout semblait efface. Desormais :
--   - chaque nacelliste a UNE tournee « permanente » (sa liste
--     continue) : plus de creation/cloture quotidienne ;
--   - le statut de cette tournee ne suit plus la journee mais le
--     PARTAGE GPS : 'preparee' = GPS arrete, 'en_cours' = en
--     tournee ('terminee' n'est plus utilise) ;
--   - les interventions des anciennes tournees datees sont
--     RAPATRIEES dans la liste continue : rien n'est perdu, les
--     « faite » / supprimees gardent leur statut (historique et
--     trace admin conserves) ;
--   - les liens clients des arrets non faits, coupes par une
--     ancienne fin de tournee, sont reactives.
--
-- Additive et idempotente : re-executable sans risque, ne detruit
-- aucune donnee. A coller dans Supabase > SQL Editor.
-- ============================================================


-- ============================================================
-- 1. COLONNE « permanente » + index
-- ============================================================

ALTER TABLE tournees ADD COLUMN IF NOT EXISTS permanente BOOLEAN NOT NULL DEFAULT FALSE;

-- Une SEULE liste continue par nacelliste.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tournees_permanente
  ON tournees (nacelliste_id) WHERE permanente;

-- L'ancienne regle « une tournee par nacelliste et par jour » n'a
-- plus lieu d'etre (elle empecherait de creer la liste continue un
-- jour ou une tournee datee existe deja).
DROP INDEX IF EXISTS idx_tournees_jour;


-- ============================================================
-- 2. UNE LISTE CONTINUE PAR NACELLISTE
-- ============================================================
-- Pour chaque nacelliste sans liste permanente : on promeut sa
-- tournee la plus recente (aucune donnee creee inutilement), ou on
-- en cree une s'il n'en a jamais eu. Re-execution : ne fait rien.

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.id FROM profils p
    WHERE p.role = 'nacelliste'
      AND NOT EXISTS (
        SELECT 1 FROM tournees t
         WHERE t.nacelliste_id = p.id AND t.permanente = TRUE)
  LOOP
    UPDATE tournees SET permanente = TRUE
     WHERE id = (SELECT id FROM tournees
                 WHERE nacelliste_id = r.id
                 ORDER BY date DESC, created_at DESC LIMIT 1);
    IF NOT FOUND THEN
      INSERT INTO tournees (nacelliste_id, permanente) VALUES (r.id, TRUE);
    END IF;
  END LOOP;
END $$;


-- ============================================================
-- 3. RAPATRIEMENT DES INTERVENTIONS EXISTANTES
-- ============================================================
-- TOUTES les interventions des anciennes tournees datees rejoignent
-- la liste continue de leur nacelliste : les non-faites REVIENNENT
-- dans la liste de travail, les « faite » alimentent l'historique,
-- les supprimees gardent leur trace admin. Aucun statut ne change,
-- aucun token ne change (les liens clients restent les memes).

UPDATE interventions i
   SET tournee_id = tp.id
  FROM tournees ta, tournees tp
 WHERE i.tournee_id = ta.id
   AND ta.permanente = FALSE
   AND tp.nacelliste_id = ta.nacelliste_id
   AND tp.permanente = TRUE;

-- Renumerotation propre apres fusion (plusieurs tournees pouvaient
-- utiliser les memes numeros) : les « faite » gardent le debut
-- (dans l'ordre ou elles ont ete faites), les restantes suivent
-- dans leur ordre actuel. Meme convention que l'application.
WITH nouvelle AS (
  SELECT i.id,
         ROW_NUMBER() OVER (
           PARTITION BY i.tournee_id
           ORDER BY (i.statut = 'faite') DESC,
                    i.faite_at NULLS LAST,
                    i.ordre, i.created_at
         ) AS n
    FROM interventions i
    JOIN tournees t
      ON t.id = i.tournee_id
   WHERE t.permanente = TRUE
     AND i.supprimee = FALSE
)
UPDATE interventions SET ordre = nouvelle.n
  FROM nouvelle WHERE interventions.id = nouvelle.id;


-- ============================================================
-- 4. PLUS DE CLOTURE QUOTIDIENNE
-- ============================================================
-- Une liste continue « terminee » (ancienne fin de tournee) repasse
-- en attente. Le trigger trg_tournee_expire_tokens (v5) reactive au
-- passage les liens clients des arrets non faits et non supprimes.

UPDATE tournees SET statut = 'preparee'
 WHERE permanente = TRUE AND statut = 'terminee';

-- Et dans tous les cas (meme si la liste promue n'etait pas
-- « terminee ») : les liens clients des arrets NON faits et NON
-- supprimes, coupes par une ancienne fin de tournee, sont reactives.
-- Meme reparation que la v4, appliquee a la liste continue.
UPDATE interventions i
   SET token_actif = TRUE
  FROM tournees t
 WHERE t.id = i.tournee_id
   AND t.permanente = TRUE
   AND i.statut <> 'faite'
   AND i.supprimee = FALSE
   AND i.token_actif = FALSE;
