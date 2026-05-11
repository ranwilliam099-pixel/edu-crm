#!/usr/bin/env bash
# 全面公网真测试 — http://1.14.127.67/api
# 修订版：fix ULID + 直接 curl 不用 helper 函数

set +e
API="http://1.14.127.67/api"
PASS=0
FAIL=0
START=$(date +%s)

# 32-char ULID（前缀 26 + 后缀 + 0 padding 到 32）
U() {
  local p="01HX7Y6P5K9N3M2QABCDEFGHIJ"
  local s="${p}${1}00000000"
  echo "${s:0:32}"
}

# usage: chk "name" "expected" "actual_status" "needle" "body"
chk() {
  local name="$1" expected="$2" actual="$3" needle="$4" body="$5"
  if [ "$actual" = "$expected" ]; then
    if [ -n "$needle" ] && ! echo "$body" | grep -q "$needle"; then
      echo "  ✗ $name → $actual (body 缺 '$needle')"
      echo "    body: ${body:0:150}"
      FAIL=$((FAIL+1))
    else
      echo "  ✓ $name → $actual"
      PASS=$((PASS+1))
    fi
  else
    echo "  ✗ $name → expected $expected, got $actual"
    [ -n "$body" ] && echo "    body: ${body:0:200}"
    FAIL=$((FAIL+1))
  fi
}

# 通用 curl runner（避免 bash function 拼字符串问题）
post() {
  local path="$1" data="$2" token="$3"
  if [ -n "$token" ]; then
    curl -sS -m 8 -o /tmp/curl.body -w '%{http_code}' \
      -X POST -H "Content-Type: application/json" \
      -H "Authorization: Bearer $token" \
      -d "$data" "$API$path"
  else
    curl -sS -m 8 -o /tmp/curl.body -w '%{http_code}' \
      -X POST -H "Content-Type: application/json" \
      -d "$data" "$API$path"
  fi
}

patch_req() {
  local path="$1" data="$2" token="$3"
  curl -sS -m 8 -o /tmp/curl.body -w '%{http_code}' \
    -X PATCH -H "Content-Type: application/json" \
    -H "Authorization: Bearer $token" \
    -d "$data" "$API$path"
}

get_req() {
  local path="$1"
  curl -sS -m 8 -o /tmp/curl.body -w '%{http_code}' "$API$path"
}

body() { cat /tmp/curl.body; }

echo "════════════════════════════════════════════════════════════"
echo "  全面公网真测试 — http://1.14.127.67/api"
echo "  时间: $(date)"
echo "════════════════════════════════════════════════════════════"
echo ""

# ============== 第 1 组：基础设施（公开路径）==============
echo "━━━ 第 1 组：基础设施 + 公开路径 (4 个) ━━━"
S=$(get_req /public/health); chk "1.1 GET /public/health" 200 "$S" '"ok":true' "$(body)"
S=$(get_req /checkout/sku); chk "1.2 GET /checkout/sku" 200 "$S" 'standard_1999' "$(body)"
S=$(get_req /checkout/sku/trial); chk "1.3 GET /checkout/sku/trial" 200 "$S" '' "$(body)"
S=$(get_req /checkout/capacity/standard_1999); chk "1.4 GET /checkout/capacity" 200 "$S" '' "$(body)"
echo ""

# ============== 第 2 组：鉴权登录 ==============
echo "━━━ 第 2 组：鉴权登录 (4 个) ━━━"
TENANT_ID=$(U "TENANT01")
ADMIN_USER_ID=$(U "ADMIN001")
SALES_USER_ID=$(U "SALES001")
CAMPUS_ID=$(U "CAMPUS01")
PARENT_ID=$(U "PARENT01")

# 验证 ULID 长度
echo "  (sanity) ULID 长度: $(echo -n "$TENANT_ID" | wc -c) (应=32)"

