#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# deploy.sh – Déploiement complet du système d'automation
# Usage : ./scripts/deploy.sh [--pull] [--clean]
#   --pull  : forcer le pull des images Docker
#   --clean : supprimer les volumes et repartir de zéro (DANGER)
# ══════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Couleurs
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()   { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $1"; }
info()  { echo -e "${BLUE}[$(date '+%H:%M:%S')] ℹ${NC} $1"; }
warn()  { echo -e "${YELLOW}[$(date '+%H:%M:%S')] ⚠${NC} $1"; }
error() { echo -e "${RED}[$(date '+%H:%M:%S')] ✗${NC} $1"; exit 1; }

PULL_IMAGES=false
CLEAN_VOLUMES=false

for arg in "$@"; do
    case $arg in
        --pull)  PULL_IMAGES=true ;;
        --clean) CLEAN_VOLUMES=true ;;
    esac
done

# ─────────────────────────────────────────────
# Bannière
# ─────────────────────────────────────────────
echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════╗"
echo "║   LinkedIn/Instagram Automation – Deployment     ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${NC}"

# ─────────────────────────────────────────────
# 1. Vérifications préalables
# ─────────────────────────────────────────────
log "Vérification des prérequis..."

command -v docker &>/dev/null || error "Docker n'est pas installé"
command -v docker &>/dev/null && docker compose version &>/dev/null || \
    command -v docker-compose &>/dev/null || \
    error "docker compose / docker-compose non disponible"

DOCKER_COMPOSE_CMD="docker compose"
if ! docker compose version &>/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker-compose"
fi

# Vérifier .env
if [ ! -f "$PROJECT_DIR/.env" ]; then
    error ".env manquant ! Copiez .env.example vers .env et remplissez les valeurs.\n  cp .env.example .env"
fi

# Vérifier les secrets critiques
source "$PROJECT_DIR/.env"

[ -z "${POSTGRES_PASSWORD:-}" ] && error "POSTGRES_PASSWORD manquant dans .env"
[ -z "${N8N_ENCRYPTION_KEY:-}" ] && error "N8N_ENCRYPTION_KEY manquante dans .env"
[ -z "${PLAYWRIGHT_SERVER_API_KEY:-}" ] && error "PLAYWRIGHT_SERVER_API_KEY manquante dans .env"
[ -z "${CLAUDE_API_KEY:-}" ] && error "CLAUDE_API_KEY manquante dans .env"

