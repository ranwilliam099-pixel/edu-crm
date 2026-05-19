#!/bin/bash
# ============================================================
# seed-demo-data.sh — Day 1 T2a：15 demo tenant 业务数据灌入
#
# 来源：
#   - 测试方案 v2.0 §3 L0 基础设施层
#   - architect spec §1.4（CLI 接口规格）+ §3.2（每 tenant 数据规格）
#   - leader prompt:「不偷懒」
#
# 流程：
#   1. 读 scripts/seed/demo-users.json（reset-all-tenants.sh phase 2 写入）
#   2. 对每个 demo tenant：
#      a. 调 scripts/seed/generate-seed-sql.js 生成业务 SQL 到 /tmp/seed-<tenant>.sql
#      b. sudo -u postgres psql -f 跑这个 SQL（事务 BEGIN/COMMIT 内）
#      c. 失败回滚不影响其他 tenant
#   3. Summary：每 tenant 行数 + 失败列表
#
# 严谨度（leader 强约束）：
#   - 真跑 SQL 不 echo mock
#   - 数据严格按 architect spec §3.2 规格
#   - 幂等 INSERT ON CONFLICT (id) DO NOTHING
#   - PII 严格双写（HMAC + AES-GCM），requires ENCRYPTION_KEY + HASH_KEY 已 export
#   - 5000 schedule + 20000 feedback 分批 INSERT VALUES (100 rows/batch)
#   - 每 tenant 独立事务，失败 rollback 不影响其他
#
# 用法：
#   bash scripts/seed-demo-data.sh                          # dry-run 默认
#   bash scripts/seed-demo-data.sh --apply                  # 真执行
#   bash scripts/seed-demo-data.sh --apply --tenant-id=<id> # 单 tenant
#   bash scripts/seed-demo-data.sh --apply --logical-name=demo-empty
#   bash scripts/seed-demo-data.sh --apply --scenario=small # 只跑特定 scenario 类
#
# ENV：
#   PG_DB=edu
#   PG_USER_OS=postgres
#   ENCRYPTION_KEY=<base64 32B>   必填（用于加密 PII）
#   HASH_KEY=<base64 32B>          必填（用于 HMAC PII）
#
# 输入：scripts/seed/demo-users.json（由 reset-all-tenants.sh phase 2 生成）
#
# 出具：edu-server backend Day 1  2026-05-19
# ============================================================

set -euo pipefail

# ===== 配置 =====
PG_DB="${PG_DB:-edu}"
PG_USER_OS="${PG_USER_OS:-postgres}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED_DIR="${REPO_ROOT}/scripts/seed"
DEMO_USERS_FILE="${SEED_DIR}/demo-users.json"
GENERATOR_JS="${SEED_DIR}/generate-seed-sql.js"

# ===== 参数解析 =====
APPLY=false
ONLY_TENANT_ID=""
ONLY_LOGICAL_NAME=""
SCENARIO_FILTER=""
CLEAR_FIRST=false

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --tenant-id=*) ONLY_TENANT_ID="${arg#*=}" ;;
    --logical-name=*) ONLY_LOGICAL_NAME="${arg#*=}" ;;
    --scenario=*) SCENARIO_FILTER="${arg#*=}" ;;
    --clear-first) CLEAR_FIRST=true ;;
    --help|-h)
      echo "Usage: bash scripts/seed-demo-data.sh [--apply] [--tenant-id=<id>] [--logical-name=<name>]"
      echo "                                       [--scenario=<empty|small|medium|large|edge-case>]"
      echo "                                       [--clear-first]"
      exit 0
      ;;
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

# ===== Scenario → logical_name 集合映射 =====
# empty:     demo-empty
# small:     demo-empty, demo-parent-single, demo-archived, demo-frozen, demo-sales-active
# medium:    demo-boss-single, demo-teacher-rated, demo-finance-invoice, demo-admin-multi-campus,
#            demo-academic-busy, demo-marketing, demo-hr, demo-parent-multi-tenant
# large:     demo-large-scale
# edge-case: demo-edge-case
scenario_matches() {
  local lname="$1"
  local sf="$2"
  case "$sf" in
    empty)
      [[ "$lname" == "demo-empty" ]]
      ;;
    small)
      [[ "$lname" == "demo-empty" || "$lname" == "demo-parent-single" || "$lname" == "demo-archived" || "$lname" == "demo-frozen" || "$lname" == "demo-sales-active" ]]
      ;;
    medium)
      [[ "$lname" == "demo-boss-single" || "$lname" == "demo-teacher-rated" || "$lname" == "demo-finance-invoice" || "$lname" == "demo-admin-multi-campus" || "$lname" == "demo-academic-busy" || "$lname" == "demo-marketing" || "$lname" == "demo-hr" || "$lname" == "demo-parent-multi-tenant" ]]
      ;;
    large)
      [[ "$lname" == "demo-large-scale" ]]
      ;;
    edge-case)
      [[ "$lname" == "demo-edge-case" ]]
      ;;
    *)
      return 1
      ;;
  esac
}

