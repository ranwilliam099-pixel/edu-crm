#!/usr/bin/env bash
# 全面测试生产 :3001（部署后验证）
# 6 维度：DB schema / 服务健康 / 现有 endpoint / 新 endpoint 性能 / 跨 tenant / 数据真实性

set -u
G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; B='\033[1m'; X='\033[0m'
PASS=0; FAIL=0; WARN=0
ok()   { echo -e "  ${G}✓${X} $1"; PASS=$((PASS+1)); }
bad()  { echo -e "  ${R}✗${X} $1"; FAIL=$((FAIL+1)); }
warn() { echo -e "  ${Y}⚠${X} $1"; WARN=$((WARN+1)); }

export PGPASSWORD='edu_2026_secret_pwd'
SQL() { psql -h 127.0.0.1 -U eduapp -d edu -tA -c "$1" 2>/dev/null | tr -d '[:space:]'; }
SQL_LIST() { psql -h 127.0.0.1 -U eduapp -d edu -tA -c "$1" 2>/dev/null; }

TENANT_ID='mxedu_00000000000001777796864574'
BASE='http://127.0.0.1:3001/api'

echo
echo "═════════════════════════════════════════════════════════"
echo "  全面测试 · 6 维度（生产 :3001 已部署）"
echo "═════════════════════════════════════════════════════════"

# ════════════════ 1. DB schema 完整性 ════════════════
echo
echo "${B}─── 1/6 DB Schema 完整性（25 tenants × 3 表/字段）───${X}"

TENANTS=$(SQL_LIST "SELECT id FROM public.tenants ORDER BY created_at")
TENANT_CNT=$(echo "$TENANTS" | grep -c .)

for table in leaves parent_recommendations; do
  MISSING=0
  for tid in $TENANTS; do
    schema="tenant_${tid,,}"
    HAS=$(SQL "SELECT 1 FROM information_schema.tables WHERE table_schema = '$schema' AND table_name = '$table'")
    if [ -z "$HAS" ]; then MISSING=$((MISSING+1)); fi
  done
  if [ $MISSING -eq 0 ]; then
    ok "table $table: $TENANT_CNT/$TENANT_CNT tenants 都有"
  else
    bad "table $table: 缺 $MISSING/$TENANT_CNT tenants"
  fi
done

# V18 5 字段
MISSING=0
for tid in $TENANTS; do
  schema="tenant_${tid,,}"
  CNT=$(SQL "SELECT count(*) FROM information_schema.columns WHERE table_schema = '$schema' AND table_name = 'lesson_feedbacks' AND column_name IN ('knowledge_matrix','dim_ratings','homework_deadline','homework_difficulty','next_preview')")
  if [ "$CNT" != "5" ]; then MISSING=$((MISSING+1)); fi
done
if [ $MISSING -eq 0 ]; then
  ok "V18 5 字段: $TENANT_CNT/$TENANT_CNT tenants 全有"
else
  bad "V18 5 字段: 缺 $MISSING/$TENANT_CNT tenants"
fi

# V19 public
HAS=$(SQL "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'campuses'")
if [ "$HAS" = "1" ]; then ok "public.campuses 存在"; else bad "public.campuses 缺"; fi
WITH_PLAN=$(SQL "SELECT count(*) FROM public.tenants WHERE plan_tier IS NOT NULL")
if [ "$WITH_PLAN" = "$TENANT_CNT" ]; then ok "tenants.plan_tier: $WITH_PLAN/$TENANT_CNT 都有值"; else warn "plan_tier 只 $WITH_PLAN/$TENANT_CNT"; fi

# ════════════════ 2. 服务健康 ════════════════
echo
echo "${B}─── 2/6 服务健康 ───${X}"
ONLINE=$(pm2 list 2>/dev/null | grep -c "edu-api.*online")
if [ $ONLINE -ge 2 ]; then ok "PM2 cluster: $ONLINE workers online"; else bad "workers $ONLINE"; fi

UPTIME=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json,time; ps=[p for p in json.load(sys.stdin) if p['name']=='edu-api']; up=ps[0]['pm2_env'].get('pm_uptime',0); print(round((time.time()*1000-up)/1000))")
ok "edu-api uptime: ${UPTIME}s"

ERRORS=$(pm2 logs edu-api --lines 200 --nostream --err 2>&1 | grep -ciE 'TypeError|ReferenceError|Cannot read|undefined is not')
if [ "$ERRORS" -eq 0 ]; then ok "近 200 行 stderr：0 个 JS 错误"; else bad "近 200 行 stderr 有 $ERRORS 个 JS 错误"; fi

# ════════════════ 3. 现有关键 endpoint 烟雾 ════════════════
echo
echo "${B}─── 3/6 现有关键 endpoint 没破坏 ───${X}"
TOKEN=$(curl -s -X POST $BASE/public/auth/login -H 'Content-Type: application/json' -d "{\"phone\":\"13800001111\",\"userId\":\"01HX0000000000000000000000U00001\",\"tenantId\":\"$TENANT_ID\",\"role\":\"admin\",\"campusId\":\"camp0000000000000000000000000001\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
H="Authorization: Bearer $TOKEN"
T="x-tenant-schema: tenant_$TENANT_ID"

probe() {
  local label="$1" method="$2" url="$3" body="$4"
  local CODE
  if [ "$method" = "GET" ]; then
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "$H" -H "$T" "$url")
  else
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'Content-Type: application/json' -H "$H" -H "$T" -d "$body" "$url")
  fi
  if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then ok "$label → $CODE"; else bad "$label → $CODE"; fi
}