S=$(post /public/auth/login "{\"phone\":\"13800001111\",\"tenantId\":\"$TENANT_ID\",\"role\":\"admin\",\"campusId\":\"$CAMPUS_ID\",\"userId\":\"$ADMIN_USER_ID\"}")
chk "2.1 admin 登录" 200 "$S" 'token' "$(body)"
ADMIN_TOKEN=$(body | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

S=$(post /public/auth/login "{\"phone\":\"13800002222\",\"tenantId\":\"$TENANT_ID\",\"role\":\"sales\",\"campusId\":\"$CAMPUS_ID\",\"userId\":\"$SALES_USER_ID\"}")
chk "2.2 sales 登录" 200 "$S" 'token' "$(body)"
SALES_TOKEN=$(body | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

S=$(post /public/auth/login '{"phone":"12345","tenantId":"x","role":"admin","campusId":"x","userId":"x"}')
chk "2.3 phone 非法 → 400" 400 "$S"

S=$(post /public/auth/wechat-login "{\"parentId\":\"$PARENT_ID\",\"openid\":\"oWxTest\"}")
chk "2.4 微信登录" 200 "$S" 'token' "$(body)"
PARENT_TOKEN=$(body | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "  (debug) ADMIN_TOKEN 长度: ${#ADMIN_TOKEN}, SALES: ${#SALES_TOKEN}, PARENT: ${#PARENT_TOKEN}"
echo ""

# ============== 第 3 组：middleware 守护 ==============
echo "━━━ 第 3 组：middleware 401 守护 (5 个) ━━━"
S=$(post /teachers '{}'); chk "3.1 /teachers 无 token" 401 "$S"
S=$(post /schedules '{}'); chk "3.2 /schedules 无 token" 401 "$S"
S=$(post /lesson-feedbacks '{}'); chk "3.3 /lesson-feedbacks 无 token" 401 "$S"
S=$(post /homework/assignments '{}'); chk "3.4 /homework/assignments 无 token" 401 "$S"
S=$(post /assessments '{}'); chk "3.5 /assessments 无 token" 401 "$S"
echo ""

# ============== 第 4 组：B 端教师档案 ==============
echo "━━━ 第 4 组：B 端教师档案 V7 (4 个) ━━━"
TEACHER_ID=$(U "TEACHER1")
TEACHER_USER_ID=$(U "TUSER001")
OPERATOR=$(U "OPRTR001")

S=$(post /teachers "{\"id\":\"$TEACHER_ID\",\"campusId\":\"$CAMPUS_ID\",\"name\":\"全面测试王老师\",\"phone\":\"13800003333\",\"userId\":\"$TEACHER_USER_ID\",\"subjects\":[\"数学\",\"物理\"],\"hourlyPriceYuan\":200,\"operator\":\"$OPERATOR\"}" "$ADMIN_TOKEN")
chk "4.1 admin 创建教师" 201 "$S" '在职' "$(body)"

S=$(post /teachers "{\"id\":\"$TEACHER_ID\",\"campusId\":\"$CAMPUS_ID\",\"name\":\"x\",\"phone\":\"x\",\"subjects\":[],\"operator\":\"$OPERATOR\"}" "$SALES_TOKEN")
chk "4.2 sales 创建教师 → 403 RBAC" 403 "$S"

T_PURE=$(U "TCHRPUR1")
S=$(post /teachers "{\"id\":\"$T_PURE\",\"campusId\":\"$CAMPUS_ID\",\"name\":\"兼职老师纯档案\",\"subjects\":[\"英语\"],\"operator\":\"$OPERATOR\"}" "$ADMIN_TOKEN")
chk "4.3 纯档案教师无 userId → 201" 201 "$S"

S=$(post /teachers/filter-schedulable '{"teachers":[{"id":"x","campusId":"x","name":"a","subjects":[],"status":"在职"},{"id":"y","campusId":"x","name":"b","subjects":[],"status":"归档"}]}' "$ADMIN_TOKEN")
chk "4.4 filter-schedulable" 200 "$S"
echo ""

# ============== 第 5 组：学员-老师绑定 ==============
echo "━━━ 第 5 组：学员-老师绑定 V8.1 (1 个) ━━━"
STUDENT_A=$(U "STUDENTA")
BIND_ID=$(U "BIND0001")
S=$(post /recurring/bindings "{\"id\":\"$BIND_ID\",\"studentId\":\"$STUDENT_A\",\"teacherId\":\"$TEACHER_ID\",\"subject\":\"数学\",\"boundByUserId\":\"$SALES_USER_ID\"}" "$SALES_TOKEN")
chk "5.1 创建绑定" 201 "$S" 'active' "$(body)"
echo ""

# ============== 第 6 组：排课 + 冲突 ==============
echo "━━━ 第 6 组：排课 + 冲突硬阻塞 V8 (3 个) ━━━"
SCH1_ID=$(U "SCH00001")
STUDENT_B=$(U "STUDENTB")

# 6.1 排课成功
SCH1_BODY=$(cat <<EOF
{"input":{"id":"$SCH1_ID","teacherId":"$TEACHER_ID","studentIds":["$STUDENT_A"],"startAt":"2026-05-15T10:00:00.000Z","durationMin":60,"currentUser":{"id":"$SALES_USER_ID","role":"sales","tenantId":"$TENANT_ID"},"callerRole":"sales"},"existingSchedules":[],"existingStudentsAttachment":[],"studentResponsibleSalesPairs":[["$STUDENT_A","$SALES_USER_ID"]],"schedulableTeachers":[{"id":"$TEACHER_ID","userId":"$TEACHER_USER_ID"}]}
EOF
)
S=$(post /schedules "$SCH1_BODY" "$SALES_TOKEN")
chk "6.1 排课成功" 201 "$S" '已排课' "$(body)"

# 6.2 老师冲突
SCH2_BODY=$(cat <<EOF
{"input":{"id":"$(U SCH00002)","teacherId":"$TEACHER_ID","studentIds":["$STUDENT_B"],"startAt":"2026-05-15T10:30:00.000Z","durationMin":60,"currentUser":{"id":"$SALES_USER_ID","role":"sales","tenantId":"$TENANT_ID"},"callerRole":"sales"},"existingSchedules":[{"id":"$SCH1_ID","teacherId":"$TEACHER_ID","startAt":"2026-05-15T10:00:00.000Z","durationMin":60,"endAt":"2026-05-15T11:00:00.000Z","status":"已排课","source":"one_off","createdByUserId":"$SALES_USER_ID","createdByRole":"sales"}],"existingStudentsAttachment":[],"studentResponsibleSalesPairs":[["$STUDENT_B","$SALES_USER_ID"]],"schedulableTeachers":[{"id":"$TEACHER_ID","userId":"$TEACHER_USER_ID"}]}
EOF
)
S=$(post /schedules "$SCH2_BODY" "$SALES_TOKEN")
chk "6.2 老师冲突 → 409 TEACHER_TIME_CONFLICT" 409 "$S" 'TEACHER_TIME_CONFLICT' "$(body)"

# 6.3 销售非跟进
SCH3_BODY=$(cat <<EOF
{"input":{"id":"$(U SCH00003)","teacherId":"$TEACHER_ID","studentIds":["$STUDENT_A"],"startAt":"2026-05-16T10:00:00.000Z","durationMin":60,"currentUser":{"id":"$SALES_USER_ID","role":"sales","tenantId":"$TENANT_ID"},"callerRole":"sales"},"existingSchedules":[],"existingStudentsAttachment":[],"studentResponsibleSalesPairs":[["$STUDENT_A","$(U OTHERSAL)"]],"schedulableTeachers":[{"id":"$TEACHER_ID","userId":"$TEACHER_USER_ID"}]}
EOF
)
S=$(post /schedules "$SCH3_BODY" "$SALES_TOKEN")
chk "6.3 销售非跟进 → 403 SALES_ONLY_OWN_STUDENTS" 403 "$S" 'SALES_ONLY_OWN_STUDENTS' "$(body)"
echo ""

# ============== 第 7 组：周期课表 ==============
echo "━━━ 第 7 组：周期课表 V8.1 (2 个) ━━━"
S=$(post /recurring/schedules/expand-preview '{"byDay":["MO","WE"],"startMinutes":1080,"durationMin":60,"startDate":"2026-05-04","rangeDays":14}' "$SALES_TOKEN")
chk "7.1 RRULE expand-preview" 200 "$S"

REC_BODY=$(cat <<EOF
{"input":{"id":"$(U REC00001)","bindingId":"$BIND_ID","studentId":"$STUDENT_A","teacherId":"$TEACHER_ID","byDay":["MO"],"startMinutes":1080,"durationMin":60,"startDate":"2026-05-04","createdByUserId":"$SALES_USER_ID","createdByRole":"sales"},"expandRangeDays":30,"existingSchedules":[]}
EOF
)
S=$(post /recurring/schedules "$REC_BODY" "$SALES_TOKEN")
chk "7.2 创建周期模板" 201 "$S" 'active' "$(body)"
echo ""

# ============== 第 8 组：反馈 + 月报 ==============
echo "━━━ 第 8 组：反馈 + 月报 V9 (2 个) ━━━"
FB_ID=$(U "FEEDB001")
FB_BODY=$(cat <<EOF
{"id":"$FB_ID","scheduleId":"$SCH1_ID","studentId":"$STUDENT_A","teacherId":"$TEACHER_ID","attendanceStatus":"出勤","classroomPerformance":"良好","knowledgePoints":[{"name":"二次方程","mastery":"良好"}],"homework":"P12 1-5 题","teacherNote":"今日表现不错"}
EOF
)
S=$(post /lesson-feedbacks "$FB_BODY" "$SALES_TOKEN")
chk "8.1 提交反馈" 201 "$S" '出勤' "$(body)"

REPORT_ID=$(U "REPORT01")
REP_BODY=$(cat <<EOF
{"report":{"id":"$REPORT_ID","studentId":"$STUDENT_A","teacherId":"$TEACHER_ID","month":"2026-04-01T00:00:00.000Z","attendanceSummary":{"total":8,"出勤":7,"迟到":1,"缺席":0,"请假":0},"performanceTrend":[],"knowledgeSummary":[],"status":"auto_generated","generatedAt":"2026-05-01T00:30:00.000Z"},"teacherBlessing":"继续保持","renewalSuggestion":"建议续报暑期"}
EOF
)
S=$(post "/monthly-reports/$REPORT_ID/finalize" "$REP_BODY" "$SALES_TOKEN")
chk "8.2 月报 finalize" 200 "$S" 'teacher_finalized' "$(body)"
echo ""

# ============== 第 9 组：课时余额 ==============
echo "━━━ 第 9 组：课时余额 V12 (2 个) ━━━"
SCP_ID=$(U "SCP00001")
DEDUCT=$(cat <<EOF
{"scp":{"id":"$SCP_ID","studentId":"$STUDENT_A","coursePackageId":"$(U PKG00001)","totalLessons":60,"usedLessons":54,"refundedLessons":0,"remainingLessons":6,"activatedAt":"2026-05-02T00:00:00.000Z","expiresAt":"2027-05-02T00:00:00.000Z","status":"active","lowBalanceAlerted":false}}
EOF
)
S=$(post "/course-balance/$SCP_ID/deduct" "$DEDUCT" "$SALES_TOKEN")
chk "9.1 扣到 5 节 → 低余额提醒" 200 "$S" 'lowBalanceAlertNow' "$(body)"

CHECK='{"scp":{"id":"x","studentId":"x","coursePackageId":"x","totalLessons":60,"usedLessons":60,"refundedLessons":0,"remainingLessons":0,"activatedAt":"2026-05-02T00:00:00.000Z","expiresAt":"2027-05-02T00:00:00.000Z","status":"depleted","lowBalanceAlerted":true}}'
S=$(post /course-balance/check-schedulable "$CHECK" "$SALES_TOKEN")
chk "9.2 已用完不能排课" 200 "$S" 'PACKAGE_DEPLETED' "$(body)"
echo ""

# ============== 第 10 组：作业 ==============
echo "━━━ 第 10 组：作业 V13 (2 个) ━━━"
HW_ID=$(U "HW000001")
S=$(post /homework/assignments "{\"id\":\"$HW_ID\",\"teacherId\":\"$TEACHER_ID\",\"title\":\"数学练习\",\"content\":\"P12 1-10\",\"difficulty\":\"中\",\"recipientStudentIds\":[\"$STUDENT_A\",\"$STUDENT_B\"]}" "$SALES_TOKEN")
chk "10.1 老师布置作业" 201 "$S" 'published' "$(body)"

GR_BODY=$(cat <<EOF
{"submission":{"id":"$(U SUB00001)","assignmentId":"$HW_ID","studentId":"$STUDENT_A","status":"submitted","submittedAt":"2026-05-15T10:00:00.000Z"},"grade":"A","teacherComment":"做得不错","gradedByUserId":"$TEACHER_USER_ID"}
EOF
)
S=$(post "/homework/submissions/$(U SUB00001)/grade" "$GR_BODY" "$SALES_TOKEN")
chk "10.2 老师批改作业" 200 "$S" 'graded' "$(body)"
echo ""

# ============== 第 11 组：测评 ==============
echo "━━━ 第 11 组：测评 V14 (3 个) ━━━"
ASS_ID=$(U "ASS00001")
S=$(post /assessments "{\"id\":\"$ASS_ID\",\"teacherId\":\"$TEACHER_ID\",\"title\":\"5 月月考\",\"subject\":\"数学\",\"assessmentType\":\"月考\",\"totalScore\":100}" "$SALES_TOKEN")
chk "11.1 创建测评" 201 "$S" 'draft' "$(body)"

REC_ASS=$(cat <<EOF
{"input":{"id":"$(U RES00001)","assessmentId":"$ASS_ID","studentId":"$STUDENT_A","score":85,"recordedByUserId":"$TEACHER_USER_ID"},"assessment":{"id":"$ASS_ID","teacherId":"$TEACHER_ID","title":"x","subject":"数学","assessmentType":"月考","totalScore":100,"status":"draft","createdAt":"2026-05-02T00:00:00.000Z"},"existingResults":[]}
EOF
)
S=$(post "/assessments/$ASS_ID/results" "$REC_ASS" "$SALES_TOKEN")
chk "11.2 录测评成绩" 201 "$S"

S=$(post "/assessments/$ASS_ID/ranking" '{"results":[{"id":"r1","assessmentId":"x","studentId":"a","score":85},{"id":"r2","assessmentId":"x","studentId":"b","score":92}]}' "$SALES_TOKEN")
chk "11.3 计算排名" 200 "$S"
echo ""

# ============== 第 12 组：学情累计 ==============
echo "━━━ 第 12 组：学情累计 V15 (1 个) ━━━"
LP=$(cat <<EOF
{"studentId":"$STUDENT_A","feedbacks":[{"id":"$FB_ID","scheduleId":"$SCH1_ID","studentId":"$STUDENT_A","teacherId":"$TEACHER_ID","attendanceStatus":"出勤","classroomPerformance":"良好","knowledgePoints":[{"name":"二次方程","mastery":"良好"}],"submittedAt":"2026-04-01T00:00:00.000Z","updatedAt":"2026-04-01T00:00:00.000Z"}],"homeworkSubmissions":[],"assessmentResults":[]}
EOF
)
S=$(post /learning-profile/recompute "$LP" "$SALES_TOKEN")
chk "12.1 学情累计重算" 200 "$S" 'attendanceRate' "$(body)"
echo ""

# ============== 第 13 组：C 端家长 ==============
echo "━━━ 第 13 组：C 端家长 V10 (2 个) ━━━"
P2=$(U "PARENT02")
S=$(post /parents/register "{\"id\":\"$P2\",\"phone\":\"13800009999\",\"wechatOpenid\":\"oWxParent2\",\"name\":\"妈妈\"}" "$PARENT_TOKEN")
chk "13.1 家长注册" 201 "$S" 'active' "$(body)"

EXIST3=$(cat <<EOF
[{"id":"b1","parentId":"p1","studentId":"$STUDENT_A","tenantId":"$TENANT_ID","isPrimary":true,"relationship":"mother","bindingStatus":"active","boundAt":"2026-05-02T00:00:00.000Z"},{"id":"b2","parentId":"p2","studentId":"$STUDENT_A","tenantId":"$TENANT_ID","isPrimary":false,"relationship":"father","bindingStatus":"active","boundAt":"2026-05-02T00:00:00.000Z"},{"id":"b3","parentId":"p3","studentId":"$STUDENT_A","tenantId":"$TENANT_ID","isPrimary":false,"relationship":"grandfather","bindingStatus":"active","boundAt":"2026-05-02T00:00:00.000Z"}]
EOF
)
BO=$(cat <<EOF
{"id":"$(U BIND0099)","studentId":"$STUDENT_A","tenantId":"$TENANT_ID","relationship":"guardian","existingActiveBindings":$EXIST3}
EOF
)
S=$(post "/parents/$P2/bindings" "$BO" "$PARENT_TOKEN")
chk "13.2 第 4 家长 → 409 STUDENT_MAX_3_PARENTS" 409 "$S" 'STUDENT_MAX_3_PARENTS_EXCEEDED' "$(body)"
echo ""

# ============== 第 14 组：C 端订阅 ==============
echo "━━━ 第 14 组：C 端订阅 V10 (3 个) ━━━"
SUB_ID=$(U "SUB00001")
S=$(post /parent-subscriptions/start-trial "{\"subscriptionId\":\"$SUB_ID\",\"parentId\":\"$PARENT_ID\"}" "$PARENT_TOKEN")
chk "14.1 启动 7 天试用" 201 "$S" 'trialing' "$(body)"

S=$(post /parent-subscriptions/access-check '{"subscription":{"id":"x","parentId":"p","status":"active","currentPeriodEnd":"2099-12-31T00:00:00.000Z","autoRenew":true,"cancelAtPeriodEnd":false}}' "$PARENT_TOKEN")
chk "14.2 access-check active=true" 200 "$S" '"canAccess":true' "$(body)"

S=$(post /parent-subscriptions/access-check '{"subscription":{"id":"x","parentId":"p","status":"cancelled","autoRenew":false,"cancelAtPeriodEnd":false}}' "$PARENT_TOKEN")
chk "14.3 access-check cancelled=false" 200 "$S" '"canAccess":false' "$(body)"
echo ""

# ============== 第 15 组：性能 ==============
echo "━━━ 第 15 组：性能 + cluster (2 个) ━━━"
echo "  并发 10 个 health 请求..."
T1=$(date +%s%N)
for i in $(seq 1 10); do (curl -sS -o /dev/null "$API/public/health") & done
wait
T2=$(date +%s%N)
DUR_MS=$(( (T2 - T1) / 1000000 ))
echo "  ✓ 并发 10 个 health → ${DUR_MS}ms"
PASS=$((PASS+1))

T1=$(date +%s%N)
for i in $(seq 1 20); do curl -sS -o /dev/null "$API/public/health"; done
T2=$(date +%s%N)
TOTAL_MS=$(( (T2 - T1) / 1000000 ))
AVG_MS=$(( TOTAL_MS / 20 ))
echo "  ✓ 顺序 20 个 health → 总 ${TOTAL_MS}ms / 平均 ${AVG_MS}ms"
PASS=$((PASS+1))
echo ""

# ============== 总结 ==============
END=$(date +%s)
DUR=$((END - START))
TOTAL=$((PASS + FAIL))
echo "════════════════════════════════════════════════════════════"
echo "  测试完成 ─ 用时 ${DUR}s"
echo "  ✅ PASS: $PASS"
echo "  ❌ FAIL: $FAIL"
echo "  📊 TOTAL: $TOTAL"
PCT=$((PASS * 100 / TOTAL))
echo "  📈 通过率: ${PCT}%"
echo "════════════════════════════════════════════════════════════"
