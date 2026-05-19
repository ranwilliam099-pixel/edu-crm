#!/bin/bash
# ============================================================
# restore-demo-users.sh — 从生产 PG 重建 scripts/seed/demo-users.json
#
# 来源（Day 3 任务 B / Sprint Y backlog #5 / Day 2 报告 §8）：
#   - reset 第二次跑后 demo-users.json 仅 2 tenant
#   - 原因：reset --apply 中途 cleanup 失败 / Phase 2 部分失败 → 文件不完整
#   - 影响：seed-demo-data.sh 起跑前 require demo-users.json，缺 13 tenant 跑不了 seed
#
# 修复方式：
#   - 不依赖 reset 重 provision（破坏性）
#   - 直接从 public.tenants + tenant_<id>.users 反查
#   - 拼出 demo-users.json 全 15 tenant + admin spec
#
# 注意：
#   - bcrypt password hash 不可逆 → restore 时设默认密码 'Demo@12345'
#   - 真实 demo 跑时 reset/seed 用同一默认密码，恢复语义一致
#   - 如生产 PG 真实密码已被改（攻击 / 误操作）→ 必须先跑 backfill UPDATE auth.users.password_hash
#     为统一 bcrypt hash（cost=4 'Demo@12345'），否则 restore 后 login 失败
#
# 用法：
#   bash scripts/restore-demo-users.sh                       # dry-run 默认（输出待写 JSON 到 stdout）
#   bash scripts/restore-demo-users.sh --apply                # 真写入 scripts/seed/demo-users.json
#   bash scripts/restore-demo-users.sh --apply --output=PATH  # 自定义输出
#   bash scripts/restore-demo-users.sh --apply --logical-name=demo-boss-single  # 只追加 1 个
#   bash scripts/restore-demo-users.sh --apply --restore-password-hash         # 同时 UPDATE bcrypt
#
# ENV：
#   PG_DB=edu                          数据库名
#   PG_USER_OS=postgres                OS 用户（sudo -u）
#
# Exit：
#   0 OK / 2 缺依赖或参数错 / 3 PG 不可达 / 1 部分 tenant 缺失
#
# 出具：edu-server backend Day 3  2026-05-19
# ============================================================

set -euo pipefail

# ===== 配置 =====
PG_DB="${PG_DB:-edu}"
PG_USER_OS="${PG_USER_OS:-postgres}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED_DIR="${REPO_ROOT}/scripts/seed"
DEFAULT_OUTPUT="${SEED_DIR}/demo-users.json"

# ===== 参数解析 =====
APPLY=false
OUTPUT_FILE="$DEFAULT_OUTPUT"
ONLY_LOGICAL_NAME=""
RESTORE_PASSWORD_HASH=false

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --output=*) OUTPUT_FILE="${arg#*=}" ;;
    --logical-name=*) ONLY_LOGICAL_NAME="${arg#*=}" ;;
    --restore-password-hash) RESTORE_PASSWORD_HASH=true ;;
    --help|-h)
      grep '^#' "$0" | head -50
      exit 0
      ;;
    *) echo "[warn] unknown arg: $arg" >&2 ;;
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
fail()  { printf "${C_RED}FAIL${C_RESET}  %s\n" "$1" >&2; }
warn()  { printf "${C_YELLOW}WARN${C_RESET}  %s\n" "$1" >&2; }
info()  { printf "${C_CYAN}INFO${C_RESET}  %s\n" "$1"; }
note()  { printf "${C_GRAY}      %s${C_RESET}\n" "$1"; }

# ===== Banner =====
echo ""
echo "==============================================="
printf "${C_BOLD}  Day 3 任务 B: restore-demo-users${C_RESET}\n"
echo "==============================================="
echo ""
if [ "$APPLY" = false ]; then
  warn "DRY-RUN（默认）— 加 --apply 才写入 $OUTPUT_FILE"
else
  info "APPLY 模式 — 真写入 $OUTPUT_FILE"
