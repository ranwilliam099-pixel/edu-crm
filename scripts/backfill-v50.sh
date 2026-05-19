#!/bin/bash
# ============================================================
# backfill-v50.sh — V50 DROP teachers.hourly_price_yuan 全租户脚本
#
# 来源：
#   - Day 2 Phase C X1 (2026-05-19) — 用户拍板 D1.4
#   - 「老师页面零财务字段」+ 物理 > 逻辑 > 文档保护
#   - 课消计算改从合同带价（contract.coursePrice / contract.lessonHours）
#
# 模式：bash 循环 tenant_ids + sed __TENANT_SCHEMA__ + sudo -u postgres psql
#       (复用 V48 模板, 已在 64 tenants 实战全过)
#
# ⚠️ W4 红线：DROP COLUMN 不可逆，DDL 不能回滚
#    本脚本必带 pg_dump 备份探测（W2 红线），失败可由 dump 恢复
#
# 用法（生产服务器，由 main session 审完 + Phase A deploy 完后再触发）：
#   # 1. dry-run（默认）— 不真跑，只列将处理的 tenant
#   bash scripts/backfill-v50.sh
#
#   # 2. 真执行（自动 pg_dump 备份）
#   bash scripts/backfill-v50.sh --apply
#
#   # 3. 只跑指定 tenant
#   bash scripts/backfill-v50.sh --apply --tenant-id=01abcd...
#
# 前置：
#   - 在 PG 主机上执行（sudo -u postgres psql 本机连接）
#   - PG_DB env 默认 'edu'，可覆盖
#   - 应用层 teacher.repository / dto / role-field-filter / spec **必须先 deploy**
#     完成且生产实测无残留 SELECT hourly_price_yuan，再跑此 backfill
#
# 幂等：DROP COLUMN 用 DO $$ 块 + IF NOT EXISTS 跳过已 DROP 的 schema
#       重跑安全
#
# 出具：edu-server backend  2026-05-19 (Day 2 Phase C X1)
# ============================================================

set -euo pipefail

# ===== 配置 =====
PG_DB="${PG_DB:-edu}"
PG_USER_OS="${PG_USER_OS:-postgres}"   # OS 层用户（sudo -u）

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_FILE="${REPO_ROOT}/migrations/V50__drop_teachers_hourly_price.sql"

# pg_dump 备份目录（W2 红线）
BACKUP_DIR="${BACKUP_DIR:-$HOME/dump-pre-2026-05-19-v50-drop}"

# ===== 参数解析 =====
APPLY=false
ONLY_TENANT_ID=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --tenant-id=*) ONLY_TENANT_ID="${arg#*=}" ;;
    *) echo "[warn] unknown arg: $arg" ;;
  esac
done

# ===== 颜色日志 =====
C_GREEN='\033[32m'
C_RED='\033[31m'
C_YELLOW='\033[33m'
C_CYAN='\033[36m'
C_GRAY='\033[90m'
C_RESET='\033[0m'

ok()    { printf "${C_GREEN}OK${C_RESET}    %s\n" "$1"; }
fail()  { printf "${C_RED}FAIL${C_RESET}  %s\n" "$1"; }
warn()  { printf "${C_YELLOW}WARN${C_RESET}  %s\n" "$1"; }
info()  { printf "${C_CYAN}INFO${C_RESET}  %s\n" "$1"; }
note()  { printf "${C_GRAY}      %s${C_RESET}\n" "$1"; }

# ===== A03 红线：tenant-id 白名单校验（防 sed/SQL 注入） =====
# 应用层守护参考 pg-pool.service.ts:69 /^tenant_[a-z0-9_]+$/
# 这里 raw tenant id 是 ULID（32 位 base32 alphanumeric），所以更严
if [[ -n "$ONLY_TENANT_ID" && ! "$ONLY_TENANT_ID" =~ ^[a-zA-Z0-9]{32}$ ]]; then
  fail "tenant-id 格式非法（须 32 位 alphanumeric）: $ONLY_TENANT_ID"
  exit 1
fi

# ===== Banner =====
echo ""
echo "==============================================="
echo "  V50 DROP teachers.hourly_price_yuan backfill"
echo "  X1 重构 — 用户拍板 D1.4 「老师页面零财务字段」"
echo "==============================================="
echo ""
if [ "$APPLY" = false ]; then
  warn "DRY-RUN mode（默认）— 加 --apply 才会真执行"
else
  info "APPLY mode — 真执行（含 pg_dump 备份）"
  warn "⚠️ DROP COLUMN 不可逆 — 失败回滚必须靠 pg_dump 备份"
fi
if [ -n "$ONLY_TENANT_ID" ]; then
  info "只跑 tenant: $ONLY_TENANT_ID"
fi
echo ""

# ===== 前置检查 =====
if [ ! -f "$MIGRATION_FILE" ]; then
  fail "migration file 不存在: $MIGRATION_FILE"
  exit 1
fi
ok "migration file: $MIGRATION_FILE"

if ! command -v psql >/dev/null 2>&1; then
  fail "psql 未安装"
  exit 1
fi
ok "psql 已就绪"

if [ "$APPLY" = true ] && ! command -v pg_dump >/dev/null 2>&1; then
  fail "pg_dump 未安装（W2 红线必备）"
  exit 1
fi
echo ""

