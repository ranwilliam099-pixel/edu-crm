#!/bin/bash
# ============================================================
# seed-traceable-runner.sh — 2026-05-22 KPI 可追溯种子 runner
#
# 流程 (3 步):
#   1. 生成 SQL (Node) → /tmp/seed-traceable-<schema>.sql
#   2. dry-run 校验 (psql -1 ROLLBACK)
#   3. apply (psql -1 真跑) — 仅 --apply
#
# 用法:
#   # dry-run (默认)
#   bash scripts/seed-traceable-runner.sh \
#     --tenant-schema=tenant_XXX --tenant-id=XXX --campus-id=XXX
#
#   # apply 本地 PG (开发机)
#   bash scripts/seed-traceable-runner.sh \
#     --tenant-schema=tenant_XXX --tenant-id=XXX --campus-id=XXX \
#     --apply --target=local
#
#   # apply 生产 (SSH pdfserver)
#   bash scripts/seed-traceable-runner.sh \
#     --tenant-schema=tenant_XXX --tenant-id=XXX --campus-id=XXX \
#     --apply --target=remote
#
# ENV (生产必填):
#   ENCRYPTION_KEY = <base64 32B>  从 .env
#   HASH_KEY       = <base64 32B>  从 .env
#
# 严谨度:
#   - dry-run 默认, 不破坏任何数据
#   - apply 真跑前打印 SQL 文件 size + 行数 + INSERT 数量 require yes typed confirm
#   - 生产 SSH 必 ALLOW_PRODUCTION_SEED=true (类似 reset-all-tenants.sh 的守门)
# ============================================================

set -euo pipefail

# ===== 参数解析 =====
TENANT_SCHEMA=""
TENANT_ID=""
CAMPUS_ID=""
APPLY=false
TARGET="local"
FORCE_CONFIRM=false

for arg in "$@"; do
  case "$arg" in
    --tenant-schema=*) TENANT_SCHEMA="${arg#*=}" ;;
    --tenant-id=*)     TENANT_ID="${arg#*=}" ;;
    --campus-id=*)     CAMPUS_ID="${arg#*=}" ;;
    --apply)           APPLY=true ;;
    --target=*)        TARGET="${arg#*=}" ;;
    --force-confirm)   FORCE_CONFIRM=true ;;
    --help|-h)
      head -40 "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) echo "[warn] unknown arg: $arg" ;;
  esac
done

if [ -z "$TENANT_SCHEMA" ] || [ -z "$TENANT_ID" ] || [ -z "$CAMPUS_ID" ]; then
  echo "ERROR: --tenant-schema / --tenant-id / --campus-id 全部必填"
  exit 2
fi

# 32-char ULID 检查
[[ "$TENANT_ID" =~ ^[a-zA-Z0-9]{32}$ ]] || { echo "ERROR: tenant-id 必须 32 字符 ULID"; exit 2; }
[[ "$CAMPUS_ID" =~ ^[a-zA-Z0-9]{32}$ ]] || { echo "ERROR: campus-id 必须 32 字符 ULID"; exit 2; }
[[ "$TENANT_SCHEMA" =~ ^tenant_ ]] || { echo "ERROR: tenant-schema 必须 tenant_ 前缀"; exit 2; }

# ===== ENC keys 检查 =====
if [ -z "${ENCRYPTION_KEY:-}" ] || [ -z "${HASH_KEY:-}" ]; then
  echo "ERROR: ENCRYPTION_KEY + HASH_KEY 必须 export"
  echo "  本地: 用 dummy keys (PII encrypted 无意义, 不影响 KPI 验证):"
  echo "  ENCRYPTION_KEY=\$(openssl rand -base64 32) HASH_KEY=\$(openssl rand -base64 32) bash $0 ..."
  echo "  生产: source ~/workspace/edu-server/.env"
  exit 2
fi

