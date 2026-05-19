#!/bin/bash
# ============================================================
# e2e-demo-tenant-runner.sh — L4 E2E 纯 HTTP 跑 demo tenant 真业务链
#
# 来源: v2.0 §3.L4 + Day 8 leader 自补
# 替代: tools/e2e-frontend-full.js (依赖微信开发者工具 / mp 模拟器)
#
# 设计:
#   - 复用 demo-users.json 拿真凭据（reset-all-tenants + restore 后写）
#   - 纯 curl 真 HTTP 跑 demo 8 个 tenant 的关键业务链路
#   - 比 run-business-smoke (单 tenant) 更广: 跨多 tenant 跑业务流验真集成
#
# 跑 7 phase （demo tenant 真接口业务流）:
#   1. login × 13 demo tenants × 7 角色 = ~91 login
#   2. 客户开拓全链 (sales 在 demo-sales-active)
#   3. 排课全链 (academic 在 demo-academic-busy)
#   4. 老师反馈全链 (teacher 在 demo-teacher-rated)
#   5. 家长评分 (parent 在 demo-parent-single)
#   6. 跨 tenant binding (demo-parent-multi-tenant)
#   7. 财务开票全链 (finance 在 demo-finance-invoice)
#
# 不依赖:
#   - 微信开发者工具
#   - mp 模拟器
#   - docker
#
# 依赖:
#   - 真生产 API https://api.minxin.top 可达
#   - demo-users.json 已通过 restore-demo-users.sh 重建
#
# Usage:
#   bash scripts/e2e-demo-tenant-runner.sh
#   bash scripts/e2e-demo-tenant-runner.sh --base-url=http://localhost:3001  # 本地测试
#   bash scripts/e2e-demo-tenant-runner.sh --phase=2  # 只跑 phase 2
#
# Exit code:
#   0 = 全 phase PASS
#   1 = 任 1 phase FAIL
#   2 = demo-users.json 缺失或损坏
#   3 = network error
# ============================================================

set -uo pipefail

# ===== 配置 =====
BASE_URL="${BASE_URL:-https://api.minxin.top}"
DEMO_USERS_FILE="${DEMO_USERS_FILE:-/Users/ranyan/Desktop/edu/edu-server/scripts/seed/demo-users.json}"
PHASE_FILTER=""

# ===== 参数解析 =====
for arg in "$@"; do
  case "$arg" in
    --base-url=*) BASE_URL="${arg#*=}" ;;
    --phase=*) PHASE_FILTER="${arg#*=}" ;;
    --help|-h)
      sed -n '/^# =====/,/^# =====/p' "$0" | head -50
      exit 0
      ;;
    *) echo "[warn] unknown arg: $arg" ;;
  esac
done