# ===== W2 红线：pg_dump 备份探测 =====
if [ "$APPLY" = true ]; then
  mkdir -p "$BACKUP_DIR"
  DUMP_FILE="${BACKUP_DIR}/edu-pre-v50-$(date +%Y%m%d-%H%M%S).dump"
  info "pg_dump 备份至 $DUMP_FILE ..."
  # postgres 用户写 ubuntu home 目录 — 用 stdout 重定向走 ubuntu shell IO
  if sudo -u "$PG_USER_OS" pg_dump -Fc -d "$PG_DB" > "$DUMP_FILE" 2>/dev/null; then
    DUMP_SIZE=$(du -h "$DUMP_FILE" | cut -f1)
    ok "pg_dump 完成 ($DUMP_SIZE)"
  else
    fail "pg_dump 失败 — DROP COLUMN 是不可逆 DDL，无备份不允许 --apply"
    exit 1
  fi
  echo ""
fi

# ===== 列出 tenant_ids =====
info "查询 public.tenants 列表..."

if [ -n "$ONLY_TENANT_ID" ]; then
  TENANT_QUERY="SELECT id, name FROM public.tenants WHERE id = '${ONLY_TENANT_ID}' ORDER BY created_at ASC"
else
  TENANT_QUERY="SELECT id, name FROM public.tenants ORDER BY created_at ASC"
fi

TENANT_LIST=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -t -A -F '|' -c "$TENANT_QUERY" 2>/dev/null || true)

if [ -z "$TENANT_LIST" ]; then
  warn "未找到 tenants（public.tenants 为空 或 only-tenant-id 不匹配）"
  exit 0
fi

TENANT_COUNT=$(echo "$TENANT_LIST" | wc -l | tr -d ' ')
ok "找到 $TENANT_COUNT 个 tenant"
echo ""

# ===== 循环每个 tenant：sed __TENANT_SCHEMA__ + psql =====
SUCCESS=0
FAILED=0
SKIPPED=0

echo "==============================================="
echo "  开始逐租户 DROP teachers.hourly_price_yuan"
echo "==============================================="

while IFS='|' read -r TENANT_ID TENANT_NAME; do
  [ -z "$TENANT_ID" ] && continue

  TENANT_ID_LC=$(echo "$TENANT_ID" | tr '[:upper:]' '[:lower:]')
  TENANT_SCHEMA="tenant_${TENANT_ID_LC}"

  printf "${C_GRAY}---${C_RESET} %s (%s...)\n" "$TENANT_NAME" "${TENANT_ID:0:8}"

  SCHEMA_CHECK=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -t -A -c \
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = '${TENANT_SCHEMA}'" 2>/dev/null || true)

  if [ -z "$SCHEMA_CHECK" ]; then
    warn "schema ${TENANT_SCHEMA} 不存在，SKIP"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  TMP_SQL=$(mktemp /tmp/v50-${TENANT_ID_LC}.XXXXXX.sql)
  sed "s/__TENANT_SCHEMA__/${TENANT_SCHEMA}/g" "$MIGRATION_FILE" > "$TMP_SQL"
  # 2026-05-13 fix: mktemp 默认 chmod 600 ubuntu，sudo -u postgres psql -f 读不了
  chmod 644 "$TMP_SQL"

  if [ "$APPLY" = false ]; then
    info "[dry-run] would DROP teachers.hourly_price_yuan on ${TENANT_SCHEMA} (sql size: $(wc -c < "$TMP_SQL") bytes)"
    SUCCESS=$((SUCCESS + 1))
    rm -f "$TMP_SQL"
    continue
  fi

  if sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$TMP_SQL" >/dev/null 2>&1; then
    ok "V50 applied to ${TENANT_SCHEMA}"
    SUCCESS=$((SUCCESS + 1))
  else
    fail "V50 failed on ${TENANT_SCHEMA}"
    # 2026-05-13 学习追加：psql -f 默认 suppress stderr → 必须 unsuppress 看真实错误
    sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$TMP_SQL" 2>&1 | tail -5 | sed 's/^/      /'
    FAILED=$((FAILED + 1))
  fi

  rm -f "$TMP_SQL"

done <<< "$TENANT_LIST"

echo ""
echo "==============================================="
echo "  Summary"
echo "==============================================="
printf "  ${C_GREEN}Success${C_RESET}: %d\n" "$SUCCESS"
printf "  ${C_YELLOW}Skipped${C_RESET}: %d (schema missing)\n" "$SKIPPED"
printf "  ${C_RED}Failed${C_RESET}:  %d\n" "$FAILED"
echo ""

if [ "$APPLY" = false ]; then
  warn "DRY-RUN 已完成 — 加 --apply 真执行（含 pg_dump 备份）"
  exit 0
fi

if [ $FAILED -gt 0 ]; then
  fail "部分 tenant backfill 失败，回查日志（dump 在 ${DUMP_FILE}）"
  exit 1
fi

ok "全部 tenant V50 DROP hourly_price_yuan 完成"
echo ""
note "下一步："
note "  1. 跑 verify-tenants-match-reference.sh 验证 teachers 表无 hourly_price_yuan 列"
note "  2. 重 snapshot baseline V49 → V50"
note "  3. pm2 reload edu-api（应用层已对齐，但确保 cluster 重启读新代码）"
echo ""
