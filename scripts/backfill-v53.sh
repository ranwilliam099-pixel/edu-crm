#!/bin/bash
# ============================================================
# backfill-v53.sh — V53 audit_log.actor_user_id + target_id: UUID → VARCHAR(32)
#
# 来源：5/20 leader 自补 — L2 monthly-report integration spec 暴露 V33 audit_log
# 类型不匹配真生产 bug（64 tenant 抽查 audit_log 全 0 行 — fail-open 静默吞错）
#
# 模式：bash 循环 tenant_ids + sed __TENANT_SCHEMA__ + sudo -u postgres psql
#       （参考 V33/V34/V35 在 64 tenants 实战全过经验）
#
# 影响：64 tenant × 2 列 ALTER TYPE = 128 操作。表为空（0 行）所以纯 DDL 无数据迁移。
#
# 用法（生产服务器，由 main session 审完再触发）：
#   # 1. dry-run（默认）— 不真跑，只列将处理的 tenant
#   bash scripts/backfill-v53.sh
#
#   # 2. 真执行
#   bash scripts/backfill-v53.sh --apply
#
#   # 3. 只跑指定 tenant
#   bash scripts/backfill-v53.sh --apply --tenant-id=01abcd...
#
# 前置：
#   - 在 PG 主机上执行（sudo -u postgres psql 本机连接）
#   - PG_DB env 默认 'edu'，可覆盖
#
# 幂等：ALTER ... ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
#       重跑安全，已存在列/索引跳过
#
# 出具：edu-server backend  2026-05-16
# ============================================================

set -euo pipefail

# ===== 配置 =====
PG_DB="${PG_DB:-edu}"
PG_USER_OS="${PG_USER_OS:-postgres}"   # OS 层用户（sudo -u）

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_FILE="${REPO_ROOT}/migrations/V53__teacher_rating_entries.sql"

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
C_BOLD='\033[1m'
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
echo "  V53 teacher_rating_entries 表新建 backfill"
echo "==============================================="
echo ""
if [ "$APPLY" = false ]; then
  warn "DRY-RUN mode（默认）— 加 --apply 才会真执行"
else
  info "APPLY mode — 真执行"
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
echo ""

# ===== 列出 tenant_ids =====
info "查询 public.tenants 列表..."

if [ -n "$ONLY_TENANT_ID" ]; then
  TENANT_QUERY="SELECT id, name FROM public.tenants WHERE id = '${ONLY_TENANT_ID}' ORDER BY created_at ASC"
else
  TENANT_QUERY="SELECT id, name FROM public.tenants ORDER BY created_at ASC"
fi

# 提取 tenant_id（pipe-separated id|name）
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
echo "  开始逐租户 backfill"
echo "==============================================="

while IFS='|' read -r TENANT_ID TENANT_NAME; do
  [ -z "$TENANT_ID" ] && continue

  # 小写化（与 tenant-provision.service.ts 的 schema 命名一致）
  TENANT_ID_LC=$(echo "$TENANT_ID" | tr '[:upper:]' '[:lower:]')
  TENANT_SCHEMA="tenant_${TENANT_ID_LC}"

  printf "${C_GRAY}---${C_RESET} %s (%s...)\n" "$TENANT_NAME" "${TENANT_ID:0:8}"

  # 验证 schema 存在
  SCHEMA_CHECK=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -t -A -c \
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = '${TENANT_SCHEMA}'" 2>/dev/null || true)

  if [ -z "$SCHEMA_CHECK" ]; then
    warn "schema ${TENANT_SCHEMA} 不存在，SKIP"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # 生成 tenant 专用 SQL（sed 替换占位符）
  TMP_SQL=$(mktemp /tmp/v53-${TENANT_ID_LC}.XXXXXX.sql)
  sed "s/__TENANT_SCHEMA__/${TENANT_SCHEMA}/g" "$MIGRATION_FILE" > "$TMP_SQL"
  # 2026-05-13 fix: mktemp 默认 chmod 600 ubuntu，sudo -u postgres psql -f 读不了
  # → chmod 644 让 postgres 用户可读（SQL 仅含 schema 替换，无敏感数据）
  chmod 644 "$TMP_SQL"

  if [ "$APPLY" = false ]; then
    info "[dry-run] would run V53 on ${TENANT_SCHEMA} (sql size: $(wc -c < "$TMP_SQL") bytes)"
    SUCCESS=$((SUCCESS + 1))
    rm -f "$TMP_SQL"
    continue
  fi

  # 真执行
  if sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$TMP_SQL" >/dev/null 2>&1; then
    ok "V53 applied to ${TENANT_SCHEMA}"
    SUCCESS=$((SUCCESS + 1))
  else
    fail "V53 failed on ${TENANT_SCHEMA}"
    # 再跑一次显示错误细节
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
  warn "DRY-RUN 已完成 — 加 --apply 真执行"
  exit 0
fi

if [ $FAILED -gt 0 ]; then
  fail "部分 tenant backfill 失败，回查日志"
  exit 1
fi

ok "全部 tenant V53 backfill 完成"
echo ""
note "下一步：跑 scripts/full-test-prod.sh 验证 64 ALTER × 2 列类型变换落地"
note "下一步：5/16 commit deploy ssh pdfserver 运行 bash scripts/backfill-v53.sh --apply"
echo ""
