#!/bin/bash
# ============================================================
# reset-all-tenants.sh — Day 1 T2a：清盘 + 重建 15 demo tenant
#
# 来源：
#   - 测试方案 v2.0 §3 L0 基础设施层
#   - architect spec §1.1（CLI 接口规格）+ §3（15 demo tenant 数据规格）
#   - leader 决策 D1.1（V49 扩 CHECK 让 archived/frozen 入库）
#
# 流程：
#   Phase 1 (drop):
#     - 前置：pg_dump 全库备份到 ~/dump-pre-reset-<timestamp>.dump
#     - 查 public.tenants 列所有 tenant_id
#     - DROP SCHEMA tenant_<id> CASCADE × N
#     - TRUNCATE public 核心 6 表（含 parent_subscriptions / parent_payment_orders）
#       注意：auth.users / auth schema 不存在；users 表在 tenant_<id>.users（已随 schema DROP 清掉）
#   Phase 2 (provision):
#     - 对 15 个 demo tenant 逐一调 POST /api/public/onboarding/provision-tenant
#     - 把每个 tenant 的 phone+password 映射写入 scripts/seed/demo-users.json
#     - demo-14 / demo-15 (archived/frozen) 依赖 V49 已跑；未跑则 SKIP 并提示
#
# 严谨度（leader 强约束）：
#   - 真调 HTTP API 不 echo mock
#   - phone 严格 /^1[3-9]\d{9}$/
#   - 数据严格按 architect spec §3.1 表
#   - 错误处理：单 tenant 失败 → log + continue + Summary 报告
#   - 颜色日志 5 级（ok/fail/warn/info/note）参考 backfill-v44.sh
#
# 用法：
#   bash scripts/reset-all-tenants.sh                          # dry-run 默认
#   bash scripts/reset-all-tenants.sh --apply                  # 真执行（drop + provision）
#   bash scripts/reset-all-tenants.sh --apply --only-phase=drop      # 只清盘
#   bash scripts/reset-all-tenants.sh --apply --only-phase=provision # 只 provision
#   bash scripts/reset-all-tenants.sh --apply --skip-backup-check    # 跳 pg_dump（紧急用）
#   bash scripts/reset-all-tenants.sh --apply --include-archived-frozen
#       # 跑 demo-14/15（要求 V49 已落地）
#
# ENV：
#   PG_DB=edu                          数据库名
#   PG_USER_OS=postgres                OS 用户（sudo -u）
#   API_BASE=http://localhost:3001     provision API 地址
#                                       (与 .env.example PORT=3001 一致)
#
# 出具：edu-server backend Day 1  2026-05-19
# ============================================================

set -euo pipefail

# ===== 配置 =====
PG_DB="${PG_DB:-edu}"
PG_USER_OS="${PG_USER_OS:-postgres}"
API_BASE="${API_BASE:-http://localhost:3001}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED_DIR="${REPO_ROOT}/scripts/seed"
DEMO_USERS_FILE="${SEED_DIR}/demo-users.json"

# ===== 参数解析 =====
APPLY=false
ONLY_PHASE="both"   # both / drop / provision
SKIP_BACKUP=false
INCLUDE_ARCHIVED_FROZEN=false
FORCE_CONFIRM=false  # F1 修复：CI/自动化场景跳过 typed confirmation
AUDIT_LOG_FILE=""   # F2 修复：可指定 audit log 路径

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --only-phase=drop) ONLY_PHASE="drop" ;;
    --only-phase=provision) ONLY_PHASE="provision" ;;
    --only-phase=both) ONLY_PHASE="both" ;;
    --skip-backup-check) SKIP_BACKUP=true ;;
    --include-archived-frozen) INCLUDE_ARCHIVED_FROZEN=true ;;
    --force-confirm) FORCE_CONFIRM=true ;;
    --audit-log-file=*) AUDIT_LOG_FILE="${arg#*=}" ;;
    --help|-h)
      echo "Usage: bash scripts/reset-all-tenants.sh [--apply] [--only-phase=drop|provision|both]"
      echo "                                          [--skip-backup-check] [--include-archived-frozen]"
      echo "                                          [--force-confirm] [--audit-log-file=PATH]"
      echo ""
      echo "ENV:"
      echo "  ALLOW_PRODUCTION_RESET=true  生产 host 守门跳过（F13 修复）"
      echo "  PG_DB=edu PG_USER_OS=postgres API_BASE=http://localhost:3001"
      exit 0
      ;;
    *) echo "[warn] unknown arg: $arg" ;;
  esac
done

# ===== 颜色日志（与 backfill-v44.sh 一致）=====
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

# ===== Banner =====
echo ""
echo "==============================================="
printf "${C_BOLD}  Day 1 T2a: reset-all-tenants${C_RESET}\n"
echo "==============================================="
echo ""
if [ "$APPLY" = false ]; then
  warn "DRY-RUN mode（默认）— 加 --apply 才会真执行"
else
  info "APPLY mode — 真执行"
