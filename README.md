# Automation LinkedIn/Instagram – Production Ready

Système complet d'automatisation de l'acquisition client sur LinkedIn et Instagram, orchestré par n8n, piloté par Claude (Anthropic) et Playwright.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Docker Network                           │
│                                                                 │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────────┐ │
│  │          │    │              │    │                       │ │
│  │   n8n    │◄──►│  PostgreSQL  │    │  Playwright Server    │ │
│  │          │    │              │    │  (LinkedIn/Instagram) │ │
│  │ Workflows│    │  - prospects │    │                       │ │
│  │ Crons    │    │  - actions   │    │  /linkedin/send-invite│ │
│  │ Webhooks │    │  - sequences │    │  /linkedin/send-msg   │ │
│  │          │    │  - quotas    │    │  /linkedin/read-dms   │ │
│  └────┬─────┘    └──────────────┘    │  /instagram/send-dm   │ │
│       │                              │  /instagram/read-dms  │ │
│       │          ┌──────────┐        └───────────┬───────────┘ │
│       └─────────►│  Redis   │                    │             │
│       │          │  (Queue) │            Playwright Browser    │
│       │          └──────────┘            (Sessions persistées) │
│       │                                                         │
│       ▼                                                         │
│  ┌──────────┐                                                   │
│  │  n8n     │                                                   │
│  │  Worker  │                                                   │
│  └──────────┘                                                   │
└─────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  Claude API                    Discord/Slack
  (Anthropic)                   (Alertes)
  - Messages outreach
  - Analyse DMs
  - Réponses auto
  - Création posts
  - Qualification
```

### Flux de données

```
Prospects CSV/Manuel
        │
        ▼
[DB: prospects table] ──► Score Claude (Prompt E) ──► profile_score
        │
        ▼
[WF1: Outreach] ──► Claude (Prompt A) ──► Message personnalisé
        │                                         │
        │                               Playwright → LinkedIn
        │                                         │
        ▼                                         ▼
[DB: actions]                          [DB: status = 'contacted']
        │
        ▼
[WF4: Séquences] ──► J+3 relance ──► J+7 finale
        │
        ▼
[WF2: DMs entrants] ──► Claude (Prompt B) ──► Score/Intention
        │                        │
        │                   score < 9 ──► Claude (Prompt C) ──► Auto-reply
        │                        │
        │                   score >= 9 ──► Discord alerte ──► Humain
        ▼
[WF3: Contenu] ──► Claude (Prompt D) ──► Post LinkedIn + Instagram
        │
        ▼
Discord validation ──► Approuvé ──► Publication
```

---

## Prérequis

- Docker 24+ et Docker Compose v2
- Node.js 18+ (pour scripts utilitaires locaux)
- Clé API Anthropic (Claude) – [console.anthropic.com](https://console.anthropic.com)
- Comptes LinkedIn et/ou Instagram (de test en premier)
- Un VPS ou machine locale avec 2GB RAM minimum (4GB recommandé)
- Optionnel : ngrok pour les webhooks entrants depuis LinkedIn/Instagram

---

## Installation rapide

### 1. Cloner et configurer

```bash
git clone https://github.com/skaba89/hello.git
cd hello

# Créer le fichier .env depuis l'exemple
cp .env.example .env
nano .env   # ou vim .env
```

### 2. Remplir les variables d'environnement obligatoires

```bash
# Générer les secrets
openssl rand -hex 16   # → N8N_ENCRYPTION_KEY
openssl rand -hex 24   # → PLAYWRIGHT_SERVER_API_KEY

# Dans .env, remplir obligatoirement :
POSTGRES_PASSWORD=...
N8N_ENCRYPTION_KEY=...
PLAYWRIGHT_SERVER_API_KEY=...
CLAUDE_API_KEY=sk-ant-...
LINKEDIN_EMAIL=...
LINKEDIN_PASSWORD=...
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=...

