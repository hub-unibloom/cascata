#!/bin/bash
# ============================================================
#  Cascata Safe Update — NUNCA perca dados
# ============================================================
#  Uso: ./safe-update.sh
#
#  Este script faz:
#    1. Backup completo do PostgreSQL (pg_dumpall → .sql.gz)
#    2. Pull do código mais recente (git pull)
#    3. Rebuild dos containers SEM destruir volumes
#
#  ⚠️  NUNCA use "docker compose down -v" manualmente!
# ============================================================

set -e

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}============================================================${NC}"
echo -e "${CYAN}  🛡️  Cascata Safe Update Protocol${NC}"
echo -e "${CYAN}============================================================${NC}"
echo ""

# Carregar .env se existir
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

DB_USER="${DB_USER:-cascata_admin}"
DB_CONTAINER="cascata-db"
BACKUP_DIR="${CASCATA_DATA_DIR:-/cascata-data}/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/cascata_full_${TIMESTAMP}.sql.gz"

# ── 1. Verificar se o PostgreSQL está rodando ──────────────
echo -e "${YELLOW}[1/4]${NC} Verificando PostgreSQL..."
if ! docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" >/dev/null 2>&1; then
    echo -e "${RED}❌ PostgreSQL não está rodando. Abortando.${NC}"
    echo -e "${YELLOW}   Se é a primeira instalação, use: docker compose up -d --build${NC}"
    exit 1
fi
echo -e "${GREEN}  ✅ PostgreSQL online${NC}"

# ── 2. Backup completo ────────────────────────────────────
echo -e "${YELLOW}[2/4]${NC} Criando backup completo..."
mkdir -p "$BACKUP_DIR"

docker exec "$DB_CONTAINER" pg_dumpall -U "$DB_USER" | gzip > "$BACKUP_FILE"
BACKUP_SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo -e "${GREEN}  ✅ Backup salvo: ${BACKUP_FILE} (${BACKUP_SIZE})${NC}"

# Limpar backups antigos (manter últimos 10)
ls -t "$BACKUP_DIR"/cascata_full_*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm
echo -e "${GREEN}  ✅ Backups antigos limpos (mantendo últimos 10)${NC}"

# ── 3. Pull do código ─────────────────────────────────────
echo -e "${YELLOW}[3/4]${NC} Baixando código mais recente..."
git pull
echo -e "${GREEN}  ✅ Código atualizado${NC}"

# ── 4. Rebuild (SEM -v) ───────────────────────────────────
echo -e "${YELLOW}[4/4]${NC} Reconstruindo containers..."
echo -e "${RED}  ⚠️  Os containers serão parados brevemente${NC}"

docker compose down          # SEM -v!
docker compose up -d --build

echo ""
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}  🎉 Atualização concluída com sucesso!${NC}"
echo -e "${GREEN}  📦 Backup: ${BACKUP_FILE}${NC}"
echo -e "${GREEN}  🔒 Dados preservados${NC}"
echo -e "${GREEN}============================================================${NC}"
echo ""
echo -e "${YELLOW}Para restaurar um backup em caso de emergência:${NC}"
echo -e "  gunzip < ${BACKUP_FILE} | docker exec -i ${DB_CONTAINER} psql -U ${DB_USER}"
echo ""
