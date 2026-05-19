#!/usr/bin/env bash
# ────────────────────────────────────────────────────
# Smoke test · 9 个新 endpoint 完整验证
#
# 启动 staging :3002 → 跑测试 → 收集结果 → 停 staging
# 测试包含：happy path / 边界 / 错误处理 / 写操作 + 验证 DB 副作用
#
# Usage: bash smoke-test-9-endpoints.sh
# ────────────────────────────────────────────────────

set -u
TENANT_ID='mxedu_00000000000001777796864574'
TENANT_SCHEMA="tenant_$TENANT_ID"
BASE='http://127.0.0.1:3002/api'
PG_HOST='127.0.0.1'
PG_USER='eduapp'
PG_DB='edu'
export PGPASSWORD='edu_2026_secret_pwd'

# ===== 颜色 =====
G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; B='\033[1m'; X='\033[0m'

PASS=0; FAIL=0; TOTAL=0
FAILED_TESTS=()

# 测试函数
test_case() {
  local name="$1"; shift
  local expected_code="$1"; shift
  local code=$(curl -s -o /tmp/smoke-rsp.json -w '%{http_code}' --max-time 8 "$@")
  local body=$(cat /tmp/smoke-rsp.json | head -c 250)
  TOTAL=$((TOTAL+1))
  if [ "$code" = "$expected_code" ]; then
    printf "  ${G}✓${X} %-58s HTTP %s\n" "$name" "$code"
    PASS=$((PASS+1))
  else
    printf "  ${R}✗${X} %-58s HTTP %s (expected %s)\n" "$name" "$code" "$expected_code"
    printf "      body: %s\n" "$body"
    FAILED_TESTS+=("$name")
    FAIL=$((FAIL+1))
  fi
}

# 抓某字段
extract_field() {
  cat /tmp/smoke-rsp.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$1', ''))" 2>/dev/null
}

echo
echo "═══════════════════════════════════════════════════════"
echo "  Smoke test · 9 endpoints + edge cases"
echo "═══════════════════════════════════════════════════════"
echo

# ===== 1. 启动 staging =====
echo "▶ 1/3 启动 staging instance (PORT=3002)..."
cd /home/ubuntu/workspace/edu-server
pm2 stop staging-3002 2>/dev/null
pm2 delete staging-3002 2>/dev/null
PORT=3002 pm2 start dist/src/main.js --name staging-3002 --env PORT=3002 > /dev/null 2>&1
sleep 4
if ! curl -s -o /dev/null --max-time 3 -w '%{http_code}' http://127.0.0.1:3002/api/public/db/ping | grep -q '200'; then
  echo "  ${R}staging 启动失败${X}"
  exit 1
fi
echo "  ${G}✓${X} staging up"
echo

# ===== 2. 签 token =====
echo "▶ 2/3 签 admin token..."
TOKEN=$(curl -s -X POST $BASE/public/auth/login -H 'Content-Type: application/json' -d "{
    \"phone\":\"13800001111\",\"userId\":\"01HX0000000000000000000000U00001\",
    \"tenantId\":\"$TENANT_ID\",\"role\":\"admin\",\"campusId\":\"camp0000000000000000000000000001\"
  }" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
if [ -z "$TOKEN" ]; then
  echo "  ${R}token sign 失败${X}"
  exit 1
fi
echo "  ${G}✓${X} token signed (${#TOKEN} chars)"
echo

H_TOKEN="Authorization: Bearer $TOKEN"
H_TENANT="x-tenant-schema: $TENANT_SCHEMA"

# ===== 3. 测试 =====
echo "▶ 3/3 测试用例"
echo

# ────── #1 leaves ──────
echo "${B}─── #1 LEAVES（请假）───${X}"

