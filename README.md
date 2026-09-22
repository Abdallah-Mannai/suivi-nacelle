# 🏗️ Suivi Nacelle — tournée temps réel type Uber

Suivi de tournée d'un **nacelliste** qui passe chez des clients après le technicien fibre.
Trois faces :

- **Admin** : crée les comptes nacellistes, voit la **liste continue** de chaque nacelliste
  (avec la trace des suppressions), une carte globale en direct, et règle les paramètres
  (temps d'intervention moyen, textes, téléphone de contact).
- **Nacelliste** (mobile) : gère **UNE liste continue** d'interventions — **sans notion de
  jour** : ce qu'il saisit (le soir pour le lendemain, ou à tout moment) **reste dans sa liste**
  tant que ce n'est pas fait ou supprimé, rien ne se vide au changement de date. Il saisit ses
  interventions (adresse ou `lat;lng`), obtient un **itinéraire optimisé** (ordre + tracé
  routier + ETA) — une **proposition** qu'il peut **réordonner à la main** (flèches ▲▼ ou
  glisser-déposer, tracé et ETA recalculés dans son ordre, bouton « Ré-optimiser » pour revenir
  à l'auto) —, passe **« En tournée »** (partage GPS, arrêtable à tout moment sans toucher à la
  liste),
  suit chaque arrêt en **trois états** (« ▶️ Je commence » → `en_cours` → « ✅ Terminé »,
  un seul arrêt en cours à la fois), peut **« ↩️ Revenir »** (rouvrir un arrêt : le lien client
  est réactivé et le changement journalisé) et donne à chaque client son **lien de suivi**.
  Les interventions **faites** restent consultables dans une section « faites » repliée.
- **Client** (lien unique, sans compte) : carte **plein écran** façon appli de livraison, avec
  un **camion 🚚 animé** qui **glisse le long du tracé routier OSRM** vers chez lui (pas de
  saut entre deux positions), le tracé nacelliste → client affiché, les autres arrêts en
  **ronds gris anonymes** (coordonnées arrondies côté serveur, jamais de nom ni d'adresse).
  En bandeau bas : statut clair (« En route vers vous », « en intervention avant vous »,
  « arrivé »), **ETA** (« vers 14h30 »), « Il y a N arrêts avant vous », barre de progression,
  **📞 Contact** (nacelliste + responsable, cliquables) — puis « Intervention terminée ✅ »
  avec les numéros.

**100 % gratuit** : JavaScript vanilla (aucun framework, aucun build), Supabase (Auth +
PostgreSQL + RLS + Realtime), Leaflet + OpenStreetMap, itinéraires OSRM public, géocodage
Base Adresse Nationale, hébergement GitHub Pages. Aucun secret dans le front.

---

## Mise en route

### 1. Créer le projet Supabase (dédié)

1. <https://supabase.com> → **New project** (nom : `suivi-nacelle`, région Europe, plan Free).
2. **SQL Editor** → coller et exécuter `supabase/migrations/nacelle_v1.sql`,
   puis `nacelle_v2.sql`, `nacelle_v3.sql`, `nacelle_v4.sql`, `nacelle_v5.sql`
   et `nacelle_v6.sql`, dans cet ordre (idempotents : ré-exécutables sans risque).
   La v6 instaure la **liste continue** (fin de la tournée par jour) et **rapatrie**
   les interventions des anciennes tournées datées — rien n'est perdu.

### 2. Vérifier Realtime

La migration ajoute déjà `positions`, `interventions` et `tournees` à la publication
Realtime. Pour vérifier : **Database > Replication > supabase_realtime** — les trois tables
doivent être cochées.

> La page **client** n'utilise pas Realtime (elle n'a pas de compte, donc pas de RLS) :
> elle interroge l'Edge Function `suivi-client` toutes les 10 s. Realtime sert à l'admin
> (carte globale) et aux mises à jour authentifiées.

### 3. Créer le compte admin

1. **Authentication > Users > Add user** :
   - Email : `admin@nacelle.local` — Password : au choix — ✅ *Auto Confirm User*.
2. **SQL Editor**, une seule fois :

```sql
UPDATE profils
   SET nom = 'Admin', role = 'admin', login = 'admin'
 WHERE id = (SELECT id FROM auth.users WHERE email = 'admin@nacelle.local');
```

### 4. Déployer les Edge Functions

Avec la [CLI Supabase](https://supabase.com/docs/guides/cli) (`npx supabase login` puis
`npx supabase link --project-ref <ref-du-projet>`) :

