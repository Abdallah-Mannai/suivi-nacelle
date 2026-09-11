# 🏗️ Suivi Nacelle — tournée temps réel type Uber

Suivi de tournée d'un **nacelliste** qui passe chez des clients après le technicien fibre.
Trois faces :

- **Admin** : crée les comptes nacellistes, voit les tournées du jour, une carte globale en
  direct, et règle les paramètres (temps d'intervention moyen, textes, téléphone de contact).
- **Nacelliste** (mobile) : saisit ses interventions du jour (adresse ou `lat;lng`), obtient un
  **itinéraire optimisé** (ordre + tracé routier + ETA), **démarre sa tournée** (partage GPS),
  clique **« Terminé »** chez chaque client et lui donne son **lien de suivi**.
- **Client** (lien unique, sans compte) : voit le nacelliste **en temps réel sur la carte**,
  son **heure d'arrivée estimée**, la progression (« à X arrêts de chez vous ») et les infos
  utiles — puis « Intervention terminée ✅ » avec le numéro de contact.

**100 % gratuit** : JavaScript vanilla (aucun framework, aucun build), Supabase (Auth +
PostgreSQL + RLS + Realtime), Leaflet + OpenStreetMap, itinéraires OSRM public, géocodage
Base Adresse Nationale, hébergement GitHub Pages. Aucun secret dans le front.

---

## Mise en route

### 1. Créer le projet Supabase (dédié)

1. <https://supabase.com> → **New project** (nom : `suivi-nacelle`, région Europe, plan Free).
2. **SQL Editor** → coller et exécuter `supabase/migrations/nacelle_v1.sql`
   (idempotent : ré-exécutable sans risque).

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
2. Le nacelliste se connecte sur son téléphone → ajoute ses interventions →
   **Optimiser l'itinéraire** → **Démarrer la tournée** (autoriser le GPS).
3. Chez chaque client : **🔗 Copier le lien client** (à donner sur place), puis **✅ Terminé**
   en repartant.

---

## Sécurité (résumé)

| Point | Comment |
|---|---|
| Secrets | Uniquement côté Edge Functions (service_role jamais dans le front). |
| Comptes nacellistes | Créés par l'admin via `admin-comptes` (vérifie que l'appelant est un admin actif). |
| RLS | Stricte sur toutes les tables : un nacelliste ne voit que **ses** tournées/interventions/positions ; `positions` n'est inscriptible que par son propriétaire. |
| Lien client | Token ≥ 48 caractères hex aléatoires générés **par la base** ; lecture **seule**, filtrée, via `suivi-client` ; ne renvoie jamais les autres interventions. |
| Expiration | « Terminé » → `token_actif = false` (page « terminé ✅ » + numéro) ; tournée terminée → **tous** les tokens désactivés (lien « expiré », aucune donnée). |
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
