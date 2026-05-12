#!/bin/bash
# ============================================================
# backfill-v41-customers-mobile.sh — V41 customers.primary_mobile 三列加密 全租户脚本
#
# 来源：用户 2026-05-10 P0 第 2 项「敏感字段加密」+ V41 migration
#
# 模式：bash 循环 tenant_ids + sed __TENANT_SCHEMA__ apply migration
#       + 每 tenant 单独跑 ts-node 加密单租户数据
#       （参考 V33/V34/V35/V37/V39 bash 循环 + V40 ts-node 单租户的混合）
#
# 与 V40 关键差异（A02-3 vs A02-4）：
#   - V40 是 public.parents 单表 N 行 backfill（ts-node 一进程跑完）
#   - V41 是 64 tenants × N 行 backfill（外层 bash 循环 tenants）
#   - ALTER TABLE 通过 sed 占位符替换；加密数据走 ts-node 单 tenant 进程
#
# 与 V37 关键差异（W4）：
#   - V37 是「DROP 列 + 数据永久丢失」操作 → 必须 pre-DROP COS 备份
#   - V41 是「ADD COLUMN nullable + 后续 UPDATE backfill」操作 → 可逆（DROP COLUMN）
#   - 但仍按规范走 pg_dump 备份探测（保持运维基线一致）
#
# 用法（生产服务器）：
#   # 1. dry-run（默认）— 只列将处理的 tenant + 备份检查 + 单 tenant ts-node dry-run
#   bash scripts/backfill-v41-customers-mobile.sh
#
#   # 2. 真执行
#   bash scripts/backfill-v41-customers-mobile.sh --apply
#
#   # 3. 跳过备份检查（DANGEROUS，仅紧急回退用）
#   bash scripts/backfill-v41-customers-mobile.sh --apply --skip-backup-check
#
#   # 4. 只跑指定 tenant
#   bash scripts/backfill-v41-customers-mobile.sh --apply --tenant-id=01abcd...
#
# 前置：
#   - 在 PG 主机上执行（sudo -u postgres psql 本机连接）
#   - PG_DB env 默认 'edu'，可覆盖
#   - .env 已配 ENCRYPTION_KEY + HASH_KEY（两个 key 必须不同；A02-3 V40 已加）
#   - V41__customers_primary_mobile_hash_and_encrypted.sql 文件存在
#   - npx ts-node 可用（package.json devDependency）
#
# 幂等：
#   - ALTER TABLE ADD COLUMN IF NOT EXISTS（重跑无害）
#   - UPDATE WHERE *_hash IS NULL OR *_encrypted IS NULL（重跑只补未处理行）
#
# 出具：edu-server backend  2026-05-13
# ============================================================

set -euo pipefail

# ===== 配置 =====
PG_DB="${PG_DB:-edu}"
PG_USER_OS="${PG_USER_OS:-postgres}"   # OS 层用户（sudo -u）
COS_BUCKET="${COS_BUCKET:-}"           # 若已配 coscmd，会自动探测

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_FILE="${REPO_ROOT}/migrations/V41__customers_primary_mobile_hash_and_encrypted.sql"
TS_SCRIPT="${REPO_ROOT}/scripts/backfill-v41-customers-mobile.ts"

# ===== 参数解析 =====
APPLY=false
ONLY_TENANT_ID=""
SKIP_BACKUP_CHECK=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --tenant-id=*) ONLY_TENANT_ID="${arg#*=}" ;;
    --skip-backup-check) SKIP_BACKUP_CHECK=true ;;
    --dry-run) APPLY=false ;;  # 显式 dry-run（默认值）
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
# 继承 backfill-v35.sh / backfill-v37.sh / backfill-v39.sh
if [[ -n "$ONLY_TENANT_ID" && ! "$ONLY_TENANT_ID" =~ ^[a-zA-Z0-9]{32}$ ]]; then
  fail "tenant-id 格式非法（须 32 位 alphanumeric）: $ONLY_TENANT_ID"
  exit 1
