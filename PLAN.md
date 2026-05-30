# Open Fit Project — Plan de création

## Context

Projet greenfield (dossier vide, pas encore de git). Objectif : une **plateforme fitness/santé auto-hébergée, 100% sans cloud et open source (GPL)**.

**Périmètre de NOTRE projet** : *récupérer* les données **en local / sur le serveur auto-hébergé*, les **afficher** (dashboard themable, multi-UI) et les **traiter** (déduplication multi-appareils + algorithmes). Le **support matériel est délégué à Gadgetbridge** : ajouter un nouvel appareil (Suunto, Coros, etc.) = affaire de Gadgetbridge, pas de notre code. On consomme ce que Gadgetbridge expose, plus un **import zip initial** pour le backfill.

Matériel de l'utilisateur : **Garmin Forerunner 945**, **Stryd (wind)**, **Amazfit Helio strap**.

Le projet a **deux cœurs novateurs** :
1. **Déduplication/fusion multi-appareils** : X appareils sur un même effort → 1 workout logique, conservant tout le brut, choisissant la meilleure source *par métrique* (préférences persistantes, modifiables, rétroactives ou non) → plusieurs « interprétations » des mêmes données.
2. **Algorithmes en plugins** : couche de traitement (HRV, recovery/readiness, staging sommeil, charge d'entraînement, anomalies) sous forme de **plugins chargeables à la volée**, versionnés, avec un **registre communautaire** (site participatif) où l'on partage des algos **selon le hardware**.

### Réalités d'accès aux données
- **Zéro cloud** : voies Garmin Connect / Zepp / Stryd PowerCenter **volontairement exclues**.
- **Backfill initial** : fichiers `.fit` (USB / export zip). **En continu** : via **Gadgetbridge** (BLE local).
- **Stryd** : puissance/wind **embarquée dans le FIT d'activité Garmin** → pas de source séparée (si extraite par BLE/USB).
- **Helio strap** : cloudless seulement via les **protocoles Gadgetbridge** (BLE).
- **Google Fit & co.** : via **Android Health Connect** (agrégateur on-device) — canal alimenté par Gadgetbridge/autres.
- **FIT** : lecture OK en Rust (`fitparser`) ; **écriture** de workouts immature en Rust (risque, phase 6).

### Décisions verrouillées (avec l'utilisateur)
- **Zéro cloud, par principe** ; exception = import zip initial unique.
- **Licence GPL-compatible** → embarquer Gadgetbridge (GPLv3) autorisé. *Reco à acter : **AGPLv3 serveur** (copyleft réseau, adapté self-hosted web) + **GPLv3 mobile** ; compatible Gadgetbridge (GPL) & wger (AGPL).*
- Backend **100% Rust** ; Frontend **React + TS, API-first, themable**.
- **Support hardware délégué à Gadgetbridge** → notre ingestion = *import fichier initial* + *pont Gadgetbridge*. Pas de zoo de connecteurs vendeurs chez nous.
- **App mobile : interop avec Gadgetbridge d'abord**, puis **embarquer ses modules device** après validation. Plus tard : **sync BLE depuis un PC**.
- **Ingestion temps réel** (HR continu, sommeil) explicite.
- **Algorithmes = système de plugins chargeables à la volée + registre communautaire** ; couche développée en **phase dédiée après le temps réel** (modèle haut-débit pré-câblé dès le jour 1).
- Déploiement **Docker Compose**, **2 paliers** (*simple* / *full*).
- Premier livrable = **colonne data + dashboard** (MVP).

## Architecture cible

Workspace Rust + frontend React + app mobile Android. Palier « simple » = binaire `ofit-api` + SQLite (wizard 1er lancement) ; « full » = Compose (api + Postgres/Timescale).

```
open-fit/
  Cargo.toml                  # workspace
  crates/
    ofit-core/                # entités canoniques + moteur dédup/fusion + résolveur par métrique
    ofit-ingest/             # import fichier initial (FIT) + pont Gadgetbridge + ingestion batch & stream
    ofit-analytics/          # exécution des algorithmes (built-in + plugins), métriques dérivées versionnées
    ofit-plugins/            # hôte de plugins WASM (Extism/wasmtime) : algos chargeables à la volée, sandboxés
    ofit-db/                  # sqlx (SQLite + Postgres/Timescale), migrations, stockage time-series
    ofit-api/                 # axum : REST + WebSocket/SSE (temps réel), OpenAPI (utoipa), auth mono-user
    ofit-mcp/                 # (tardif) serveur MCP au-dessus de l'API
  mobile/                     # app Android GPL : interop Gadgetbridge → puis modules device vendorés (hub BLE)
  registry/                   # (tardif) site participatif de partage d'algorithmes (service web séparé)
  web/                        # React + Vite + TS ; client typé généré depuis OpenAPI
  migrations/  docker/  Dockerfile
```

**Stack Rust** : `axum` (REST + temps réel WS/SSE), `sqlx` (SQLite **et** Postgres dès le départ), `tokio`, `utoipa` (OpenAPI → client TS), `fitparser`, hôte WASM (`extism`/`wasmtime`). Time-series : Timescale (Postgres) ou tables compactes (SQLite) pour le HR continu.
**Web** : Vite + React + TS ; charts **uPlot**, cartes **MapLibre GL** ; thème via **design tokens** ; UIs = clients de l'API typée.
**Mobile** : Android GPL — **étape 1 interop** (export/Health Connect de Gadgetbridge → relai API), **étape 2** vendoring des modules device (hub BLE direct).

### Ingestion (volontairement étroite)
Une **API d'ingestion unique** (batch + streaming) alimentée par deux adaptateurs seulement : **import fichier initial** (FIT) et **pont Gadgetbridge** (export DB / Health Connect / FIT). Petit trait interne pour ces adaptateurs, sans plugin system côté hardware (c'est Gadgetbridge le point d'extension matériel).

### Algorithmes (le point d'extension de NOTRE projet)
`ofit-plugins` = **hôte WASM** exécutant des algos **sandboxés** (pas d'accès réseau, limites CPU/mémoire) car ils traitent des données santé et pourront venir de tiers. Chaque plugin déclare : entrées (métriques/streams requis), **hardware applicable**, version, sorties. `ofit-analytics` orchestre built-ins + plugins → **DerivedMetric/DerivedStream** rattachés à une version d'algo, **recalculables**. Le **registre communautaire** (`registry/`) permet publier/parcourir/installer des plugins par hardware.

## Modèle de données canonique

- **Source** : instance d'appareil/fournisseur (priorités par défaut).
- **RawRecording** : artefact **immuable** (fichier/sync) — original, hash (dédup exacte), source, sport, début/fin, métadonnées.
- **Activity** (workout logique) : regroupe les recordings d'un même effort (chevauchement + sport) → **unité de dédup**.
- **Stream** : time-series par recording (HR, puissance, cadence, vitesse, altitude, lat/lng, vent…).
- **Wellness continu/temps réel** : HR live, sommeil (stades), HR repos, HRV, stress, body battery, (posture) — haute résolution. **Conçu pour le streaming dès le jour 1.**
- **MetricSourcePreference** : résolveur par métrique — **défaut persistant** + **override par Activity** + bascule **rétroactif on/off**.
- **DerivedMetric / DerivedStream** : sorties d'algorithmes, liées à un **plugin + version**, recalculables → « interprétations » des dérivées.
- **Vue canonique résolue** (cache) : meilleure source par métrique → workout/jour fusionné.

**Dédup** : (1) hash fichier ; (2) clustering temporel + sport → 1 Activity (fusion/split manuel) ; (3) résolution par métrique (défauts → futurs ; rétroactif → re-résout l'historique).

## Roadmap par phases

**Phase 0 — Fondations** : workspace Rust, Compose (2 paliers), `ofit-db` + migrations (SQLite/Postgres, time-series), config + wizard, auth mono-user, scaffold OpenAPI, scaffold React+Vite (thème). Acter la licence (AGPL serveur / GPL mobile).

**Phase 1 — MVP : colonne data + dashboard** *(point de départ)*
- Ingestion **pur Rust** : import zip/FIT initial. Modèle pré-câblé **haut-débit/streaming**.
- Modèle canonique + **moteur de dédup v1** (hash + clustering + préférences par métrique, défaut/override/rétroactif).
- API REST + client TS typé.
- Dashboard : liste + détail (uPlot + MapLibre), **UI de sélection de source par métrique**, tendances wellness ; thème via tokens.
- **Vérif** : importer tes vrais FIT 945+Stryd → 1 workout fusionné, bonne source par métrique.

**Phase 2 — Pont Gadgetbridge cloudless + temps réel** *(cœur du « zéro cloud »)*
- **2a (interop)** : app mobile GPL lisant Gadgetbridge (export DB / **Health Connect**) → relai API (**batch + streaming HR/sommeil** via WS/SSE). Prouve la boucle vite.
- **2b (embarqué)** : **vendorer les modules device de Gadgetbridge** → hub BLE direct, vrai temps réel.
- **Gate de validation** (cf. risques) : FIT Garmin (avec Stryd) extractible par BLE ? Helio couvert ? → conditionne 2b.

**Phase 3 — Algorithmes & runtime de plugins** : `ofit-plugins` (hôte WASM sandboxé) + `ofit-analytics` ; algos built-in (HRV, recovery/readiness, staging/qualité sommeil, charge TSS/CTL/ATL, anomalies), **versionnés et sélectionnables**, recalcul rétroactif. Données continues (HR/sommeil temps réel) comme matière première.

**Phase 4 — Life tracker / wellness** : vues steps/sommeil/HR/HRV/stress (jour/semaine/mois). Posture (allongé/assis/debout) **à valider** (dépend de Helio/Gadgetbridge).

**Phase 5 — Nutrition / calories** : food DB Open Food Facts, repas, macros, balance vs activité (s'inspirer de wger — AGPL).

**Phase 6 — Création de workouts + envoi device (cloudless)** : builder → encodage **FIT workout** → push sans cloud (USB `Garmin/Workouts`, ou BLE via Gadgetbridge si supporté). Dériquer l'**écriture FIT en Rust**.

**Phase 7 — Registre communautaire d'algorithmes** *(site participatif)* : service web séparé pour publier/parcourir/installer des plugins WASM par hardware (signature, versionnage, modération/confiance, compat métriques requises ↔ sources dispo).

**Phase 8 — Serveur MCP** : couche fine au-dessus de l'API (requêter/créer, lancer un algo) pour les LLMs.

**Explorations transverses** : **sync BLE depuis un PC** (`btleplug` ; tension protocoles Gadgetbridge Java vs Rust desktop) ; multi-UI/thème ; multi-utilisateur ; backup/export ; observabilité.

## Risques / points à valider
- **⚠️ Couverture Gadgetbridge = dépendance & risque #1** (tout le hardware passe par lui) : (a) FIT d'activité Garmin (avec **Stryd**) extractible **par BLE** ? (b) **Helio** supporté ? → **valider dès maintenant** avec le vrai matériel. Replis : USB (Garmin), Helio dégradé. Si GB ne supporte pas un appareil, on ne l'a pas (accepté, vu le périmètre).
- **Sandbox des plugins d'algos** : code tiers sur des **données santé** → WASM **isolé** (pas de réseau, limites ressources) obligatoire ; signature + confiance côté registre.
- **Embarquer Gadgetbridge** (2b) : pas une lib propre → vendoring = **dette de maintenance** (suivi upstream) ; d'où interop (2a) d'abord.
- **Sync BLE desktop** : faible réutilisation des protocoles Android (Java) → exploration tardive.
- **Volume temps réel** : HR continu = gros volume → dimensionner le time-series tôt.
- **Trou Rust** : **écriture FIT** des workouts (phase 6).
- **Posture allongé/assis/debout** : source non garantie → confirmer avant la phase 4.
- **Push workout cloudless** : BLE→Garmin non garanti → fallback **USB**.
- **2 paliers d'install** : simple = binaire Rust + SQLite + wizard ; `ofit-db` supporte SQLite **et** Postgres dès le jour 1.

## Vérification (fil rouge du MVP)
1. `docker compose -f docker/docker-compose.simple.yml up` démarre en un conteneur (SQLite) ; wizard OK.
2. Import FIT réel du 945 (puissance Stryd embarquée) → RawRecording + Streams parsés.
3. Import d'un enregistrement chevauchant d'une autre source → fusion en **1 Activity**.
4. Préférence par métrique (ex. HR=Helio, puissance=Stryd) → vue canonique correcte ; rétroactif → historique re-résolu.
5. Dashboard : charts uPlot + carte cohérents ; changement de thème appliqué partout.
6. Envoi d'un **batch de samples HR** à l'API d'ingestion (simulant le temps réel) → série continue stockée, visible en tendance.
7. Palier full (Postgres) : mêmes scénarios sans changement de code applicatif (sqlx).
