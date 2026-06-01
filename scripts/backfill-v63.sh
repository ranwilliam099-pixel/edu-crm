#!/bin/bash
# ============================================================
# backfill-v63.sh — V63 学员分配机制全租户 schema migration
#   (students.assigned_academic_id + campus_assignment_config 表)
#
# 来源：../edu-mp-sandbox/docs/2026-06-01-业务链方案-试听激活分配反馈.md Phase 3（#8）
# 业务：合同激活后触发分配教务。校长配「是否自动分配」开关（round-robin 发牌 / 手动）。
#
# 模式：bash 循环 tenant_ids + sed __TENANT_SCHEMA__ + sudo -u postgres psql
#       （参考 V62 模式；含 COS pre-ALTER 备份探测红线）
#
# 内容：
#   1. ALTER TABLE students ADD COLUMN assigned_academic_id（可逆 DROP COLUMN）
#   2. CREATE TABLE campus_assignment_config（可逆 DROP TABLE）
#   均幂等（IF NOT EXISTS），无数据 backfill（assigned_academic_id 初始全 NULL = 全部待分配）。
#
# 用法（生产服务器，在 PG 主机上执行）：
#   # 1. dry-run（默认）— 列将处理的 tenant，不改库
#   bash scripts/backfill-v63.sh
#
#   # 2. 真执行
#   bash scripts/backfill-v63.sh --apply
#
#   # 3. 跳过备份检查（DANGEROUS，仅在确认 pg_dump 还原点已存在时用；主机无 coscmd 时常用）
#   bash scripts/backfill-v63.sh --apply --skip-backup-check
#
#   # 4. 只跑指定 tenant
#   bash scripts/backfill-v63.sh --apply --tenant-id=01abcd...
#
# 前置：
#   - 在 PG 主机执行（sudo -u postgres psql 本机连接）
#   - PG_DB env 默认 'edu'，可覆盖
#   - migrations/V63__student_assignment.sql 文件存在
#
# 幂等：
#   - ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS（重跑无害）
#
# 出具：edu-server backend  2026-06-01（Phase 3 学员→教务分配机制）
# ============================================================

set -euo pipefail

# ===== 配置 =====
PG_DB="${PG_DB:-edu}"
PG_USER_OS="${PG_USER_OS:-postgres}"   # OS 层用户（sudo -u）
COS_BUCKET="${COS_BUCKET:-}"           # 若已配 coscmd，会自动探测

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_FILE="${REPO_ROOT}/migrations/V63__student_assignment.sql"

# ===== 参数解析 =====
APPLY=false
ONLY_TENANT_ID=""
SKIP_BACKUP_CHECK=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --tenant-id=*) ONLY_TENANT_ID="${arg#*=}" ;;
    --skip-backup-check) SKIP_BACKUP_CHECK=true ;;
    --dry-run) APPLY=false ;;
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

# ===== 红线：tenant-id 白名单校验（防 sed/SQL 注入） =====
if [[ -n "$ONLY_TENANT_ID" && ! "$ONLY_TENANT_ID" =~ ^[a-zA-Z0-9]{32}$ ]]; then
  fail "tenant-id 格式非法（须 32 位 alphanumeric）: $ONLY_TENANT_ID"
  exit 1
fi

# ===== Banner =====
echo ""
echo "==============================================="
echo "  V63 学员→教务分配机制（Phase 3）"
echo "==============================================="
echo ""
if [ "$APPLY" = false ]; then
  warn "DRY-RUN mode（默认）— 加 --apply 才会真执行"
else
  info "APPLY mode — 真执行（ADD COLUMN assigned_academic_id + CREATE TABLE campus_assignment_config）"
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

# ===== 红线：pre-ALTER COS 备份探测 =====
# ADD COLUMN / CREATE TABLE 均可逆（DROP 恢复），无数据 backfill，仍按规范走备份探测
echo "==============================================="
echo "  红线：pre-ALTER pg_dump 备份探测"
echo "==============================================="
echo ""

if [ "$SKIP_BACKUP_CHECK" = true ]; then
  warn "${C_BOLD}已跳过备份检查（--skip-backup-check）${C_RESET}"
  warn "请确认已有 pg_dump 还原点（V63 = ADD COLUMN + CREATE TABLE，可逆，无数据 backfill，风险低）"
elif command -v coscmd >/dev/null 2>&1 && [ -n "$COS_BUCKET" ]; then
  TODAY=$(date +%Y-%m-%d)
  YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d "yesterday" +%Y-%m-%d)

  info "探测 COS bucket: ${COS_BUCKET}"
  BACKUP_FOUND=false
  for DATE in "$TODAY" "$YESTERDAY"; do
    if coscmd list "$COS_BUCKET" 2>/dev/null | grep -q "$DATE"; then
      ok "找到 ${DATE} 备份"
      BACKUP_FOUND=true
      break
    fi
  done

  if [ "$BACKUP_FOUND" = false ]; then
    warn "${C_BOLD}未找到今日/昨日 pg_dump 备份在 COS${C_RESET}"
    warn "V63 是 ADD COLUMN + CREATE TABLE（可逆），缺备份不阻塞，但建议先跑备份"
    if [ "$APPLY" = true ]; then
      fail "${C_BOLD}--apply 模式 + 备份未确认 → 拒绝继续${C_RESET}"
      fail "请先确认备份，或加 --skip-backup-check 强制（ADD COLUMN/CREATE TABLE 可逆，风险低）"
      exit 1
    fi
  fi