# Pour les webhooks entrants (ngrok en local)
N8N_WEBHOOK_URL=https://xxxx.ngrok.io/
```

### 3. Déployer

```bash
chmod +x scripts/deploy.sh scripts/backup.sh
./scripts/deploy.sh
```

Le script :
- Vérifie les prérequis
- Build l'image Playwright
- Démarre tous les services dans l'ordre
- Attend les healthchecks
- Affiche les URLs d'accès

### 4. Accéder à n8n

Ouvrez http://localhost:5678 avec les identifiants définis dans `.env`.

### 5. Configurer les credentials n8n

Dans n8n → **Settings → Credentials** → créer :

**a) Claude API Key**
- Type : `HTTP Header Auth`
- Nom : `Claude API Key`
- Header Name : `x-api-key`
- Header Value : `[votre clé Claude depuis .env]`

**b) PostgreSQL**
- Type : `Postgres`
- Nom : `PostgreSQL`
- Host : `postgres`
- Port : `5432`
- Database : `automation_db`
- User : `automation`
- Password : `[POSTGRES_PASSWORD depuis .env]`

### 6. Importer les workflows

Dans n8n → **Workflows → Import from file** :

Importer dans cet ordre :
1. `workflows/workflow-5-monitoring.json` (référencé comme error workflow)
2. `workflows/workflow-1-outreach.json`
3. `workflows/workflow-2-dms.json`
4. `workflows/workflow-3-content.json`
5. `workflows/workflow-4-sequences.json`

Dans chaque workflow importé, mettre à jour les credentials des nœuds PostgreSQL et Claude API Key.

### 7. Premier test en dry-run

```bash
# Activer le dry-run dans .env
echo "DRY_RUN=true" >> .env
docker compose restart n8n n8n-worker

# Ajouter un prospect de test
node scripts/add-prospect.js --json '{
  "first_name": "Test",
  "last_name": "User",
  "company": "TestCorp",
  "title": "CEO",
  "linkedin_url": "https://linkedin.com/in/test-user-123",
  "platform": "linkedin",
  "profile_score": 8,
  "public_fact": "A récemment publié sur la croissance des SaaS B2B"
}'
```

Déclenchez manuellement le Workflow 1 depuis l'interface n8n et vérifiez les logs.

### 8. Passer en production

```bash
# Désactiver le dry-run
sed -i 's/DRY_RUN=true/DRY_RUN=false/' .env
docker compose restart n8n n8n-worker

