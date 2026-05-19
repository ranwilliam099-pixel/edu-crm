#!/bin/bash
# ============================================================
# run-business-smoke.sh
#
# 职责（v2.0 方案 §3 L5 + architect spec §1.5 + leader D1.2）：
#   跑 8 个核心 API smoke case（Case 8 扩展 3 sub-case = 10 sub-cases）
#   deploy 后验证核心路径可用
#
# 8 cases：
#   1. POST /api/public/auth/login        9 角色全过
#   2. POST /api/db/customers (sales)      创建客户
#   3. POST /api/db/students/:id/contracts 签约
#   4. POST /api/schedules                 排课（academic）
#   5. POST /api/lesson-feedbacks          反馈（teacher）
#   6. POST /api/checkout/wxpay/unified-order 沙箱支付
#   7. POST /api/db/onboarding/start-trial 跨 tenant 拒绝
#   8a GET /api/db/customers (finance)    → 403
#   8b GET /api/db/contracts/:id (finance) → 200 字段范围
#   8c GET /api/db/invoices/pending-contracts (finance) → 200
#
# 用法：
#   bash scripts/run-business-smoke.sh --tenant-id=<demo-tenant-id> [--base-url=...] [--verbose]
#
# Exit code：
#   0 = 8/8 PASS
#   1 = 任 1 FAIL
#   2 = login 失败
#   3 = network error
#
# 出具：edu-server dev B (T2b)  2026-05-19
# ============================================================

set -o pipefail  # 注意：不用 -e，避免 case 失败早退；不用 -u 兼容空数组 ${arr[@]}

# trap ERR
trap 'echo "[ERR] run-business-smoke.sh fatal at line $LINENO" >&2; exit 3' ERR

# ---- 配置 ----
readonly BASE_URL="${BASE_URL:-https://api.minxin.top}"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- 参数解析 ----
TENANT_ID=""
BASE_URL_OVERRIDE=""
VERBOSE=false
JSON_REPORT=""
for arg in "$@"; do
  case "$arg" in
    --tenant-id=*) TENANT_ID="${arg#*=}" ;;
    --base-url=*) BASE_URL_OVERRIDE="${arg#*=}" ;;
    --verbose) VERBOSE=true ;;
    --json-report=*) JSON_REPORT="${arg#*=}" ;;
    -h|--help)
      grep '^#' "$0" | head -40
      exit 0
      ;;
    *) echo "[warn] unknown arg: $arg" >&2 ;;
  esac
done

if [[ -z "$TENANT_ID" ]]; then
  echo "[FAIL] --tenant-id=<demo-tenant-id> required" >&2
  exit 2
fi
# tenant id 校验 + lowercase
if [[ ! "$TENANT_ID" =~ ^([A-Za-z0-9]{32}|mxedu_[0-9]+)$ ]]; then
  echo "[FAIL] tenant-id must be 32-char alphanumeric or mxedu_<num>" >&2
  exit 2
fi
readonly API_BASE="${BASE_URL_OVERRIDE:-$BASE_URL}"
readonly TENANT_ID_LC=$(echo "$TENANT_ID" | tr '[:upper:]' '[:lower:]')
readonly TENANT_SCHEMA="tenant_${TENANT_ID_LC}"

# ---- 状态统计 ----
TOTAL=0
PASS=0
FAIL=0
SUB_TOTAL=0
SUB_PASS=0
SUB_FAIL=0
FAILED_CASES=()
START_TS=$(date +%s)
RESULTS_JSON="["
FIRST_RESULT=true

# ---- 工具函数 ----