fi

# ===== Banner =====
echo ""
echo "==============================================="
echo "  V41 customers.primary_mobile_hash + primary_mobile_encrypted"
echo "==============================================="
echo ""
if [ "$APPLY" = false ]; then
  warn "DRY-RUN mode（默认）— 加 --apply 才会真执行"
else
  info "APPLY mode — 真执行（ADD COLUMN + UPDATE 加密数据）"
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

if [ ! -f "$TS_SCRIPT" ]; then
  fail "ts-node 脚本不存在: $TS_SCRIPT"
  exit 1
fi
ok "ts-node 脚本: $TS_SCRIPT"

if ! command -v psql >/dev/null 2>&1; then
  fail "psql 未安装"
  exit 1
fi
ok "psql 已就绪"

if ! command -v npx >/dev/null 2>&1; then
  fail "npx 未安装（需 Node.js + ts-node）"
  exit 1
fi
ok "npx 已就绪"
echo ""

# ===== W2 红线：pre-ADD COLUMN COS 备份存在性前置检查 =====
# 虽然 ADD COLUMN 可逆（DROP COLUMN 恢复），但仍按规范走备份探测保持运维基线一致
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
    warn "V41 是 ADD COLUMN + UPDATE backfill（可逆），缺备份不阻塞，但建议先跑备份"
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
  warn "V41 是 ADD COLUMN + UPDATE backfill（可逆），缺备份风险低于 V37 DROP"
  warn "若已确认数据已备份，可加 --skip-backup-check 跳过本检查"
  warn ""
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
# Phase 1：sed __TENANT_SCHEMA__ + psql apply migration（ADD COLUMN + 索引）
# Phase 2：调 ts-node 跑数据加密 backfill（UPDATE）
SCHEMA_OK=0
SCHEMA_FAILED=0
SCHEMA_SKIPPED=0
BF_TOTAL_OK=0
BF_TOTAL_FAIL=0
BF_TOTAL_ROWS=0

