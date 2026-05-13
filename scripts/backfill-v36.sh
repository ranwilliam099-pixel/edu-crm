#!/bin/bash
# ============================================================
# backfill-v36.sh — V36 monthly_reports audience columns 全租户灌入脚本
#
# 来源：用户 5/11 拍板「方案 B」V36 = 加 5 列复用同一行（双轨 audience 隔离）
#
# 模式：bash 循环 tenant_ids + sed __TENANT_SCHEMA__ + sudo -u postgres psql
#       继承 backfill-v35.sh + backfill-v39.sh 经验
#       （V33/V34/V35/V37/V39 在 64 tenants 实战全过）
#
# ⚠️ V36 风险级别：低
#   - V37 是「DROP 列 + 数据永久丢失」操作 → 必须 pre-DROP COS 备份
#   - V39 是「RENAME COLUMN + 数据保留」可逆 → 备份缺失 WARN 但不阻塞
#   - V36 是「ADD COLUMN（5 列 NULL）+ ADD INDEX」纯加 = 与 V39 同级（可逆）
#     → backfill 备份探测使用 V39 WARN 模式（缺备份不阻塞）
#
# 用法（生产服务器，由 main session 审完再触发）：
#   # 1. dry-run（默认）— 不真跑，只列将处理的 tenant + 备份检查
#   bash scripts/backfill-v36.sh
#
#   # 2. 真执行
#   bash scripts/backfill-v36.sh --apply
#
#   # 3. 跳过备份检查（DANGEROUS，仅紧急回退用）
#   bash scripts/backfill-v36.sh --apply --skip-backup-check
#
#   # 4. 只跑指定 tenant
#   bash scripts/backfill-v36.sh --apply --tenant-id=01abcd...
#
# 前置：
#   - 在 PG 主机上执行（sudo -u postgres psql 本机连接）
#   - PG_DB env 默认 'edu'，可覆盖
#   - 强烈建议在 PG 主机已配 coscmd（COS_BUCKET 探测）；
#     未配则只会 banner 警告，不阻塞
#
# 幂等：ADD COLUMN IF NOT EXISTS（重跑无害，已加列直接跳过）
#
# 出具：研发负责人  2026-05-11
# ============================================================

set -euo pipefail

# ===== 配置 =====
PG_DB="${PG_DB:-edu}"
PG_USER_OS="${PG_USER_OS:-postgres}"   # OS 层用户（sudo -u）
COS_BUCKET="${COS_BUCKET:-}"           # 若已配 coscmd，会自动探测

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_FILE="${REPO_ROOT}/migrations/V36__monthly_reports_audience_columns.sql"

# ===== 参数解析 =====
APPLY=false
ONLY_TENANT_ID=""
SKIP_BACKUP_CHECK=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --tenant-id=*) ONLY_TENANT_ID="${arg#*=}" ;;
    --skip-backup-check) SKIP_BACKUP_CHECK=true ;;
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

# ===== W1 红线：tenant-id 白名单校验（防 sed/SQL 注入） =====
# 继承 backfill-v35/v37/v39.sh — 应用层守护参考 pg-pool.service.ts:69 /^tenant_[a-z0-9_]+$/
# 这里 raw tenant id 是 ULID（32 位 base32 alphanumeric）
if [[ -n "$ONLY_TENANT_ID" && ! "$ONLY_TENANT_ID" =~ ^[a-zA-Z0-9]{32}$ ]]; then
  fail "tenant-id 格式非法（须 32 位 alphanumeric）: $ONLY_TENANT_ID"
  exit 1
fi

# ===== Banner =====
echo ""
echo "==============================================="
echo "  V36 monthly_reports audience columns backfill"
echo "==============================================="
echo ""
if [ "$APPLY" = false ]; then
  warn "DRY-RUN mode（默认）— 加 --apply 才会真执行"
else
  info "APPLY mode — 真执行（ADD COLUMN + ADD INDEX，可逆）"
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