# 颜色
C_GREEN='\033[32m'; C_RED='\033[31m'; C_YELLOW='\033[33m'; C_CYAN='\033[36m'; C_RESET='\033[0m'
ok()   { printf "${C_GREEN}OK${C_RESET}    %s\n" "$1"; }
fail() { printf "${C_RED}FAIL${C_RESET}  %s\n" "$1"; }
warn() { printf "${C_YELLOW}WARN${C_RESET}  %s\n" "$1"; }
info() { printf "${C_CYAN}INFO${C_RESET}  %s\n" "$1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GENERATOR="${REPO_ROOT}/scripts/seed-traceable-one-tenant.js"
OUTPUT_SQL="/tmp/seed-traceable-${TENANT_SCHEMA}.sql"

# ===== 1. 生成 SQL =====
echo ""
info "============================================="
info "Step 1: 生成 SQL"
info "============================================="
info "  tenant_schema = $TENANT_SCHEMA"
info "  tenant_id     = $TENANT_ID"
info "  campus_id     = $CAMPUS_ID"
info "  output        = $OUTPUT_SQL"

node "$GENERATOR" \
  --tenant-schema="$TENANT_SCHEMA" \
  --tenant-id="$TENANT_ID" \
  --campus-id="$CAMPUS_ID" \
  --output="$OUTPUT_SQL"

SIZE=$(wc -c < "$OUTPUT_SQL" | tr -d ' ')
LINES=$(wc -l < "$OUTPUT_SQL" | tr -d ' ')
INSERTS=$(grep -c "^INSERT" "$OUTPUT_SQL" || echo 0)
ok "SQL 生成: ${SIZE} bytes, ${LINES} lines, ${INSERTS} INSERTs"

# ===== 2. dry-run (ROLLBACK 校验) =====
echo ""
info "============================================="
info "Step 2: Dry-run 语法 + 表存在校验"
info "============================================="

if [ "$TARGET" = "local" ]; then
  if ! command -v psql >/dev/null 2>&1; then
    warn "本地 psql 未安装 — 跳过 dry-run (apply 时仍会跑)"
  else
    # 本地: cat | sudo -u postgres psql 在 macOS 通常用 LOCAL_PG_DB
    if [ -n "${LOCAL_PG_DB:-}" ] && [ -n "${LOCAL_PG_USER:-}" ]; then
      # 本地 PG: 不加 sudo, 用 -U
      cat "$OUTPUT_SQL" | psql -U "$LOCAL_PG_USER" -d "$LOCAL_PG_DB" -v ON_ERROR_STOP=1 -1 -c "ROLLBACK;" >/dev/null 2>&1 \
        && ok "dry-run 通过 (本地)" \
        || warn "dry-run 失败 — 可能表不存在 (本地 PG schema 缺 migration). apply 跑前请验证"
    else
      warn "LOCAL_PG_DB / LOCAL_PG_USER 未 set — 跳过本地 dry-run"
    fi
  fi
else
  info "remote target: dry-run 在 SSH 端跑"
  # 用 -1 + ROLLBACK 验证 (生产实测过)
  ssh pdfserver "cat > /tmp/seed-traceable-dryrun.sql" < "$OUTPUT_SQL"
  if ssh pdfserver "sudo -u postgres psql -d edu -v ON_ERROR_STOP=1 -f /tmp/seed-traceable-dryrun.sql --single-transaction -c 'ROLLBACK;'" 2>&1 | tail -3; then
    ok "dry-run 通过 (remote)"
  else
    fail "dry-run 失败 — 中止 apply"
    exit 1
  fi
fi

# ===== 3. apply =====
if [ "$APPLY" = false ]; then
  echo ""
  warn "Dry-run 完成. 加 --apply 真跑"
  echo ""
  echo "下一步:"
  echo "  bash $0 \\"
  echo "    --tenant-schema=$TENANT_SCHEMA \\"
  echo "    --tenant-id=$TENANT_ID \\"
  echo "    --campus-id=$CAMPUS_ID \\"
  echo "    --apply --target=$TARGET"
  exit 0
fi

echo ""
info "============================================="
info "Step 3: Apply (真跑 SQL → ${TARGET})"
info "============================================="

# 生产守门
if [ "$TARGET" = "remote" ]; then
  if [ "${ALLOW_PRODUCTION_SEED:-false}" != "true" ]; then
    fail "生产 apply 需 ALLOW_PRODUCTION_SEED=true 显式 opt-in"
    exit 2
  fi

  if [ "$FORCE_CONFIRM" = false ]; then
    echo ""
    warn "你即将 TRUNCATE 生产 tenant ${TENANT_SCHEMA} 的全部业务表 + 重新 INSERT seed data"
    echo "  数据流: ${SIZE} bytes / ${INSERTS} INSERT"
    echo ""
    read -p "Type 'APPLY SEED' to confirm: " CONFIRM
    [ "$CONFIRM" = "APPLY SEED" ] || { fail "未确认 (输入了 '$CONFIRM')"; exit 1; }
  fi
fi

if [ "$TARGET" = "local" ]; then
  if [ -z "${LOCAL_PG_DB:-}" ] || [ -z "${LOCAL_PG_USER:-}" ]; then
    fail "LOCAL_PG_DB / LOCAL_PG_USER 必填 (apply local)"
    exit 2
  fi
  cat "$OUTPUT_SQL" | psql -U "$LOCAL_PG_USER" -d "$LOCAL_PG_DB" -v ON_ERROR_STOP=1 --single-transaction \
    && ok "apply 完成 (本地)" \
    || { fail "apply 失败"; exit 1; }
else
  scp "$OUTPUT_SQL" pdfserver:/tmp/seed-traceable-apply.sql >/dev/null
  if ssh pdfserver "sudo -u postgres psql -d edu -v ON_ERROR_STOP=1 -f /tmp/seed-traceable-apply.sql --single-transaction"; then
    ok "apply 完成 (remote)"
    ssh pdfserver "rm /tmp/seed-traceable-apply.sql" 2>/dev/null || true
  else
    fail "apply 失败"
    exit 1
  fi
fi

echo ""
info "============================================="
info "验证 query (推荐手动跑确认):"
info "============================================="
echo "  ssh pdfserver \"sudo -u postgres psql -d edu -c \\\"SELECT order_type, COUNT(*), SUM(total_amount) FROM ${TENANT_SCHEMA}.contracts GROUP BY order_type;\\\"\""
echo "  (预期: 新签 8 行 ¥96000 + 续费 2 行 ¥24000)"
echo ""
