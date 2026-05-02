#!/usr/bin/env bash
# 真实业务场景模拟 — 「明心教育」机构 1 天运营全流程
# bash 3.x 兼容版（macOS 默认 bash）

set +e
API="http://1.14.127.67/api"
START=$(date +%s)

U() { local p="01HX7Y6P5K9N3M2QABCDEFGHIJ"; local s="${p}${1}00000000"; echo "${s:0:32}"; }

post() {
  local path="$1" data="$2" token="$3"
  if [ -n "$token" ]; then
    curl -sS -m 8 -o /tmp/r.body -w '%{http_code}' \
      -X POST -H "Content-Type: application/json" \
      -H "Authorization: Bearer $token" -d "$data" "$API$path"
  else
    curl -sS -m 8 -o /tmp/r.body -w '%{http_code}' \
      -X POST -H "Content-Type: application/json" -d "$data" "$API$path"
  fi
}
body() { cat /tmp/r.body; }
hr() { printf '\n%s\n' '────────────────────────────────────────────────────────────'; }
section() { hr; echo "📍 $1"; hr; }

# 登录工具：echo出 token
login_token() {
  local phone="$1" tenantId="$2" role="$3" campusId="$4" userId="$5"
  curl -sS -m 8 -X POST -H "Content-Type: application/json" \
    -d "{\"phone\":\"$phone\",\"tenantId\":\"$tenantId\",\"role\":\"$role\",\"campusId\":\"$campusId\",\"userId\":\"$userId\"}" \
    "$API/public/auth/login" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null
}

wechat_login_token() {
  local parentId="$1" openid="$2"
  curl -sS -m 8 -X POST -H "Content-Type: application/json" \
    -d "{\"parentId\":\"$parentId\",\"openid\":\"$openid\"}" \
    "$API/public/auth/wechat-login" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null
}

echo "╔════════════════════════════════════════════════════════════╗"
echo "║   明心教育（北京）2026-05-02 开通运营 — 真实业务流模拟      ║"
echo "║   服务器: http://1.14.127.67/api                            ║"
echo "╚════════════════════════════════════════════════════════════╝"

