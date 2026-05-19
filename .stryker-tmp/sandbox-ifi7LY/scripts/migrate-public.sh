#!/bin/bash
# ============================================================
# migrate-public.sh
#
# 职责（F3 修复 / leader D1.3 修订）：
#   未来所有 public schema migration 必须通过此 wrapper 跑
#   禁止 `psql -f V<N>.sql` 直接执行（D1.3 V49 意外部署生产事故的根因防护）
#
# 操作纪律：
#   - --dry-run：BEGIN; \i V<N>.sql; SELECT 1/0; ROLLBACK; → 强制回滚验证语法
#   - --apply ：直接 `psql -v ON_ERROR_STOP=1 -f V<N>.sql` 真跑
#
# D1.3 事件：
#   V49 SQL 内嵌 `BEGIN; ... COMMIT;` 时，外层 BEGIN 会被内层 COMMIT 接管 →
#   即使 dry-run 路径仍真提交（migration BEGIN/COMMIT 与外层冲突）
#   wrapper 解决：dry-run 用 `psql --single-transaction + 末尾 SELECT 1/0` 强制 ROLLBACK
#   注：如 migration SQL 含 BEGIN/COMMIT，wrapper dry-run 会 unwrap（提示用户改写）
#
# 用法：
#   bash scripts/migrate-public.sh --dry-run migrations/V49__expand_subscription_status_check.sql
#   bash scripts/migrate-public.sh --apply   migrations/V49__expand_subscription_status_check.sql
#
# ENV：
#   PG_DB=edu  PG_USER_OS=postgres
#
# Exit code:
#   0 = success (apply: committed / dry-run: rolled back)
#   1 = SQL 语法错误 / 约束违反 / psql 失败
#   2 = 参数错误 / 文件不存在 / migration SQL 含未 unwrap 的 BEGIN/COMMIT (dry-run only)
#
# 出具：edu-server backend Day 1 T5 修红  2026-05-19
# ============================================================

set -euo pipefail

trap 'echo "[ERR] migrate-public.sh fatal at line $LINENO" >&2; exit 1' ERR

# ---- 配置 ----
readonly PG_DB="${PG_DB:-edu}"
readonly PG_USER_OS="${PG_USER_OS:-postgres}"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- 颜色日志 ----
C_GREEN='\033[32m'
C_RED='\033[31m'
C_YELLOW='\033[33m'
C_CYAN='\033[36m'
C_BOLD='\033[1m'
C_RESET='\033[0m'

ok()   { printf "${C_GREEN}OK${C_RESET}    %s\n" "$1"; }
fail() { printf "${C_RED}FAIL${C_RESET}  %s\n" "$1"; }
warn() { printf "${C_YELLOW}WARN${C_RESET}  %s\n" "$1"; }
info() { printf "${C_CYAN}INFO${C_RESET}  %s\n" "$1"; }

# ---- 参数解析 ----
MODE=""
SQL_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --apply)   MODE="apply"; shift ;;
    -h|--help)
      grep '^#' "$0" | head -40
      exit 0
      ;;
    -*)
      fail "unknown flag: $1"
      exit 2
      ;;
    *)
      if [[ -z "$SQL_FILE" ]]; then
        SQL_FILE="$1"
      else
        fail "extra argument: $1 (only one SQL file allowed)"
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  fail "--dry-run 或 --apply 必填"
  echo "Usage: bash scripts/migrate-public.sh --dry-run|--apply <V<N>.sql>" >&2
  exit 2
fi

if [[ -z "$SQL_FILE" ]]; then
  fail "<V<N>.sql> 路径必填"
  echo "Usage: bash scripts/migrate-public.sh --dry-run|--apply <V<N>.sql>" >&2
  exit 2
fi