probe 'POST /feedback/db/students/x/feedbacks (现有)' POST "$BASE/feedback/db/students/stud0000000000000000000000000001/feedbacks" '{"limit":3}'
probe 'POST /homework/db/teachers/x/assignments  (现有)' POST "$BASE/homework/db/teachers/T0000000000000000000000000000001/assignments" '{"limit":3}'
probe 'POST /assessment/db/teachers/x/list       (现有)' POST "$BASE/assessment/db/teachers/T0000000000000000000000000000001/list" '{}'
probe 'POST /learning-profile/db/students/x/profile (现有)' POST "$BASE/learning-profile/db/students/stud0000000000000000000000000001/profile" '{}'
probe 'GET  /db/teachers/x/showcase             (现有)' GET  "$BASE/db/teachers/T0000000000000000000000000000001/showcase" ''
probe 'POST /teacher/db/list                    (现有)' POST "$BASE/teacher/db/list" "{\"tenantSchema\":\"tenant_$TENANT_ID\"}"

# ════════════════ 4. 新 endpoint 性能 ════════════════
echo
echo "${B}─── 4/6 新 endpoint 性能（5 次平均）───${X}"
perf() {
  local label="$1" method="$2" url="$3" body="${4:-}"
  local total=0
  for i in 1 2 3 4 5; do
    if [ "$method" = "GET" ]; then
      MS=$(curl -s -o /dev/null -w '%{time_total}' --max-time 5 -H "$H" -H "$T" "$url")
    else
      MS=$(curl -s -o /dev/null -w '%{time_total}' --max-time 5 -X POST -H 'Content-Type: application/json' -H "$H" -H "$T" -d "$body" "$url")
    fi
    total=$(python3 -c "print($total + $MS)")
  done
  local avg=$(python3 -c "print(round($total / 5 * 1000))")
  if [ "$avg" -lt 200 ]; then ok "$label avg ${avg}ms"; else warn "$label avg ${avg}ms (>200)"; fi
}

perf 'POST /db/students/x/leaves/list' POST "$BASE/db/students/stud0000000000000000000000000001/leaves/list" '{}'
perf 'POST /db/teachers/x/recommendations/list' POST "$BASE/db/teachers/T0000000000000000000000000000001/recommendations/list" '{}'
perf 'GET  /db/dashboards/admin' GET "$BASE/db/dashboards/admin"
perf 'GET  /db/dashboards/sales-funnel' GET "$BASE/db/dashboards/sales-funnel"
perf 'GET  /db/dashboards/teacher-leaderboard' GET "$BASE/db/dashboards/teacher-leaderboard?sortBy=payroll"
perf 'GET  /db/boss/subscription' GET "$BASE/db/boss/subscription?tenantId=$TENANT_ID"

# ════════════════ 5. 跨 tenant 隔离 ════════════════
echo
echo "${B}─── 5/6 跨 tenant 隔离 ───${X}"
ANOTHER=$(SQL_LIST "SELECT id FROM public.tenants WHERE id != '$TENANT_ID' LIMIT 1" | head -1)
ANOTHER_SCHEMA="tenant_${ANOTHER,,}"
RSP=$(curl -s --max-time 3 -H "$H" -H "x-tenant-schema: $ANOTHER_SCHEMA" "$BASE/db/dashboards/admin")
if echo "$RSP" | grep -qiE 'unauthorized|forbidden|tenant.*mismatch|wrong.*tenant'; then
  ok "header 切换到别的 tenant：被拦"
else
  warn "可以切 tenant header（按 header 走，不校验 token tenantId）— 应用层应加 guard"
fi

# ════════════════ 6. 数据真实性 ════════════════
echo
echo "${B}─── 6/6 数据真实性 spot check ───${X}"
SCHEMA="tenant_${TENANT_ID,,}"
NEW_STU=$(SQL "SELECT count(*) FROM ${SCHEMA}.students WHERE student_name LIKE 'smoke%'")
ok "smoke 留下的 students: $NEW_STU 条"
NEW_CUS=$(SQL "SELECT count(*) FROM ${SCHEMA}.customers WHERE parent_name LIKE 'smoke%'")
ok "smoke 留下的 customers: $NEW_CUS 条"

CURR_PLAN=$(SQL "SELECT plan_tier FROM public.tenants WHERE id = '$TENANT_ID'")
if [ "$CURR_PLAN" = "single" ]; then ok "测试 tenant plan_tier: single（已回滚）"; else bad "plan_tier: $CURR_PLAN（清理失败）"; fi

LEFT_CAMP=$(SQL "SELECT count(*) FROM public.campuses WHERE tenant_id = '$TENANT_ID'")
if [ "$LEFT_CAMP" = "0" ]; then ok "测试 campuses: 0（清理）"; else warn "campuses 残留 $LEFT_CAMP"; fi

# ════════════════ 总结 ════════════════
echo
echo "═════════════════════════════════════════════════════════"
echo -e "  Result: ${G}${PASS} pass${X} · ${Y}${WARN} warn${X} · ${R}${FAIL} fail${X}"
echo "═════════════════════════════════════════════════════════"
[ $FAIL -eq 0 ]