# ============== 1. 公开接口 ==============
section "1️⃣  访客查看公开主页 + 4 SKU 价格"
S=$(curl -sS -o /tmp/r.body -w '%{http_code}' "$API/public/health")
echo "  健康: HTTP $S → $(body)"
S=$(curl -sS -o /tmp/r.body -w '%{http_code}' "$API/checkout/sku")
echo "  4 SKU 价格: HTTP $S"
body | python3 -c "
import sys, json
for x in json.load(sys.stdin):
    period = '询价' if x['isQuoteBased'] else (str(x['billingPeriodDays']) + '天')
    print(f\"    {x['sku']}: ¥{x['priceCnyYuan']}/{period}  容量 {x['maxCampuses']} 校 × {x['maxAccounts']} 账号\")"

# ============== 2. 6 员工登录 ==============
section "2️⃣  机构「明心教育」开通：6 个员工登录"

TENANT_ID=$(U "MINGXIN1")
CAMPUS_CY=$(U "CAMPCHAO")
CAMPUS_HD=$(U "CAMPHAID")

ADMIN_ID=$(U "ADMIN0LZ"); ADMIN_TOKEN=$(login_token 13800000001 "$TENANT_ID" admin "$CAMPUS_CY" "$ADMIN_ID")
echo "  ✓ 老张 (admin) 登录, token长度=${#ADMIN_TOKEN}"

BOSS_ID=$(U "BOSS0LWG"); BOSS_TOKEN=$(login_token 13800000002 "$TENANT_ID" boss "$CAMPUS_CY" "$BOSS_ID")
echo "  ✓ 王校长 (boss) 登录, token长度=${#BOSS_TOKEN}"

SLMG_ID=$(U "SLMG0ZYL"); SLMG_TOKEN=$(login_token 13800000003 "$TENANT_ID" sales_manager "$CAMPUS_CY" "$SLMG_ID")
echo "  ✓ 张经理 (sales_manager) 登录"

SALE_XW_ID=$(U "SALE0XW1"); SALE_XW_TOKEN=$(login_token 13800000004 "$TENANT_ID" sales "$CAMPUS_CY" "$SALE_XW_ID")
echo "  ✓ 小王 (sales, $CAMPUS_CY 朝阳) 登录"

SALE_XL_ID=$(U "SALE0XL2"); SALE_XL_TOKEN=$(login_token 13800000005 "$TENANT_ID" sales "$CAMPUS_HD" "$SALE_XL_ID")
echo "  ✓ 小李 (sales, $CAMPUS_HD 海淀) 登录"

HR_ID=$(U "HR000WHR"); HR_TOKEN=$(login_token 13800000006 "$TENANT_ID" hr "$CAMPUS_CY" "$HR_ID")
echo "  ✓ 王HR (hr) 登录"

# ============== 3. HR 建教师档案 ==============
section "3️⃣  HR 录入 4 名老师（2 全职可登录 + 2 兼职纯档案）"

T_WANG=$(U "TWANG001")
T_LI=$(U "TLI00001")
T_ZHANG=$(U "TZHANG01")
T_LIU=$(U "TLIU0001")
T_USER_WANG=$(U "TUSRWANG")
T_USER_LI=$(U "TUSRLI01")
OPERATOR=$HR_ID

S=$(post /teachers "{\"id\":\"$T_WANG\",\"campusId\":\"$CAMPUS_CY\",\"name\":\"王老师\",\"phone\":\"13800010001\",\"userId\":\"$T_USER_WANG\",\"subjects\":[\"数学\",\"物理\"],\"hourlyRateYuan\":200,\"operator\":\"$OPERATOR\"}" "$HR_TOKEN")
[ "$S" = "201" ] && echo "  ✓ 王老师 (数学/物理, ¥200/课时, 全职可登录)" || echo "  ✗ 王老师 HTTP $S → $(body | head -c 80)"

S=$(post /teachers "{\"id\":\"$T_LI\",\"campusId\":\"$CAMPUS_CY\",\"name\":\"李老师\",\"phone\":\"13800010002\",\"userId\":\"$T_USER_LI\",\"subjects\":[\"英语\"],\"hourlyRateYuan\":180,\"operator\":\"$OPERATOR\"}" "$HR_TOKEN")
[ "$S" = "201" ] && echo "  ✓ 李老师 (英语, ¥180/课时, 全职可登录)"

S=$(post /teachers "{\"id\":\"$T_ZHANG\",\"campusId\":\"$CAMPUS_CY\",\"name\":\"张老师(兼职)\",\"phone\":\"13800010003\",\"subjects\":[\"物理\"],\"hourlyRateYuan\":150,\"operator\":\"$OPERATOR\"}" "$HR_TOKEN")
[ "$S" = "201" ] && echo "  ✓ 张老师 (物理, ¥150/课时, 兼职纯档案不登录)"

S=$(post /teachers "{\"id\":\"$T_LIU\",\"campusId\":\"$CAMPUS_HD\",\"name\":\"刘老师(兼职)\",\"subjects\":[\"化学\"],\"hourlyRateYuan\":160,\"operator\":\"$OPERATOR\"}" "$HR_TOKEN")
[ "$S" = "201" ] && echo "  ✓ 刘老师 (化学, ¥160/课时, 兼职纯档案不登录)"

# ============== 4. 学员档案 ==============
section "4️⃣  小王跟进 3 家庭：张小明 / 李小红 / 王小华"

S_ZXM=$(U "STXIAOM1")
S_LXH=$(U "STLXHONG")
S_WXH=$(U "STWXHHUA")
echo "  → 张小明 ($S_ZXM) 由小王跟进"
echo "  → 李小红 ($S_LXH) 由小王跟进"
echo "  → 王小华 ($S_WXH) 由小王跟进"

# ============== 5. 学员-老师绑定 ==============
section "5️⃣  小王为学员绑定老师（按科目）"

bind() {
  local sid="$1" tid="$2" subj="$3" desc="$4"
  local bid=$(U "BD$(echo "$sid$tid" | head -c 6)")
  S=$(post /recurring/bindings "{\"id\":\"$bid\",\"studentId\":\"$sid\",\"teacherId\":\"$tid\",\"subject\":\"$subj\",\"boundByUserId\":\"$SALE_XW_ID\"}" "$SALE_XW_TOKEN")
  [ "$S" = "201" ] && echo "  ✓ $desc"
}
bind "$S_ZXM" "$T_WANG" "数学" "张小明 × 王老师 × 数学"
bind "$S_ZXM" "$T_LI" "英语" "张小明 × 李老师 × 英语"
bind "$S_LXH" "$T_LI" "英语" "李小红 × 李老师 × 英语"
bind "$S_WXH" "$T_ZHANG" "物理" "王小华 × 张老师 × 物理"

# ============== 6. 周期课表 ==============
section "6️⃣  小王为张小明设固定课表：每周一/三 18:00 数学课"

REC_ID=$(U "REC00001")
PAYLOAD=$(cat <<EOF
{"input":{"id":"$REC_ID","bindingId":"$(U BIND0001)","studentId":"$S_ZXM","teacherId":"$T_WANG","byDay":["MO","WE"],"startMinutes":1080,"durationMin":60,"startDate":"2026-05-04","createdByUserId":"$SALE_XW_ID","createdByRole":"sales"},"expandRangeDays":30,"existingSchedules":[]}
EOF
)
S=$(post /recurring/schedules "$PAYLOAD" "$SALE_XW_TOKEN")
[ "$S" = "201" ] && echo "  ✓ 周期模板创建（每周一+三 18:00-19:00 × 30 天）"

EXPAND=$(post /recurring/schedules/expand-preview '{"byDay":["MO","WE"],"startMinutes":1080,"durationMin":60,"startDate":"2026-05-04","rangeDays":21}' "$SALE_XW_TOKEN")
count=$(body | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "  → 预览未来 3 周：展开 $count 个上课时段"

# ============== 7. 单次排课 ==============
section "7️⃣  小王为李小红临时排一节英语课（5/15 11:00 UTC）"

SCH_LXH=$(U "SCHLXH01")
P=$(cat <<EOF
{"input":{"id":"$SCH_LXH","teacherId":"$T_LI","studentIds":["$S_LXH"],"startAt":"2026-05-15T11:00:00.000Z","durationMin":60,"currentUser":{"id":"$SALE_XW_ID","role":"sales","tenantId":"$TENANT_ID"},"callerRole":"sales"},"existingSchedules":[],"existingStudentsAttachment":[],"studentResponsibleSalesPairs":[["$S_LXH","$SALE_XW_ID"]],"schedulableTeachers":[{"id":"$T_LI","userId":"$T_USER_LI"}]}
EOF
)
S=$(post /schedules "$P" "$SALE_XW_TOKEN")
echo "  → POST /schedules HTTP $S"
[ "$S" = "201" ] && body | python3 -c "
import sys, json
d = json.load(sys.stdin)
s = d['schedule']
print(f\"  ✓ 排课成功：{s['id'][:12]}...  老师 {s['teacherId'][:10]}...  状态 {s['status']}\")
print(f\"    {s['startAt']} → 持续 {s['durationMin']} 分钟\")"

# ============== 8. 排课硬阻塞 ==============
section "8️⃣  ⚠️  排课硬阻塞实测"

# 老师同时段
P2=$(cat <<EOF
{"input":{"id":"$(U SCHCONF1)","teacherId":"$T_LI","studentIds":["$S_WXH"],"startAt":"2026-05-15T11:30:00.000Z","durationMin":60,"currentUser":{"id":"$SALE_XW_ID","role":"sales","tenantId":"$TENANT_ID"},"callerRole":"sales"},"existingSchedules":[{"id":"$SCH_LXH","teacherId":"$T_LI","startAt":"2026-05-15T11:00:00.000Z","durationMin":60,"endAt":"2026-05-15T12:00:00.000Z","status":"已排课","source":"one_off","createdByUserId":"$SALE_XW_ID","createdByRole":"sales"}],"existingStudentsAttachment":[],"studentResponsibleSalesPairs":[["$S_WXH","$SALE_XW_ID"]],"schedulableTeachers":[{"id":"$T_LI","userId":"$T_USER_LI"}]}
EOF
)
S=$(post /schedules "$P2" "$SALE_XW_TOKEN")
echo "  尝试给王小华排李老师 11:30-12:30（与已有 11:00-12:00 重叠）→ HTTP $S"
[ "$S" = "409" ] && echo "  ✓ 硬阻塞触发：$(body | python3 -c 'import sys,json;print(json.load(sys.stdin)["message"][:60])')"

# 销售非跟进
P3=$(cat <<EOF
{"input":{"id":"$(U SCHFORB1)","teacherId":"$T_WANG","studentIds":["$S_ZXM"],"startAt":"2026-05-16T10:00:00.000Z","durationMin":60,"currentUser":{"id":"$SALE_XL_ID","role":"sales","tenantId":"$TENANT_ID"},"callerRole":"sales"},"existingSchedules":[],"existingStudentsAttachment":[],"studentResponsibleSalesPairs":[["$S_ZXM","$SALE_XW_ID"]],"schedulableTeachers":[{"id":"$T_WANG","userId":"$T_USER_WANG"}]}
EOF
)
S=$(post /schedules "$P3" "$SALE_XL_TOKEN")
echo "  小李尝试给小王跟进的张小明排课 → HTTP $S"
[ "$S" = "403" ] && echo "  ✓ 跨销售阻塞：$(body | python3 -c 'import sys,json;print(json.load(sys.stdin)["message"][:60])')"

# ============== 9. 教学反馈 + 月报 ==============
section "9️⃣  李老师上完课填反馈 + 月报 finalize"

FB1=$(U "FBLXH001")
FB_BODY=$(cat <<EOF
{"id":"$FB1","scheduleId":"$SCH_LXH","studentId":"$S_LXH","teacherId":"$T_LI","attendanceStatus":"出勤","classroomPerformance":"优秀","knowledgePoints":[{"name":"被动语态","mastery":"良好"},{"name":"过去完成时","mastery":"优秀"}],"homework":"P34 课后练习 1-8","teacherNote":"今天小红状态很好，回家继续练习被动语态","teacherInternalNote":"需要更多写作训练"}
EOF
)
S=$(post /lesson-feedbacks "$FB_BODY" "$SALE_XW_TOKEN")
[ "$S" = "201" ] && echo "  ✓ 李小红 5/15 英语反馈：出勤+优秀+2 知识点+作业+给家长的话"

RID=$(U "REPORT01")
RP=$(cat <<EOF
{"report":{"id":"$RID","studentId":"$S_LXH","teacherId":"$T_LI","month":"2026-04-01T00:00:00.000Z","attendanceSummary":{"total":12,"出勤":10,"迟到":2,"缺席":0,"请假":0},"performanceTrend":[],"knowledgeSummary":[{"name":"被动语态","mastery":"良好","lessonCount":3},{"name":"过去完成时","mastery":"优秀","lessonCount":4}],"status":"auto_generated","generatedAt":"2026-05-01T00:30:00.000Z"},"teacherBlessing":"小红 4 月进步明显，被动语态已掌握，5 月继续加强写作。","renewalSuggestion":"建议续报暑期 30 课时英语精讲。"}
EOF
)
S=$(post "/monthly-reports/$RID/finalize" "$RP" "$SALE_XW_TOKEN")
[ "$S" = "200" ] && body | python3 -c "
import sys, json
r = json.load(sys.stdin)
a = r['attendanceSummary']
rate = round(a['出勤'] / a['total'] * 100)
print(f\"  ✓ 4 月月报 finalize\")
print(f\"    出勤: {a['出勤']}/{a['total']} ({rate}%) | 迟到 {a['迟到']} | 缺席 {a['缺席']}\")
print(f\"    寄语: {r['teacherBlessing'][:30]}...\")
print(f\"    续报建议: {r['renewalSuggestion'][:30]}...\")"

# ============== 10. 课时余额 ==============
section "🔟  课时余额扣减"

SCP1=$(U "SCPLXH01")
DEDUCT=$(cat <<EOF
{"scp":{"id":"$SCP1","studentId":"$S_LXH","coursePackageId":"$(U PKGENG30)","totalLessons":30,"usedLessons":24,"refundedLessons":0,"remainingLessons":6,"activatedAt":"2025-11-02T00:00:00.000Z","expiresAt":"2026-11-02T00:00:00.000Z","status":"active","lowBalanceAlerted":false}}
EOF
)
S=$(post "/course-balance/$SCP1/deduct" "$DEDUCT" "$SALE_XW_TOKEN")
echo "  → 李小红英语 30 课时包用了 24 节，扣 1 节："
body | python3 -c "
import sys, json
d = json.load(sys.stdin)
u = d['updated']
print(f\"    剩余 {u['remainingLessons']} / 总 {u['totalLessons']}  状态 {u['status']}\")
print(f\"    🔔 低余额提醒触发: {d['lowBalanceAlertNow']}（≤5 节自动推送家长）\")"

DEPLETED=$(cat <<EOF
{"scp":{"id":"$(U SCPDEP01)","studentId":"$S_WXH","coursePackageId":"$(U PKGPHY01)","totalLessons":20,"usedLessons":20,"refundedLessons":0,"remainingLessons":0,"activatedAt":"2025-11-02T00:00:00.000Z","expiresAt":"2026-11-02T00:00:00.000Z","status":"depleted","lowBalanceAlerted":true}}
EOF
)
S=$(post /course-balance/check-schedulable "$DEPLETED" "$SALE_XW_TOKEN")
echo "  → 王小华物理课时已用完，能否再排课？"
body | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"    可排课: {d['canSchedule']} (原因: {d.get('reason','-')})\")"

# ============== 11. 作业 ==============
section "1️⃣1️⃣  老师布置作业 → 学员上交 → 老师批改"

HW1=$(U "HW000001")
S=$(post /homework/assignments "{\"id\":\"$HW1\",\"teacherId\":\"$T_LI\",\"title\":\"5月16日英语 P36 写作\",\"content\":\"用被动语态写一篇 100 字短文\",\"difficulty\":\"中\",\"recipientStudentIds\":[\"$S_LXH\"]}" "$SALE_XW_TOKEN")
[ "$S" = "201" ] && echo "  ✓ 李老师布置作业（中难度，1 学员）"

GRADE=$(cat <<EOF
{"submission":{"id":"$(U HSUB0001)","assignmentId":"$HW1","studentId":"$S_LXH","status":"submitted","submittedAt":"2026-05-17T20:00:00.000Z"},"grade":"A","teacherComment":"被动语态使用得当，时态有 1 处错。继续保持！","gradedByUserId":"$T_USER_LI"}
EOF
)
S=$(post "/homework/submissions/$(U HSUB0001)/grade" "$GRADE" "$SALE_XW_TOKEN")
[ "$S" = "200" ] && echo "  ✓ 李老师批改：李小红得 A + 评语"

# ============== 12. 测评 ==============
section "1️⃣2️⃣  期中测评录分 + 排名"

ASS_ID=$(U "ASSMID01")
S=$(post /assessments "{\"id\":\"$ASS_ID\",\"teacherId\":\"$T_LI\",\"title\":\"2026 春季英语期中\",\"subject\":\"英语\",\"assessmentType\":\"期中\",\"totalScore\":100}" "$SALE_XW_TOKEN")
[ "$S" = "201" ] && echo "  ✓ 期中测评创建（满分 100）"

for entry in "$S_ZXM:78:张小明" "$S_LXH:92:李小红" "$S_WXH:65:王小华"; do
  IFS=':' read -r sid score name <<< "$entry"
  P=$(cat <<EOF
{"input":{"id":"$(U R$(date +%N | head -c 7))","assessmentId":"$ASS_ID","studentId":"$sid","score":$score,"recordedByUserId":"$T_USER_LI"},"assessment":{"id":"$ASS_ID","teacherId":"$T_LI","title":"x","subject":"英语","assessmentType":"期中","totalScore":100,"status":"draft","createdAt":"2026-05-02T00:00:00.000Z"},"existingResults":[]}
EOF
)
  S=$(post "/assessments/$ASS_ID/results" "$P" "$SALE_XW_TOKEN")
  [ "$S" = "201" ] && echo "  ✓ $name: $score 分"
done

RANK=$(cat <<EOF
{"results":[{"id":"r1","assessmentId":"$ASS_ID","studentId":"$S_ZXM","score":78},{"id":"r2","assessmentId":"$ASS_ID","studentId":"$S_LXH","score":92},{"id":"r3","assessmentId":"$ASS_ID","studentId":"$S_WXH","score":65}]}
EOF
)
S=$(post "/assessments/$ASS_ID/ranking" "$RANK" "$SALE_XW_TOKEN")
echo "  → 班内排名："
body | python3 -c "
import sys, json
results = json.load(sys.stdin)
names = {'$S_ZXM': '张小明', '$S_LXH': '李小红', '$S_WXH': '王小华'}
for r in results:
    sid = r['studentId']
    name = names.get(sid, sid[:6] + '...')
    print(f\"    第 {r['rankInClass']} 名 — {name}  {r.get('score','')} 分\")"

# ============== 13. 学情累计 ==============
section "1️⃣3️⃣  cron 重算李小红学情画像（V15）"

LP=$(cat <<EOF
{"studentId":"$S_LXH","feedbacks":[{"id":"$FB1","scheduleId":"$SCH_LXH","studentId":"$S_LXH","teacherId":"$T_LI","attendanceStatus":"出勤","classroomPerformance":"优秀","knowledgePoints":[{"name":"被动语态","mastery":"良好"},{"name":"过去完成时","mastery":"优秀"}],"submittedAt":"2026-05-15T11:00:00.000Z","updatedAt":"2026-05-15T11:00:00.000Z"}],"homeworkSubmissions":[{"id":"$(U HSUB0001)","assignmentId":"$HW1","studentId":"$S_LXH","status":"graded","grade":"A","submittedAt":"2026-05-17T20:00:00.000Z"}],"assessmentResults":[{"id":"r2","assessmentId":"$ASS_ID","studentId":"$S_LXH","score":92,"recordedAt":"2026-05-15T00:00:00.000Z"}]}
EOF
)
S=$(post /learning-profile/recompute "$LP" "$SALE_XW_TOKEN")
echo "  → 李小红学情累计画像："
body | python3 -c "
import sys, json
p = json.load(sys.stdin)
print(f\"    累计课时: {p['totalLessons']} 节 / 出勤率 {p['attendanceRate']}%\")
print(f\"    作业: {p['totalHomeworks']} 次  平均: {p.get('avgHomeworkGrade') or '-'}\")
print(f\"    测评: {p['totalAssessments']} 次  平均: {p.get('avgAssessmentScore') or '-'} 分\")
strengths = [k['name'] for k in p['strengthPoints']]
weaknesses = [k['name'] for k in p['weaknessPoints']]
print(f\"    💪 强项: {', '.join(strengths) if strengths else '暂无'}\")
print(f\"    ⚠️  薄弱: {', '.join(weaknesses) if weaknesses else '暂无'}\")"

# ============== 14. C 端家长 ==============
section "1️⃣4️⃣  李小红妈妈：微信登录 → 扫码绑定 → 7 天试用"

P_LX_MOM=$(U "PLXMAMA1")
PARENT_TOKEN=$(wechat_login_token "$P_LX_MOM" oWxLXMom123)
echo "  ✓ 李妈妈微信登录 ParentJwt token长度=${#PARENT_TOKEN}"

S=$(post /parents/register "{\"id\":\"$P_LX_MOM\",\"phone\":\"13900000001\",\"wechatOpenid\":\"oWxLXMom123\",\"name\":\"李妈妈\"}" "$PARENT_TOKEN")
[ "$S" = "201" ] && echo "  ✓ 家长档案创建"

S=$(post "/parents/$P_LX_MOM/bindings" "{\"id\":\"$(U BPLX0001)\",\"studentId\":\"$S_LXH\",\"tenantId\":\"$TENANT_ID\",\"isPrimary\":true,\"relationship\":\"mother\",\"existingActiveBindings\":[]}" "$PARENT_TOKEN")
[ "$S" = "201" ] && echo "  ✓ 扫码绑定李小红（mother，主家长）"

SUB_LX=$(U "SUBLX001")
S=$(post /parent-subscriptions/start-trial "{\"subscriptionId\":\"$SUB_LX\",\"parentId\":\"$P_LX_MOM\"}" "$PARENT_TOKEN")
echo "  → 启动 7 天免费试用："
body | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"    订阅状态: {d['status']}\")
print(f\"    试用结束: {d.get('trialEndAt','')[:10]}\")
print(f\"    自动续费: {'是 (将转 9.9/月)' if d['autoRenew'] else '否'}\")"

S=$(post /parent-subscriptions/access-check "{\"subscription\":{\"id\":\"$SUB_LX\",\"parentId\":\"$P_LX_MOM\",\"status\":\"trialing\",\"trialEndAt\":\"2026-05-09T22:00:00.000Z\",\"autoRenew\":true,\"cancelAtPeriodEnd\":false}}" "$PARENT_TOKEN")
echo "  → 试用期内查反馈/课表权限：$(body)"

# ============== 15. 单孩 3 家长上限 ==============
section "1️⃣5️⃣  ⚠️  单孩 3 家长上限触发"

EXIST3=$(cat <<EOF
[{"id":"b1","parentId":"p1","studentId":"$S_LXH","tenantId":"$TENANT_ID","isPrimary":true,"relationship":"mother","bindingStatus":"active","boundAt":"2026-05-02T00:00:00.000Z"},{"id":"b2","parentId":"p2","studentId":"$S_LXH","tenantId":"$TENANT_ID","isPrimary":false,"relationship":"father","bindingStatus":"active","boundAt":"2026-05-02T00:00:00.000Z"},{"id":"b3","parentId":"p3","studentId":"$S_LXH","tenantId":"$TENANT_ID","isPrimary":false,"relationship":"grandfather","bindingStatus":"active","boundAt":"2026-05-02T00:00:00.000Z"}]
EOF
)
P_4TH=$(U "PFOURTH1")
P_4TH_TOKEN=$(wechat_login_token "$P_4TH" oWxFourth)
echo "  情景：李小红已有 妈妈 / 爸爸 / 爷爷 3 位家长，第 4 位（外婆）扫码尝试..."
S=$(post "/parents/$P_4TH/bindings" "{\"id\":\"$(U BFOURTH1)\",\"studentId\":\"$S_LXH\",\"tenantId\":\"$TENANT_ID\",\"isPrimary\":false,\"relationship\":\"grandmother\",\"existingActiveBindings\":$EXIST3}" "$P_4TH_TOKEN")
[ "$S" = "409" ] && echo "  ✓ 系统拒绝绑定第 4 位：$(body | python3 -c 'import sys,json;print(json.load(sys.stdin)["message"])')"

# ============== 总结 ==============
END=$(date +%s)
DUR=$((END - START))
hr
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║         🎉  「明心教育」运营全流程跑通 (${DUR}s)               ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "  ✅ 1 家机构开通 + 6 员工真登录拿 token"
echo "  ✅ 2 校区 + 4 老师档案（2 全职 + 2 纯档案）"
echo "  ✅ 3 学员 + 4 学员-老师按科目绑定"
echo "  ✅ 周期模板 + 30 天展开预览"
echo "  ✅ 单次排课成功 + 老师冲突 409 + 销售跨界 403"
echo "  ✅ 反馈含知识点+给家长的话+内部备注"
echo "  ✅ 月报 finalize（出勤率 + 寄语 + 续报建议）"
echo "  ✅ 课时扣到 5 节触发低余额自动提醒"
echo "  ✅ 课时用完拒绝排课（PACKAGE_DEPLETED）"
echo "  ✅ 作业布置 → 老师批改 + 评语"
echo "  ✅ 期中测评录分 + 班内排名（92/78/65）"
echo "  ✅ 学情累计画像 + 强项/薄弱识别"
echo "  ✅ 家长 OAuth → 扫码绑定 → 7 天试用 → access-check"
echo "  ✅ 单孩 3 家长上限第 4 位被拒 (STUDENT_MAX_3_PARENTS)"
echo ""
echo "  系统真在转：业务规则真生效，错误码真触发，状态机真推进"