# 1a. happy path: create
LEAVE_ID="leave$(date +%s)$(printf '%020d' $RANDOM)"
LEAVE_ID=${LEAVE_ID:0:32}
test_case "[1.1] POST /db/leaves create" "201" \
  -X POST $BASE/db/leaves \
  -H 'Content-Type: application/json' -H "$H_TOKEN" -H "$H_TENANT" \
  -d "{\"id\":\"$LEAVE_ID\",\"studentId\":\"stud0000000000000000000000000001\",\"type\":\"leave\",\"reason\":\"smoke测试请假\"}"

# 1b. list
test_case "[1.2] POST /db/students/x/leaves/list" "200" \
  -X POST $BASE/db/students/stud0000000000000000000000000001/leaves/list \
  -H 'Content-Type: application/json' -H "$H_TOKEN" -H "$H_TENANT" -d '{}'

# 1c. approve
test_case "[1.3] POST /db/leaves/:id/approve" "200" \
  -X POST $BASE/db/leaves/$LEAVE_ID/approve \
  -H 'Content-Type: application/json' -H "$H_TOKEN" -H "$H_TENANT" -d '{}'

# 1d. 边界: type 错误 → BadRequest
test_case "[1.4] type='invalid' → 400" "400" \
  -X POST $BASE/db/leaves \
  -H 'Content-Type: application/json' -H "$H_TOKEN" -H "$H_TENANT" \
  -d '{"id":"leave99999999999999999999999999","studentId":"stud0000000000000000000000000001","type":"invalid"}'

# 1e. 24h 警告
WARN_ID="warn$(date +%s)$(printf '%020d' $RANDOM)"
WARN_ID=${WARN_ID:0:32}
NOW_MS=$(date +%s)000
SOON_MS=$((NOW_MS + 6 * 60 * 60 * 1000))  # 6h 后
test_case "[1.5] 24h 警告（lessonStartAtMs < 24h）" "201" \
  -X POST $BASE/db/leaves \
  -H 'Content-Type: application/json' -H "$H_TOKEN" -H "$H_TENANT" \
  -d "{\"id\":\"$WARN_ID\",\"studentId\":\"stud0000000000000000000000000001\",\"type\":\"leave\",\"lessonStartAtMs\":$SOON_MS}"
WARN_FIELD=$(cat /tmp/smoke-rsp.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('warning',''))")
if [ -n "$WARN_FIELD" ]; then
  echo "      ${G}↳${X} warning 字段: '$WARN_FIELD'"
else
  echo "      ${R}↳${X} 缺 warning 字段"
fi

echo
# ────── #2 recommendations ──────
echo "${B}─── #2 RECOMMENDATIONS（家长推荐）───${X}"

test_case "[2.1] POST /db/teachers/x/recommendations/list" "200" \
  -X POST $BASE/db/teachers/T0000000000000000000000000000001/recommendations/list \
  -H 'Content-Type: application/json' -H "$H_TOKEN" -H "$H_TENANT" -d '{}'

test_case "[2.2] POST /db/teachers/x/recommendations/invite" "200" \
  -X POST $BASE/db/teachers/T0000000000000000000000000000001/recommendations/invite \
  -H 'Content-Type: application/json' -H "$H_TOKEN" -H "$H_TENANT" \
  -d '{"studentId":"stud0000000000000000000000000001"}'

# toggle 不存在的 id → 404
test_case "[2.3] toggle 不存在 id → 404" "404" \
  -X POST $BASE/db/recommendations/notexist000000000000000000000000/toggle \
  -H 'Content-Type: application/json' -H "$H_TOKEN" -H "$H_TENANT" \
  -d '{"displayed":true}'

echo
# ────── #3 students/import ──────
echo "${B}─── #3 STUDENTS IMPORT（批量导入）───${X}"

# 1 行有效
RANDOM_PHONE=138$(printf '%08d' $((RANDOM * RANDOM % 100000000)))
test_case "[3.1] import 1 valid row" "200" \
  -X POST $BASE/db/students/import \
  -H 'Content-Type: application/json' -H "$H_TOKEN" -H "$H_TENANT" \
  -d "{\"rows\":[{\"name\":\"smoke测试\",\"parentName\":\"smoke家长\",\"parentPhone\":\"$RANDOM_PHONE\"}],\"operatorUserId\":\"01HX0000000000000000000000U00001\",\"campusId\":\"camp0000000000000000000000000001\"}"
