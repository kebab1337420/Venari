# Venari

> **Compatible [Boite](https://github.com/beboite/boite)** : Venari est pensé pour le fonctionner aux côtés de Boite — coordination d'agents, threads par projet, previews et navigateur intégrés pour valider vos finds.

Application desktop Windows et Linux pour chasser sur la plateforme de bug bounty **Intigriti** : catalogue de programmes, favoris/groups/tags/notes locaux, veille sur le scope, scans de profondeur low/med/high, catalogue de **144 outils** de pen-test installables, et un serveur MCP local pour piloter le tout depuis une IA (Claude, opencode…).

**Venari automatise la reconnaissance et le test contrôlé, dans le scope des programmes : les agents IA (via MCP) peuvent lancer des outils, envoyer des requêtes HTTP et rédiger des rapports sans confirmation manuelle, mais les requêtes restent confinées aux cibles in-scope. Aucun rapport n'est soumis automatiquement à la plateforme — l'API chercheur d'Intigriti est en lecture seule (aucun endpoint public de soumission) : les rapports sont écrits localement dans `reports/`, prêts à transmettre.**

## Prérequis

| | Windows | Linux |
| --- | --- | --- |
| OS | Windows 10/11 64 bits | distribution x86-64 avec glibc ≥ 2.28 (Debian 12+, Ubuntu 22.04+, Fedora 39+) |
| Gestionnaire d'outils système | `winget` (livré avec Windows 11) | `apt` via `pkexec` (polkit), sinon `sudo` non interactif |
| Outils de build | — | `build-essential`, `pkg-config`, `libssl-dev`, `libgtk-3-0` |

Autres prérequis communs :

- Un token d'API Intigriti (onglet *Settings* → *API* sur le site Intigriti, rôle *External Researcher*).
- Accès réseau vers `api.intigriti.com` et `api.github.com` (téléchargement des outils portables).
- Pour l'agent distant Rust : une toolchain Rust (`cargo`) **sous Windows uniquement**, voir [Agent distant](#agent-distant-rust).

## Installation

### Installateur

| Plateforme | Artefact | Contenu |
| --- | --- | --- |
| Windows | `dist/Venari-Setup-<version>.exe` (NSIS) | dossier d'installation au choix, raccourcis bureau et menu démarrer, désinstallation propre |
| Linux | `dist/Venari-<version>.AppImage` | auto-portable : `chmod +x` puis lancer, aucun privilège requis |
| Linux | `dist/venari_<version>_amd64.deb` | installation native via `apt install ./venari_<version>_amd64.deb` |

`<version>` est la version déclarée dans `package.json`.

Au premier lancement, collez votre token Intigriti : il est testé auprès de l'API puis chiffré au repos (voir [Chiffrement](#chiffrement-au-repos)).

### Depuis les sources

```bash
npm install            # récupère le binaire Electron (voir note)
npm start              # lance l'app en dev (electron-vite preview)
```

Note sous Node ≥24 : les scripts `postinstall` sont bloqués par défaut. Récupérez le binaire Electron manuellement :

```bash
node node_modules/electron/install.js
```

## Commandes

| Commande | Rôle |
| --- | --- |
| `npm run dev` | dev avec rechargement (electron-vite) |
| `npm start` | preview du build courant |
| `npm run test` | tests unitaires (Vitest) |
| `npm run typecheck` | typecheck TypeScript (main + renderer) |
| `npm run lint` | analyse statique (oxlint, règles `correctness`, aucun avertissement accepté) |
| `npm run build` | build `out/` (main, preload, renderer) |
| `npm run pack:check` | lint + tests + typecheck + build, **sans** empaquetage — la porte à utiliser en CI et sur les deux plateformes |
| `npm run dist:win` | `pack:check` + installeur NSIS → `dist/Venari-Setup-<version>.exe` |
| `npm run dist:linux` | `pack:check` + AppImage et deb → `dist/` |
| `npm run dist:all` | les deux plateformes (à lancer sur chaque OS : un AppImage ne se cross-build pas de façon fiable) |
| `npm run dist` | alias de `dist:win` (compatibilité) |
| `npm run boite -- <args>` | CLI `boite` — boîte de coordination d'agents (voir ci-dessous) |
| `npm run mcp:pair` | appaire un poste au serveur MCP : découverte LAN + échange de code contre un jeton (voir [MCP](#mcp-ia)) |

### Tests

`npm run test` exécute tout le dossier `tests/` avec Vitest, en deux environnements :

- `tests/*.test.ts` → `node` (main, preload, services, outils) ;
- `tests/*.test.tsx` → **jsdom**, pour les composants React du renderer. Chaque fichier porte `// @vitest-environment jsdom` en première ligne et mock le pont preload via `vi.mock('../src/renderer/src/api')` : seul le mappage état → rendu est testé, l'IPC réel reste couvert par les tests de `src/main`.

Le typecheck suit la même ligne : `tsconfig.node.json` exclut les `*.tsx` (pas de JSX ni de DOM côté main), `tsconfig.web.json` les inclut. Comme Vitest tourne sans globales, l'auto-nettoyage de Testing Library ne s'active pas : chaque fichier TSX appelle `afterEach(cleanup)`.

### Boîte (CLI d'agents)

`boite` est une boîte à lettres locale pour coordonner des agents (IA ou humains), sans réseau ni politesse : uniquement des tâches et des ressources partagées. Les données vivent dans `~/.boite/boite.db` (surcharge avec `BOITE_DIR`), et les adresses ont la forme `thread-id` (machine locale) ou `machine/thread-id`.

| Commande | Rôle |
| --- | --- |
| `boite agents list [--all] [--json]` | état / complétion / pause / archive de chaque agent |
| `boite agents find <mots...>` | cherche dans les noms, ids, adresses et corps de messages |
| `boite agents read <adresse>` | transcription du fil (marque les entrées lues) |
| `boite agents send <adresse> <texte...> [--wait] [--ready] [--ref R] [--project P]` | dépose un message |
| `boite agents reply <id> <texte...>` | répond à un message précis |
| `boite agents log <adresse> [--limit N] [--follow]` | journal du fil, en direct |
| `boite agents wait <adresse> [--timeout S]` | attend la sortie d'un état de travail |
| `boite agents create <nom>` | crée un agent |
| `boite agents run / done / edit / pause / resume / archive / restore <adresse>` | transitions d'état |

Codes de sortie : `0` ok, `2` usage, `3` refus (courtoisie/archivé/ready), `4` délai, `5` agent inconnu. `--help` est accepté à n'importe quelle position, et `--json` rend chaque commande exploitable par un autre script.

### Intégration continue

`.github/workflows/ci.yml` s'exécute à chaque push sur `main`, à chaque pull request et à chaque tag `v*`, sur 7 jobs :

| Job | Ce qu'il prouve |
|---|---|
| `verify` (Windows + Linux) | `npm run pack:check` passe sur les deux plateformes |
| `package` (Windows + Linux) | l'installeur NSIS, l'AppImage et le deb se construisent vraiment |
| `release` (tag `v*`) | la release GitHub est créée et les artefacts (NSIS, blockmap, AppImage, deb, `latest*.yml`) y sont attachés |
| `agent` | l'agent Rust compile et passe son test de bout en bout (Windows) |
| `agent-windows-only` | le build de l'agent **échoue** hors Windows, avec le message explicite attendu |
| `smoke-linux` | l'AppImage se lance et son processus tient 30 s |
| `smoke-windows` | l'installeur NSIS s'installe en silence et l'application se lance |

Les artefacts NSIS, AppImage et deb sont publiés en artifact de chaque run.

Le port MCP n'est volontairement pas vérifié par les jobs de smoke test : le serveur ne démarre que si la configuration contient un jeton chiffré, qu'un test externe ne peut pas forger. Ce qui est vérifié, c'est que le binaire démarre et reste vivant.

## Fonctionnalités

### Programmes et sync
- Écran **Programmes** : liste paginée (recherche avec debounce, filtre favoris, tri nom/prime/récent, sens croissant/décroissant). La page affiche `x / y programmes` et le bouton **Charger la suite** déroule au-delà des 200 premiers — le catalogue n'est plus tronqué en silence.
- **Exporter** : sélecteur CSV / JSON / Markdown, avec les **filtres courants** (favori, groupe, tag, recherche), la pagination ignorée. Le fichier est écrit à l'emplacement choisi au système. CSV en UTF-8 avec BOM (Excel l'ouvre sans réglage), cellules échappées à la norme RFC 4180 et préfixées quand elles commenceraient par `=`, `+`, `-` ou `@` (injection de formule). Markdown produit un tableau prêt à coller dans un rapport (barres verticales et retours à la ligne échappés).
- **Synchroniser** importe le catalogue (paginated, limite ~400 requêtes / 5 min gérée par un token bucket, retry en backoff sur 429/5xx).
- Favoris, groupes, tags et notes : **stockés localement en SQLite**, indépendants de l'API (lecture seule). Base : `%APPDATA%\Venari\bountydesk.db` sous Windows, `~/.config/Venari/bountydesk.db` sous Linux (chemins XDG standard, résolus par `app.getPath('userData')`).

### Détail de mission et credentials
- Clic sur un programme → modal **Détails** : badges (statut/type/confidentialité/secteur), primes min/max, **règles d'engagement (ROE)** complètes (Intigriti Me, outils automatisés, user-agent, header autorisé, safe harbour, pièces jointes) et **scope in/out** (domaines, tiers, skills requis), lien vers la page programme.
- Bouton **Get credentials** : identifiants (login/mot de passe) chiffrés par programme, avec raccourci vers la page de login de la mission. Les secrets ne sont jamais envoyés au renderer en clair sauf demande explicite de révélation.

### Scans low / med / high
- Bouton **Scanner** dans le détail d'une mission : profils de profondeur — Bas (curl + nuclei low/medium), Moyen (+ tags tech/exposure, severities ≤ high), Élevé (+ ffuf, severities ≤ critical).
- **Garde-fous** : cibles limitées au scope **in-scope** et aux endpoints HTTP(S) ; la confirmation ROE (`roeConfirm`) est **requise** depuis l'interface (le scan ne démarre qu'après validation manuelle — seule l'outil MCP `start_scan` peut la rendre optionnelle) ; les ROE restent respectées (si `automatedTooling: 0`, le scan est refusé) ; rate limit par scan ; bouton **Arrêter** toujours disponible ; tout est loggé dans `scan_events` ; exécution séquentielle, arrêt propre du process courant. Aucune soumission automatique : les rapports sont rédigés localement (`submit_report`).
- Si **aucun** outil du plan n'a pu être lancé, le scan se termine en `error` avec la liste des binaires manquants — il ne se présente jamais comme réussi.
- **Un scan ne peut pas rester bloqué** : chaque étape a un plafond de 30 min (au-delà, l'outil est arrêté et le scan le dit), le flux est plafonné à 5 000 événements par scan (la troncature est annoncée, jamais silencieuse), et le bouton **Arrêter** tue l'outil *et* ses sous-processus — ffuf ou nuclei lancent des enfants, sans cela un scan orphelin continuerait après l'arrêt.
- **Tableau de bord Scans** (menu **Scans**) : tous les scans, tous programmes confondus, avec programme, profondeur, statut, début et durée. La liste se rafraîchit automatiquement tant qu'un scan tourne, et le journal live + le bouton **Arrêter** restent accessibles même après avoir fermé la fiche du programme.

### Rapports
- **Écran Rapports** : les rapports Markdown écrits par `submit_report` (dossier `reports/` du dossier de données) sont listés dans l'app, filtrables par fichier/programme, avec date, taille, **Ouvrir** et **Dossier**. Aucun chemin n'est fourni par le renderer : seul un couple (programme, fichier) validé est résolu côté processus principal.
- Rien n'est soumis automatiquement à la plateforme : l'API chercheur d'Intigriti reste en lecture seule.

### Outils

Le catalogue compte **144 entrées** réparties en six catégories (`recon` 65, `enumer` 9, `fuzz` 14, `network` 16, `utility` 38, `ai` 2) :

| Source | Nb | Installation |
| --- | --- | --- |
| `winget` | 23 | `winget install` (Windows) ; sous Linux, détection d'abord, puis `apt` via `pkexec` quand un paquet Debian est connu |
| `github` | 43 | asset de release téléchargé, extrait, rendu exécutable, copié dans le dossier outils |
| `git` | 69 | `git clone` sécurisé (frameworks, wordlists, outils Python/Go) — un bouton **Guide** ouvre la doc, rien n'est compilé ni exécuté automatiquement |
| `go` | 5 | `go install <module>@latest` avec `GOBIN` dirigé vers le dossier de l'outil |
| `pip` | 4 | `uv venv` + `uv pip install` dans un venv isolé par outil (uv est lui-même au catalogue) |

Détails qui comptent :

- **Vérification d'intégrité** : chaque archive GitHub est hachée en SHA-256 puis comparée au fichier de sommes de la release (`checksums.txt`, `SHA256SUMS`…) quand le projet en publie un. Écart ou ligne manquante = installation refusée. Quand le projet ne publie rien, l'app l'affiche clairement plutôt que de laisser croire à une vérification.
- **Téléchargement borné** : les assets sont écrits sur disque en streaming avec un plafond de 512 Mo — jamais de `arrayBuffer()` en mémoire, et l'en-tête `content-length` n'est pas cru sur parole.
- **Aucun binaire exécuté pour détecter** : l'onglet Outils résout l'emplacement dans le PATH via `where`/`which` au lieu de lancer `--version`. Ouvrir l'onglet ne déclenche donc aucune exécution d'un binaire trouvé dans le PATH (qui peut venir d'un dossier utilisateur).
- **Timeouts** : toute commande d'installation/extraction a un budget de 5 min, la détection 10 s. Un `git clone` bloqué ne fige plus l'app.
- **Purge au démarrage** : archives `.download.*` et dossiers `.tmp` laissés par une installation interrompue sont supprimés au lancement.

- **Détection d'abord** : avant toute installation, Venari cherche le binaire dans le `PATH` (via le champ `detectCmd`). Installer un outil déjà présent est sans effet, et les noms diffèrent entre plateformes (`ripgrep`→`rg`, `bat`→`batcat`, `fd`→`fdfind`, `wireshark`→`tshark`, `powershell`→`pwsh`…).
- **Portables multi-plateformes** : pour chaque binaire GitHub, l'asset de release est choisi en fonction de la plateforme hôte (nom du binaire sans extension sous Linux, suffixe `.exe` sous Windows, `chmod +x` à l'installation). Un asset ambigu ou absent produit une erreur explicite, jamais un faux « installé ».
- **Outils signalés non disponibles** : 2 entrées sont marquées Windows-only (chisel, Fiddler Classic) et 4 sont des applications graphiques (Burp Suite, Postman, Insomnia, Bruno) ; l'app refuse de tenter une installation qui n'a pas de sens sur la plateforme, avec une explication.
- **Token GitHub optionnel** (écran Outils) : les downloads passent par l'API GitHub, qui est limitée à 60 requêtes/heure sans authentification. Le token est chiffré au repos.

### MCP (IA)
- Écran **Réglages → IA** : activer un serveur MCP HTTP (port défaut `8787`), exposable **sur le réseau local (LAN)** pour piloter Venari depuis plusieurs PC, avec **un jeton nommé par PC/IA** (jetons chiffrés, révocation en 1 clic, jamais listés dans le README ni les logs).
- **Aucun secret ne traverse le pont vers l'interface** : les jetons MCP et d'agent sont affichés masqués (`••••••••1234`), le bouton « Copier » fait écrire dans le presse-papier par le processus principal, et les extraits de configuration affichent `<JETON>`. Même règle pour les mots de passe enregistrés : la liste ne contient qu'un booléen « a un secret », le déchiffrement n'arrive que pour la ligne dont l'utilisateur demande la révélation.
- Adresse du serveur (locale et LAN) copiable en 1 clic, et un tableau **Activité des IA** journalise chaque appel d'outil (poste, outil, statut, durée).
- **Outils MCP** (18) : `list_programs` (paginé : `limit` / `offset`, total annoncé dans `details`), `get_program_detail`, `list_credentials` (sans secret), `set_note` / `list_notes` (notes horodatées, lecture seule pour la seconde), `list_tools`, `install_tool`, `open_browser`, `fetch_page`, `list_scans`, `start_scan` (mêmes garde-fous que l'UI, `roeConfirm` optionnel), `get_scan`, `scan_events`, `dedupe_findings`, `cvss_score`, `run_tool` (exécution *encadrée* d'un binaire du catalogue, whitelist stricte par défaut), `http_request` (requête HTTP personnalisée confinée aux hôtes *in-scope* du programme, sans confirmation), `submit_report` (rapport Markdown écrit dans `reports/`, **aucune soumission externe**).
- Exemple de config `claude_desktop_config.json` / `opencode.json` fourni dans l'app.
- **Appairage sans config manuelle** : l'app affiche un **code à usage unique (6 caractères, 5 minutes)** ; sur le poste à connecter, `npm run mcp:pair` découvre le serveur sur le réseau local (sonde UDP, repli loopback), échange le code contre un **jeton dédié** et imprime la config MCP prête à coller. Le serveur répond aussi à `GET /.well-known/venari.json` (pairId, port, hôtes — **aucun jeton**) et à `POST /pair`.
- Pare-feu : l'app vérifie l'état de la règle d'ouverture du port et sait la créer — `netsh` sous Windows, `ufw` / `firewall-cmd` via `pkexec` sous Linux. Sur les autres plateformes, l'état est honnêtement rapporté « non géré ». La règle est **limitée au réseau privé** (profils `private` sous Windows, sources RFC1918 sous Linux) et **retirée à la désactivation du serveur**.
- **Le mode LAN n'est accordé que sur un réseau privé** (10/8, 172.16/12, 192.168/16). La vérification est faite dans `startMcpServer` lui-même : aucun appelant ne peut obtenir `0.0.0.0` depuis un café ou un partage public, même en le demandant explicitement.

### Agent IA (pont Claude Code → Venari)
- Dossier `agent/` : un **pack prêt à copier** dans un dossier de mission pour donner à Claude Code un workflow encadré (sélection de programmes, vérification ROE avec verdicts *refuse/restreint/légitime*, choix low/med/high, scan puis tri des résultats, brouillon de rapport dans `reports/` — **soumission manuelle uniquement**, l'API Intigriti étant en lecture seule).
- Contenu : `CLAUDE.md` (garde-fous non négociables), deux skills (`.claude/skills/bountydesk-hunt`, `bountydesk-roe-check`), un agent `hunt-validated` (demande validation humaine avant exécution), et un gabarit `.mcp.json`.
- Mise en place : activer l'IA dans Réglages, copier l'URL + le jeton (1 clic), les placer dans `cibles/<mission>/.mcp.json`. Détails dans `agent/README.md`.

### Agent distant Rust

`remote-agent/` contient un agent Rust qui streame l'écran d'un second poste vers la vue isolée de Venari.

> **Cet agent est Windows uniquement.** La capture (BitBlt/GetDIBits) et l'injection d'entrées (SendInput) utilisent l'API Win32 déclarée en FFI brut dans `remote-agent/src/main.rs`, sans couche de portage. Un `cargo build` hors de Windows s'arrête volontairement sur un `compile_error!` explicite. Le reste de Venari, lui, tourne sur Windows et Linux.

C'est un binaire **compilé séparément** :

```bash
cd remote-agent
cargo build --release          # produit target/release/bountydesk-agent.exe
```

L'agent lit son `config.json` **à côté de son propre exécutable** (pas dans le répertoire courant) :

```json
{ "server": "192.168.1.20", "port": 8787, "token": "<jeton de l'agent>", "fps": 5 }
```

Le test `tests/agent-rust.test.ts` est automatiquement ignoré si le binaire n'a pas été compilé, afin que `npm test` reste vert sur une machine qui ne l'a pas construit.

## Chiffrement au repos

Les secrets (token Intigriti, credentials de mission, jetons MCP, token GitHub) sont chiffrés avec le trousseau du système quand il est disponible :

| Plateforme | Mécanisme |
| --- | --- |
| Windows | DPAPI via `safeStorage` |
| Linux avec keyring (GNOME Keyring, KWallet, libsecret) | `safeStorage` |
| Linux **sans** keyring (poste headless, session sans agent) | repli interne : AES-256-GCM, clé scrypt dérivée et stockée dans un fichier `0600` du dossier utilisateur |

Le mécanisme réellement utilisé est visible dans l'app. Le repli AES-GCM protège le fichier au repos mais ne bénéficie pas du verrou de session du système : sur un poste Linux sans keyring, préférez-en un.

## Sécurité

- Secrets chiffrés au repos (voir ci-dessus), jamais en clair ni en logs.
- Renderer isolé : `contextIsolation`, pas de `nodeIntegration`, `sandbox`, CSP stricte au build.
- Toute entrée IPC est validée (zod) ; les schémas API sont dérivés de la spec OpenAPI officielle fournie dans `openapi/researcher.swagger.json`.
- L'API Intigriti est utilisée en **lecture seule** ; les favoris/groups/tags/notes/credentials sont strictement locaux.
- Serveur MCP : JSON-RPC sur `POST`, authentification par jeton Bearer, **aucun header CORS** (un navigateur cross-origin ne peut pas consommer le serveur), liste blanche d'outils par défaut (coquilles, interpréteurs et téléchargeurs refusés, y compris via le catalogue).
- **Transport LAN en clair (HTTP/WS sans TLS)** : le jeton circule donc en clair sur le réseau local. Il n'est **jamais** placé dans l'URL (en-tête `Authorization: Bearer` uniquement, y compris pour l'agent) afin d'éviter sa fuite par journaux, proxys et historique, mais un observateur passif du LAN peut l'intercepter. À n'exposer que sur un réseau privé de confiance ; les jetons sont révocables en 1 clic en cas de doute.
- **Filtre SSRF** : `fetch_page` et `http_request` refusent les cibles locales et privées (loopback, RFC1918, link-local, `*.internal`) après résolution DNS, à chaque saut de redirection ; `http_request` respecte les ROE du programme (outils automatisés interdits) en plus du scope.
- `run_tool` refuse les coquilles, interpréteurs et binaires-téléchargeurs, même présents au catalogue : aucune évasion shell ni exécution de code arbitraire via une ligne de commande.

## Structure

```
src/
  main/            # processus principal : fenêtres, IPC, DB, API, scans, outils, MCP
    db/            # migrations + openDatabase + repository (node:sqlite)
    services/
      intigriti/   # client API
      scan/        # plan + runner
      tools/       # catalog.ts, installer.ts, platform.ts (résolution binaire/asset)
      mcp/         # serveur HTTP, agents, outils exposés
    ipc-*.ts       # validateurs + handlers (programs, detail, scan, tools, mcp)
  preload/         # contextBridge → window.bountydesk
  renderer/        # React (UI seule, sans réseau ni SQL)
  shared/ipc.ts    # contrat de types et canaux partagés
remote-agent/      # agent Rust d'ecran distant (Windows uniquement, compile a part)
agent/             # pack Claude Code + skills
boite/             # CLI de coordination d'agents (boite agents ...)
tests/             # Vitest (API, schema, throttler, paginate, db, scan, catalogue, plateforme, installer, MCP)
openapi/           # spec OpenAPI Intigriti vendored
```

## Licence

Usage personnel/assistant seulement. N'utilisez pas un tool sur des cibles hors scope, et respectez toujours les règles d'engagement de chaque programme.