fi
info "PG_DB=$PG_DB  PG_USER_OS=$PG_USER_OS  API_BASE=$API_BASE"
info "ONLY_PHASE=$ONLY_PHASE  SKIP_BACKUP=$SKIP_BACKUP  INCLUDE_ARCHIVED_FROZEN=$INCLUDE_ARCHIVED_FROZEN"
echo ""

# ===== F13: 生产 host 守门（防生产事故）=====
# 检查环境变量 ALLOW_PRODUCTION_RESET=true 显式 opt-in 才允许在生产 host 跑
if [ "$APPLY" = true ]; then
  CURRENT_HOST=$(hostname 2>/dev/null || echo "unknown")
  if [ "${ALLOW_PRODUCTION_RESET:-false}" != "true" ]; then
    if echo "$CURRENT_HOST" | grep -qiE "prod|production|vm-0-2-ubuntu"; then
      fail "DANGER: 检测到在生产 host '$CURRENT_HOST' 上跑 --apply"
      fail "必须显式传 ALLOW_PRODUCTION_RESET=true 才能继续（防误触）"
      note "示例：ALLOW_PRODUCTION_RESET=true bash scripts/reset-all-tenants.sh --apply"
      exit 1
    fi
    ok "生产 host 守门通过（host=$CURRENT_HOST，未匹配 prod/production/vm-0-2-ubuntu）"
  else
    warn "ALLOW_PRODUCTION_RESET=true 已显式 opt-in（host=$CURRENT_HOST）"
  fi
fi

# ===== 前置检查 =====
# dry-run 模式允许缺 psql（dev 机器没 PG），只验证脚本流程；--apply 强制要 psql
if ! command -v psql >/dev/null 2>&1; then
  if [ "$APPLY" = true ]; then
    fail "psql 未安装"
    exit 2
  else
    warn "psql 未安装（dry-run 跳过；--apply 必须 psql）"
  fi
else
  ok "psql 已就绪"
fi

if ! command -v curl >/dev/null 2>&1; then
  fail "curl 未安装"
  exit 2
fi
ok "curl 已就绪"

if ! command -v node >/dev/null 2>&1; then
  fail "node 未安装（用于 ULID 生成）"
  exit 2
fi
ok "node 已就绪"

# 验证 API_BASE 可达（只在 provision 阶段需要）
if [ "$ONLY_PHASE" != "drop" ] && [ "$APPLY" = true ]; then
  if ! curl -sS --max-time 5 -o /dev/null -w "%{http_code}" "${API_BASE}/api/public/db/ping" 2>/dev/null | grep -q "200"; then
    fail "API_BASE=${API_BASE} 不可达（GET /api/public/db/ping !== 200）"
    note "确认 nest server 已启动：cd $REPO_ROOT && pnpm start:dev"
    exit 2
  fi
  ok "API_BASE=${API_BASE} 可达"
fi

mkdir -p "$SEED_DIR"

# ===== F8: 预分配 mktemp tmpfile + trap cleanup（防 /tmp/provision-resp.json race + 残留）=====
TMP_BODY=""
TMP_RESP=""
cleanup_tmpfiles() {
  rm -f "$TMP_BODY" "$TMP_RESP" 2>/dev/null || true
}
trap cleanup_tmpfiles EXIT INT TERM

# ===== F2: audit log 文件初始化（DROP/TRUNCATE 平台级操作落地审计 trail）=====
# 调查：V33 audit_log 在 tenant_<id>.audit_log（per-tenant），不在 public（查 migrations/V33__audit_log_in_tenant_schema.sql:25 `SET LOCAL search_path = __TENANT_SCHEMA__, public;`）
# Clean-slate 会 DROP 所有 tenant schema，无法记 tenant_xxx.audit_log → 文件持久化主路径 + Sprint Y 后切 public.platform_admin_audit_log 表
# 双轨：
#   1. 主：文件 ~/edu-clean-slate-audit.log（永远写得到，pg 下线/断网/sudo 失败都行）
#   2. 副：public.platform_admin_audit_log 表（如表已存在）— Sprint Y 后才有此表
if [ -z "$AUDIT_LOG_FILE" ]; then
  AUDIT_LOG_FILE="${HOME}/edu-clean-slate-audit.log"
fi

audit_log_entry() {
  local action="$1"; shift
  local detail="${1:-}"
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local actor="$(whoami)@$(hostname 2>/dev/null || echo unknown)"
  if [ "$APPLY" = true ]; then
    # 主路径：写文件（绝不抛错）
    {
      echo "[$ts] action=$action actor=$actor pg_db=$PG_DB only_phase=$ONLY_PHASE include_archived_frozen=$INCLUDE_ARCHIVED_FROZEN $detail"
    } >> "$AUDIT_LOG_FILE" 2>/dev/null || warn "audit_log 写文件 $AUDIT_LOG_FILE 失败（继续）"

    # 副路径：尝试 INSERT public.platform_admin_audit_log（Sprint Y 表，未来兼容）
    # 用 IF EXISTS DO 块避免表不存在时报错；详细 SQL 在 DO 块中
    if command -v psql >/dev/null 2>&1; then
      sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=0 -c "
        DO \$\$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public'
               AND table_name = 'platform_admin_audit_log'
          ) THEN
            INSERT INTO public.platform_admin_audit_log (action, actor, detail, created_at)
            VALUES ('$action', '$actor', '$(echo "$detail" | sed "s/'/''/g")'::text, NOW());
          END IF;
        END \$\$;
      " >/dev/null 2>&1 || true  # 静默失败，文件 trail 是 SSOT
    fi
  fi
}