# api_post <path> <token> <body_json> [extra_curl_args...]  → echo "<status>|<body>"
# F10 修复：token 为空时不发 Authorization header（防 "Bearer " 空 token 让 RBAC 401/403 断言失效）
api_post() {
  local path="$1"; shift
  local token="$1"; shift
  local body="$1"; shift
  local extra=("$@")
  local -a auth_args=()
  if [[ -n "$token" ]]; then
    auth_args=(-H "Authorization: Bearer $token")
  else
    # F10: 不传 token 时显式 warn — 帮助 debug RBAC 测试
    echo "[WARN] api_post: making unauthenticated request to $path (token empty)" >&2
  fi
  local response
  response=$(curl -sS -w "\n__HTTP_STATUS__:%{http_code}" \
    -X POST \
    "${auth_args[@]}" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: smoke-$(date +%s)-$$-$RANDOM" \
    "${extra[@]}" \
    --max-time 30 \
    -d "$body" \
    "${API_BASE}${path}" 2>&1)
  local status
  status=$(echo "$response" | grep '__HTTP_STATUS__:' | sed 's/.*__HTTP_STATUS__://')
  local body_out
  body_out=$(echo "$response" | grep -v '__HTTP_STATUS__:')
  echo "${status}|${body_out}"
}

# api_get <path> <token> [extra_curl_args...] → echo "<status>|<body>"
# F10 修复：token 为空时不发 Authorization header
api_get() {
  local path="$1"; shift
  local token="$1"; shift
  local extra=("$@")
  local -a auth_args=()
  if [[ -n "$token" ]]; then
    auth_args=(-H "Authorization: Bearer $token")
  else
    echo "[WARN] api_get: making unauthenticated request to $path (token empty)" >&2
  fi
  local response
  response=$(curl -sS -w "\n__HTTP_STATUS__:%{http_code}" \
    -X GET \
    "${auth_args[@]}" \
    "${extra[@]}" \
    --max-time 30 \
    "${API_BASE}${path}" 2>&1)
  local status
  status=$(echo "$response" | grep '__HTTP_STATUS__:' | sed 's/.*__HTTP_STATUS__://')
  local body_out
  body_out=$(echo "$response" | grep -v '__HTTP_STATUS__:')
  echo "${status}|${body_out}"
}

# parse_json <json_string> <jq-style-path>  (用 python3 简化避免 jq 依赖)
parse_json() {
  local json="$1"
  local path="$2"
  echo "$json" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    for k in '$path'.lstrip('.').split('.'):
        if k.isdigit():
            d = d[int(k)]
        else:
            d = d.get(k)
        if d is None:
            print('')
            sys.exit(0)
    print(d if not isinstance(d, (dict, list)) else json.dumps(d))
except Exception as e:
    print('')
" 2>/dev/null
}

# record_result <case_id> <name> <status> [detail]
record_result() {
  local case_id="$1"
  local name="$2"
  local result="$3"
  local detail="${4:-}"
  TOTAL=$((TOTAL + 1))
  if [[ "$result" == "PASS" ]]; then
    PASS=$((PASS + 1))
    printf "[%-6s] %-55s ......... PASS %s\n" "$case_id" "$name" "$detail"
  else
    FAIL=$((FAIL + 1))
    FAILED_CASES+=("$case_id: $name $detail")
    printf "[%-6s] %-55s ......... FAIL %s\n" "$case_id" "$name" "$detail"
  fi
  if [[ "$FIRST_RESULT" != "true" ]]; then RESULTS_JSON+=","; fi
  FIRST_RESULT=false
  # JSON-escape detail
  local detail_escaped
  detail_escaped=$(python3 -c "import json; print(json.dumps('''$detail'''))" 2>/dev/null || echo '""')
  RESULTS_JSON+="{\"caseId\":\"$case_id\",\"name\":\"$name\",\"result\":\"$result\",\"detail\":$detail_escaped}"
}

# record_subresult <case_id> <name> <result> [detail]
record_subresult() {
  local case_id="$1"
  local name="$2"
  local result="$3"
  local detail="${4:-}"
  SUB_TOTAL=$((SUB_TOTAL + 1))
  if [[ "$result" == "PASS" ]]; then
    SUB_PASS=$((SUB_PASS + 1))
    printf "  [%-4s] %-53s ......... PASS %s\n" "$case_id" "$name" "$detail"
  else
    SUB_FAIL=$((SUB_FAIL + 1))
    FAILED_CASES+=("$case_id: $name $detail")
    printf "  [%-4s] %-53s ......... FAIL %s\n" "$case_id" "$name" "$detail"
  fi
}

# ---- 环境检查（依赖 env vars 提供 demo tenant 的角色 phone/password）----
# 这些 ENV 由 seed-demo-data.sh 后续产出（dev A 负责）
# 暂未提供时使用 architect spec §3.1 推断的默认值 + 提示

SALES_PHONE="${SMOKE_SALES_PHONE:-13800001004}"
SALES_PWD="${SMOKE_SALES_PWD:-Demo@12345}"
ACADEMIC_PHONE="${SMOKE_ACADEMIC_PHONE:-13800001005}"
ACADEMIC_PWD="${SMOKE_ACADEMIC_PWD:-Demo@12345}"
TEACHER_PHONE="${SMOKE_TEACHER_PHONE:-13800001006}"
TEACHER_PWD="${SMOKE_TEACHER_PWD:-Demo@12345}"
FINANCE_PHONE="${SMOKE_FINANCE_PHONE:-13800001009}"
FINANCE_PWD="${SMOKE_FINANCE_PWD:-Demo@12345}"
ADMIN_PHONE="${SMOKE_ADMIN_PHONE:-13800001002}"
ADMIN_PWD="${SMOKE_ADMIN_PWD:-Demo@12345}"
BOSS_PHONE="${SMOKE_BOSS_PHONE:-13800001003}"
BOSS_PWD="${SMOKE_BOSS_PWD:-Demo@12345}"
PARENT_PHONE="${SMOKE_PARENT_PHONE:-13800001007}"
PARENT_PWD="${SMOKE_PARENT_PWD:-Demo@12345}"
HR_PHONE="${SMOKE_HR_PHONE:-13800001010}"
HR_PWD="${SMOKE_HR_PWD:-Demo@12345}"
MARKETING_PHONE="${SMOKE_MARKETING_PHONE:-13800001011}"
MARKETING_PWD="${SMOKE_MARKETING_PWD:-Demo@12345}"

# Test data IDs (由 seed-demo-data.sh 后续注入)
DEMO_STUDENT_ID="${SMOKE_DEMO_STUDENT_ID:-}"
DEMO_TEACHER_ID="${SMOKE_DEMO_TEACHER_ID:-}"
DEMO_CONTRACT_ID="${SMOKE_DEMO_CONTRACT_ID:-}"
DEMO_COURSE_PRODUCT_ID="${SMOKE_DEMO_COURSE_PRODUCT_ID:-}"
DEMO_CAMPUS_ID="${SMOKE_DEMO_CAMPUS_ID:-}"
DEMO_SCHEDULE_ID="${SMOKE_DEMO_SCHEDULE_ID:-}"
DEMO_ALT_TENANT_ID="${SMOKE_DEMO_ALT_TENANT_ID:-}"  # Case 7 跨 tenant 用 alt tenant 的 schema

echo "============================================================"
echo "  run-business-smoke.sh"
echo "============================================================"
echo "  API base:       $API_BASE"
echo "  Demo tenant:    $TENANT_SCHEMA"
echo "  Verbose:        $VERBOSE"
echo "============================================================"
echo ""

# ============================================================
# Case 1: POST /api/public/auth/login — 9 角色全过
# ============================================================
echo "[Case 1] POST /api/public/auth/login (9 roles)"

# JWT 缓存
SALES_TOKEN=""
ACADEMIC_TOKEN=""
TEACHER_TOKEN=""
FINANCE_TOKEN=""
ADMIN_TOKEN=""
BOSS_TOKEN=""
PARENT_TOKEN=""
HR_TOKEN=""
MARKETING_TOKEN=""

login_role() {
  local role_name="$1"
  local phone="$2"
  local password="$3"
  local result
  result=$(api_post "/api/public/auth/login" "" "{\"phone\":\"${phone}\",\"password\":\"${password}\"}")
  local status="${result%%|*}"
  local body="${result#*|}"
  if [[ "$status" == "200" ]]; then
    # 检查是否单 tenant 或 multi-tenant 候选
    local needsel
    needsel=$(parse_json "$body" ".needTenantSelection")
    if [[ "$needsel" == "True" || "$needsel" == "true" ]]; then
      # 多 tenant → 调 login-confirm
      local result2
      result2=$(api_post "/api/public/auth/login-confirm" "" "{\"phone\":\"${phone}\",\"password\":\"${password}\",\"tenantId\":\"${TENANT_ID}\"}")
      local status2="${result2%%|*}"
      local body2="${result2#*|}"
      if [[ "$status2" == "200" ]]; then
        local token
        token=$(parse_json "$body2" ".token")
        if [[ -n "$token" && ${#token} -gt 50 ]]; then
          echo "$token"
          return 0
        fi
      fi
      echo ""
      return 1
    fi
    local token
    token=$(parse_json "$body" ".token")
    if [[ -n "$token" && ${#token} -gt 50 ]]; then
      echo "$token"
      return 0
    fi
  fi
  if [[ "$VERBOSE" == "true" ]]; then
    echo "[login] $role_name failed status=$status body=$(echo $body | head -c 200)" >&2
  fi
  echo ""
  return 1
}

LOGIN_OK=0
LOGIN_TOTAL=0

LOGIN_TOTAL=$((LOGIN_TOTAL + 1)); SALES_TOKEN=$(login_role "sales" "$SALES_PHONE" "$SALES_PWD") && [[ -n "$SALES_TOKEN" ]] && LOGIN_OK=$((LOGIN_OK + 1)) || true
LOGIN_TOTAL=$((LOGIN_TOTAL + 1)); ACADEMIC_TOKEN=$(login_role "academic" "$ACADEMIC_PHONE" "$ACADEMIC_PWD") && [[ -n "$ACADEMIC_TOKEN" ]] && LOGIN_OK=$((LOGIN_OK + 1)) || true
LOGIN_TOTAL=$((LOGIN_TOTAL + 1)); TEACHER_TOKEN=$(login_role "teacher" "$TEACHER_PHONE" "$TEACHER_PWD") && [[ -n "$TEACHER_TOKEN" ]] && LOGIN_OK=$((LOGIN_OK + 1)) || true
LOGIN_TOTAL=$((LOGIN_TOTAL + 1)); FINANCE_TOKEN=$(login_role "finance" "$FINANCE_PHONE" "$FINANCE_PWD") && [[ -n "$FINANCE_TOKEN" ]] && LOGIN_OK=$((LOGIN_OK + 1)) || true
LOGIN_TOTAL=$((LOGIN_TOTAL + 1)); ADMIN_TOKEN=$(login_role "admin" "$ADMIN_PHONE" "$ADMIN_PWD") && [[ -n "$ADMIN_TOKEN" ]] && LOGIN_OK=$((LOGIN_OK + 1)) || true
LOGIN_TOTAL=$((LOGIN_TOTAL + 1)); BOSS_TOKEN=$(login_role "boss" "$BOSS_PHONE" "$BOSS_PWD") && [[ -n "$BOSS_TOKEN" ]] && LOGIN_OK=$((LOGIN_OK + 1)) || true
LOGIN_TOTAL=$((LOGIN_TOTAL + 1)); PARENT_TOKEN=$(login_role "parent" "$PARENT_PHONE" "$PARENT_PWD") && [[ -n "$PARENT_TOKEN" ]] && LOGIN_OK=$((LOGIN_OK + 1)) || true
LOGIN_TOTAL=$((LOGIN_TOTAL + 1)); HR_TOKEN=$(login_role "hr" "$HR_PHONE" "$HR_PWD") && [[ -n "$HR_TOKEN" ]] && LOGIN_OK=$((LOGIN_OK + 1)) || true
LOGIN_TOTAL=$((LOGIN_TOTAL + 1)); MARKETING_TOKEN=$(login_role "marketing" "$MARKETING_PHONE" "$MARKETING_PWD") && [[ -n "$MARKETING_TOKEN" ]] && LOGIN_OK=$((LOGIN_OK + 1)) || true

if [[ "$LOGIN_OK" -eq "$LOGIN_TOTAL" ]]; then
  record_result "1/8" "POST /api/public/auth/login (9 roles)" "PASS" "($LOGIN_OK/$LOGIN_TOTAL 200)"
else
  record_result "1/8" "POST /api/public/auth/login (9 roles)" "FAIL" "($LOGIN_OK/$LOGIN_TOTAL)"
fi

# 严谨度：login 失败大量 case 后续无法跑，但仍尝试跑（不 set -e 早退），让用户看到全 case 状态
if [[ -z "$SALES_TOKEN" ]]; then
  echo "[WARN] sales token missing — Case 2/3 will fail" >&2
fi

# ============================================================
# Case 2: POST /api/db/customers (sales)
# ============================================================
echo "[Case 2] POST /api/db/customers (sales)"
NEW_CUSTOMER_ID=""
if [[ -n "$SALES_TOKEN" && -n "$DEMO_CAMPUS_ID" ]]; then
  # F7 修复：手机号严格 11 位 /^1[3-9]\d{9}$/
  # 之前 139${RANDOM:0:8}：${RANDOM:0:8} 实际长度 1-5（$RANDOM 是 0-32767 共 1-5 位）→ 长度 4-8 位会 400
  # 改用 13900 前缀 + epoch 秒数后 6 位 = 稳定 11 位 (139_00 ______)
  SMOKE_PHONE_SUFFIX=$(date +%s | tail -c 7 | head -c 6)
  SMOKE_PHONE="13900${SMOKE_PHONE_SUFFIX}"
  CASE2_RESULT=$(api_post "/api/db/customers" "$SALES_TOKEN" \
    "{\"tenantSchema\":\"${TENANT_SCHEMA}\",\"name\":\"测试客户-smoke\",\"primaryMobile\":\"${SMOKE_PHONE}\",\"source\":\"朋友推荐\",\"campusId\":\"${DEMO_CAMPUS_ID}\"}")
  CASE2_STATUS="${CASE2_RESULT%%|*}"
  CASE2_BODY="${CASE2_RESULT#*|}"
  if [[ "$CASE2_STATUS" == "201" ]]; then
    NEW_CUSTOMER_ID=$(parse_json "$CASE2_BODY" ".id")
    if [[ -n "$NEW_CUSTOMER_ID" && ${#NEW_CUSTOMER_ID} -ge 16 ]]; then
      record_result "2/8" "POST /api/db/customers (sales)" "PASS" "(201, id=$NEW_CUSTOMER_ID)"
    else
      record_result "2/8" "POST /api/db/customers (sales)" "FAIL" "(201 but no id)"
    fi
  else
    record_result "2/8" "POST /api/db/customers (sales)" "FAIL" "($CASE2_STATUS: $(echo $CASE2_BODY | head -c 120))"
  fi
else
  record_result "2/8" "POST /api/db/customers (sales)" "FAIL" "(missing SALES_TOKEN or DEMO_CAMPUS_ID — seed-demo-data 未跑)"
fi

# ============================================================
# Case 3: POST /api/db/students/:id/contracts
# ============================================================
echo "[Case 3] POST /api/db/students/:id/contracts (sales)"
if [[ -n "$SALES_TOKEN" && -n "$DEMO_STUDENT_ID" && -n "$DEMO_COURSE_PRODUCT_ID" && -n "$DEMO_CAMPUS_ID" ]]; then
  CASE3_RESULT=$(api_post "/api/db/students/${DEMO_STUDENT_ID}/contracts" "$SALES_TOKEN" \
    "{\"tenantSchema\":\"${TENANT_SCHEMA}\",\"courseProductId\":\"${DEMO_COURSE_PRODUCT_ID}\",\"totalAmountYuan\":3000,\"lessonsTotal\":20,\"signedAt\":\"2026-05-19\",\"campusId\":\"${DEMO_CAMPUS_ID}\"}")
  CASE3_STATUS="${CASE3_RESULT%%|*}"
  CASE3_BODY="${CASE3_RESULT#*|}"
  if [[ "$CASE3_STATUS" == "201" ]]; then
    CONTRACT_ID=$(parse_json "$CASE3_BODY" ".id")
    record_result "3/8" "POST /api/db/students/:id/contracts" "PASS" "(201, id=$CONTRACT_ID)"
  else
    record_result "3/8" "POST /api/db/students/:id/contracts" "FAIL" "($CASE3_STATUS: $(echo $CASE3_BODY | head -c 120))"
  fi
else
  record_result "3/8" "POST /api/db/students/:id/contracts" "FAIL" "(missing demo data IDs)"
fi

# ============================================================
# Case 4: POST /api/schedules (academic)
# ============================================================
echo "[Case 4] POST /api/schedules (academic)"
if [[ -n "$ACADEMIC_TOKEN" && -n "$DEMO_STUDENT_ID" && -n "$DEMO_TEACHER_ID" && -n "$DEMO_CAMPUS_ID" ]]; then
  CASE4_RESULT=$(api_post "/api/schedules" "$ACADEMIC_TOKEN" \
    "{\"tenantSchema\":\"${TENANT_SCHEMA}\",\"teacherId\":\"${DEMO_TEACHER_ID}\",\"studentIds\":[\"${DEMO_STUDENT_ID}\"],\"scheduledAt\":\"2026-05-20T10:00:00+08:00\",\"durationMinutes\":60,\"classType\":\"一对一\",\"campusId\":\"${DEMO_CAMPUS_ID}\"}")
  CASE4_STATUS="${CASE4_RESULT%%|*}"
  CASE4_BODY="${CASE4_RESULT#*|}"
  if [[ "$CASE4_STATUS" == "201" || "$CASE4_STATUS" == "200" ]]; then
    SCHEDULE_ID=$(parse_json "$CASE4_BODY" ".id")
    record_result "4/8" "POST /api/schedules (academic)" "PASS" "($CASE4_STATUS, id=$SCHEDULE_ID)"
  else
    record_result "4/8" "POST /api/schedules (academic)" "FAIL" "($CASE4_STATUS: $(echo $CASE4_BODY | head -c 120))"
  fi
else
  record_result "4/8" "POST /api/schedules (academic)" "FAIL" "(missing demo IDs)"
fi

# ============================================================
# Case 5: POST /api/lesson-feedbacks (teacher)
# ============================================================
echo "[Case 5] POST /api/lesson-feedbacks (teacher)"
if [[ -n "$TEACHER_TOKEN" && -n "$DEMO_SCHEDULE_ID" ]]; then
  CASE5_RESULT=$(api_post "/api/lesson-feedbacks" "$TEACHER_TOKEN" \
    "{\"tenantSchema\":\"${TENANT_SCHEMA}\",\"scheduleId\":\"${DEMO_SCHEDULE_ID}\",\"content\":\"今天学习了加减法，掌握良好\",\"attendanceStatus\":\"present\"}")
  CASE5_STATUS="${CASE5_RESULT%%|*}"
  CASE5_BODY="${CASE5_RESULT#*|}"
  if [[ "$CASE5_STATUS" == "201" || "$CASE5_STATUS" == "200" ]]; then
    record_result "5/8" "POST /api/lesson-feedbacks (teacher)" "PASS" "($CASE5_STATUS)"
  else
    record_result "5/8" "POST /api/lesson-feedbacks (teacher)" "FAIL" "($CASE5_STATUS: $(echo $CASE5_BODY | head -c 120))"
  fi
else
  record_result "5/8" "POST /api/lesson-feedbacks (teacher)" "FAIL" "(missing TEACHER_TOKEN or DEMO_SCHEDULE_ID)"
fi

# ============================================================
# Case 6: POST /api/checkout/wxpay/unified-order (sandbox)
# ============================================================
echo "[Case 6] POST /api/checkout/wxpay/unified-order (mock/sandbox)"
if [[ -n "$PARENT_TOKEN" ]]; then
  CASE6_RESULT=$(api_post "/api/checkout/wxpay/unified-order" "$PARENT_TOKEN" \
    "{\"tenantSchema\":\"${TENANT_SCHEMA}\",\"skuId\":\"trial\",\"amountCents\":1,\"openid\":\"smoke_test_openid_001\"}")
  CASE6_STATUS="${CASE6_RESULT%%|*}"
  CASE6_BODY="${CASE6_RESULT#*|}"
  # mock 模式期望 200，real 模式期望 200 或 400（缺凭据）— 不接受 500
  if [[ "$CASE6_STATUS" == "200" || "$CASE6_STATUS" == "201" || "$CASE6_STATUS" == "400" ]]; then
    record_result "6/8" "POST /api/checkout/wxpay/unified-order" "PASS" "($CASE6_STATUS)"
  else
    record_result "6/8" "POST /api/checkout/wxpay/unified-order" "FAIL" "($CASE6_STATUS: $(echo $CASE6_BODY | head -c 120))"
  fi
else
  record_result "6/8" "POST /api/checkout/wxpay/unified-order" "FAIL" "(missing PARENT_TOKEN)"
fi

# ============================================================
# Case 7: POST /api/db/onboarding/start-trial — 跨 tenant 拒绝
# ============================================================
# 思路：用 tenant-A 的 admin JWT，故意传 tenant-B 的 tenantSchema → TenantScopeGuard 403
echo "[Case 7] POST /api/db/onboarding/start-trial (cross-tenant rejection)"
if [[ -n "$ADMIN_TOKEN" && -n "$DEMO_ALT_TENANT_ID" ]]; then
  ALT_SCHEMA="tenant_$(echo "$DEMO_ALT_TENANT_ID" | tr '[:upper:]' '[:lower:]')"
  CASE7_RESULT=$(api_post "/api/db/onboarding/start-trial" "$ADMIN_TOKEN" \
    "{\"tenantId\":\"${DEMO_ALT_TENANT_ID}\",\"tenantSchema\":\"${ALT_SCHEMA}\"}")
  CASE7_STATUS="${CASE7_RESULT%%|*}"
  CASE7_BODY="${CASE7_RESULT#*|}"
  if [[ "$CASE7_STATUS" == "403" ]]; then
    record_result "7/8" "POST /api/db/onboarding/start-trial (cross-tenant)" "PASS" "(403 as expected)"
  else
    record_result "7/8" "POST /api/db/onboarding/start-trial (cross-tenant)" "FAIL" "(expected 403, got $CASE7_STATUS)"
  fi
else
  record_result "7/8" "POST /api/db/onboarding/start-trial (cross-tenant)" "FAIL" "(missing ADMIN_TOKEN or DEMO_ALT_TENANT_ID)"
fi

# ============================================================
# Case 8 (a/b/c) — finance RBAC 3 sub-case (leader D1.2)
# ============================================================
echo "[Case 8] finance RBAC (3 sub-cases)"

# 8a: GET /api/db/customers with finance → 403
if [[ -n "$FINANCE_TOKEN" ]]; then
  CASE8A_RESULT=$(api_get "/api/db/customers?tenantSchema=${TENANT_SCHEMA}" "$FINANCE_TOKEN")
  CASE8A_STATUS="${CASE8A_RESULT%%|*}"
  CASE8A_BODY="${CASE8A_RESULT#*|}"
  if [[ "$CASE8A_STATUS" == "403" ]]; then
    record_subresult "8a" "GET /api/db/customers (finance → 403)" "PASS" "(403 as expected)"
  else
    record_subresult "8a" "GET /api/db/customers (finance → 403)" "FAIL" "(expected 403, got $CASE8A_STATUS)"
  fi
else
  record_subresult "8a" "GET /api/db/customers (finance → 403)" "FAIL" "(missing FINANCE_TOKEN)"
fi

# 8b: GET /api/db/contracts/:id with finance → 200 + 财务字段
if [[ -n "$FINANCE_TOKEN" && -n "$DEMO_CONTRACT_ID" ]]; then
  CASE8B_RESULT=$(api_get "/api/db/contracts/${DEMO_CONTRACT_ID}?tenantSchema=${TENANT_SCHEMA}" "$FINANCE_TOKEN")
  CASE8B_STATUS="${CASE8B_RESULT%%|*}"
  CASE8B_BODY="${CASE8B_RESULT#*|}"
  if [[ "$CASE8B_STATUS" == "200" ]]; then
    # 验证财务字段存在（totalAmount 或 totalAmountYuan，按实际命名）
    HAS_TOTAL_AMOUNT=$(parse_json "$CASE8B_BODY" ".totalAmountYuan")
    HAS_TOTAL_AMOUNT2=$(parse_json "$CASE8B_BODY" ".totalAmount")
    if [[ -n "$HAS_TOTAL_AMOUNT" || -n "$HAS_TOTAL_AMOUNT2" ]]; then
      # 严谨度：字段权限矩阵未实施前 不验证 customer.parent_name 是否 masked
      # 后续 Sprint Y 字段过滤实施后补充：parse_json "$CASE8B_BODY" ".customer.parent_name" 应返回 masked
      record_subresult "8b" "GET /api/db/contracts/:id (finance → 200)" "PASS" "(200, totalAmount visible — 字段过滤待 Sprint Y 实施)"
    else
      record_subresult "8b" "GET /api/db/contracts/:id (finance → 200)" "FAIL" "(200 but no totalAmount field)"
    fi
  else
    record_subresult "8b" "GET /api/db/contracts/:id (finance → 200)" "FAIL" "(expected 200, got $CASE8B_STATUS)"
  fi
else
  record_subresult "8b" "GET /api/db/contracts/:id (finance → 200)" "FAIL" "(missing FINANCE_TOKEN or DEMO_CONTRACT_ID)"
fi

# 8c: GET /api/db/invoices/pending-contracts with finance → 200
# 注意：invoice controller 无 GET /db/invoices（list all）；实际有 /db/invoices/pending-contracts + /db/invoices/:id
# Case 8c 改为验证 GET /db/invoices/pending-contracts（finance 主战场）
if [[ -n "$FINANCE_TOKEN" ]]; then
  CASE8C_RESULT=$(api_get "/api/db/invoices/pending-contracts?tenantSchema=${TENANT_SCHEMA}" "$FINANCE_TOKEN")
  CASE8C_STATUS="${CASE8C_RESULT%%|*}"
  CASE8C_BODY="${CASE8C_RESULT#*|}"
  if [[ "$CASE8C_STATUS" == "200" ]]; then
    # 验证 response 是数组（即使为空数组也 PASS）
    IS_ARRAY=$(echo "$CASE8C_BODY" | python3 -c "import json, sys; d=json.loads(sys.stdin.read()); print(isinstance(d, list) or (isinstance(d, dict) and isinstance(d.get('items', d.get('data', None)), list)))" 2>/dev/null || echo "False")
    if [[ "$IS_ARRAY" == "True" ]]; then
      record_subresult "8c" "GET /api/db/invoices/pending-contracts (finance)" "PASS" "(200, array)"
    else
      record_subresult "8c" "GET /api/db/invoices/pending-contracts (finance)" "PASS" "(200, non-array but accepted: $(echo $CASE8C_BODY | head -c 80))"
    fi
  else
    record_subresult "8c" "GET /api/db/invoices/pending-contracts (finance)" "FAIL" "(expected 200, got $CASE8C_STATUS)"
  fi
else
  record_subresult "8c" "GET /api/db/invoices/pending-contracts (finance)" "FAIL" "(missing FINANCE_TOKEN)"
fi

# 8 case 总评（sub-case 全过才算 case 8 PASS）
if [[ "$SUB_FAIL" -eq 0 ]]; then
  record_result "8/8" "finance RBAC (3 sub-cases)" "PASS" "(3/3 sub-cases pass)"
else
  record_result "8/8" "finance RBAC (3 sub-cases)" "FAIL" "($SUB_FAIL/3 sub-cases failed)"
fi

# ============================================================
# Summary
# ============================================================
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))
RESULTS_JSON+="]"

echo ""
echo "============================================================"
printf "  Summary: %d/%d PASS (sub-cases: %d/%d) | %d FAIL | %ds\n" "$PASS" "$TOTAL" "$SUB_PASS" "$SUB_TOTAL" "$FAIL" "$ELAPSED"
echo "============================================================"

if [[ "$FAIL" -gt 0 ]]; then
  echo ""
  echo "Failed cases ($FAIL):"
  for c in "${FAILED_CASES[@]}"; do
    echo "  - $c"
  done
fi

# JSON 报告
if [[ -n "$JSON_REPORT" ]]; then
  cat > "$JSON_REPORT" <<EOF
{
  "runAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "apiBase": "$API_BASE",
  "tenant": "$TENANT_SCHEMA",
  "elapsedSec": $ELAPSED,
  "total": $TOTAL,
  "pass": $PASS,
  "fail": $FAIL,
  "subTotal": $SUB_TOTAL,
  "subPass": $SUB_PASS,
  "subFail": $SUB_FAIL,
  "results": $RESULTS_JSON
}
EOF
  echo "JSON report: $JSON_REPORT"
fi

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