```bash
npx supabase functions deploy admin-comptes
npx supabase functions deploy suivi-client --no-verify-jwt
```

> `--no-verify-jwt` est **indispensable** pour `suivi-client` : le client final n'a pas de
> compte, il s'identifie uniquement par son token (48 caractères aléatoires générés par la
> base). La fonction ne renvoie que le strict minimum pour CE token — jamais les autres
> clients ni leurs adresses.

Les secrets (`SUPABASE_SERVICE_ROLE_KEY`, etc.) sont fournis automatiquement par la
plateforme aux fonctions : **rien à copier, rien dans le front**.

### 5. Configurer le front

Dans `js/supabase-config.js`, remplir avec **Project Settings > API** :

```js
const SUPABASE_URL      = 'https://xxxxxxxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJ...';   // clé anon/public UNIQUEMENT
```

### 6. GitHub Pages

1. Pousser le dépôt sur GitHub (branche `main`).
2. **Settings > Pages > Source : GitHub Actions** — le workflow
   `.github/workflows/static.yml` déploie à chaque push.

### 7. Premiers pas

1. Se connecter en `admin` → onglet **Comptes** → créer Hamda, Lheoui, Klach, Zitouni.
2. Le nacelliste se connecte sur son téléphone → ajoute ses interventions (quand il veut :
   elles restent dans sa liste) → **Ré-optimiser** → **En tournée** (autoriser le GPS).
3. Chez chaque client : **🔗 Copier le lien client** (à donner sur place), puis **✅ Terminé**
   en repartant.

---

## Sécurité (résumé)

| Point | Comment |
|---|---|
| Secrets | Uniquement côté Edge Functions (service_role jamais dans le front). |
| Comptes nacellistes | Créés par l'admin via `admin-comptes` (vérifie que l'appelant est un admin actif). |
| RLS | Stricte sur toutes les tables : un nacelliste ne voit que **ses** tournées/interventions/positions ; `positions` n'est inscriptible que par son propriétaire. |
| Lien client | Token ≥ 48 caractères hex aléatoires générés **par la base** ; lecture **seule**, filtrée, via `suivi-client` ; ne renvoie jamais l'identité des autres interventions. |
| Points anonymes | Les autres arrêts affichés au client sont anonymisés **côté serveur** : lat/lng arrondis à 3 décimales (~100 m) + statut, triés par latitude (l'ordre du tableau ne révèle pas l'ordre de passage) — ni nom, ni adresse, ni token, ni ETA, ni id. |
| Expiration | Le lien d'un arrêt reste **actif tant que l'arrêt n'est pas « faite »** (ou supprimé). « Terminé » → `token_actif = false` (page « terminé ✅ » + numéros, jamais « invalide ») ; arrêter le partage GPS ne coupe **aucun** lien. |
| Retour arrière | « ↩️ Revenir » rouvre un arrêt : le trigger serveur réactive le token, et chaque changement de statut est journalisé dans `interventions_journal` (écrit uniquement par trigger, lisible par le propriétaire/l'admin). |
| Suppression douce | « 🗑️ Supprimer » côté nacelliste ne fait **jamais** de DELETE : `supprimee = true` (trigger serveur : horodatage, auteur, lien client coupé, journal `supprimee`/`restauree`). L'arrêt est traité comme inexistant par `suivi-client`. L'admin voit la trace (qui, quand, statut) et est **seul** à pouvoir restaurer (verrou par trigger). |
| Vie privée GPS | Position captée **uniquement** pendant `en_cours`, bandeau « Suivi de position activé » visible, bouton pause, envoi toutes les ~25 s, purge automatique à 48 h. |

## Tests

Logique pure (optimiseur, ETA, parsing coordonnées, garde-fous géocodage) :

```bash
node --test test/itineraire.test.mjs
```

Scénario complet à vérifier à la main : voir la section 10 du cahier des charges
(création compte → ajout 4 interventions → optimiser → démarrer → lien client →
terminé → GPS refusé → token invalide).

## Services externes (gratuits, sans clé)

- **OSRM** : `router.project-osrm.org` (tracé routier + durées). Usage raisonnable :
  recalcul des ETA au plus toutes les 3 min par tournée.
- **BAN** : `api-adresse.data.gouv.fr` (géocodage, France métropolitaine).
- **OpenStreetMap** : tuiles de carte (Leaflet via CDN).