# 相对路径解析（基于 repo root）
if [[ "$SQL_FILE" != /* ]]; then
  SQL_FILE="${REPO_ROOT}/${SQL_FILE}"
fi

if [[ ! -f "$SQL_FILE" ]]; then
  fail "SQL 文件不存在: $SQL_FILE"
  exit 2
fi

# 验证文件名合规（V<N>__*.sql 或 V<N>_<M>__*.sql）
SQL_BASENAME=$(basename "$SQL_FILE")
if ! echo "$SQL_BASENAME" | grep -qE '^V[0-9]+(_[0-9]+)?__.*\.sql$'; then
  warn "SQL 文件名不符合 V<N>__*.sql 规范（实际: $SQL_BASENAME）— 仍继续"
fi

echo ""
echo "==============================================="
printf "${C_BOLD}  migrate-public.sh${C_RESET}\n"
echo "==============================================="
info "Mode:     $MODE"
info "SQL:      $SQL_FILE"
info "PG_DB:    $PG_DB"
info "PG_USER:  $PG_USER_OS"
echo ""

# ---- 工具检查 ----
if ! command -v psql >/dev/null 2>&1; then
  if [[ "$MODE" == "dry-run" ]]; then
    warn "psql 未安装 — 仅做 SQL 文件结构验证（不真跑 PG）"
    PSQL_AVAILABLE=false
  else
    fail "psql 未安装（--apply 必须 psql）"
    exit 2
  fi
else
  PSQL_AVAILABLE=true
fi

# ---- 检查 migration 是否含 BEGIN/COMMIT（dry-run 警告）----
# F3 关键：嵌套 BEGIN/COMMIT 会让 dry-run 提交真发生
# leader D1.3 事件：V49 内嵌 BEGIN; ... COMMIT; → 即使在外层 BEGIN 包裹仍提交
HAS_BEGIN=$(grep -ciE '^[[:space:]]*BEGIN[[:space:]]*;' "$SQL_FILE" 2>/dev/null || echo 0)
HAS_COMMIT=$(grep -ciE '^[[:space:]]*COMMIT[[:space:]]*;' "$SQL_FILE" 2>/dev/null || echo 0)

if [[ "$MODE" == "dry-run" ]] && { [[ "$HAS_BEGIN" -gt 0 ]] || [[ "$HAS_COMMIT" -gt 0 ]]; }; then
  warn "================================================================"
  warn "  migration SQL 含 BEGIN($HAS_BEGIN) / COMMIT($HAS_COMMIT) 语句"
  warn "  D1.3 事件：内嵌 BEGIN/COMMIT 会让 dry-run 提交真发生 — 危险"
  warn "================================================================"
  warn "防护策略 dry-run 转换："
  warn "  自动 strip 内嵌 BEGIN/COMMIT 仅保留 DDL/DML"
  warn "  并包裹外层 BEGIN; <stripped>; SELECT 1/0; ROLLBACK;"
  warn "  确保 SQL 语法可验证 + 一定 ROLLBACK"
  echo ""
fi

# ============================================================
# Dry-run 模式：BEGIN; <SQL stripped of internal BEGIN/COMMIT>; SELECT 1/0; ROLLBACK;
# ============================================================
if [[ "$MODE" == "dry-run" ]]; then
  info "dry-run mode — 跑 SQL 但强制 ROLLBACK"

  # 准备 stripped SQL（去内嵌 BEGIN/COMMIT 防嵌套提交）
  TMP_SQL=$(mktemp /tmp/migrate-dry-XXXXXX.sql)
  trap 'rm -f "$TMP_SQL"' EXIT INT TERM

  {
    echo "-- =========================================="
    echo "-- dry-run wrapper — 强制 ROLLBACK"
    echo "-- Source: $SQL_FILE"
    echo "-- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "-- =========================================="
    echo "BEGIN;"
    echo ""
    # strip 内嵌 BEGIN; / COMMIT; 行（避免嵌套提交）
    # 注：只 strip 顶层 BEGIN;/COMMIT;（行首可有空白），不 strip BEGIN ATOMIC（DO 块内）
    sed -E \
      -e '/^[[:space:]]*BEGIN[[:space:]]*;[[:space:]]*(--.*)?$/d' \
      -e '/^[[:space:]]*COMMIT[[:space:]]*;[[:space:]]*(--.*)?$/d' \
      "$SQL_FILE"
    echo ""
    echo "-- =========================================="
    echo "-- 强制 ROLLBACK（即使前面成功）"
    echo "-- =========================================="
    echo "DO \$\$ BEGIN RAISE EXCEPTION 'dry_run_force_rollback'; END \$\$;"
  } > "$TMP_SQL"

  info "stripped SQL → $TMP_SQL"
  info "原始 SQL 行数: $(wc -l < "$SQL_FILE" | tr -d ' ')"
  info "wrapped SQL 行数: $(wc -l < "$TMP_SQL" | tr -d ' ')"

  if [[ "$PSQL_AVAILABLE" != "true" ]]; then
    warn "psql 不可用，跳过真跑 — 仅 wrap 完成"
    cat "$TMP_SQL" | head -20
    info "(完整 wrapped SQL 见 $TMP_SQL)"
    exit 0
  fi

  # 真跑 psql — chmod 644 让 postgres user 可读（mktemp 默认 600）
  chmod 644 "$TMP_SQL"

  # 用 stdin pipe 兼容 ubuntu home 权限受限场景（参考 deploy 经验）
  PSQL_OUT=$(cat "$TMP_SQL" | sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 2>&1 || true)

  # 判定：必须包含「dry_run_force_rollback」exception → 才算成功 ROLLBACK
  if echo "$PSQL_OUT" | grep -q "dry_run_force_rollback"; then
    ok "dry-run 通过：SQL 语法 OK，已强制 ROLLBACK（无数据变更）"
    info "psql output (last 5 lines):"
    echo "$PSQL_OUT" | tail -5 | sed 's/^/      /'
    exit 0
  else
    fail "dry-run 失败：未检测到 ROLLBACK 路径（SQL 可能在前面就出错）"
    echo ""
    fail "psql output:"
    echo "$PSQL_OUT" | sed 's/^/      /'
    exit 1
  fi
fi

# ============================================================
# Apply 模式：真跑 SQL（无 wrapper，原 BEGIN/COMMIT 生效）
# ============================================================
if [[ "$MODE" == "apply" ]]; then
  warn "APPLY mode — 真执行 SQL，COMMIT 不可逆"
  echo ""

  # 双重确认（仅交互式终端）
  if [[ -t 0 ]]; then
    printf "${C_RED}请输入 'APPLY' 确认（大小写敏感）: ${C_RESET}"
    read -r CONFIRM_TEXT
    if [[ "$CONFIRM_TEXT" != "APPLY" ]]; then
      fail "确认字符串不匹配（got: \"${CONFIRM_TEXT:-empty}\"）— abort"
      exit 1
    fi
    ok "确认通过"
  else
    warn "非交互式终端 — 跳过双重确认（CI 模式）"
  fi

  # 跑 SQL 直接
  cp "$SQL_FILE" /tmp/migrate-apply-$$.sql
  TMP_APPLY="/tmp/migrate-apply-$$.sql"
  chmod 644 "$TMP_APPLY"
  trap 'rm -f "$TMP_APPLY"' EXIT INT TERM

  PSQL_OUT=$(cat "$TMP_APPLY" | sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 2>&1)
  PSQL_EXIT=$?

  if [[ "$PSQL_EXIT" -eq 0 ]]; then
    ok "apply 完成 — COMMIT 已生效"
    info "psql output (last 10 lines):"
    echo "$PSQL_OUT" | tail -10 | sed 's/^/      /'

    # 审计落地
    AUDIT_LOG_FILE="${HOME}/edu-migrate-public-audit.log"
    {
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] action=MIGRATE_PUBLIC_APPLY actor=$(whoami)@$(hostname 2>/dev/null || echo unknown) pg_db=$PG_DB sql=$SQL_BASENAME exit=0"
    } >> "$AUDIT_LOG_FILE" 2>/dev/null || true
    info "audit trail: $AUDIT_LOG_FILE"
    exit 0
  else
    fail "apply 失败 — exit=$PSQL_EXIT"
    fail "psql output:"
    echo "$PSQL_OUT" | sed 's/^/      /'
    exit 1
  fi
fi

fail "internal error: MODE=$MODE 未处理"
exit 1