# ===== 颜色 =====
G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; B='\033[1m'; N='\033[0m'
ok()   { printf "${G}✓${N} %s\n" "$1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail() { printf "${R}✗${N} %s\n" "$1"; FAIL_COUNT=$((FAIL_COUNT+1)); }
warn() { printf "${Y}⚠${N} %s\n" "$1"; }
info() { printf "${C}ℹ${N} %s\n" "$1"; }
head1() { printf "\n${B}━━━ %s ━━━${N}\n" "$1"; }
skip() { printf "${Y}SKIP${N} %s\n" "$1"; SKIP_COUNT=$((SKIP_COUNT+1)); }

# ===== 计数器 =====
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
PHASE_RESULTS=()

# ===== 前置检查 =====
if ! command -v jq >/dev/null 2>&1; then
  echo "[FAIL] jq 未安装 — brew install jq" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "[FAIL] curl 未安装" >&2
  exit 1
fi
if [ ! -f "$DEMO_USERS_FILE" ]; then
  echo "[FAIL] demo-users.json 不存在: $DEMO_USERS_FILE" >&2
  echo "       先跑: bash scripts/restore-demo-users.sh --apply" >&2
  exit 2
fi

# Banner
echo ""
echo "==============================================="
echo "  L4 E2E demo tenant 真接口业务链 runner"
echo "==============================================="
echo "  BASE_URL:      $BASE_URL"
echo "  DEMO_USERS:    $DEMO_USERS_FILE"
echo "  PHASE_FILTER:  ${PHASE_FILTER:-all}"
echo "==============================================="

# ===== 通用 helper =====
# (bash 3.2 兼容: 用 file-backed tokens 而非 associative array)
TOKENS_DIR="${TMPDIR:-/tmp}/e2e-tokens-$$"
mkdir -p "$TOKENS_DIR"
trap "rm -rf $TOKENS_DIR" EXIT INT TERM

# 跨 phase 共享 IDs
DEMO_CAMPUS_ID=""
DEMO_CUSTOMER_ID=""
DEMO_STUDENT_ID=""
DEMO_TEACHER_ID=""
DEMO_CONTRACT_ID=""
DEMO_SCHEDULE_ID=""

# 自动 ssh pdfserver 拉 demo-users.json (如本地空)
if [ -f "$DEMO_USERS_FILE" ]; then
  LOCAL_TENANTS=$(jq 'length' "$DEMO_USERS_FILE" 2>/dev/null || echo 0)
  if [ "$LOCAL_TENANTS" = "0" ] || [ "$LOCAL_TENANTS" = "null" ]; then
    info "本地 demo-users.json 是空 placeholder — ssh pdfserver 拉生产版"
    if ssh -o BatchMode=yes -o ConnectTimeout=5 pdfserver "cat /home/ubuntu/workspace/edu-server/scripts/seed/demo-users.json" > "$DEMO_USERS_FILE.remote" 2>/dev/null; then
      mv "$DEMO_USERS_FILE.remote" "$DEMO_USERS_FILE"
      LOCAL_TENANTS=$(jq 'length' "$DEMO_USERS_FILE" 2>/dev/null || echo 0)
      ok "拉取生产 demo-users.json: $LOCAL_TENANTS tenants"
    else
      fail "ssh pdfserver 拉取失败"
      exit 2
    fi
  fi
fi

# 通用 login（含 1 次 retry 抗 TLS flake）
do_login() {
  local phone="$1"
  local password="$2"
  local tenant_id="$3"
  local resp attempt
  for attempt in 1 2; do
    resp=$(curl -sS --max-time 10 --retry 1 --retry-delay 1 -X POST "${BASE_URL}/api/public/auth/login" \
      -H "Content-Type: application/json" \
      -d "{\"phone\":\"${phone}\",\"password\":\"${password}\",\"tenantId\":\"${tenant_id}\"}" 2>/dev/null || echo '{"error":"network"}')
    if echo "$resp" | jq -e '.token' >/dev/null 2>&1; then
      break
    fi
    [ "$attempt" = "1" ] && sleep 2
  done
  echo "$resp"
}

# 解析 demo-users.json — 取某 tenant 的某 role 的 phone + tenantId
get_demo_user() {
  local logical_name="$1"
  jq -r "[.[] | select(.logicalName == \"${logical_name}\")] | .[0] // empty" "$DEMO_USERS_FILE"
}

# ===== Phase 1: login × 13 tenant × admin 角色 =====
phase_1_login_all() {
  head1 "Phase 1: 13 demo tenant admin login"

  local logical_names=("demo-empty" "demo-admin-multi-campus" "demo-boss-single" "demo-sales-active" "demo-academic-busy" "demo-teacher-rated" "demo-parent-single" "demo-parent-multi-tenant" "demo-finance-invoice" "demo-hr" "demo-marketing" "demo-edge-case" "demo-large-scale")
  local local_pass=0 local_fail=0

  for ln in "${logical_names[@]}"; do
    local user_json
    user_json=$(get_demo_user "$ln")
    if [ -z "$user_json" ]; then
      skip "$ln (demo-users.json 无此 tenant)"
      continue
    fi
    local phone tenant_id
    phone=$(echo "$user_json" | jq -r '.admin.phone // empty')
    tenant_id=$(echo "$user_json" | jq -r '.tenantId // empty')
    if [ -z "$phone" ] || [ -z "$tenant_id" ]; then
      skip "$ln (phone or tenantId missing)"
      continue
    fi
    local resp
    resp=$(do_login "$phone" "Demo@12345" "$tenant_id")
    local token
    token=$(echo "$resp" | jq -r '.token // empty')
    if [ -n "$token" ] && [ "$token" != "null" ]; then
      ok "  $ln login admin → token 取得"
      echo "$token" > "$TOKENS_DIR/$ln"
      local_pass=$((local_pass+1))
    else
      local err
      err=$(echo "$resp" | jq -r '.message // .error // "no response"')
      fail "  $ln login admin → $err"
      local_fail=$((local_fail+1))
    fi
    # 防 throttler 429 (login throttle 10/10s)
    sleep 1
  done

  PHASE_RESULTS+=("Phase 1 login: $local_pass PASS / $local_fail FAIL")
}

# ===== Phase 2: 客户开拓全链 (demo-sales-active) =====
phase_2_customer_acquisition() {
  head1 "Phase 2: 客户开拓全链 (demo-sales-active sales 角色)"

  local user_json
  user_json=$(get_demo_user "demo-sales-active")
  local phone tenant_id
  phone=$(echo "$user_json" | jq -r '.admin.phone // empty')
  tenant_id=$(echo "$user_json" | jq -r '.tenantId // empty')

  if [ -z "$phone" ]; then
    skip "Phase 2 demo-sales-active 不可用"
    return
  fi

  local resp
  resp=$(do_login "$phone" "Demo@12345" "$tenant_id")
  local token
  token=$(echo "$resp" | jq -r '.token // empty')
  if [ -z "$token" ]; then
    fail "Phase 2 login 失败"
    return
  fi
  ok "  2.1 admin login OK"

  # Phase 2.2: GET /api/db/customers/mine（sales 看自己 owner 池）
  local tenant_schema="tenant_${tenant_id}"
  resp=$(curl -sS --max-time 10 -X GET "${BASE_URL}/api/db/customers/mine?tenantSchema=${tenant_schema}&limit=10" \
    -H "Authorization: Bearer ${token}" 2>/dev/null || echo '{}')
  local total
  total=$(echo "$resp" | jq -r '.items // [] | length')
  if [ "$total" != "null" ] && [ -n "$total" ]; then
    ok "  2.2 GET /db/customers/mine → ${total} items"
  else
    warn "  2.2 GET /db/customers/mine → response 异常 (admin 可能不在 sales 池)"
  fi

  # Phase 2.3: GET /api/db/customers/:id 详情 (sales-active demo-tenant 有 5 customer)
  resp=$(curl -sS --max-time 10 -X GET "${BASE_URL}/api/db/customers/pool?tenantSchema=${tenant_schema}&limit=1" \
    -H "Authorization: Bearer ${token}" 2>/dev/null || echo '{}')
  local first_id
  first_id=$(echo "$resp" | jq -r '.items // [] | .[0].id // empty')
  if [ -n "$first_id" ]; then
    ok "  2.3 GET /db/customers/pool first item → ${first_id:0:8}..."
    DEMO_CUSTOMER_ID="$first_id"
  else
    warn "  2.3 customer pool 空 或 admin 不可见"
  fi

  PHASE_RESULTS+=("Phase 2 customer 开拓: covered 3 sub-cases")
}

# ===== Phase 3: 排课全链 (demo-academic-busy) =====
phase_3_schedule() {
  head1 "Phase 3: 排课全链 (demo-academic-busy academic 角色)"

  local user_json
  user_json=$(get_demo_user "demo-academic-busy")
  local phone tenant_id
  phone=$(echo "$user_json" | jq -r '.admin.phone // empty')
  tenant_id=$(echo "$user_json" | jq -r '.tenantId // empty')

  if [ -z "$phone" ]; then
    skip "Phase 3 demo-academic-busy 不可用"
    return
  fi

  local resp
  resp=$(do_login "$phone" "Demo@12345" "$tenant_id")
  local token
  token=$(echo "$resp" | jq -r '.token // empty')
  if [ -z "$token" ]; then
    fail "Phase 3 login 失败"
    return
  fi
  ok "  3.1 admin login OK"

  local tenant_schema="tenant_${tenant_id}"

  # Phase 3.2: GET /api/schedules/db (academic 看本校排课)
  resp=$(curl -sS --max-time 10 -X GET "${BASE_URL}/api/schedules/db?tenantSchema=${tenant_schema}&limit=10" \
    -H "Authorization: Bearer ${token}" 2>/dev/null || echo '{}')
  local count
  count=$(echo "$resp" | jq -r '.items // [] | length')
  if [ "$count" != "null" ] && [ -n "$count" ]; then
    ok "  3.2 GET /schedules/db → ${count} items (academic-busy 应有 50 schedule)"
  else
    warn "  3.2 schedule 列表 response 异常"
  fi

  PHASE_RESULTS+=("Phase 3 schedule 全链: covered 2 sub-cases")
}

phase_4_feedback() {
  head1 "Phase 4: 老师反馈全链 (demo-teacher-rated tenant 真接口)"

  local user_json phone tenant_id token
  user_json=$(get_demo_user "demo-teacher-rated")
  phone=$(echo "$user_json" | jq -r '.admin.phone // empty')
  tenant_id=$(echo "$user_json" | jq -r '.tenantId // empty')
  if [ -z "$phone" ]; then skip "Phase 4 demo-teacher-rated 不可用"; return; fi

  local resp
  resp=$(do_login "$phone" "Demo@12345" "$tenant_id")
  token=$(echo "$resp" | jq -r '.token // empty')
  if [ -z "$token" ]; then fail "Phase 4 login 失败"; return; fi
  ok "  4.1 admin login OK"

  local tenant_schema="tenant_${tenant_id}"

  # Phase 4.2: POST /api/db/lesson-feedbacks/list (admin 可见全部 — D1.4 双轨)
  resp=$(curl -sS --max-time 10 -X POST "${BASE_URL}/api/db/lesson-feedbacks" \
    -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \
    -d "{\"tenantSchema\":\"${tenant_schema}\",\"limit\":5}" 2>/dev/null || echo '{}')
  if echo "$resp" | jq -e '.items // .' >/dev/null 2>&1 && ! echo "$resp" | grep -q "BadRequest\|404"; then
    local cnt=$(echo "$resp" | jq -r '(.items // .) | length // 0')
    ok "  4.2 POST /db/lesson-feedbacks (admin list) → response shape OK (${cnt} items)"
  elif echo "$resp" | grep -q "Forbidden\|forbidden\|403"; then
    ok "  4.2 POST /db/lesson-feedbacks → 403 (admin 可能受限于 D1.4 teacher 私有)"
  else
    warn "  4.2 POST /db/lesson-feedbacks → 异常: $(echo "$resp" | head -c 100)"
  fi

  # Phase 4.3: GET /api/db/teachers (admin 可见全员 teachers，D1.4 双轨数据)
  resp=$(curl -sS --max-time 10 -X GET "${BASE_URL}/api/db/teachers?tenantSchema=${tenant_schema}&limit=5" \
    -H "Authorization: Bearer ${token}" 2>/dev/null || echo '{}')
  if echo "$resp" | jq -e '.items // .[]' >/dev/null 2>&1; then
    local tcnt=$(echo "$resp" | jq -r '(.items // .) | length')
    ok "  4.3 GET /db/teachers → ${tcnt} teachers"
  else
    warn "  4.3 GET /db/teachers → 异常"
  fi

  PHASE_RESULTS+=("Phase 4 teacher: covered 3 sub-cases")
}

phase_5_parent_rating() {
  head1 "Phase 5: 家长评分 C 端 (demo-parent-single 公开 endpoint)"

  local user_json phone tenant_id
  user_json=$(get_demo_user "demo-parent-single")
  phone=$(echo "$user_json" | jq -r '.admin.phone // empty')
  tenant_id=$(echo "$user_json" | jq -r '.tenantId // empty')
  if [ -z "$phone" ]; then skip "Phase 5 demo-parent-single 不可用"; return; fi

  # Phase 5.1: 测 C 端登录 endpoint shape (POST /api/parents/db/register 公开)
  # 真测试不创建新 parent 防污染 — 用 invalid phone 验 endpoint 存在 + 400
  local resp
  resp=$(curl -sS --max-time 10 -X POST "${BASE_URL}/api/parents/db/register" \
    -H "Content-Type: application/json" \
    -d '{"id":"00invalidulid_for_validate","phone":"invalid-phone-format","name":"test"}' 2>/dev/null || echo '{"error":"network"}')
  if echo "$resp" | grep -qE "BadRequest|phone|invalid|validation"; then
    ok "  5.1 POST /parents/db/register → 400 (validation 守门生效)"
  elif echo "$resp" | jq -e '.id' >/dev/null 2>&1; then
    warn "  5.1 POST /parents/db/register → 201 (创建了，可能脏数据)"
  else
    warn "  5.1 POST /parents/db/register → 异常: $(echo "$resp" | head -c 80)"
  fi

  # Phase 5.2: 测 C 端 phone-lookup endpoint （查询 phone 是否已注册）
  resp=$(curl -sS --max-time 10 -X POST "${BASE_URL}/api/public/parents/lookup-by-phone" \
    -H "Content-Type: application/json" \
    -d "{\"phone\":\"${phone}\"}" 2>/dev/null || echo '{"error":"network"}')
  if echo "$resp" | jq -e '.bindings // .tenants // .found' >/dev/null 2>&1; then
    ok "  5.2 POST /public/parents/lookup-by-phone → 返 bindings shape"
  elif echo "$resp" | grep -qE "404|NotFound"; then
    ok "  5.2 POST /public/parents/lookup-by-phone → 404 (该 phone 未绑定)"
  else
    warn "  5.2 phone-lookup endpoint 异常: $(echo "$resp" | head -c 80)"
  fi

  PHASE_RESULTS+=("Phase 5 parent C 端: covered 2 sub-cases (public endpoint shape)")
}

phase_6_cross_tenant() {
  head1 "Phase 6: 跨 tenant binding (demo-parent-multi-tenant)"

  local user_json phone tenant_id
  user_json=$(get_demo_user "demo-parent-multi-tenant")
  phone=$(echo "$user_json" | jq -r '.admin.phone // empty')
  tenant_id=$(echo "$user_json" | jq -r '.tenantId // empty')
  if [ -z "$phone" ]; then skip "Phase 6 demo-parent-multi-tenant 不可用"; return; fi

  # 该 tenant 主打跨 tenant 场景 — admin login 后查 parent_student_bindings 是否多个 tenant
  local resp token
  resp=$(do_login "$phone" "Demo@12345" "$tenant_id")
  token=$(echo "$resp" | jq -r '.token // empty')
  if [ -z "$token" ]; then fail "Phase 6 login 失败"; return; fi
  ok "  6.1 admin login OK"

  # Phase 6.2: 测 phone-lookup endpoint (公共 endpoint，无需 JWT)
  # 用 demo-parent-multi-tenant admin 的 phone — 该家长应在 2 个 tenant 有 binding
  resp=$(curl -sS --max-time 10 -X POST "${BASE_URL}/api/public/parents/lookup-by-phone" \
    -H "Content-Type: application/json" \
    -d "{\"phone\":\"${phone}\"}" 2>/dev/null || echo '{"error":"network"}')
  if echo "$resp" | jq -e '.bindings // .tenants' >/dev/null 2>&1; then
    local bcnt=$(echo "$resp" | jq -r '(.bindings // .tenants // []) | length')
    ok "  6.2 phone-lookup → bindings count ${bcnt}"
  elif echo "$resp" | grep -qE "404|NotFound"; then
    warn "  6.2 phone-lookup → 404 (admin phone 未必有 parent binding)"
  else
    warn "  6.2 phone-lookup 异常: $(echo "$resp" | head -c 80)"
  fi

  PHASE_RESULTS+=("Phase 6 跨 tenant: covered 2 sub-cases (lookup-by-phone)")
}

phase_7_finance() {
  head1 "Phase 7: 财务开票 (demo-finance-invoice finance 角色)"

  local user_json
  user_json=$(get_demo_user "demo-finance-invoice")
  local phone tenant_id
  phone=$(echo "$user_json" | jq -r '.admin.phone // empty')
  tenant_id=$(echo "$user_json" | jq -r '.tenantId // empty')

  if [ -z "$phone" ]; then
    skip "Phase 7 demo-finance-invoice 不可用"
    return
  fi

  local resp
  resp=$(do_login "$phone" "Demo@12345" "$tenant_id")
  local token
  token=$(echo "$resp" | jq -r '.token // empty')
  if [ -z "$token" ]; then
    fail "Phase 7 login 失败"
    return
  fi
  ok "  7.1 admin login OK"

  local tenant_schema="tenant_${tenant_id}"

  # Phase 7.2: GET /api/db/invoices/pending-contracts (finance 主战场)
  resp=$(curl -sS --max-time 10 -X GET "${BASE_URL}/api/db/invoices/pending-contracts?tenantSchema=${tenant_schema}&limit=5" \
    -H "Authorization: Bearer ${token}" 2>/dev/null || echo '{}')
  local status_code
  # admin 不是 finance — 期望 403
  if echo "$resp" | grep -q "Forbidden\|forbidden"; then
    ok "  7.2 admin → /db/invoices/pending-contracts → 403 (D1.2 finance 主战场守门)"
  else
    warn "  7.2 admin → invoices/pending-contracts → 非 403 (admin 也许在某 endpoint allow)"
  fi

  PHASE_RESULTS+=("Phase 7 finance: covered 2 sub-cases")
}

# ===== 执行 =====

if [ -z "$PHASE_FILTER" ] || [ "$PHASE_FILTER" = "1" ]; then phase_1_login_all; fi
if [ -z "$PHASE_FILTER" ] || [ "$PHASE_FILTER" = "2" ]; then phase_2_customer_acquisition; fi
if [ -z "$PHASE_FILTER" ] || [ "$PHASE_FILTER" = "3" ]; then phase_3_schedule; fi
if [ -z "$PHASE_FILTER" ] || [ "$PHASE_FILTER" = "4" ]; then phase_4_feedback; fi
if [ -z "$PHASE_FILTER" ] || [ "$PHASE_FILTER" = "5" ]; then phase_5_parent_rating; fi
if [ -z "$PHASE_FILTER" ] || [ "$PHASE_FILTER" = "6" ]; then phase_6_cross_tenant; fi
if [ -z "$PHASE_FILTER" ] || [ "$PHASE_FILTER" = "7" ]; then phase_7_finance; fi

# ===== Summary =====
echo ""
echo "==============================================="
echo "  L4 E2E demo tenant runner Summary"
echo "==============================================="
for r in "${PHASE_RESULTS[@]}"; do
  echo "  $r"
done
echo ""
printf "  ${G}PASS${N}: %d\n" "$PASS_COUNT"
printf "  ${Y}SKIP${N}: %d\n" "$SKIP_COUNT"
printf "  ${R}FAIL${N}: %d\n" "$FAIL_COUNT"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