# ===== W2 红线：pre-ALTER COS 备份存在性前置检查 =====
# V36 与 V39 同级（可逆），缺备份不阻塞，但仍按规范走探测
echo "==============================================="
echo "  W2 红线：pre-ALTER pg_dump 备份探测"
echo "==============================================="
echo ""

if [ "$SKIP_BACKUP_CHECK" = true ]; then
  warn "${C_BOLD}已跳过备份检查（--skip-backup-check）${C_RESET}"
  note "仅在数据已确认不需要、或紧急回退场景使用"
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
    warn "V36 是 ADD COLUMN 操作（可逆），缺备份不阻塞，但建议先跑备份"
    warn "操作建议："
    warn "  1. ssh 上 PG 主机手动跑 scripts/pg_dump_backup.sh"
    warn "  2. 或加 --skip-backup-check 跳过本检查"
    if [ "$APPLY" = true ]; then
      fail "${C_BOLD}--apply 模式 + 备份未确认 → 拒绝继续${C_RESET}"
      fail "请先确认备份，或加 --skip-backup-check 强制（ADD COLUMN 可逆，风险低）"
      exit 1
    fi
  fi
else
  warn "${C_BOLD}WARNING：未确认今日 pg_dump 备份在 COS${C_RESET}"
  warn "原因：coscmd 未安装 或 \$COS_BUCKET 环境变量未设置"
  warn ""
  warn "${C_BOLD}请确认以下任一条件已满足，再加 --apply 触发：${C_RESET}"
  warn "  1. 已经手动 pg_dump 到本地/异地"
  warn "  2. 已配置 cron 每日 pg_dump 上传 COS（V35 之后建议）"
  warn "  3. 已 git tag + branch 提供回退（仅代码侧）"
  warn ""
  warn "V36 是 ADD COLUMN 操作（可逆），缺备份风险低于 V37 DROP"
  warn "若已确认数据已备份，可加 --skip-backup-check 跳过本检查"
  warn ""
  if [ "$APPLY" = true ]; then
    fail "${C_BOLD}--apply 模式 + 备份未确认 → 拒绝继续${C_RESET}"
    fail "请先确认备份，或加 --skip-backup-check 强制（ADD COLUMN 可逆，风险低）"
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

# ===== 循环每个 tenant：sed __TENANT_SCHEMA__ + psql =====
SUCCESS=0
FAILED=0
SKIPPED=0

echo "==============================================="
echo "  开始逐租户 backfill V36"
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
  TMP_SQL=$(mktemp /tmp/v36-${TENANT_ID_LC}.XXXXXX.sql)
  sed "s/__TENANT_SCHEMA__/${TENANT_SCHEMA}/g" "$MIGRATION_FILE" > "$TMP_SQL"
  # 2026-05-13 fix: mktemp 默认 chmod 600 ubuntu，sudo -u postgres psql -f 读不了
  # → chmod 644 让 postgres 用户可读（SQL 仅含 schema 替换，无敏感数据）
  chmod 644 "$TMP_SQL"

  if [ "$APPLY" = false ]; then
    info "[dry-run] would ADD 5 audience columns + idx on ${TENANT_SCHEMA} (sql size: $(wc -c < "$TMP_SQL") bytes)"
    SUCCESS=$((SUCCESS + 1))
    rm -f "$TMP_SQL"
    continue
  fi

  # 真执行
  if sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$TMP_SQL" >/dev/null 2>&1; then
    ok "V36 applied to ${TENANT_SCHEMA}"
    SUCCESS=$((SUCCESS + 1))
  else
    fail "V36 failed on ${TENANT_SCHEMA}"
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

ok "全部 tenant V36 ADD COLUMNS 完成"
echo ""
note "下一步：pm2 reload edu-api（部署 V36 代码侧 monthly-report.repository / service / controller 改造）"
note "回退（恢复列结构，不恢复 NULL 数据）：见 migrations/V36__monthly_reports_audience_columns.sql 注释末段"
note "硬约束：64 tenants 必须先跑 V36 backfill，才能 reload 含 V36 代码的服务"
echo ""
