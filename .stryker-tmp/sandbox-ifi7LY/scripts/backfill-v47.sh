#!/bin/bash
# ============================================================
# backfill-v47.sh — V47 public.parents.status 中文化（单次执行）
#
# 来源：Sprint X.2 (2026-05-17) — SSOT §12.6 失效逻辑统一中文 status
#       用户拍板 D9「parents.status 完全切中文 backfill active→启用 / suspended,deleted→停用」
#
# 与 V46 不同：V47 在 public schema (跨租户共享 parents 表), 单次执行不需逐 tenant 循环
#       (参考 V43 refresh_tokens 同模式 — public schema 单次 migration)
#
# 用法：
#   # 1. dry-run（默认）
#   bash scripts/backfill-v47.sh
#
#   # 2. 真执行
#   bash scripts/backfill-v47.sh --apply
#
# 幂等：UPDATE 用 WHERE 旧 enum 值 → 重跑时旧 enum 已无 row → UPDATE 0 行
#       DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT 通过事务保证原子性
#
# 出具：edu-server backend  2026-05-17
# ============================================================

set -euo pipefail

PG_DB="${PG_DB:-edu}"
PG_USER_OS="${PG_USER_OS:-postgres}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_FILE="${REPO_ROOT}/migrations/V47__parents_status_chinese.sql"

APPLY=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    *) echo "[warn] unknown arg: $arg" ;;
  esac
done

C_GREEN='\033[32m'
C_RED='\033[31m'
C_YELLOW='\033[33m'
C_CYAN='\033[36m'
C_RESET='\033[0m'

ok()   { printf "${C_GREEN}OK${C_RESET}    %s\n" "$1"; }
fail() { printf "${C_RED}FAIL${C_RESET}  %s\n" "$1"; }
warn() { printf "${C_YELLOW}WARN${C_RESET}  %s\n" "$1"; }
info() { printf "${C_CYAN}INFO${C_RESET}  %s\n" "$1"; }

echo ""
echo "==============================================="
echo "  V47 parents.status 中文化 (public schema)"
echo "==============================================="
echo ""
if [ "$APPLY" = false ]; then
  warn "DRY-RUN mode（默认）— 加 --apply 才会真执行"
else
  info "APPLY mode — 真执行"
fi
echo ""

if [ ! -f "$MIGRATION_FILE" ]; then
  fail "migration file 不存在: $MIGRATION_FILE"
  exit 1
fi
ok "migration file: $MIGRATION_FILE"
echo ""

# pre-check: 先看 status 分布
info "改造前 status 分布："
sudo -u "$PG_USER_OS" psql -d "$PG_DB" -c \
  "SELECT status, COUNT(*) AS rows FROM public.parents GROUP BY status ORDER BY status;" || true
echo ""

if [ "$APPLY" = false ]; then
  warn "[dry-run] would run V47 (sql size: $(wc -c < "$MIGRATION_FILE") bytes)"
  warn "DRY-RUN 已完成 — 加 --apply 真执行"
  exit 0
fi

# 真执行
# 2026-05-17 fix: postgres OS 用户无法读 /home/ubuntu/...（owner 0700 dir），
#   改用 stdin pipe (cat | psql) 让 ubuntu shell 处理 IO，postgres 只读 stdin
#   (5/13 leader 学习「cat sql | sudo -u postgres psql 比 -f file 更通用」)
if cat "$MIGRATION_FILE" | sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 >/dev/null 2>&1; then
  ok "V47 applied to public.parents"
else
  fail "V47 failed"
  cat "$MIGRATION_FILE" | sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 2>&1 | tail -10
  exit 1
fi

echo ""
info "改造后 status 分布（应只剩 启用/停用）："
sudo -u "$PG_USER_OS" psql -d "$PG_DB" -c \
  "SELECT status, COUNT(*) AS rows FROM public.parents GROUP BY status ORDER BY status;" || true
echo ""
ok "V47 backfill 完成"