else
  warn "${C_BOLD}WARNING：未确认今日 pg_dump 备份在 COS${C_RESET}"
  warn "原因：coscmd 未安装 或 \$COS_BUCKET 环境变量未设置"
  if [ "$APPLY" = true ]; then
    fail "${C_BOLD}--apply 模式 + 备份未确认 → 拒绝继续${C_RESET}"
    fail "请先确认备份，或加 --skip-backup-check 强制"
    exit 1
  fi
fi
echo ""

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

# ===== 循环每个 tenant =====
SCHEMA_OK=0
SCHEMA_FAILED=0
SCHEMA_SKIPPED=0

echo "==============================================="
echo "  开始逐租户 ADD COLUMN + CREATE TABLE"
echo "==============================================="

while IFS='|' read -r TENANT_ID TENANT_NAME; do
  [ -z "$TENANT_ID" ] && continue

  TENANT_ID_LC=$(echo "$TENANT_ID" | tr '[:upper:]' '[:lower:]')
  TENANT_SCHEMA="tenant_${TENANT_ID_LC}"

  printf "${C_GRAY}---${C_RESET} %s (%s...)\n" "$TENANT_NAME" "${TENANT_ID:0:8}"

  # 验证 schema 存在
  SCHEMA_CHECK=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -t -A -c \
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = '${TENANT_SCHEMA}'" 2>/dev/null || true)

  if [ -z "$SCHEMA_CHECK" ]; then
    warn "schema ${TENANT_SCHEMA} 不存在，SKIP"
    SCHEMA_SKIPPED=$((SCHEMA_SKIPPED + 1))
    continue
  fi

  # ----- ADD COLUMN + CREATE TABLE -----
  TMP_SQL=$(mktemp /tmp/v63-${TENANT_ID_LC}.XXXXXX.sql)
  sed "s/__TENANT_SCHEMA__/${TENANT_SCHEMA}/g" "$MIGRATION_FILE" > "$TMP_SQL"
  # V41 已踩坑：mktemp 默认 chmod 600 ubuntu，sudo -u postgres psql -f 读不了
  chmod 644 "$TMP_SQL"

  if [ "$APPLY" = false ]; then
    info "[dry-run] would ADD COLUMN assigned_academic_id + CREATE TABLE campus_assignment_config on ${TENANT_SCHEMA} (sql size: $(wc -c < "$TMP_SQL") bytes)"
    SCHEMA_OK=$((SCHEMA_OK + 1))
  else
    if sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$TMP_SQL" >/dev/null 2>&1; then
      ok "V63 applied to ${TENANT_SCHEMA}"
      SCHEMA_OK=$((SCHEMA_OK + 1))
    else
      fail "V63 failed on ${TENANT_SCHEMA}"
      # 重跑取错误日志（unsuppress stderr 防 ROLLBACK silent）
      sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$TMP_SQL" 2>&1 | tail -10 | sed 's/^/      /'
      SCHEMA_FAILED=$((SCHEMA_FAILED + 1))
    fi
  fi
  rm -f "$TMP_SQL"

done <<< "$TENANT_LIST"

echo ""
echo "==============================================="
echo "  Summary"
echo "==============================================="
echo ""
echo "  ADD COLUMN + CREATE TABLE:"
printf "    ${C_GREEN}Success${C_RESET}: %d\n" "$SCHEMA_OK"
printf "    ${C_YELLOW}Skipped${C_RESET}: %d (schema missing)\n" "$SCHEMA_SKIPPED"
printf "    ${C_RED}Failed${C_RESET}:  %d\n" "$SCHEMA_FAILED"
echo ""

if [ "$APPLY" = false ]; then
  warn "DRY-RUN 已完成 — 加 --apply 真执行"
  exit 0
fi

if [ $SCHEMA_FAILED -gt 0 ]; then
  fail "部分 tenant V63 失败（schema_failed=$SCHEMA_FAILED）"
  exit 1
fi

ok "全部 tenant V63 ADD COLUMN + CREATE TABLE 完成"
echo ""
note "下一步：pm2 reload edu-api（部署 StudentAssignmentService + 激活后触发 + 校长配置/手动分配端点）"
note "灰度验证：boss 开自动分配开关 → 激活合同 → SELECT id, assigned_academic_id FROM students 看是否发牌；待分配列表 POST /db/students/pending-assignment"
note "回退：ALTER TABLE <schema>.students DROP COLUMN IF EXISTS assigned_academic_id; DROP TABLE IF EXISTS <schema>.campus_assignment_config;"
echo ""