# Vérifier longueur clé de chiffrement
if [ ${#N8N_ENCRYPTION_KEY} -lt 16 ]; then
    error "N8N_ENCRYPTION_KEY trop courte (minimum 16 chars). Générez avec : openssl rand -hex 16"
fi

log "✓ Prérequis OK"

# ─────────────────────────────────────────────
# 2. Mode clean (optionnel – dangereux)
# ─────────────────────────────────────────────
if [ "$CLEAN_VOLUMES" = true ]; then
    warn "MODE CLEAN – Suppression de tous les volumes (données perdues !)"
    read -p "Confirmez avec 'YES' : " confirm
    [ "$confirm" = "YES" ] || error "Annulé"
    cd "$PROJECT_DIR"
    $DOCKER_COMPOSE_CMD down -v --remove-orphans
    log "Volumes supprimés"
fi

# ─────────────────────────────────────────────
# 3. Pull des images (optionnel)
# ─────────────────────────────────────────────
if [ "$PULL_IMAGES" = true ]; then
    log "Pull des images Docker..."
    cd "$PROJECT_DIR"
    $DOCKER_COMPOSE_CMD pull
    log "✓ Images à jour"
fi

# ─────────────────────────────────────────────
# 4. Build du serveur Playwright
# ─────────────────────────────────────────────
log "Build du serveur Playwright..."
cd "$PROJECT_DIR"
$DOCKER_COMPOSE_CMD build --no-cache playwright-server
log "✓ Build Playwright OK"

# ─────────────────────────────────────────────
# 5. Démarrage des services
# ─────────────────────────────────────────────
log "Démarrage des services (ordre : postgres → redis → n8n → playwright)..."

# Démarrer postgres et redis en premier
$DOCKER_COMPOSE_CMD up -d postgres redis

log "Attente que PostgreSQL soit prêt..."
RETRIES=30
until docker exec automation_postgres pg_isready -U "${POSTGRES_USER:-automation}" &>/dev/null; do
    RETRIES=$((RETRIES - 1))
    [ $RETRIES -eq 0 ] && error "PostgreSQL ne démarre pas après 30 tentatives"
    printf "."
    sleep 2
done
echo ""
log "✓ PostgreSQL prêt"

log "Attente que Redis soit prêt..."
RETRIES=20
until docker exec automation_redis redis-cli -a "${REDIS_PASSWORD}" ping &>/dev/null; do
    RETRIES=$((RETRIES - 1))
    [ $RETRIES -eq 0 ] && error "Redis ne démarre pas"
    printf "."
    sleep 2
done
echo ""
log "✓ Redis prêt"

# Démarrer n8n et playwright
$DOCKER_COMPOSE_CMD up -d n8n n8n-worker playwright-server
log "Services n8n et Playwright démarrés"

# ─────────────────────────────────────────────
# 6. Healthchecks
# ─────────────────────────────────────────────
log "Vérification des healthchecks..."

N8N_URL="http://localhost:${N8N_PORT:-5678}"
PLAYWRIGHT_URL="http://localhost:3001"

# Attendre n8n
info "Attente n8n (peut prendre 30-60 secondes)..."
RETRIES=60
until curl -s -f "$N8N_URL/healthz" &>/dev/null; do
    RETRIES=$((RETRIES - 1))
    [ $RETRIES -eq 0 ] && warn "n8n ne répond pas encore – vérifiez les logs : docker logs automation_n8n"
    printf "."
    sleep 3
done
echo ""
log "✓ n8n répond sur $N8N_URL"

# Attendre Playwright
info "Attente Playwright Server..."
RETRIES=30
until curl -s -f "$PLAYWRIGHT_URL/health" &>/dev/null; do
    RETRIES=$((RETRIES - 1))
    [ $RETRIES -eq 0 ] && warn "Playwright Server ne répond pas – vérifiez : docker logs automation_playwright"
    printf "."
    sleep 3
done
echo ""
log "✓ Playwright Server répond sur $PLAYWRIGHT_URL"

# ─────────────────────────────────────────────
# 7. Affichage du statut final
# ─────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗"
echo "║              DÉPLOIEMENT RÉUSSI ✓                ║"
echo -e "╚══════════════════════════════════════════════════╝${NC}"
echo ""

echo -e "${BLUE}Services actifs :${NC}"
$DOCKER_COMPOSE_CMD ps

echo ""
echo -e "${BLUE}Accès :${NC}"
echo "  n8n Interface : http://localhost:${N8N_PORT:-5678}"
echo "  Playwright Health : http://localhost:3001/health"
echo "  Playwright Status : http://localhost:3001/status"
echo ""
echo -e "${BLUE}Prochaines étapes :${NC}"
echo "  1. Ouvrez n8n : http://localhost:${N8N_PORT:-5678}"
echo "  2. Identifiants : ${N8N_BASIC_AUTH_USER:-admin} / [voir .env]"
echo "  3. Importez les workflows depuis ./workflows/"
echo "  4. Configurez les credentials n8n (Claude API, PostgreSQL)"
echo "  5. Activez le dry-run d'abord : DRY_RUN=true dans .env"
echo ""
echo -e "${YELLOW}Commandes utiles :${NC}"
echo "  Logs n8n       : docker logs -f automation_n8n"
echo "  Logs Playwright: docker logs -f automation_playwright"
echo "  Arrêter        : docker compose down"
echo "  Backup         : ./scripts/backup.sh"
echo ""

# Lancer le backup initial si premier déploiement
if [ "$CLEAN_VOLUMES" = true ] || ! ls "$PROJECT_DIR/backups/" &>/dev/null; then
    info "Premier déploiement détecté – pas de backup initial"
fi

log "Déploiement terminé avec succès !"