fi
info "PG_DB=$PG_DB PG_USER_OS=$PG_USER_OS"
if [ -n "$ONLY_LOGICAL_NAME" ]; then
  info "只 restore: $ONLY_LOGICAL_NAME"
fi
echo ""

# ===== 前置检查 =====
if ! command -v psql >/dev/null 2>&1; then
  fail "psql 未安装"
  exit 2
fi
ok "psql 已就绪"

if ! command -v node >/dev/null 2>&1; then
  fail "node 未安装（拼 JSON 需要）"
  exit 2
fi
ok "node 已就绪"

# 连通性
if ! sudo -u "$PG_USER_OS" psql -d "$PG_DB" -tA -c "SELECT 1" >/dev/null 2>&1; then
  fail "无法连接 PG (db=$PG_DB user=$PG_USER_OS)"
  exit 3
fi
ok "PG 连通"

# 检查 public.tenants 表
if ! sudo -u "$PG_USER_OS" psql -d "$PG_DB" -tA -c \
  "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tenants'" \
  | grep -q '^1$'; then
  fail "public.tenants 表不存在 — V8 之前的部署？"
  exit 3
fi
ok "public.tenants 存在"

echo ""

# ===== 1. 列出所有 demo-* tenant =====
info "Step 1: 列 public.tenants 中所有 demo-* 租户..."

# logical_name 在 public.tenants.name（V8 Tenant entity 用 name 字段）
# 拍板 reset 用 logicalName 映射 tenant.name = demo-empty / demo-boss-single / ...
TENANT_ROWS_RAW=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -tA -F'|' \
  -c "SELECT id, name, plan_tier, subscription_status, status
        FROM public.tenants
        WHERE name LIKE 'demo-%'
        ORDER BY name" 2>/dev/null)

if [ -z "$TENANT_ROWS_RAW" ]; then
  warn "public.tenants 无 demo-* 记录"
  note "如刚跑过 reset --only-phase=drop 是正常 — 需先跑 --only-phase=provision"
  if [ "$APPLY" = true ]; then
    echo "[]" > "$OUTPUT_FILE"
    ok "写入空数组到 $OUTPUT_FILE"
  fi
  exit 0
fi

# 统计 + 列表
TENANT_COUNT=$(echo "$TENANT_ROWS_RAW" | wc -l | tr -d ' ')
ok "找到 $TENANT_COUNT 个 demo-* 租户"
echo "$TENANT_ROWS_RAW" | while IFS='|' read -r ID NAME PLAN_TIER SUB_ST STATUS; do
  note "  $NAME | id=${ID:0:10}... | plan_tier=$PLAN_TIER | sub=$SUB_ST | status=$STATUS"
done
echo ""

# ===== 2. 对每个 tenant 反查 admin =====
info "Step 2: 反查每个 tenant 的 admin user..."

# 默认密码（与 reset-all-tenants.sh L512 + seed/generate-seed-sql.js 一致）
DEMO_ADMIN_PASSWORD="Demo@12345"

# admin phone 映射（与 reset-all-tenants.sh L493-509 DEMO_TENANTS 数组一致）
# logical_name -> phone
declare -A ADMIN_PHONE_MAP=(
  [demo-empty]="13800001001"
  [demo-admin-multi-campus]="13800001002"
  [demo-boss-single]="13800001003"
  [demo-sales-active]="13800001004"
  [demo-academic-busy]="13800001005"
  [demo-teacher-rated]="13800001006"
  [demo-parent-single]="13800001007"
  [demo-parent-multi-tenant]="13800001008"
  [demo-finance-invoice]="13800001009"
  [demo-hr]="13800001010"
  [demo-marketing]="13800001011"
  [demo-edge-case]="13800001012"
  [demo-large-scale]="13800001013"
  [demo-archived]="13800001014"
  [demo-frozen]="13800001015"
)

# 累积 JSON 数组（用 node 写文件保 escape）
JSON_TMP=$(mktemp /tmp/demo-users-rebuild-XXXXXX.json)
echo "[]" > "$JSON_TMP"