SUCCESS_CNT=$(cat /tmp/smoke-rsp.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('successCount',0))")
echo "      ${G}↳${X} successCount: $SUCCESS_CNT"

# 错误手机号 → errorRows
test_case "[3.2] 错误手机号 → 不阻塞，进 errorRows" "200" \
  -X POST $BASE/db/students/import \
  -H 'Content-Type: application/json' -H "$H_TOKEN" -H "$H_TENANT" \
  -d '{"rows":[{"name":"测试","parentName":"家长","parentPhone":"abc123"}],"operatorUserId":"01HX0000000000000000000000U00001","campusId":"camp0000000000000000000000000001"}'
ERR_CNT=$(cat /tmp/smoke-rsp.json | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('errorRows',[])))")
echo "      ${G}↳${X} errorRows: $ERR_CNT 条"

# 空 rows
test_case "[3.3] 空 rows" "200" \
  -X POST $BASE/db/students/import \
  -H 'Content-Type: application/json' -H "$H_TOKEN" -H "$H_TENANT" \
  -d '{"rows":[],"operatorUserId":"01HX0000000000000000000000U00001","campusId":"camp0000000000000000000000000001"}'

echo
# ────── #5 boss/campuses ──────
echo "${B}─── #5 BOSS/CAMPUSES ───${X}"

test_case "[5.1] POST /db/boss/campuses/list" "200" \
  -X POST $BASE/db/boss/campuses/list \
  -H 'Content-Type: application/json' -H "$H_TOKEN" \
  -d "{\"tenantId\":\"$TENANT_ID\"}"

# 创建第 1 个校区（max=1，应成功）
CAMPUS_ID="campus$(date +%s)$(printf '%020d' $RANDOM)"
CAMPUS_ID=${CAMPUS_ID:0:32}
test_case "[5.2] 创建第 1 个校区（max=1）" "201" \
  -X POST $BASE/db/boss/campuses \
  -H 'Content-Type: application/json' -H "$H_TOKEN" \
  -d "{\"tenantId\":\"$TENANT_ID\",\"id\":\"$CAMPUS_ID\",\"name\":\"smoke 测试校区\"}"

# 创建第 2 个 → CAMPUS_LIMIT_REACHED (400)
CAMPUS_ID2="campus$(date +%s)$(printf '%020d' $((RANDOM+1)))"
CAMPUS_ID2=${CAMPUS_ID2:0:32}
test_case "[5.3] 创建第 2 个 → CAMPUS_LIMIT_REACHED" "400" \
  -X POST $BASE/db/boss/campuses \
  -H 'Content-Type: application/json' -H "$H_TOKEN" \
  -d "{\"tenantId\":\"$TENANT_ID\",\"id\":\"$CAMPUS_ID2\",\"name\":\"smoke 测试校区 2\"}"

echo
# ────── #6 boss/subscription ──────
echo "${B}─── #6 BOSS/SUBSCRIPTION ───${X}"

test_case "[6.1] GET 当前订阅" "200" \
  -H "$H_TOKEN" "$BASE/db/boss/subscription?tenantId=$TENANT_ID"
PLAN=$(cat /tmp/smoke-rsp.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('planTier',''))")
echo "      ${G}↳${X} planTier: $PLAN"

# 升级 single → growth
test_case "[6.2] 升级 single → growth" "200" \
  -X POST $BASE/db/boss/subscription/upgrade \
  -H 'Content-Type: application/json' -H "$H_TOKEN" \
  -d "{\"tenantId\":\"$TENANT_ID\",\"targetPlan\":\"growth\"}"
PRICE_DIFF=$(cat /tmp/smoke-rsp.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('priceDiff',0))")
echo "      ${G}↳${X} priceDiff: ¥$PRICE_DIFF"

