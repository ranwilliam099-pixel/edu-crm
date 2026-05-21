#!/bin/bash
# ============================================================
# backfill-v56.sh — V56 monthly_kpi_targets 全租户 CREATE TABLE
#
# 来源：用户 2026-05-22 SSOT §6.8 拍板 KPI 4 字段 — 校长下发月度目标
#
# 模式：bash 循环 tenant_ids + sed __TENANT_SCHEMA__ + sudo -u postgres psql
#       （参考 V33/V34/V35/V36/V37/V39/V40/V41/V55 实战模式）
#
# 幂等：CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS（重跑无害）
#
# 用法（生产服务器）：
#   bash scripts/backfill-v56.sh             # dry-run 默认
#   bash scripts/backfill-v56.sh --apply     # 真跑
#
# 前置：
#   - PG 主机执行（sudo -u postgres psql 本机连接）
#   - PG_DB env 默认 'edu'
#   - migrations/V56__monthly_kpi_targets.sql 存在
# ============================================================

set -euo pipefail

PG_DB="${PG_DB:-edu}"
PG_USER_OS="${PG_USER_OS:-postgres}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_FILE="${REPO_ROOT}/migrations/V56__monthly_kpi_targets.sql"

APPLY=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    *) echo "[warn] unknown arg: $arg" ;;
  esac
done

C_GREEN='\033[32m'; C_RED='\033[31m'; C_YELLOW='\033[33m'; C_CYAN='\033[36m'; C_RESET='\033[0m'
ok()    { printf "${C_GREEN}OK${C_RESET}    %s\n" "$1"; }
fail()  { printf "${C_RED}FAIL${C_RESET}  %s\n" "$1"; }
info()  { printf "${C_CYAN}INFO${C_RESET}  %s\n" "$1"; }
warn()  { printf "${C_YELLOW}WARN${C_RESET}  %s\n" "$1"; }

[ ! -f "$MIGRATION_FILE" ] && { fail "Migration not found: $MIGRATION_FILE"; exit 1; }

info "查询全部 tenant schemas..."
TENANTS=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -At -c \
  "SELECT id FROM public.tenants ORDER BY created_at ASC")
TENANT_COUNT=$(echo "$TENANTS" | wc -l | tr -d ' ')
info "共 ${TENANT_COUNT} 个 tenants"

SUCCESS=0
FAILED=0
FAILED_LIST=()

for tenant_id in $TENANTS; do
  [ -z "$tenant_id" ] && continue
  schema="tenant_$(echo "$tenant_id" | tr 'A-Z' 'a-z')"

  if [ "$APPLY" = false ]; then
    printf "${C_YELLOW}DRY${C_RESET}   ${schema}: 将 CREATE TABLE monthly_kpi_targets\n"
    continue
  fi

  # 真跑：sed 替换 __TENANT_SCHEMA__ + psql apply
  TMP_SQL=$(mktemp /tmp/v56-${schema}.XXXXXX.sql)
  sed "s/__TENANT_SCHEMA__/${schema}/g" "$MIGRATION_FILE" > "$TMP_SQL"
  chmod 644 "$TMP_SQL"

  if sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$TMP_SQL" > /dev/null 2>&1; then
    ok "${schema}: CREATE TABLE monthly_kpi_targets"
    SUCCESS=$((SUCCESS + 1))
  else
    ERR=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$TMP_SQL" 2>&1 || true)
    fail "${schema}: ${ERR}"
    FAILED=$((FAILED + 1))
    FAILED_LIST+=("$schema")
  fi
  rm -f "$TMP_SQL"
done

echo ""
echo "=========================================="
info "Backfill V56 完成"
info "扫描 tenants: ${TENANT_COUNT}"
if [ "$APPLY" = true ]; then
  info "成功: ${SUCCESS} / 失败: ${FAILED}"
  if [ ${#FAILED_LIST[@]} -gt 0 ]; then
    fail "失败 tenants: ${FAILED_LIST[*]}"
    exit 1
  fi
else
  warn "DRY-RUN 模式 — 真跑加 --apply"
fi
echo "=========================================="
