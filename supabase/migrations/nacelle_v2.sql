-- ============================================================
-- Suivi Nacelle — migration v2
-- Telephone du nacelliste (affiche au client dans l'onglet
-- « Contact » via l'Edge Function suivi-client, jamais en direct).
--
-- Additive et idempotente, comme la v1 : re-executable sans risque.
-- A coller dans Supabase > SQL Editor.
-- ============================================================

ALTER TABLE profils ADD COLUMN IF NOT EXISTS telephone TEXT;