# ===== F1: typed confirmation（防误触 DROP 全部 tenant + TRUNCATE public）=====
# 仅在 --apply + 含 drop phase（both 或 drop）时触发；--force-confirm 跳过（CI 用）
if [ "$APPLY" = true ] && [ "$ONLY_PHASE" != "provision" ]; then
  echo ""
  warn "================================================================"
  warn "  DANGER: 即将 DROP 所有 tenant_* schemas + TRUNCATE 6 public 核心表"
  warn "  目标 host:    $(hostname 2>/dev/null || echo unknown)"
  warn "  目标 PG_DB:   $PG_DB"
  warn "  操作人:       $(whoami)"
  warn "  操作时间:     $(date)"
  warn "================================================================"

  if [ "$FORCE_CONFIRM" = true ]; then
    warn "--force-confirm 已传，跳过交互（CI 模式）— 已审计落地"
    audit_log_entry "CLEAN_SLATE_RESET_CONFIRM_BYPASS" "via_force_confirm=true"
  else
    printf "${C_RED}请输入 'DROP ALL TENANTS' 确认（大小写敏感，3 单词）: ${C_RESET}"
    read -r CONFIRM_TEXT
    if [ "$CONFIRM_TEXT" != "DROP ALL TENANTS" ]; then
      fail "确认字符串不匹配（got: \"${CONFIRM_TEXT:-empty}\"）— abort"
      audit_log_entry "CLEAN_SLATE_RESET_ABORT" "reason=confirmation_mismatch got=\"${CONFIRM_TEXT:0:20}\""
      exit 1
    fi
    ok "确认通过"
    audit_log_entry "CLEAN_SLATE_RESET_CONFIRMED" "via_typed_confirm=true"
  fi

  # 记录 pre-drop 状态（snapshot tenant_count）
  if command -v psql >/dev/null 2>&1; then
    PRE_TENANT_COUNT=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -t -A -c "SELECT count(*) FROM public.tenants" 2>/dev/null | tr -d ' ' || echo "0")
    audit_log_entry "CLEAN_SLATE_RESET_PRE_DROP" "tenant_count=${PRE_TENANT_COUNT}"
  fi

  # 提示 PM2
  warn "建议先停 pm2 防止 pg_terminate_backend 后立即被 pm2 cluster 重连接管："
  note "  ssh pdfserver 'pm2 stop edu-api'  → 跑完 reset 再 pm2 start edu-api"
fi

echo ""

