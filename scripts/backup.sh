#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# backup.sh – Sauvegarde quotidienne des volumes et configurations
# Usage : ./scripts/backup.sh [destination_dir]
# Cron suggéré : 0 3 * * * /path/to/scripts/backup.sh >> /var/log/automation-backup.log 2>&1
# ══════════════════════════════════════════════════════════════════

set -euo pipefail

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_BASE="${1:-$PROJECT_DIR/backups}"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="$BACKUP_BASE/$DATE"
RETENTION_DAYS=7

# Charger les variables d'environnement
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    source "$PROJECT_DIR/.env"
    set +a
fi

# Couleurs pour les logs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"; }
warn() { echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] WARN:${NC} $1"; }
error() { echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ERROR:${NC} $1"; }

# ─────────────────────────────────────────────
# Vérifications préalables
# ─────────────────────────────────────────────
if ! command -v docker &> /dev/null; then
    error "Docker n'est pas installé ou accessible"
    exit 1
fi

if ! docker ps &> /dev/null; then
    error "Docker daemon non accessible. Vérifiez les permissions."
    exit 1
fi

# ─────────────────────────────────────────────
# Création du répertoire de sauvegarde
# ─────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
log "Démarrage de la sauvegarde → $BACKUP_DIR"

# ─────────────────────────────────────────────
# 1. Dump PostgreSQL
# ─────────────────────────────────────────────
log "Sauvegarde PostgreSQL..."

POSTGRES_CONTAINER=$(docker ps --filter "name=automation_postgres" --format "{{.Names}}" | head -1)

if [ -n "$POSTGRES_CONTAINER" ]; then
    docker exec "$POSTGRES_CONTAINER" \
        pg_dump \
        -U "${POSTGRES_USER:-automation}" \
        -d "${POSTGRES_DB:-automation_db}" \
        --format=custom \
        --compress=9 \
        --no-password \
    > "$BACKUP_DIR/postgres_dump.pgc" \
    && log "✓ PostgreSQL dump OK ($(du -sh "$BACKUP_DIR/postgres_dump.pgc" | cut -f1))" \
    || warn "PostgreSQL dump a échoué"
else
    warn "Conteneur PostgreSQL non trouvé, dump ignoré"
fi

# ─────────────────────────────────────────────
# 2. Sauvegarde du volume n8n (workflows, credentials chiffrés)
# ─────────────────────────────────────────────
log "Sauvegarde volume n8n..."

N8N_VOLUME=$(docker volume ls --filter "name=.*n8n_data" --format "{{.Name}}" | head -1)

if [ -n "$N8N_VOLUME" ]; then
    docker run --rm \
        -v "$N8N_VOLUME":/source:ro \
        -v "$BACKUP_DIR":/backup \
        alpine \
        tar czf /backup/n8n_data.tar.gz -C /source . \
    && log "✓ Volume n8n sauvegardé" \
    || warn "Sauvegarde volume n8n échouée"
else
    warn "Volume n8n non trouvé"
fi

# ─────────────────────────────────────────────
# 3. Sauvegarde des sessions Playwright
# ─────────────────────────────────────────────
log "Sauvegarde sessions Playwright..."

PLAYWRIGHT_VOLUME=$(docker volume ls --filter "name=.*playwright_sessions" --format "{{.Name}}" | head -1)

if [ -n "$PLAYWRIGHT_VOLUME" ]; then
    docker run --rm \
        -v "$PLAYWRIGHT_VOLUME":/source:ro \
        -v "$BACKUP_DIR":/backup \
        alpine \
        tar czf /backup/playwright_sessions.tar.gz -C /source . \
    && log "✓ Sessions Playwright sauvegardées" \
    || warn "Sauvegarde sessions Playwright échouée"
fi

# ─────────────────────────────────────────────
# 4. Sauvegarde des fichiers de configuration
# ─────────────────────────────────────────────
log "Sauvegarde des fichiers de configuration..."

CONFIG_BACKUP="$BACKUP_DIR/config"
mkdir -p "$CONFIG_BACKUP"

# Copier les fichiers importants (sans le .env contenant les secrets)
cp "$PROJECT_DIR/docker-compose.yml" "$CONFIG_BACKUP/" 2>/dev/null || true
cp "$PROJECT_DIR/.env.example" "$CONFIG_BACKUP/" 2>/dev/null || true
cp -r "$PROJECT_DIR/workflows/" "$CONFIG_BACKUP/workflows/" 2>/dev/null || true
cp -r "$PROJECT_DIR/db/" "$CONFIG_BACKUP/db/" 2>/dev/null || true
cp -r "$PROJECT_DIR/prompts/" "$CONFIG_BACKUP/prompts/" 2>/dev/null || true

# Exporter les workflows n8n via l'API n8n
N8N_URL="http://localhost:${N8N_PORT:-5678}"
N8N_USER="${N8N_BASIC_AUTH_USER:-admin}"
N8N_PASS="${N8N_BASIC_AUTH_PASSWORD:-}"

if [ -n "$N8N_PASS" ]; then
    log "Export workflows n8n via API..."
    curl -s -f \
        -u "$N8N_USER:$N8N_PASS" \
        "$N8N_URL/api/v1/workflows" \
        -o "$CONFIG_BACKUP/n8n_workflows_export.json" \
    && log "✓ Workflows n8n exportés" \
    || warn "Export workflows n8n échoué (n8n accessible ?)"
fi

tar czf "$BACKUP_DIR/config.tar.gz" -C "$CONFIG_BACKUP" . && rm -rf "$CONFIG_BACKUP"
log "✓ Configuration sauvegardée"

# ─────────────────────────────────────────────
# 5. Sauvegarde des logs
# ─────────────────────────────────────────────
log "Sauvegarde des logs..."

LOGS_VOLUME=$(docker volume ls --filter "name=.*logs_data" --format "{{.Name}}" | head -1)

if [ -n "$LOGS_VOLUME" ]; then
    docker run --rm \
        -v "$LOGS_VOLUME":/source:ro \
        -v "$BACKUP_DIR":/backup \
        alpine \
        tar czf /backup/logs.tar.gz -C /source . \
    && log "✓ Logs sauvegardés" \
    || warn "Sauvegarde logs échouée"
fi

# ─────────────────────────────────────────────
# 6. Manifeste de sauvegarde
# ─────────────────────────────────────────────
cat > "$BACKUP_DIR/manifest.json" <<EOF
{
  "backup_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "backup_dir": "$BACKUP_DIR",
  "hostname": "$(hostname)",
  "files": $(ls "$BACKUP_DIR" | jq -R . | jq -s .),
  "size_total": "$(du -sh "$BACKUP_DIR" | cut -f1)"
}
EOF

TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
log "✓ Manifeste créé | Taille totale : $TOTAL_SIZE"

# ─────────────────────────────────────────────
# 7. Nettoyage des anciennes sauvegardes
# ─────────────────────────────────────────────
log "Nettoyage sauvegardes > ${RETENTION_DAYS} jours..."
find "$BACKUP_BASE" -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} + 2>/dev/null || true
REMAINING=$(ls -d "$BACKUP_BASE"/*/  2>/dev/null | wc -l)
log "✓ Nettoyage terminé | $REMAINING sauvegarde(s) conservée(s)"

# ─────────────────────────────────────────────
# 8. Notification Discord (optionnel)
# ─────────────────────────────────────────────
if [ -n "${DISCORD_WEBHOOK_URL:-}" ]; then
    curl -s -f -X POST "$DISCORD_WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "{\"content\": \"✅ Backup automation terminé\\n📦 Taille: $TOTAL_SIZE\\n📅 Date: $(date '+%d/%m/%Y %H:%M')\\n💾 Rétention: $REMAINING backup(s)\"}" \
    > /dev/null 2>&1 || true
fi

log "══════════════════════════════════════"
log "Backup TERMINÉ avec succès → $BACKUP_DIR"
log "══════════════════════════════════════"
