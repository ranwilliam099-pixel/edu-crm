#!/bin/bash
# ============================================================
# backfill-v61.sh — V61 一次性补 V59/V60 漏掉的 GRANT
#
# 来源：2026-05-23 真机验证发现 /db/refunds/pending 500 permission denied
# 根因：V59/V60 migration 漏 GRANT TO eduapp（V46 注释已记录 V43 教训，再次重蹈覆辙）
#
# 模式：bash 循环 tenant_ids + sed __TENANT_SCHEMA__ + sudo -u postgres psql
# 幂等：GRANT 重复执行 PG 自动忽略
#
# 用法：
#   bash scripts/backfill-v61.sh             # dry-run
#   bash scripts/backfill-v61.sh --apply     # 真跑
# ============================================================

set -euo pipefail

PG_DB="${PG_DB:-edu}"
PG_USER_OS="${PG_USER_OS:-postgres}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_FILE="${REPO_ROOT}/migrations/V61__grant_refund_and_recipients.sql"

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
    printf "${C_YELLOW}DRY${C_RESET}   ${schema}: 将 GRANT refund_orders + assessment_recipients\n"
    continue
  fi

  TMP_SQL=$(mktemp /tmp/v61-${schema}.XXXXXX.sql)
  sed "s/__TENANT_SCHEMA__/${schema}/g" "$MIGRATION_FILE" > "$TMP_SQL"
  chmod 644 "$TMP_SQL"

  if sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$TMP_SQL" > /dev/null 2>&1; then
    ok "${schema}: GRANT refund_orders + assessment_recipients"
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
info "Backfill V61 完成"
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