# Activer les workflows dans n8n (bouton "Active" sur chaque workflow)
```

---

## Structure des fichiers

```
.
├── docker-compose.yml          # Orchestration Docker
├── .env.example                # Template variables d'environnement
├── playwright-server/
│   ├── playwright-server.js    # Serveur Express + Playwright
│   ├── package.json
│   └── Dockerfile
├── workflows/
│   ├── workflow-1-outreach.json    # Invitations LinkedIn séquentielles
│   ├── workflow-2-dms.json         # Lecture et réponse automatique DMs
│   ├── workflow-3-content.json     # Création et publication de contenu
│   ├── workflow-4-sequences.json   # Relances J+3, J+7
│   └── workflow-5-monitoring.json  # Healthchecks et alertes
├── prompts/
│   └── prompts.md              # Prompts Claude A-E documentés
├── db/
│   └── init-db.sql             # Schéma complet PostgreSQL
├── scripts/
│   ├── deploy.sh               # Script de déploiement
│   ├── backup.sh               # Sauvegarde quotidienne
│   └── add-prospect.js         # Import prospects (CSV/JSON)
└── README.md
```

---

## Workflows n8n – Description détaillée

### Workflow 1 – Outreach séquentiel
**Déclencheur** : Cron toutes les 2h (heures ouvrées recommandées : 9h-18h)

**Flux** :
1. Récupère les prospects `status = 'new'` avec `profile_score >= 6` non encore contactés
2. Vérifie le quota journalier (60 invitations/jour LinkedIn)
3. Pour chaque prospect, génère un message personnalisé via Claude (Prompt A)
4. Attend un délai aléatoire 45-90 secondes (anti-bot)
5. Envoie l'invitation + message via Playwright
6. Log le résultat en DB, alerte Discord en cas d'erreur

**Configurer les heures ouvrées** : Dans le nœud Cron, ajoutez un nœud `IF` pour vérifier que `new Date().getHours()` est entre 9 et 17.

### Workflow 2 – Réponse automatique aux DMs
**Déclencheur** : Cron toutes les 30 minutes

**Flux** :
1. Lit les DMs LinkedIn et Instagram via Playwright
2. Filtre les conversations déjà traitées (DB lookup)
3. Claude analyse chaque message (Prompt B) → score 0-10
4. Score >= 9 : alerte Discord pour intervention humaine
5. Score < 9 : génère et envoie une réponse automatique (Prompt C)
6. Log la conversation et la réponse en DB

### Workflow 3 – Création de contenu
**Déclencheur** : Cron mardi et jeudi à 8h (personnalisable)

**Flux** :
1. Récupère le sujet planifié dans `content_calendar` pour aujourd'hui
2. Claude génère les versions LinkedIn et Instagram (Prompt D)
3. Enregistre en DB avec statut `pending_review`
4. Envoie dans Discord pour validation humaine
5. Après 2h, publie les posts approuvés

**Note** : La publication effective (post LinkedIn/Instagram) nécessite une intégration supplémentaire avec l'API officielle LinkedIn (limité) ou un endpoint Playwright dédié `/linkedin/post-content` à ajouter dans `playwright-server.js`.

### Workflow 4 – Séquences et relances
**Déclencheur** : Cron lundi-vendredi à 9h

**Flux** :
1. Récupère les étapes `scheduled_at <= NOW()` et `status = 'pending'`
2. Route selon le type : `follow_up_1` (J+3) ou `follow_up_2` (J+7)
3. Claude génère le message de relance approprié
4. Délai jitter 45-90s puis envoi via Playwright
5. Met à jour la séquence en DB et planifie l'étape suivante

**Démarrer une séquence pour un prospect** :
```sql
INSERT INTO sequence_steps (prospect_id, step_number, step_type, scheduled_at)
VALUES ([id], 1, 'message', NOW() + INTERVAL '1 day');
```

### Workflow 5 – Monitoring et alertes
**Déclencheur** : Cron toutes les heures

**Flux** :
1. Healthcheck du Playwright Server (`/health`)
2. Métriques DB (erreurs/heure, invitations du jour, retards)
3. Analyse des seuils (erreurs > 5/h, quota > 90%, steps en retard)
4. Alerte Discord si seuils dépassés
5. Mode veille automatique si quota journalier atteint
6. Log le rapport dans `monitoring_logs`

---

## Gestion des risques anti-ban

### LinkedIn – Limites recommandées

| Action | Limite sûre | Limite max absolue |
|--------|-------------|-------------------|
| Invitations/jour | 60 | 80 |
| Messages/jour | 100 | 150 |
| Délai entre actions | 45-90s | 30s minimum |
| Profils visités/jour | 80 | 100 |

**Variables à ajuster dans `.env`** :
```
LINKEDIN_DAILY_INVITE_LIMIT=60
LINKEDIN_MIN_DELAY_MS=45000
LINKEDIN_MAX_DELAY_MS=90000
```

### Instagram – Limites recommandées

| Action | Limite sûre |
|--------|-------------|
| DMs/jour | 30 |
| Délai entre DMs | 30-60s |
| Nouveaux follows/jour | 30 |

### Signes d'un compte en danger

- Trop d'erreurs 429 consécutives → mode veille automatique activé
- CAPTCHA sur le login → les sessions Playwright sont corrompues → `docker exec automation_playwright rm -rf /sessions/*` + redémarrage
- Restriction de compte LinkedIn → arrêt immédiat, attendre 24-48h
- "We noticed unusual activity" → désactiver l'automatisation 7 jours

### Rotation de comptes SDR (multi-comptes)

Pour gérer plusieurs comptes LinkedIn, modifiez `.env` avec des tableaux et adaptez `playwright-server.js` :

```env
LINKEDIN_ACCOUNTS=email1:pass1,email2:pass2,email3:pass3
```

Le round-robin peut être implémenté dans le serveur en créant un pool de contextes Playwright.

---

## Endpoints Playwright Server

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/health` | Healthcheck + compteurs |
| GET | `/status` | Quotas et limites détaillés |
| POST | `/linkedin/send-invite` | Envoyer une invitation + note |
| POST | `/linkedin/send-message` | Envoyer un message à un contact |
| GET | `/linkedin/read-dms` | Lire les DMs récents |
| POST | `/instagram/send-dm` | Envoyer un DM Instagram |
| GET | `/instagram/read-dms` | Lire les DMs Instagram |
| POST | `/session/reset` | Réinitialiser les sessions |

Tous les endpoints (sauf `/health`) requièrent le header : `x-api-key: [PLAYWRIGHT_SERVER_API_KEY]`

### Exemple d'appel depuis curl :
```bash
curl -X POST http://localhost:3001/linkedin/send-invite \
  -H "x-api-key: votre_clé" \
  -H "Content-Type: application/json" \
  -d '{"profileUrl": "https://linkedin.com/in/test", "message": "Bonjour !"}'
```

---

## Base de données – Schéma principal

### Requêtes utiles

```sql
-- Pipeline commercial (top leads)
SELECT * FROM v_hot_leads LIMIT 20;

-- Métriques du jour
SELECT * FROM v_daily_metrics WHERE date = CURRENT_DATE;

-- Prospects prêts pour l'outreach
SELECT * FROM prospects
WHERE status = 'new' AND profile_score >= 6
ORDER BY profile_score DESC;

-- Quota du jour
SELECT * FROM quotas WHERE quota_date = CURRENT_DATE;

-- Conversations nécessitant une intervention humaine
SELECT * FROM conversations
WHERE requires_human = TRUE AND status = 'active'
ORDER BY score DESC;

-- Performances des séquences
SELECT
  step_type,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE status = 'sent') as sent,
  COUNT(*) FILTER (WHERE status = 'failed') as failed
FROM sequence_steps
GROUP BY step_type;
```

---

## Configuration ngrok (webhooks en local)

Pour recevoir les webhooks entrants (optionnel) :

```bash
# Installer ngrok
npm install -g ngrok
# ou : brew install ngrok (Mac)

# Exposer n8n sur internet
ngrok http 5678

# Copier l'URL HTTPS générée dans .env
N8N_WEBHOOK_URL=https://xxxx.ngrok.io/
```

Redémarrez n8n après modification :
```bash
docker compose restart n8n
```

---

## Sauvegarde et récupération

### Sauvegarde manuelle
```bash
./scripts/backup.sh
# Les backups sont dans ./backups/YYYYMMDD_HHMMSS/
```

### Automatiser (cron)
```bash
# Ajouter à la crontab : 3h du matin chaque jour
crontab -e
0 3 * * * /chemin/vers/scripts/backup.sh >> /var/log/automation-backup.log 2>&1
```

### Restaurer PostgreSQL
```bash
# Arrêter n8n pour éviter les écritures
docker compose stop n8n n8n-worker

# Restaurer
docker exec -i automation_postgres \
  pg_restore -U automation -d automation_db \
  < backups/[DATE]/postgres_dump.pgc

# Redémarrer
docker compose start n8n n8n-worker
```

### Restaurer les sessions Playwright
```bash
docker run --rm \
  -v automation_playwright_sessions:/target \
  -v $(pwd)/backups/[DATE]:/backup:ro \
  alpine tar xzf /backup/playwright_sessions.tar.gz -C /target
```

---

## Commandes de maintenance

```bash
# Voir tous les logs en temps réel
docker compose logs -f

# Logs d'un service spécifique
docker logs -f automation_n8n
docker logs -f automation_playwright
docker logs -f automation_postgres

# Accéder à la DB
docker exec -it automation_postgres psql -U automation -d automation_db

# Réinitialiser les sessions Playwright (si bug de navigation)
docker exec automation_playwright rm -rf /sessions/*
docker compose restart playwright-server

# Mettre à jour n8n vers la dernière version
docker compose pull n8n n8n-worker
docker compose up -d n8n n8n-worker

# Voir l'utilisation des ressources
docker stats

# Vider les vieilles exécutions n8n (si la DB grossit)
# Dans n8n : Settings → Pruning → activer
```

---

## Variables d'environnement – Référence complète

| Variable | Obligatoire | Description | Exemple |
|----------|-------------|-------------|---------|
| `POSTGRES_PASSWORD` | Oui | Mot de passe PostgreSQL | `str0ng_pass` |
| `POSTGRES_USER` | Non | User PostgreSQL | `automation` |
| `POSTGRES_DB` | Non | Nom de la DB | `automation_db` |
| `REDIS_PASSWORD` | Oui | Mot de passe Redis | `redis_pass` |
| `N8N_ENCRYPTION_KEY` | Oui | Clé chiffrement n8n (32c+) | `openssl rand -hex 16` |
| `N8N_BASIC_AUTH_USER` | Oui | Login interface n8n | `admin` |
| `N8N_BASIC_AUTH_PASSWORD` | Oui | Password interface n8n | `admin_pass` |
| `N8N_WEBHOOK_URL` | Oui | URL publique pour webhooks | `https://xxx.ngrok.io/` |
| `CLAUDE_API_KEY` | Oui | Clé API Anthropic | `sk-ant-...` |
| `PLAYWRIGHT_SERVER_API_KEY` | Oui | Clé auth serveur Playwright | `openssl rand -hex 24` |
| `LINKEDIN_EMAIL` | Oui | Email compte LinkedIn | `user@email.com` |
| `LINKEDIN_PASSWORD` | Oui | Mot de passe LinkedIn | `pass` |
| `LINKEDIN_DAILY_INVITE_LIMIT` | Non | Max invitations/jour | `60` |
| `LINKEDIN_MIN_DELAY_MS` | Non | Délai minimum entre actions (ms) | `45000` |
| `LINKEDIN_MAX_DELAY_MS` | Non | Délai maximum entre actions (ms) | `90000` |
| `INSTAGRAM_EMAIL` | Non | Email compte Instagram | `user@email.com` |
| `INSTAGRAM_PASSWORD` | Non | Mot de passe Instagram | `pass` |
| `DISCORD_WEBHOOK_URL` | Non | Webhook Discord pour alertes | `https://discord.com/...` |
| `DRY_RUN` | Non | Mode simulation (true/false) | `false` |
| `PLAYWRIGHT_HEADLESS` | Non | Navigateur sans interface | `true` |
| `TIMEZONE` | Non | Timezone | `Europe/Paris` |

---

## Coûts estimés (sans licence)

| Service | Coût |
|---------|------|
| n8n Community | Gratuit (auto-hébergé) |
| PostgreSQL | Gratuit |
| Redis | Gratuit |
| Playwright | Gratuit |
| VPS (2 vCPU, 4GB RAM) | ~10-20€/mois |
| Claude API | ~5-30€/mois selon volume |
| **Total** | **~15-50€/mois** |

**Estimation API Claude** (pour 60 prospects/jour) :
- Prompt A (outreach) : ~500 tokens × 60 = 30k tokens/jour
- Prompt B (analyse) : ~400 tokens × 30 = 12k tokens/jour
- Prompt C (réponses) : ~500 tokens × 15 = 7.5k tokens/jour
- Total ≈ 50k tokens/jour ≈ **~1.5€/jour** avec Claude Sonnet 4.6

---

## Checklist Production Ready

- [ ] Tous les secrets sont dans `.env` (hors du dépôt git)
- [ ] `.env` ajouté au `.gitignore`
- [ ] `N8N_ENCRYPTION_KEY` est unique et sauvegardée
- [ ] Workflows n8n exportés en JSON et versionnés
- [ ] Playwright redémarre automatiquement (`restart: unless-stopped`)
- [ ] Logs centralisés (docker json-file driver)
- [ ] Healthcheck exposé pour chaque service
- [ ] Sauvegarde quotidienne configurée (cron backup.sh)
- [ ] Mode dry-run testé avant production
- [ ] Compte LinkedIn de test utilisé pour validation initiale
- [ ] Quotas configurés en dessous des limites officielles
- [ ] Discord/Slack configuré pour les alertes
- [ ] Mode monitoring activé (Workflow 5)
- [ ] Séquence testée de bout en bout
- [ ] Credentials n8n configurés (Claude + PostgreSQL)
- [ ] ICP défini dans les prompts Claude (Prompt E)

---

## Conformité et aspects légaux

> **Important** : Ce système doit être utilisé en conformité avec les CGU de LinkedIn et Instagram, le RGPD, et les lois locales sur la prospection commerciale.

**Bonnes pratiques** :
- Ne pas dépasser les limites documentées des plateformes
- Respecter les demandes de désinscription immédiatement
- Ne pas usurper une identité ou induire en erreur
- Conserver les logs pour traçabilité (déjà implémenté)
- Ajouter une option de désinscription dans les messages
- Ne pas utiliser sur des profils ayant mentionné "pas de démarchage"

Le champ `do_not_contact` dans la table `prospects` et le statut `unsubscribed` permettent de gérer les exclusions.

---

## Support et contribution

- Issues : ouvrez un ticket sur le dépôt GitHub
- La documentation des workflows n8n est dans le fichier JSON de chaque workflow
- Les prompts Claude sont documentés dans `prompts/prompts.md`