# ===== Banner =====
echo ""
echo "==============================================="
printf "${C_BOLD}  Day 1 T2a: seed-demo-data${C_RESET}\n"
echo "==============================================="
echo ""
if [ "$APPLY" = false ]; then
  warn "DRY-RUN mode（默认）— 加 --apply 才会真执行"
else
  info "APPLY mode — 真执行"
fi
info "PG_DB=$PG_DB  PG_USER_OS=$PG_USER_OS"
info "DEMO_USERS_FILE=$DEMO_USERS_FILE"
if [ -n "$ONLY_TENANT_ID" ]; then info "  --tenant-id=$ONLY_TENANT_ID"; fi
if [ -n "$ONLY_LOGICAL_NAME" ]; then info "  --logical-name=$ONLY_LOGICAL_NAME"; fi
if [ -n "$SCENARIO_FILTER" ]; then info "  --scenario=$SCENARIO_FILTER"; fi
echo ""

# ===== 前置检查 =====
if [ ! -f "$DEMO_USERS_FILE" ]; then
  fail "$DEMO_USERS_FILE 不存在 — 先跑 bash scripts/reset-all-tenants.sh --apply"
  exit 2
fi
ok "demo-users.json 找到"

if [ ! -f "$GENERATOR_JS" ]; then
  fail "$GENERATOR_JS 不存在（同 commit 应一并提交）"
  exit 2
fi
ok "generate-seed-sql.js 找到"

if ! command -v node >/dev/null 2>&1; then
  fail "node 未安装"
  exit 2
fi
ok "node 已就绪"

# dry-run 允许缺 psql
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

# 检查 ENCRYPTION_KEY / HASH_KEY（generate-seed-sql.js 强制要）
if [ -z "${ENCRYPTION_KEY:-}" ] || [ -z "${HASH_KEY:-}" ]; then
  fail "ENCRYPTION_KEY + HASH_KEY 未 export — 在 shell 设置后重试"
  note "示例：source /home/ubuntu/workspace/edu-server/.env && export ENCRYPTION_KEY HASH_KEY"
  exit 2
fi
ok "ENCRYPTION_KEY / HASH_KEY 已 export"
echo ""

# bcryptjs 依赖检查（generate-seed-sql.js 用）
if ! node -e "require('bcryptjs')" 2>/dev/null; then
  fail "bcryptjs 模块未安装 — 在 edu-server 跑 npm install"
  exit 2
fi
ok "bcryptjs 模块可用"
echo ""

