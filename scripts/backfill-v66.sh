#!/bin/bash
# ============================================================
# backfill-v66.sh — V66 反馈提醒规则配置（Phase 5）全租户 schema migration
#   (CREATE TABLE feedback_rule_config — 独立新表，per campus 反馈规则)
#
# 来源：../edu-mp-sandbox/docs/SSOT-拍板权威.md §5.3.3（2026-06-01 拍板：反馈规则 + 教务反馈页）
# 业务：校长配反馈提醒规则（reminder_days 时间维度 / every_n_lessons 次数维度，OR 任一命中）
#       → 系统算每个教务名下待反馈学员 → 进教务反馈页（只读待办）。
#
# 模式：bash 循环 tenant_ids + sed __TENANT_SCHEMA__ + sudo -u postgres psql
#       （完全仿 backfill-v65.sh；含 COS pre-DDL 备份探测红线）
#
# ⚠️ 为何独立 V66 而非编辑旧迁移：本迁移从未 applied，下次部署必跑（正确）。
#    禁止把表/列加进已部署旧迁移（V64 trials 表已建于生产）—— 已 applied 迁移不会重跑，
#    生产将永不执行（与 V65 同教训）。独立新表 CREATE TABLE IF NOT EXISTS 对全/未跑两态都幂等。
#
# 内容：
#   1. CREATE TABLE IF NOT EXISTS feedback_rule_config
#        (campus_id PK, reminder_days int, every_n_lessons int, updated_by, updated_at)
#   2. ALTER TABLE feedback_rule_config OWNER TO eduapp（V56 教训：否则应用层 query permission denied）
#   幂等（CREATE TABLE IF NOT EXISTS），无数据 backfill（无行=规则全关，调用方兜默认 null/null）。
#
# 用法（生产服务器，在 PG 主机上执行）：
#   # 1. dry-run（默认）— 列将处理的 tenant，不改库
#   bash scripts/backfill-v66.sh
#
#   # 2. 真执行
#   bash scripts/backfill-v66.sh --apply
#
#   # 3. 跳过备份检查（DANGEROUS，仅在确认 pg_dump 还原点已存在时用；主机无 coscmd 时常用）
#   bash scripts/backfill-v66.sh --apply --skip-backup-check
#
#   # 4. 只跑指定 tenant
#   bash scripts/backfill-v66.sh --apply --tenant-id=01abcd...
#
# 前置：
#   - 在 PG 主机执行（sudo -u postgres psql 本机连接）
#   - PG_DB env 默认 'edu'，可覆盖
#   - migrations/V66__feedback_rule_config.sql 文件存在
#
# 幂等：
#   - CREATE TABLE IF NOT EXISTS（重跑无害）
#
# 出具：edu-server backend  2026-06-02（Phase 5 反馈规则配置）
# ============================================================

set -euo pipefail

# ===== 配置 =====
PG_DB="${PG_DB:-edu}"
PG_USER_OS="${PG_USER_OS:-postgres}"   # OS 层用户（sudo -u）
COS_BUCKET="${COS_BUCKET:-}"           # 若已配 coscmd，会自动探测

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_FILE="${REPO_ROOT}/migrations/V66__feedback_rule_config.sql"

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
echo "  V66 反馈提醒规则配置（Phase 5）"
echo "==============================================="
echo ""
if [ "$APPLY" = false ]; then
  warn "DRY-RUN mode（默认）— 加 --apply 才会真执行"
else
  info "APPLY mode — 真执行（CREATE TABLE feedback_rule_config）"
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

# ===== 红线：pre-DDL COS 备份探测 =====
# CREATE TABLE 可逆（DROP TABLE 恢复），无数据 backfill，仍按规范走备份探测
echo "==============================================="
echo "  红线：pre-DDL pg_dump 备份探测"
echo "==============================================="
echo ""

if [ "$SKIP_BACKUP_CHECK" = true ]; then
  warn "${C_BOLD}已跳过备份检查（--skip-backup-check）${C_RESET}"
  warn "请确认已有 pg_dump 还原点（V66 = CREATE TABLE，可逆，无数据 backfill，风险低）"
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
    warn "V66 是 CREATE TABLE（可逆），缺备份不阻塞，但建议先跑备份"
    if [ "$APPLY" = true ]; then
      fail "${C_BOLD}--apply 模式 + 备份未确认 → 拒绝继续${C_RESET}"
      fail "请先确认备份，或加 --skip-backup-check 强制（CREATE TABLE 可逆，风险低）"
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
echo "  开始逐租户 CREATE TABLE feedback_rule_config"
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

  # ----- CREATE TABLE feedback_rule_config -----
  TMP_SQL=$(mktemp /tmp/v66-${TENANT_ID_LC}.XXXXXX.sql)
  sed "s/__TENANT_SCHEMA__/${TENANT_SCHEMA}/g" "$MIGRATION_FILE" > "$TMP_SQL"
  # V41 已踩坑：mktemp 默认 chmod 600 ubuntu，sudo -u postgres psql -f 读不了
  chmod 644 "$TMP_SQL"

  if [ "$APPLY" = false ]; then
    info "[dry-run] would CREATE TABLE feedback_rule_config on ${TENANT_SCHEMA} (sql size: $(wc -c < "$TMP_SQL") bytes)"
    SCHEMA_OK=$((SCHEMA_OK + 1))
  else
    if sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$TMP_SQL" >/dev/null 2>&1; then
      ok "V66 applied to ${TENANT_SCHEMA}"
      SCHEMA_OK=$((SCHEMA_OK + 1))
    else
      fail "V66 failed on ${TENANT_SCHEMA}"
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
echo "  CREATE TABLE feedback_rule_config:"
printf "    ${C_GREEN}Success${C_RESET}: %d\n" "$SCHEMA_OK"
printf "    ${C_YELLOW}Skipped${C_RESET}: %d (schema missing)\n" "$SCHEMA_SKIPPED"
printf "    ${C_RED}Failed${C_RESET}:  %d\n" "$SCHEMA_FAILED"
echo ""

if [ "$APPLY" = false ]; then
  warn "DRY-RUN 已完成 — 加 --apply 真执行"
  exit 0
fi

if [ $SCHEMA_FAILED -gt 0 ]; then
  fail "部分 tenant V66 失败（schema_failed=$SCHEMA_FAILED）"
  exit 1
fi

ok "全部 tenant V66 CREATE TABLE feedback_rule_config 完成"
echo ""
note "下一步：pm2 reload edu-api（部署 FeedbackRuleConfigRepository + PendingFeedbackService 端点）"
note "灰度验证：校长 POST /db/campus-config/feedback-rule/set 配规则 → 教务 POST /db/feedback/pending-students 看命中待办"
note "回退：DROP TABLE IF EXISTS <schema>.feedback_rule_config;"
echo ""