SUCCESS=0
FAILED=0
SKIPPED=0
declare -a MISSING_TENANTS=()

while IFS='|' read -r TENANT_ID LOGICAL_NAME PLAN_TIER SUB_ST STATUS; do
  [ -z "$LOGICAL_NAME" ] && continue

  # filter --logical-name
  if [ -n "$ONLY_LOGICAL_NAME" ] && [ "$LOGICAL_NAME" != "$ONLY_LOGICAL_NAME" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  TENANT_SCHEMA="tenant_$(echo "$TENANT_ID" | tr '[:upper:]' '[:lower:]')"

  printf "${C_GRAY}---${C_RESET} %s (schema=%s)\n" "$LOGICAL_NAME" "${TENANT_SCHEMA:0:25}..."

  # ----- 2.1 验证 tenant schema 存在 -----
  SCHEMA_EXISTS=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -tA -c \
    "SELECT 1 FROM information_schema.schemata WHERE schema_name='$TENANT_SCHEMA'" 2>/dev/null || true)
  if [ -z "$SCHEMA_EXISTS" ]; then
    warn "schema $TENANT_SCHEMA 不存在 — 跳过"
    MISSING_TENANTS+=("$LOGICAL_NAME (schema 缺失)")
    FAILED=$((FAILED + 1))
    continue
  fi

  # ----- 2.2 查 admin user_id（admin 角色 + 第一个） -----
  # auth.users 在 V46 之后是 tenant_<id>.users 表，含 role + phone + 加密
  # 注意：phone 列可能是 BYTEA（V41 加密）或 TEXT（V41 前），按 column type 反查
  USERS_TABLE_EXISTS=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -tA -c \
    "SELECT 1 FROM information_schema.tables
       WHERE table_schema='$TENANT_SCHEMA' AND table_name='users'" 2>/dev/null || true)
  if [ -z "$USERS_TABLE_EXISTS" ]; then
    warn "${TENANT_SCHEMA}.users 不存在 — 跳过"
    MISSING_TENANTS+=("$LOGICAL_NAME (users 表缺失)")
    FAILED=$((FAILED + 1))
    continue
  fi

  ADMIN_ROW=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -tA -F'|' \
    -c "SELECT id, COALESCE(name, '') FROM ${TENANT_SCHEMA}.users
         WHERE role='admin' ORDER BY created_at LIMIT 1" 2>/dev/null || true)

  if [ -z "$ADMIN_ROW" ]; then
    warn "${TENANT_SCHEMA}.users 无 admin 角色 — 跳过"
    MISSING_TENANTS+=("$LOGICAL_NAME (无 admin user)")
    FAILED=$((FAILED + 1))
    continue
  fi

  ADMIN_USER_ID=$(echo "$ADMIN_ROW" | cut -d'|' -f1)
  ADMIN_NAME=$(echo "$ADMIN_ROW" | cut -d'|' -f2)
  if [ -z "$ADMIN_NAME" ]; then
    ADMIN_NAME="$LOGICAL_NAME"
  fi

  # admin phone：优先 map（reset 固定写），fallback：echo 默认 13800001xxx
  ADMIN_PHONE="${ADMIN_PHONE_MAP[$LOGICAL_NAME]:-}"
  if [ -z "$ADMIN_PHONE" ]; then
    warn "$LOGICAL_NAME 不在 map 内 — 用 generic 默认 (admin phone 不准确)"
    ADMIN_PHONE="13800001999"
  fi

  # ----- 2.3 查 campusIds（public.campuses tenant_id = $TENANT_ID） -----
  CAMPUS_IDS_JSON=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -tA \
    -c "SELECT COALESCE(json_agg(id ORDER BY created_at), '[]'::json)::text
          FROM public.campuses WHERE tenant_id='$TENANT_ID'" 2>/dev/null || echo '[]')

  if [ -z "$CAMPUS_IDS_JSON" ] || [ "$CAMPUS_IDS_JSON" = "[]" ]; then
    warn "$LOGICAL_NAME 无 campus（可能 multi-campus 表已 truncate）— 用 []"
    CAMPUS_IDS_JSON='[]'
  fi

  # ----- 2.4 拼 JSON 入 array -----
  # 用 node 保证 JSON escape 正确
  if ! node -e "
    const fs = require('fs');
    const path = '$JSON_TMP';
    const arr = JSON.parse(fs.readFileSync(path, 'utf-8'));
    arr.push({
      logicalName: '$LOGICAL_NAME',
      tenantId: '$TENANT_ID',
      tenantSchema: '$TENANT_SCHEMA',
      sku: '$PLAN_TIER',
      campusIds: $CAMPUS_IDS_JSON,
      admin: {
        userId: '$ADMIN_USER_ID',
        name: '$ADMIN_NAME',
        phone: '$ADMIN_PHONE',
        password: '$DEMO_ADMIN_PASSWORD',
        email: '${LOGICAL_NAME}@demo.local',
      },
      restoredAt: new Date().toISOString(),
      restoredFrom: 'PG via restore-demo-users.sh',
    });
    fs.writeFileSync(path, JSON.stringify(arr, null, 2));
  " 2>&1; then
    fail "$LOGICAL_NAME node JSON 拼接失败"
    FAILED=$((FAILED + 1))
    continue
  fi

  # ----- 2.5 可选：UPDATE password_hash 回 'Demo@12345' bcrypt cost=4 -----
  # 不能在 restore 阶段裸算 bcrypt（节点没 bcryptjs 依赖时炸）
  # 用 generate-seed-sql.js 同一 bcrypt cost=4 hash（硬编码常量节省一致性）
  # 'Demo@12345' bcrypt cost=4 hash：$2b$04$8vIKhh2qmF1abeBI5RaR2OXMfV4ggQT0r9ftPjE6cE7CWLM84RNN6
  # （从 generate-seed-sql.js 已验证可登）
  if [ "$RESTORE_PASSWORD_HASH" = true ] && [ "$APPLY" = true ]; then
    DEMO_BCRYPT_HASH='$2b$04$8vIKhh2qmF1abeBI5RaR2OXMfV4ggQT0r9ftPjE6cE7CWLM84RNN6'
    # 转义单引号给 SQL
    if sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 \
         -c "UPDATE ${TENANT_SCHEMA}.users SET password_hash='${DEMO_BCRYPT_HASH}' WHERE role='admin'" \
         >/dev/null 2>&1; then
      ok "UPDATE password_hash 回 Demo@12345"
    else
      warn "UPDATE password_hash 失败（可能 V46 password_hash 列不存在）"
    fi
  fi

  ok "$LOGICAL_NAME restored (admin_user=${ADMIN_USER_ID:0:10}... campus=${CAMPUS_IDS_JSON})"
  SUCCESS=$((SUCCESS + 1))
done <<< "$TENANT_ROWS_RAW"

echo ""

# ===== 3. 写入 OUTPUT_FILE =====
if [ "$APPLY" = true ]; then
  cp "$JSON_TMP" "$OUTPUT_FILE"
  ok "写入 $OUTPUT_FILE"
else
  warn "DRY-RUN — 不写入。预览："
  cat "$JSON_TMP"
fi

rm -f "$JSON_TMP"

echo ""
echo "==============================================="
printf "${C_BOLD}  总体 Summary${C_RESET}\n"
echo "==============================================="
printf "  ${C_GREEN}Success${C_RESET}: %d\n" "$SUCCESS"
printf "  ${C_YELLOW}Skipped${C_RESET}: %d\n" "$SKIPPED"
printf "  ${C_RED}Failed${C_RESET}:  %d\n" "$FAILED"

if [ ${#MISSING_TENANTS[@]} -gt 0 ]; then
  echo ""
  warn "缺失的 tenant（需要重 provision）："
  for m in "${MISSING_TENANTS[@]}"; do
    note "  - $m"
  done
fi

echo ""

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
exit 0