echo "==============================================="
echo "  开始逐租户 ADD COLUMN + backfill"
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
    SCHEMA_SKIPPED=$((SCHEMA_SKIPPED + 1))
    continue
  fi

  # ----- Phase 1: ADD COLUMN -----
  TMP_SQL=$(mktemp /tmp/v41-${TENANT_ID_LC}.XXXXXX.sql)
  sed "s/__TENANT_SCHEMA__/${TENANT_SCHEMA}/g" "$MIGRATION_FILE" > "$TMP_SQL"

  if [ "$APPLY" = false ]; then
    info "[dry-run/Phase1] would ADD COLUMN primary_mobile_hash + primary_mobile_encrypted on ${TENANT_SCHEMA} (sql size: $(wc -c < "$TMP_SQL") bytes)"
    SCHEMA_OK=$((SCHEMA_OK + 1))
  else
    if sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$TMP_SQL" >/dev/null 2>&1; then
      ok "V41 ALTER applied to ${TENANT_SCHEMA}"
      SCHEMA_OK=$((SCHEMA_OK + 1))
    else
      fail "V41 ALTER failed on ${TENANT_SCHEMA}"
      sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$TMP_SQL" 2>&1 | tail -5 | sed 's/^/      /'
      SCHEMA_FAILED=$((SCHEMA_FAILED + 1))
      rm -f "$TMP_SQL"
      continue
    fi
  fi
  rm -f "$TMP_SQL"

  # ----- Phase 2: ts-node 数据 backfill -----
  TS_ARGS=""
  if [ "$APPLY" = true ]; then
    TS_ARGS="--apply"
  fi

  # ts-node 用 cwd 而非 absolute path 避免 require 路径混乱
  if TS_OUT=$(cd "$REPO_ROOT" && TENANT_SCHEMA="$TENANT_SCHEMA" npx ts-node "$TS_SCRIPT" $TS_ARGS 2>&1); then
    # 解析最后一行 ===> TENANT=tenant_xxx OK=N FAIL=N TOTAL=N
    SUMMARY=$(echo "$TS_OUT" | grep -oE 'TENANT=[a-z0-9_]+ OK=[0-9]+ FAIL=[0-9]+ TOTAL=[0-9]+' | tail -1)
    if [ -n "$SUMMARY" ]; then
      OK_COUNT=$(echo "$SUMMARY" | grep -oE 'OK=[0-9]+' | head -1 | cut -d= -f2)
      FAIL_COUNT=$(echo "$SUMMARY" | grep -oE 'FAIL=[0-9]+' | head -1 | cut -d= -f2)
      TOTAL_COUNT=$(echo "$SUMMARY" | grep -oE 'TOTAL=[0-9]+' | head -1 | cut -d= -f2)
      BF_TOTAL_OK=$((BF_TOTAL_OK + ${OK_COUNT:-0}))
      BF_TOTAL_FAIL=$((BF_TOTAL_FAIL + ${FAIL_COUNT:-0}))
      BF_TOTAL_ROWS=$((BF_TOTAL_ROWS + ${TOTAL_COUNT:-0}))
      if [ "$APPLY" = false ]; then
        info "[dry-run/Phase2] ${TENANT_SCHEMA}: total=${TOTAL_COUNT} rows to encrypt"
      else
        ok "Phase2 backfill ${TENANT_SCHEMA}: ok=${OK_COUNT} fail=${FAIL_COUNT} total=${TOTAL_COUNT}"
      fi
    else
      warn "Phase2 ${TENANT_SCHEMA}: 无 summary 行（可能脚本异常）"
      echo "$TS_OUT" | tail -5 | sed 's/^/      /'
      BF_TOTAL_FAIL=$((BF_TOTAL_FAIL + 1))
    fi
  else
    fail "Phase2 ts-node 失败 on ${TENANT_SCHEMA}"
    echo "$TS_OUT" | tail -10 | sed 's/^/      /'
    BF_TOTAL_FAIL=$((BF_TOTAL_FAIL + 1))
  fi

done <<< "$TENANT_LIST"

echo ""
echo "==============================================="
echo "  Summary"
echo "==============================================="
echo ""
echo "  Phase 1: ADD COLUMN"
printf "    ${C_GREEN}Success${C_RESET}: %d\n" "$SCHEMA_OK"
printf "    ${C_YELLOW}Skipped${C_RESET}: %d (schema missing)\n" "$SCHEMA_SKIPPED"
printf "    ${C_RED}Failed${C_RESET}:  %d\n" "$SCHEMA_FAILED"
echo ""
echo "  Phase 2: UPDATE backfill"
printf "    Total rows:  %d\n" "$BF_TOTAL_ROWS"
printf "    ${C_GREEN}OK${C_RESET} rows:     %d\n" "$BF_TOTAL_OK"
printf "    ${C_RED}FAIL${C_RESET} rows:   %d\n" "$BF_TOTAL_FAIL"
echo ""

if [ "$APPLY" = false ]; then
  warn "DRY-RUN 已完成 — 加 --apply 真执行"
  exit 0
fi

if [ $SCHEMA_FAILED -gt 0 ] || [ $BF_TOTAL_FAIL -gt 0 ]; then
  fail "部分 tenant V41 失败（schema_failed=$SCHEMA_FAILED, backfill_failed=$BF_TOTAL_FAIL）"
  exit 1
fi

ok "全部 tenant V41 ADD COLUMN + backfill 完成"
echo ""
note "下一步：pm2 reload edu-api（部署 V41 代码侧 CustomerRepository / StudentImportRepository 三写）"
note "灰度验证：抽样 SQL 比对 hash 列与明文查询结果一致"
note "回退：见 migrations/V41__customers_primary_mobile_hash_and_encrypted.sql 注释末段"
echo ""