# ============================================================
# Phase 1: DROP all tenant_* schemas + TRUNCATE public 核心表
# ============================================================
if [ "$ONLY_PHASE" = "drop" ] || [ "$ONLY_PHASE" = "both" ]; then
  echo "==============================================="
  printf "${C_BOLD}  Phase 1: DROP + TRUNCATE${C_RESET}\n"
  echo "==============================================="
  echo ""

  # ----- pg_dump 备份 -----
  if [ "$SKIP_BACKUP" = false ] && [ "$APPLY" = true ]; then
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    DUMP_PATH="${HOME}/dump-pre-reset-${TIMESTAMP}.dump"
    info "pg_dump 全库备份 → $DUMP_PATH"
    # 用 stdout 重定向避免 postgres user 没权限写 ubuntu home
    if sudo -u "$PG_USER_OS" pg_dump --format=custom --no-owner --no-acl -d "$PG_DB" > "$DUMP_PATH" 2>/dev/null; then
      DUMP_SIZE=$(du -h "$DUMP_PATH" 2>/dev/null | awk '{print $1}')
      ok "备份完成 ($DUMP_SIZE)"
    else
      fail "pg_dump 失败 — 加 --skip-backup-check 跳过（紧急用）"
      exit 1
    fi
  elif [ "$SKIP_BACKUP" = true ]; then
    warn "跳过 pg_dump 备份（--skip-backup-check）"
  fi

  # ----- 列所有 tenant_id（含 demo-* 和测试 tenant）-----
  if [ "$APPLY" = false ] && ! command -v psql >/dev/null 2>&1; then
    warn "[dry-run + no psql] 跳过 tenants 列表查询，直接到 provision"
    TENANT_LIST=""
    TENANT_COUNT=0
  else
    info "查询 public.tenants 列表..."
    TENANT_LIST=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -t -A -F '|' \
      -c "SELECT id, name FROM public.tenants ORDER BY created_at ASC" 2>/dev/null || true)

    if [ -z "$TENANT_LIST" ]; then
      warn "未找到 tenants（public.tenants 为空）"
      TENANT_COUNT=0
    else
      TENANT_COUNT=$(echo "$TENANT_LIST" | wc -l | tr -d ' ')
      ok "找到 $TENANT_COUNT 个 tenant"
    fi
  fi
  echo ""

  # ----- F4: TENANT_ID 白名单 regex（防 DROP SCHEMA injection / 异常字符）-----
  # 规则：lowercase alphanumeric + underscore (mxedu_<num> 兼容老 id)，长度 8-64
  validate_tenant_id_lc() {
    local id_lc="$1"
    echo "$id_lc" | grep -qE '^[a-z0-9_]{8,64}$'
  }
  validate_orphan_schema() {
    # schema 名形如 tenant_<id>，剥掉 prefix 后校验 id
    local schema="$1"
    local id_part
    id_part=$(echo "$schema" | sed 's/^tenant_//')
    if [ "$id_part" = "$schema" ]; then
      return 1  # 没有 tenant_ 前缀，不是孤立 tenant schema
    fi
    validate_tenant_id_lc "$id_part"
  }

  # ----- DROP SCHEMA loop -----
  DROPPED=0
  DROP_FAILED=0
  if [ "$TENANT_COUNT" -gt 0 ]; then
    while IFS='|' read -r TENANT_ID TENANT_NAME; do
      [ -z "$TENANT_ID" ] && continue
      TENANT_ID_LC=$(echo "$TENANT_ID" | tr '[:upper:]' '[:lower:]')

      # F4: 白名单校验（不通过 → SKIP + 记 fail）
      if ! validate_tenant_id_lc "$TENANT_ID_LC"; then
        warn "SKIP DROP: tenant_id 含非法字符 (前 20 字符: ${TENANT_ID:0:20})"
        audit_log_entry "CLEAN_SLATE_DROP_SKIP" "tenant_id_prefix=${TENANT_ID:0:8} reason=whitelist_fail"
        DROP_FAILED=$((DROP_FAILED + 1))
        continue
      fi
      TENANT_SCHEMA="tenant_${TENANT_ID_LC}"
      printf "${C_GRAY}---${C_RESET} %s (%s...)\n" "$TENANT_NAME" "${TENANT_ID:0:8}"
      if [ "$APPLY" = false ]; then
        info "[dry-run] would DROP SCHEMA $TENANT_SCHEMA CASCADE"
        DROPPED=$((DROPPED + 1))
      else
        # F9: 先终止活跃连接（pm2 cluster 可能持锁，DROP CASCADE 会被 hang）
        # 注意：connection 终止只是 hint，pm2 cluster 会自动重连 → 见 banner 提示先 pm2 stop
        sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=0 -c "
          SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
           WHERE datname = current_database()
             AND application_name NOT LIKE 'reset-all-tenants%'
             AND pid <> pg_backend_pid()
             AND (query ILIKE '%${TENANT_SCHEMA}.%' OR query ILIKE '%${TENANT_SCHEMA}\"%');
        " >/dev/null 2>&1 || warn "pg_terminate_backend $TENANT_SCHEMA 失败但继续"

        if sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 \
             -c "DROP SCHEMA IF EXISTS ${TENANT_SCHEMA} CASCADE" >/dev/null 2>&1; then
          ok "DROP SCHEMA $TENANT_SCHEMA"
          DROPPED=$((DROPPED + 1))
          audit_log_entry "CLEAN_SLATE_DROP_OK" "tenant_id=${TENANT_ID} schema=${TENANT_SCHEMA}"
        else
          fail "DROP SCHEMA $TENANT_SCHEMA 失败（活跃连接可能未释放，确认 pm2 stop edu-api 后重跑）"
          DROP_FAILED=$((DROP_FAILED + 1))
          audit_log_entry "CLEAN_SLATE_DROP_FAIL" "tenant_id=${TENANT_ID} schema=${TENANT_SCHEMA}"
        fi
      fi
    done <<< "$TENANT_LIST"
  fi
  echo ""

  # ----- 额外清理：可能还有非 public.tenants 注册过的孤立 tenant_* schema -----
  ORPHAN_COUNT=0
  if [ "$APPLY" = false ] && ! command -v psql >/dev/null 2>&1; then
    note "[dry-run + no psql] 跳过孤立 schema 扫描"
    ORPHAN_SCHEMAS=""
  else
    info "扫描孤立 tenant_* schema（不在 public.tenants 但 schema 存在）..."
    ORPHAN_SCHEMAS=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -t -A -c \
      "SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant\_%' ESCAPE '\\'
        ORDER BY schema_name" 2>/dev/null || true)
  fi
  if [ -n "$ORPHAN_SCHEMAS" ]; then
    while IFS= read -r SCHEMA; do
      [ -z "$SCHEMA" ] && continue

      # F4: 孤立 schema 也走白名单校验（防 schema 名异常字符）
      if ! validate_orphan_schema "$SCHEMA"; then
        warn "SKIP 孤立 schema: 名称含非法字符 (${SCHEMA:0:30})"
        audit_log_entry "CLEAN_SLATE_ORPHAN_SKIP" "schema=${SCHEMA:0:30} reason=whitelist_fail"
        continue
      fi

      printf "${C_GRAY}---${C_RESET} 孤立 schema: %s\n" "$SCHEMA"
      if [ "$APPLY" = false ]; then
        info "[dry-run] would DROP SCHEMA $SCHEMA CASCADE"
      else
        # F9: 同样先终止该 schema 上的活跃连接
        sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=0 -c "
          SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
           WHERE datname = current_database()
             AND application_name NOT LIKE 'reset-all-tenants%'
             AND pid <> pg_backend_pid()
             AND (query ILIKE '%${SCHEMA}.%' OR query ILIKE '%${SCHEMA}\"%');
        " >/dev/null 2>&1 || true

        if sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 \
             -c "DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE" >/dev/null 2>&1; then
          ok "DROP 孤立 schema $SCHEMA"
          audit_log_entry "CLEAN_SLATE_ORPHAN_OK" "schema=${SCHEMA}"
        else
          warn "DROP 孤立 schema $SCHEMA 失败"
          audit_log_entry "CLEAN_SLATE_ORPHAN_FAIL" "schema=${SCHEMA}"
        fi
      fi
      ORPHAN_COUNT=$((ORPHAN_COUNT + 1))
    done <<< "$ORPHAN_SCHEMAS"
  fi
  if [ "$ORPHAN_COUNT" -gt 0 ]; then
    info "处理孤立 schema $ORPHAN_COUNT 个"
  fi
  echo ""

  # ----- TRUNCATE public 核心表 -----
  # 顺序：先 child（FK depend）再 parent；CASCADE 兜底
  # 6 张表：
  #   parent_student_bindings (FK → parents + tenants)
  #   parent_payment_orders   (FK → parents + parent_subscriptions)
  #   parent_subscriptions    (FK → parents)
  #   refresh_tokens          (独立)
  #   parents                 (root)
  #   tenants                 (root) — 最后，触发 FK cascade 清 public.campuses 等
  info "TRUNCATE public 核心表（CASCADE）..."
  TRUNCATE_TABLES=(
    "public.parent_student_bindings"
    "public.parent_payment_orders"
    "public.parent_subscriptions"
    "public.refresh_tokens"
    "public.parents"
    "public.tenants"
  )
  for T in "${TRUNCATE_TABLES[@]}"; do
    if [ "$APPLY" = false ]; then
      info "[dry-run] would TRUNCATE ${T} CASCADE"
    else
      # 表可能不存在（V43 之前的部署）→ ON_ERROR_STOP=0 + check exists
      EXISTS=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -t -A -c \
        "SELECT 1 FROM information_schema.tables
          WHERE table_schema = split_part('${T}', '.', 1)
            AND table_name = split_part('${T}', '.', 2)" 2>/dev/null || true)
      if [ -z "$EXISTS" ]; then
        warn "表 ${T} 不存在，SKIP"
        continue
      fi
      if sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 \
           -c "TRUNCATE ${T} CASCADE" >/dev/null 2>&1; then
        ok "TRUNCATE ${T} CASCADE"
      else
        fail "TRUNCATE ${T} 失败"
      fi
    fi
  done
  echo ""

  printf "${C_BOLD}Phase 1 Summary:${C_RESET}\n"
  printf "  ${C_GREEN}Dropped${C_RESET}: %d schema (%d in tenants + %d orphan)\n" \
    "$((DROPPED + ORPHAN_COUNT))" "$DROPPED" "$ORPHAN_COUNT"
  printf "  ${C_RED}Failed${C_RESET}:  %d\n" "$DROP_FAILED"
  echo ""