# ===== 列出待 seed 的 tenant =====
TENANT_COUNT=$(node -e "
  const arr = require('${DEMO_USERS_FILE}');
  console.log(arr.length);
")
info "demo-users.json 含 $TENANT_COUNT 个 tenant"

if [ "$TENANT_COUNT" -eq 0 ]; then
  warn "demo-users.json 为空 — 先跑 bash scripts/reset-all-tenants.sh --apply"
  exit 0
fi
echo ""

# ===== 循环 seed =====
echo "==============================================="
printf "${C_BOLD}  开始逐 tenant seed${C_RESET}\n"
echo "==============================================="
echo ""

SUCCESS=0
FAILED=0
SKIPPED=0
declare -a RESULTS=()

# 从 demo-users.json 列每 tenant 的核心字段（logical_name|tenantId|tenantSchema）
TENANT_LINES=$(node -e "
  const arr = require('${DEMO_USERS_FILE}');
  for (const t of arr) {
    console.log([t.logicalName, t.tenantId, t.tenantSchema].join('|'));
  }
")

while IFS='|' read -r LOGICAL_NAME TENANT_ID TENANT_SCHEMA; do
  [ -z "$LOGICAL_NAME" ] && continue

  # 过滤
  if [ -n "$ONLY_TENANT_ID" ] && [ "$TENANT_ID" != "$ONLY_TENANT_ID" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  if [ -n "$ONLY_LOGICAL_NAME" ] && [ "$LOGICAL_NAME" != "$ONLY_LOGICAL_NAME" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  if [ -n "$SCENARIO_FILTER" ] && ! scenario_matches "$LOGICAL_NAME" "$SCENARIO_FILTER"; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  printf "${C_GRAY}---${C_RESET} %s (schema=%s)\n" "$LOGICAL_NAME" "${TENANT_SCHEMA:0:25}..."

  # 取 tenant 完整 spec JSON
  TENANT_SPEC_JSON=$(node -e "
    const arr = require('${DEMO_USERS_FILE}');
    const t = arr.find(x => x.logicalName === '${LOGICAL_NAME}');
    if (!t) { process.exit(1); }
    console.log(JSON.stringify(t));
  " 2>/dev/null)

  if [ -z "$TENANT_SPEC_JSON" ]; then
    fail "无法读取 $LOGICAL_NAME 的 spec"
    FAILED=$((FAILED + 1))
    RESULTS+=("FAIL|${LOGICAL_NAME}|reason=spec-read-failed")
    continue
  fi

  # ===== 生成 SQL =====
  TMP_SQL="/tmp/seed-${LOGICAL_NAME}-$$.sql"

  # 把 JSON 通过 tmp 文件传，避免 shell 转义
  TMP_SPEC=$(mktemp /tmp/spec-${LOGICAL_NAME}-XXXXXX.json)
  echo "$TENANT_SPEC_JSON" > "$TMP_SPEC"

  SUMMARY_JSON=$(node "$GENERATOR_JS" \
    --tenant-spec="$(cat "$TMP_SPEC")" \
    --demo-users-file="$DEMO_USERS_FILE" \
    --output-sql="$TMP_SQL" \
    2>/tmp/seed-gen-err.log) || {
      fail "生成 SQL 失败: $LOGICAL_NAME"
      note "stderr: $(cat /tmp/seed-gen-err.log | head -5)"
      rm -f "$TMP_SPEC" "$TMP_SQL"
      FAILED=$((FAILED + 1))
      RESULTS+=("FAIL|${LOGICAL_NAME}|reason=sql-gen-failed")
      continue
    }

  rm -f "$TMP_SPEC"

  SQL_SIZE=$(wc -c < "$TMP_SQL" | tr -d ' ')
  ROW_COUNTS=$(echo "$SUMMARY_JSON" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf-8'));
    const rc = d.rowCounts;
    const total = Object.values(rc).reduce((a, b) => a + b, 0);
    console.log(Object.entries(rc).filter(([k, v]) => v > 0).map(([k, v]) => k + '=' + v).join(', '));
  ")

  info "生成 SQL ${SQL_SIZE}B (${ROW_COUNTS:-empty})"

  if [ "$APPLY" = false ]; then
    info "[dry-run] would run /tmp/seed-${LOGICAL_NAME}-*.sql"
    SUCCESS=$((SUCCESS + 1))
    RESULTS+=("OK|${LOGICAL_NAME}|dry-run|${ROW_COUNTS:-empty}")
    rm -f "$TMP_SQL"
    continue
  fi

  # ===== 真跑 SQL（事务在 SQL 内）=====
  # chmod 644 让 postgres 用户可读（mktemp 默认 600）
  chmod 644 "$TMP_SQL"

  # 大文件用 stdin pipe 避免文件权限问题（参考 deploy 经验）
  if cat "$TMP_SQL" | sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 >/tmp/seed-psql-out.log 2>&1; then
    ok "seed $LOGICAL_NAME 完成"
    SUCCESS=$((SUCCESS + 1))
    RESULTS+=("OK|${LOGICAL_NAME}|${ROW_COUNTS:-empty}")
  else
    fail "seed $LOGICAL_NAME 失败"
    note "psql output (last 10 lines):"
    tail -10 /tmp/seed-psql-out.log | sed 's/^/      /'
    FAILED=$((FAILED + 1))
    RESULTS+=("FAIL|${LOGICAL_NAME}|psql-failed|$(tail -3 /tmp/seed-psql-out.log | tr '\n' ' ' | head -c 200)")
  fi

  rm -f "$TMP_SQL"
done <<< "$TENANT_LINES"

echo ""
echo "==============================================="
printf "${C_BOLD}  Summary${C_RESET}\n"
echo "==============================================="
printf "  ${C_GREEN}Success${C_RESET}: %d\n" "$SUCCESS"
printf "  ${C_YELLOW}Skipped${C_RESET}: %d (filter)\n" "$SKIPPED"
printf "  ${C_RED}Failed${C_RESET}:  %d\n" "$FAILED"
echo ""

printf "${C_BOLD}详细：${C_RESET}\n"
for R in "${RESULTS[@]}"; do
  echo "  $R"
done
echo ""

if [ "$APPLY" = false ]; then
  warn "DRY-RUN 已完成 — 加 --apply 真执行"
  exit 0
fi

# ============================================================
# Phase 3 (post-seed)：跨 tenant 关系建立
#   - demo-parent-multi-tenant 的 parent 还要绑 demo-parent-single 的 student
#     (architect spec §3.2: 1 parent 跨 2 tenant 共 3 bindings)
#   - 此 phase 只在全量 apply 时跑（filter 模式跳过）
# ============================================================
if [ -z "$ONLY_TENANT_ID" ] && [ -z "$ONLY_LOGICAL_NAME" ] && [ -z "$SCENARIO_FILTER" ]; then
  echo ""
  echo "==============================================="
  printf "${C_BOLD}  Phase 3: 跨 tenant parent 绑定${C_RESET}\n"
  echo "==============================================="
  echo ""

  # 找 demo-parent-multi-tenant 的 parent_id（存在 public.parents）
  # 找 demo-parent-single 的 student_id（在它 tenant_schema.students）
  MULTI_TENANT_SPEC=$(node -e "
    const arr = require('${DEMO_USERS_FILE}');
    const t = arr.find(x => x.logicalName === 'demo-parent-multi-tenant');
    console.log(t ? JSON.stringify(t) : 'null');
  ")
  SINGLE_TENANT_SPEC=$(node -e "
    const arr = require('${DEMO_USERS_FILE}');
    const t = arr.find(x => x.logicalName === 'demo-parent-single');
    console.log(t ? JSON.stringify(t) : 'null');
  ")

  if [ "$MULTI_TENANT_SPEC" = "null" ] || [ "$SINGLE_TENANT_SPEC" = "null" ]; then
    warn "demo-parent-multi-tenant 或 demo-parent-single 未 provision，跳过 phase 3"
  else
    # parent_id 是 deterministicUlid('parent-shared', 0) 派生自 'demo-parent-multi-tenant'
    # student_id 是 deterministicUlid('student', 0) 派生自 'demo-parent-single'
    # 用 generator JS 里同样的算法重算（保证一致）
    PARENT_ID=$(node -e "
      const crypto = require('crypto');
      const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      const h = crypto.createHash('sha256');
      h.update('demo-parent-multi-tenant|parent-shared|0');
      const digest = h.digest();
      let result = '';
      for (let i = 0; i < 20 && result.length < 32; i++) {
        const byte = digest[i];
        result += ALPHABET[byte & 0x1f];
        result += ALPHABET[(byte >> 3) & 0x1f];
      }
      console.log(result.slice(0, 32).toLowerCase());
    ")
    STUDENT_ID=$(node -e "
      const crypto = require('crypto');
      const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      const h = crypto.createHash('sha256');
      h.update('demo-parent-single|student|0');
      const digest = h.digest();
      let result = '';
      for (let i = 0; i < 20 && result.length < 32; i++) {
        const byte = digest[i];
        result += ALPHABET[byte & 0x1f];
        result += ALPHABET[(byte >> 3) & 0x1f];
      }
      console.log(result.slice(0, 32).toLowerCase());
    ")
    SINGLE_TENANT_ID=$(echo "$SINGLE_TENANT_SPEC" | node -e "
      console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).tenantId);
    ")

    # 生成跨 tenant binding ULID（用同样算法 'psb-cross|0'）
    BINDING_ID=$(node -e "
      const crypto = require('crypto');
      const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      const h = crypto.createHash('sha256');
      h.update('demo-parent-multi-tenant|psb-cross|0');
      const digest = h.digest();
      let result = '';
      for (let i = 0; i < 20 && result.length < 32; i++) {
        const byte = digest[i];
        result += ALPHABET[byte & 0x1f];
        result += ALPHABET[(byte >> 3) & 0x1f];
      }
      console.log(result.slice(0, 32).toLowerCase());
    ")

    info "跨 tenant binding: parent=${PARENT_ID:0:8}... student=${STUDENT_ID:0:8}... tenant=${SINGLE_TENANT_ID:0:8}..."

    CROSS_SQL="INSERT INTO public.parent_student_bindings (id, parent_id, student_id, tenant_id, is_primary, relationship, binding_status)
 VALUES ('${BINDING_ID}', '${PARENT_ID}', '${STUDENT_ID}', '${SINGLE_TENANT_ID}', FALSE, 'mother', 'active')
 ON CONFLICT (id) DO NOTHING;"

    if echo "$CROSS_SQL" | sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 >/dev/null 2>&1; then
      ok "跨 tenant binding created (demo-parent-multi-tenant.parent → demo-parent-single.student)"
    else
      warn "跨 tenant binding 失败（可能 demo-parent-single 的 student 未真存在 → 父 FK miss）"
      note "可手工跑: ${CROSS_SQL}"
    fi
  fi
fi

if [ "$FAILED" -gt 0 ]; then
  fail "部分 tenant seed 失败"
  exit 1
fi

ok "全部完成"
echo ""
note "下一步：bash scripts/run-business-smoke.sh （T2b dev B 提供）"
echo ""