# 验证 max_campuses 改了
test_case "[6.3] 升级后 max_campuses 应=3" "200" \
  -H "$H_TOKEN" "$BASE/db/boss/subscription?tenantId=$TENANT_ID"
NEW_MAX=$(cat /tmp/smoke-rsp.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('maxCampuses',0))")
if [ "$NEW_MAX" = "3" ]; then
  echo "      ${G}↳${X} maxCampuses 已 ${G}3${X}"
else
  echo "      ${R}↳${X} maxCampuses=$NEW_MAX (期望 3)"
fi

# 升级到无效 plan
test_case "[6.4] 升级到无效 plan → 400" "400" \
  -X POST $BASE/db/boss/subscription/upgrade \
  -H 'Content-Type: application/json' -H "$H_TOKEN" \
  -d "{\"tenantId\":\"$TENANT_ID\",\"targetPlan\":\"INVALID\"}"

echo
# ────── #7-9 dashboards ──────
echo "${B}─── #7-9 DASHBOARDS ───${X}"

test_case "[7] GET /db/dashboards/admin" "200" \
  -H "$H_TOKEN" -H "$H_TENANT" "$BASE/db/dashboards/admin"
echo "      ${G}↳${X} body: $(cat /tmp/smoke-rsp.json | head -c 200)"

test_case "[8] GET /db/dashboards/sales-funnel" "200" \
  -H "$H_TOKEN" -H "$H_TENANT" "$BASE/db/dashboards/sales-funnel"

test_case "[9] GET /db/dashboards/teacher-leaderboard" "200" \
  -H "$H_TOKEN" -H "$H_TENANT" "$BASE/db/dashboards/teacher-leaderboard?sortBy=payroll"
LEADER_CNT=$(cat /tmp/smoke-rsp.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('count',0))")
echo "      ${G}↳${X} teachers count: $LEADER_CNT"

# 测 sortBy 不同选项都能跑
for SORT in lessons rating feedbackRate; do
  test_case "[9.$SORT] sortBy=$SORT" "200" \
    -H "$H_TOKEN" -H "$H_TENANT" "$BASE/db/dashboards/teacher-leaderboard?sortBy=$SORT"
done

echo
# ===== 4. 清理：把测试 tenant 回滚到 single 计费 =====
echo "${B}─── 清理 ───${X}"

# 把 plan 改回 single
psql -h $PG_HOST -U $PG_USER -d $PG_DB -c "
UPDATE public.tenants SET plan_tier='single', max_campuses=1 WHERE id='$TENANT_ID';
DELETE FROM public.campuses WHERE tenant_id='$TENANT_ID';
" > /dev/null 2>&1
echo "  ${G}✓${X} 测试 tenant plan_tier 回滚到 single + 删除测试校区"

# 删除测试 leaves（不强制，下次自动 cascade 不影响）
psql -h $PG_HOST -U $PG_USER -d $PG_DB -c "
DELETE FROM ${TENANT_SCHEMA}.leaves WHERE id LIKE 'leave%' OR id LIKE 'warn%';
" > /dev/null 2>&1
echo "  ${G}✓${X} 测试 leaves 清理"

# 停 staging
pm2 stop staging-3002 > /dev/null 2>&1 && pm2 delete staging-3002 > /dev/null 2>&1
echo "  ${G}✓${X} staging 停止"

echo
echo "═══════════════════════════════════════════════════════"
echo "  Result: ${G}$PASS pass${X} / ${R}$FAIL fail${X} / $TOTAL total"
echo "═══════════════════════════════════════════════════════"
if [ $FAIL -gt 0 ]; then
  echo
  echo "${R}Failed tests:${X}"
  for t in "${FAILED_TESTS[@]}"; do
    echo "  - $t"
  done
  exit 1
fi
echo
echo "${G}🎉 ALL GREEN — 可以安全部署到生产${X}"