fi

# ============================================================
# Phase 2: 调 POST /api/public/onboarding/provision-tenant 建 15 demo tenant
# ============================================================
if [ "$ONLY_PHASE" = "provision" ] || [ "$ONLY_PHASE" = "both" ]; then
  echo "==============================================="
  printf "${C_BOLD}  Phase 2: Provision 15 demo tenants${C_RESET}\n"
  echo "==============================================="
  echo ""

  # ----- 15 demo tenant 规格（来自 architect spec §3.1 表 + leader D1.1 拍板）-----
  # 列：logical_name | sku | campuses_count | admin_phone | needs_v49
  # needs_v49=1 表示 demo-14/demo-15 (archived/frozen)，依赖 V49 已落地
  DEMO_TENANTS=(
    "demo-empty|trial|1|13800001001|0"
    "demo-admin-multi-campus|school_pro|3|13800001002|0"
    "demo-boss-single|standard_1999|1|13800001003|0"
    "demo-sales-active|standard_1999|1|13800001004|0"
    "demo-academic-busy|standard_1999|1|13800001005|0"
    "demo-teacher-rated|standard_1999|1|13800001006|0"
    "demo-parent-single|trial|1|13800001007|0"
    "demo-parent-multi-tenant|trial|1|13800001008|0"
    "demo-finance-invoice|standard_1999|1|13800001009|0"
    "demo-hr|standard_1999|1|13800001010|0"
    "demo-marketing|standard_1999|1|13800001011|0"
    "demo-edge-case|standard_1999|1|13800001012|0"
    "demo-large-scale|school_pro|2|13800001013|0"
    "demo-archived|standard_1999|1|13800001014|1"
    "demo-frozen|standard_1999|1|13800001015|1"
  )

  # 标准 demo 密码（所有 admin 统一，便于 smoke + e2e）
  DEMO_ADMIN_PASSWORD="Demo@12345"

  # 校区名称模板：每 tenant 第 i 个 campus 命名「<demo-name> 校区 i」
  # demo-admin-multi-campus 特殊：北校区 / 南校区 / 东校区

  # 启动 demo-users.json：空数组
  if [ "$APPLY" = true ]; then
    echo "[]" > "$DEMO_USERS_FILE"
    ok "初始化 $DEMO_USERS_FILE"
  fi

  # ----- 检查 V49 状态（如有需要 archived/frozen tenant）-----
  V49_OK=false
  if [ "$INCLUDE_ARCHIVED_FROZEN" = true ]; then
    V49_CHECK=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -t -A -c \
      "SELECT pg_get_constraintdef(c.oid)
         FROM pg_constraint c
         JOIN pg_class t ON c.conrelid = t.oid
         JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = 'public'
          AND t.relname = 'tenants'
          AND c.conname = 'tenants_subscription_status_check'" 2>/dev/null || true)
    if echo "$V49_CHECK" | grep -q "archived"; then
      V49_OK=true
      ok "V49 已落地 — CHECK 接受 archived/frozen"
    else
      warn "V49 未落地 — demo-archived / demo-frozen 将 SKIP"
      note "可先跑：sudo -u $PG_USER_OS psql -d $PG_DB -f migrations/V49__expand_subscription_status_check.sql"
    fi
  fi

  echo ""

  # ----- 循环 provision -----
  PROVISION_SUCCESS=0
  PROVISION_FAILED=0
  PROVISION_SKIPPED=0
  declare -a PROVISION_RESULTS=()

  for SPEC in "${DEMO_TENANTS[@]}"; do
    IFS='|' read -r LOGICAL_NAME SKU CAMPUSES_COUNT ADMIN_PHONE NEEDS_V49 <<< "$SPEC"
    printf "${C_GRAY}---${C_RESET} %s\n" "$LOGICAL_NAME"

    # ===== SKIP archived/frozen 如未指定 --include-archived-frozen 或 V49 未落地 =====
    if [ "$NEEDS_V49" = "1" ]; then
      if [ "$INCLUDE_ARCHIVED_FROZEN" = false ]; then
        warn "SKIP $LOGICAL_NAME — 加 --include-archived-frozen 才会建（要求 V49 已落地）"
        PROVISION_SKIPPED=$((PROVISION_SKIPPED + 1))
        PROVISION_RESULTS+=("SKIP|${LOGICAL_NAME}|reason=no-include-archived-frozen")
        continue
      fi
      if [ "$V49_OK" = false ]; then
        warn "SKIP $LOGICAL_NAME — V49 未落地"
        PROVISION_SKIPPED=$((PROVISION_SKIPPED + 1))
        PROVISION_RESULTS+=("SKIP|${LOGICAL_NAME}|reason=V49-missing")
        continue
      fi
    fi

    # ===== 生成 tenantId (32-char) =====
    TENANT_ID=$(node -e "
      const t = Date.now().toString(36).padStart(10, '0');
      let rand = '';
      while (rand.length < 22) rand += Math.random().toString(36).slice(2);
      console.log((t + rand).slice(0, 32));
    " 2>/dev/null)

    if [ -z "$TENANT_ID" ] || [ ${#TENANT_ID} -ne 32 ]; then
      fail "无法生成 32-char tenantId for $LOGICAL_NAME"
      PROVISION_FAILED=$((PROVISION_FAILED + 1))
      PROVISION_RESULTS+=("FAIL|${LOGICAL_NAME}|reason=ulid-gen-failed")
      continue
    fi

    # ===== 生成 campuses 数组 JSON =====
    # demo-admin-multi-campus 用「北/南/东」；其他用「<name> 校区 N」
    CAMPUSES_JSON=$(node -e "
      const names = ${CAMPUSES_COUNT} === 3 && '${LOGICAL_NAME}' === 'demo-admin-multi-campus'
        ? ['北校区', '南校区', '东校区']
        : Array.from({length: ${CAMPUSES_COUNT}}, (_, i) => '${LOGICAL_NAME} 校区' + (i + 1));
      const campuses = names.map((name) => {
        const t = Date.now().toString(36).padStart(10, '0');
        let rand = '';
        while (rand.length < 22) rand += Math.random().toString(36).slice(2);
        const id = (t + rand).slice(0, 32);
        const addr = '重庆市 demo 地址 ' + name;
        return { id, name, address: addr, courseLines: '语文,数学,英语' };
      });
      console.log(JSON.stringify(campuses));
    " 2>/dev/null)

    if [ -z "$CAMPUSES_JSON" ]; then
      fail "无法生成 campuses JSON for $LOGICAL_NAME"
      PROVISION_FAILED=$((PROVISION_FAILED + 1))
      PROVISION_RESULTS+=("FAIL|${LOGICAL_NAME}|reason=campuses-json-failed")
      continue
    fi

    # ===== 构造 provision body =====
    PROVISION_BODY=$(node -e "
      const body = {
        tenantId: '${TENANT_ID}',
        name: '${LOGICAL_NAME}',
        sku: '${SKU}',
        campuses: ${CAMPUSES_JSON},
        adminName: 'demo-admin-${LOGICAL_NAME}',
        adminPhone: '${ADMIN_PHONE}',
        adminEmail: '${LOGICAL_NAME}@demo.local',
        adminPassword: '${DEMO_ADMIN_PASSWORD}',
      };
      console.log(JSON.stringify(body));
    " 2>/dev/null)

    if [ "$APPLY" = false ]; then
      info "[dry-run] would POST /api/public/onboarding/provision-tenant"
      info "          tenantId=${TENANT_ID:0:8}... sku=${SKU} campuses=${CAMPUSES_COUNT} phone=${ADMIN_PHONE}"
      PROVISION_SUCCESS=$((PROVISION_SUCCESS + 1))
      PROVISION_RESULTS+=("OK|${LOGICAL_NAME}|tenantId=${TENANT_ID}|dry-run")
      continue
    fi

    # ===== 真调 HTTP POST =====
    # F11: throttle 用「总请求数」触发 sleep（含 fail/skip）— 之前用 PROVISION_SUCCESS off-by-one
    # 实际 throttle 算 IP 上所有 5xx + 4xx，每 4 个请求强制 sleep 65s 防 5/min/IP
    PROVISION_TOTAL=$((PROVISION_SUCCESS + PROVISION_FAILED + PROVISION_SKIPPED))
    if [ "$PROVISION_TOTAL" -gt 0 ] && [ $((PROVISION_TOTAL % 4)) -eq 0 ]; then
      info "throttle 防护（已请求 $PROVISION_TOTAL 次）：等 65s 防 5/min/IP limit..."
      sleep 65
    fi

    # F8: mktemp 双 tmpfile + trap cleanup（已在文件顶部 trap 注册）
    # 防 /tmp/provision-resp.json 并发 race（其他 reset 跑同名文件覆盖响应体）
    TMP_BODY=$(mktemp /tmp/provision-body.XXXXXX.json)
    TMP_RESP=$(mktemp /tmp/provision-resp.XXXXXX.json)

    echo "$PROVISION_BODY" > "$TMP_BODY"

    HTTP_CODE=$(curl -sS --max-time 60 \
      -o "$TMP_RESP" \
      -w "%{http_code}" \
      -X POST \
      -H "Content-Type: application/json" \
      --data-binary @"$TMP_BODY" \
      "${API_BASE}/api/public/onboarding/provision-tenant" 2>/dev/null || echo "000")

    if [ "$HTTP_CODE" != "201" ]; then
      RESP_BODY=$(cat "$TMP_RESP" 2>/dev/null | head -c 500 || echo "")
      fail "provision $LOGICAL_NAME failed: HTTP $HTTP_CODE"
      note "response: $RESP_BODY"
      PROVISION_FAILED=$((PROVISION_FAILED + 1))
      PROVISION_RESULTS+=("FAIL|${LOGICAL_NAME}|HTTP=${HTTP_CODE}|resp=$(echo "$RESP_BODY" | tr '\n' ' ' | head -c 200)")
      audit_log_entry "CLEAN_SLATE_PROVISION_FAIL" "logical=${LOGICAL_NAME} tenant_id=${TENANT_ID} http=${HTTP_CODE}"
      # tmpfile 不立即 rm（trap 兜底）— 复用 $TMP_BODY / $TMP_RESP 变量到下一轮 mktemp 即可
      continue
    fi

    # ===== 解析 response 取 tenantSchema + accessToken =====
    TENANT_SCHEMA=$(node -e "
      const r = require('${TMP_RESP}');
      console.log(r.tenantSchema || '');
    " 2>/dev/null)

    MIGRATIONS_COUNT=$(node -e "
      const r = require('${TMP_RESP}');
      console.log((r.ranMigrations || []).length);
    " 2>/dev/null)

    CAMPUS_IDS_JSON=$(node -e "
      const r = require('${TMP_RESP}');
      console.log(JSON.stringify(r.campusIds || []));
    " 2>/dev/null)

    ADMIN_USER_ID=$(node -e "
      const r = require('${TMP_RESP}');
      console.log(r.adminUserId || '');
    " 2>/dev/null)

    # ===== 写入 demo-users.json =====
    # JSON 数组追加：read-modify-write
    node -e "
      const fs = require('fs');
      const path = '${DEMO_USERS_FILE}';
      const arr = JSON.parse(fs.readFileSync(path, 'utf-8'));
      arr.push({
        logicalName: '${LOGICAL_NAME}',
        tenantId: '${TENANT_ID}',
        tenantSchema: '${TENANT_SCHEMA}',
        sku: '${SKU}',
        campusIds: ${CAMPUS_IDS_JSON},
        admin: {
          userId: '${ADMIN_USER_ID}',
          name: 'demo-admin-${LOGICAL_NAME}',
          phone: '${ADMIN_PHONE}',
          password: '${DEMO_ADMIN_PASSWORD}',
          email: '${LOGICAL_NAME}@demo.local',
        },
        provisionedAt: new Date().toISOString(),
      });
      fs.writeFileSync(path, JSON.stringify(arr, null, 2));
    " 2>/dev/null

    ok "$LOGICAL_NAME provisioned: schema=${TENANT_SCHEMA:0:15}... migrations=${MIGRATIONS_COUNT}"
    PROVISION_SUCCESS=$((PROVISION_SUCCESS + 1))
    PROVISION_RESULTS+=("OK|${LOGICAL_NAME}|tenantId=${TENANT_ID}|migrations=${MIGRATIONS_COUNT}")
    audit_log_entry "CLEAN_SLATE_PROVISION_OK" "logical=${LOGICAL_NAME} tenant_id=${TENANT_ID} schema=${TENANT_SCHEMA} sku=${SKU} migrations=${MIGRATIONS_COUNT}"

    # ===== 特殊处理：archived/frozen UPDATE public.tenants.subscription_status =====
    if [ "$LOGICAL_NAME" = "demo-archived" ]; then
      info "UPDATE public.tenants.subscription_status = 'archived' for demo-archived"
      sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 \
        -c "UPDATE public.tenants SET subscription_status='archived' WHERE id='${TENANT_ID}'" \
        >/dev/null 2>&1 || warn "UPDATE archived failed (V49 not applied?)"
      audit_log_entry "CLEAN_SLATE_PROVISION_SET_ARCHIVED" "tenant_id=${TENANT_ID}"
    elif [ "$LOGICAL_NAME" = "demo-frozen" ]; then
      info "UPDATE public.tenants.subscription_status = 'frozen' AND status='已冻结' for demo-frozen"
      sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 \
        -c "UPDATE public.tenants SET subscription_status='frozen', status='已冻结' WHERE id='${TENANT_ID}'" \
        >/dev/null 2>&1 || warn "UPDATE frozen failed (V49 not applied?)"
      audit_log_entry "CLEAN_SLATE_PROVISION_SET_FROZEN" "tenant_id=${TENANT_ID}"
    fi
  done

  echo ""
  printf "${C_BOLD}Phase 2 Summary:${C_RESET}\n"
  printf "  ${C_GREEN}Success${C_RESET}: %d\n" "$PROVISION_SUCCESS"
  printf "  ${C_YELLOW}Skipped${C_RESET}: %d (archived/frozen 未启用)\n" "$PROVISION_SKIPPED"
  printf "  ${C_RED}Failed${C_RESET}:  %d\n" "$PROVISION_FAILED"
  echo ""

  printf "${C_BOLD}详细：${C_RESET}\n"
  for R in "${PROVISION_RESULTS[@]}"; do
    echo "  $R"
  done
  echo ""
fi

# ============================================================
# 总 Summary
# ============================================================
echo "==============================================="
printf "${C_BOLD}  总体 Summary${C_RESET}\n"
echo "==============================================="
if [ "$APPLY" = false ]; then
  warn "DRY-RUN 已完成 — 加 --apply 真执行"
  exit 0
fi

ERRORS=0
if [ "$ONLY_PHASE" = "drop" ] || [ "$ONLY_PHASE" = "both" ]; then
  if [ "$DROP_FAILED" -gt 0 ]; then
    ERRORS=$((ERRORS + DROP_FAILED))
  fi
fi
if [ "$ONLY_PHASE" = "provision" ] || [ "$ONLY_PHASE" = "both" ]; then
  if [ "$PROVISION_FAILED" -gt 0 ]; then
    ERRORS=$((ERRORS + PROVISION_FAILED))
  fi
fi

if [ "$ERRORS" -gt 0 ]; then
  fail "部分操作失败，回查日志（共 $ERRORS 项）"
  audit_log_entry "CLEAN_SLATE_RESET_FINAL_FAIL" "errors=${ERRORS}"
  note "audit trail: $AUDIT_LOG_FILE"
  exit 1
fi

ok "全部完成 — 0 error"
audit_log_entry "CLEAN_SLATE_RESET_FINAL_OK" "drop_ok=${DROPPED:-0} provision_ok=${PROVISION_SUCCESS:-0} skipped=${PROVISION_SKIPPED:-0}"
note "audit trail: $AUDIT_LOG_FILE"
if [ "$ONLY_PHASE" != "drop" ]; then
  note "下一步：bash scripts/seed-demo-data.sh --apply 灌业务数据"
  note "demo-users.json: $DEMO_USERS_FILE"
fi
echo ""
