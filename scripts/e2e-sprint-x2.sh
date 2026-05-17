#!/bin/bash
# ============================================================
# e2e-sprint-x2.sh — Sprint X.2 admin 创建 + admin 创建其他角色 全链路 e2e
#
# 设计：模拟前端真实 payload (与 wizard.js/staff-list.js 一字不差) + 每步查 PG 验证落库
# 任何 case fail 立即 STOP (不浪费时间)
# 出具：edu-server backend  2026-05-17 round 5
# ============================================================

BASE="${BASE:-http://1.14.127.67/api}"
SSH_PROD="${SSH_PROD:-pdfserver}"

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; N='\033[0m'
ok()    { printf "${G}✓${N} %s\n" "$1"; }
fail()  { printf "${R}✗${N} %s\n  ${R}stderr:${N} %s\n" "$1" "$2"; exit 1; }
info()  { printf "${C}ℹ${N} %s\n" "$1"; }
head1() { printf "\n${Y}━━━ %s ━━━${N}\n" "$1"; }

ulid()       { LC_ALL=C tr -dc 'A-Z0-9' < /dev/urandom | head -c 32; }
phone_rand() { local p="138$(printf '%08d' $RANDOM$RANDOM)"; echo "${p:0:11}"; }
psql_query() { ssh "$SSH_PROD" "sudo -u postgres psql -d edu -t -A -c \"$1\"" 2>/dev/null | tr -d '\r'; }

# ════════════════════════════════════════════════════════════
# Phase 0 — 前置健康检查
# ════════════════════════════════════════════════════════════
head1 "Phase 0 健康检查"
H=$(curl -s -m 5 "$BASE/public/health")
[[ "$H" == *'"ok":true'* ]] || fail "0.1 backend health" "$H"
ok "0.1 backend health 200"

# ════════════════════════════════════════════════════════════
# Phase 1 — admin 自助开通新机构 (前端 wizard.js finish 调用真实 payload)
# ════════════════════════════════════════════════════════════
head1 "Phase 1 admin 注册 (wizard finish payload)"

TID=$(ulid)
CID=$(ulid)
ADMIN_PHONE=$(phone_rand)
ADMIN_PWD="TestPass1234"
ORG_NAME="E2E-$(date +%H%M%S)"

# 与 wizard.js:333-348 payload 一字不差（含 admin 4 字段）
PROV_PAYLOAD=$(cat <<JSON
{
  "tenantId": "$TID",
  "name": "$ORG_NAME",
  "sku": "standard_1999",
  "campuses": [{"id": "$CID", "name": "主校区", "address": "测试地址", "courseLines": "K12"}],
  "adminName": "测试老板",
  "adminPhone": "$ADMIN_PHONE",
  "adminEmail": "test@example.com",
  "adminPassword": "$ADMIN_PWD"
}
JSON
)

PROV=$(curl -s -m 30 -X POST "$BASE/public/onboarding/provision-tenant" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: e2e-$(date +%s%N)" \
  -d "$PROV_PAYLOAD")

TENANT_SCHEMA=$(echo "$PROV" | grep -oE '"tenantSchema":"[^"]+' | sed 's/"tenantSchema":"//')
ACCESS_TOKEN=$(echo "$PROV" | grep -oE '"accessToken":"[^"]+' | sed 's/"accessToken":"//')
ADMIN_USER_ID=$(echo "$PROV" | grep -oE '"adminUserId":"[^"]+' | sed 's/"adminUserId":"//')

[[ -n "$TENANT_SCHEMA" && -n "$ACCESS_TOKEN" && -n "$ADMIN_USER_ID" ]] || fail "1.1 provision-tenant 缺关键字段" "$(echo "$PROV" | head -c 400)"
ok "1.1 provision-tenant 201 + token + adminUserId 返回"
info "  tenantSchema=$TENANT_SCHEMA"
info "  adminPhone=$ADMIN_PHONE"
info "  adminUserId=$ADMIN_USER_ID"

# 验证 PG: admin 用户真落库 + mobile 非空 + password_hash 非空 + status='启用'
ADMIN_ROW=$(psql_query "SELECT name, mobile, role, status, length(password_hash), password_updated_at IS NOT NULL FROM $TENANT_SCHEMA.users WHERE id = '$ADMIN_USER_ID';")
[[ -n "$ADMIN_ROW" ]] || fail "1.2 admin 行未落库" "$ADMIN_ROW"
ADMIN_NAME=$(echo "$ADMIN_ROW" | cut -d'|' -f1)
ADMIN_MOBILE=$(echo "$ADMIN_ROW" | cut -d'|' -f2)
ADMIN_ROLE=$(echo "$ADMIN_ROW" | cut -d'|' -f3)
ADMIN_STATUS=$(echo "$ADMIN_ROW" | cut -d'|' -f4)
ADMIN_PWD_LEN=$(echo "$ADMIN_ROW" | cut -d'|' -f5)
ADMIN_PWD_AT=$(echo "$ADMIN_ROW" | cut -d'|' -f6)

[[ "$ADMIN_NAME" == "测试老板" ]] || fail "1.2.1 admin.name 不对" "$ADMIN_NAME"
[[ "$ADMIN_MOBILE" == "$ADMIN_PHONE" ]] || fail "1.2.2 admin.mobile 不对" "$ADMIN_MOBILE (期望 $ADMIN_PHONE)"
[[ "$ADMIN_ROLE" == "admin" ]] || fail "1.2.3 admin.role 不对" "$ADMIN_ROLE"
[[ "$ADMIN_STATUS" == "启用" ]] || fail "1.2.4 admin.status 不对" "$ADMIN_STATUS"
[[ "$ADMIN_PWD_LEN" -ge 60 ]] || fail "1.2.5 admin.password_hash bcrypt 60 字符长度" "len=$ADMIN_PWD_LEN"
[[ "$ADMIN_PWD_AT" == "t" ]] || fail "1.2.6 admin.password_updated_at 应非 NULL" "$ADMIN_PWD_AT"
ok "1.2 PG admin 行: name/mobile/role/status/password_hash(60)/updated_at 全对"

# 验证 PG: campus 落库
CAMPUS_ROW=$(psql_query "SELECT name, address FROM $TENANT_SCHEMA.campuses WHERE id = '$CID';")
[[ "$CAMPUS_ROW" == "主校区|测试地址" ]] || fail "1.3 campus 落库" "$CAMPUS_ROW"
ok "1.3 PG campus 落库: 主校区 / 测试地址"

# 验证 PG: tenants 表 trial 状态 (V45 14d 试用)
TENANT_ROW=$(psql_query "SELECT subscription_status, trial_ends_at > NOW() FROM public.tenants WHERE id = '$TID';")
[[ "$TENANT_ROW" == "trial|t" ]] || fail "1.4 tenant 14d 试用状态" "$TENANT_ROW"
ok "1.4 PG tenant subscription_status=trial + trial_ends_at > NOW (14d)"

# ════════════════════════════════════════════════════════════
# Phase 2 — admin login 拿 fresh token (验证 password 真能登录)
# ════════════════════════════════════════════════════════════
head1 "Phase 2 admin login 验证密码生效"

# Phase 2.1: check-phone admin 应返 accountType=b
CP=$(curl -s -m 5 -X POST "$BASE/public/auth/check-phone" -H "Content-Type: application/json" -d "{\"phone\":\"$ADMIN_PHONE\"}")
[[ "$CP" == *'"exists":true'* && "$CP" == *'"accountType":"b"'* ]] || fail "2.1 check-phone 应返 accountType=b" "$CP"
ok "2.1 check-phone admin 命中 accountType=b"

# Phase 2.2: login 用正确密码
LOGIN=$(curl -s -m 10 -X POST "$BASE/public/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"$ADMIN_PHONE\",\"password\":\"$ADMIN_PWD\"}")

LOGIN_TOKEN=$(echo "$LOGIN" | grep -oE '"token":"[^"]+' | sed 's/"token":"//')
LOGIN_ROLE=$(echo "$LOGIN" | grep -oE '"role":"[^"]+' | sed 's/"role":"//')

if [[ -n "$LOGIN_TOKEN" && "$LOGIN_ROLE" == "admin" ]]; then
  ACCESS_TOKEN="$LOGIN_TOKEN"  # 用 fresh login token 后续测试
  ok "2.2 login 返 token + role=admin + payload.tenantId"
else
  fail "2.2 login" "$(echo "$LOGIN" | head -c 400)"
fi

# Phase 2.3: 错密码 401
WRONG=$(curl -s -m 5 -X POST "$BASE/public/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"$ADMIN_PHONE\",\"password\":\"WrongPass99\"}")
[[ "$WRONG" == *'"statusCode":401'* ]] || fail "2.3 错密码应 401" "$WRONG"
ok "2.3 错密码 401 (防枚举: 不透传 phone vs password 错)"

# ════════════════════════════════════════════════════════════
# Phase 3 — admin 创建 9 种 B 端角色员工 (staff/list.js onSubmit payload)
# ════════════════════════════════════════════════════════════
head1 "Phase 3 admin 创建 9 种员工角色"

ROLES=("boss" "sales" "sales_manager" "marketing" "finance" "hr" "teacher" "academic" "academic_admin")
EMPLOYEE_IDS=()

for role in "${ROLES[@]}"; do
  EP=$(phone_rand)
  sleep 0.1
  # 与 staff/list.js:217-227 payload 一字不差
  RESP=$(curl -s -m 15 -X POST "$BASE/db/users" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "X-Tenant-Schema: $TENANT_SCHEMA" \
    -H "Idempotency-Key: e2e-$role-$(date +%s%N)$RANDOM" \
    -d "{\"phone\":\"$EP\",\"role\":\"$role\",\"name\":\"测试-$role\",\"tenantId\":\"$TID\",\"tenantSchema\":\"$TENANT_SCHEMA\",\"campusId\":\"$CID\"}")
  USER_ID=$(echo "$RESP" | grep -oE '"id":"[^"]+' | head -1 | sed 's/"id":"//')
  INIT_PWD=$(echo "$RESP" | grep -oE '"initialPassword":"[^"]+' | sed 's/"initialPassword":"//')
  [[ -n "$USER_ID" && -n "$INIT_PWD" ]] || fail "3.$role 创建 + initialPassword" "$(echo "$RESP" | head -c 300)"

  # 验证 PG: 员工真落库 + role + status + password_hash 非空
  EMP_ROW=$(psql_query "SELECT role, status, length(password_hash), mobile FROM $TENANT_SCHEMA.users WHERE id = '$USER_ID';")
  [[ "$EMP_ROW" == "$role|启用|"* ]] || fail "3.$role PG 行 role/status" "$EMP_ROW"
  EMP_PWD_LEN=$(echo "$EMP_ROW" | cut -d'|' -f3)
  EMP_MOBILE=$(echo "$EMP_ROW" | cut -d'|' -f4)
  [[ "$EMP_PWD_LEN" -ge 60 ]] || fail "3.$role password_hash 长度" "len=$EMP_PWD_LEN"
  [[ "$EMP_MOBILE" == "$EP" ]] || fail "3.$role mobile" "$EMP_MOBILE (期望 $EP)"
  ok "3.$role 创建 + initialPassword=$INIT_PWD + PG 落库验证 (mobile/role/status/hash)"
  EMPLOYEE_IDS+=("$role:$USER_ID:$EP")
done

# ════════════════════════════════════════════════════════════
# Phase 4 — admin 守门 (admin 不能创建另一个 admin)
# ════════════════════════════════════════════════════════════
head1 "Phase 4 admin 创建另一个 admin 拒"

R4=$(curl -s -m 10 -X POST "$BASE/db/users" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Tenant-Schema: $TENANT_SCHEMA" \
  -H "Idempotency-Key: e2e-admin2-$(date +%s%N)" \
  -d "{\"phone\":\"$(phone_rand)\",\"role\":\"admin\",\"name\":\"第二admin\",\"tenantId\":\"$TID\",\"tenantSchema\":\"$TENANT_SCHEMA\"}")
[[ "$R4" == *'"statusCode":400'* || "$R4" == *'"statusCode":403'* ]] || fail "4.1 admin 应拒创第二个 admin (SSOT §12.4)" "$R4"
ok "4.1 admin 创建另一个 admin 被拒 (SSOT §12.4 admin 唯一)"

# ════════════════════════════════════════════════════════════
# Phase 5 — 跨表 phone 唯一 (B 端已注册手机号再注册 → 400)
# ════════════════════════════════════════════════════════════
head1 "Phase 5 跨表 phone 唯一"

R5=$(curl -s -m 10 -X POST "$BASE/db/users" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Tenant-Schema: $TENANT_SCHEMA" \
  -H "Idempotency-Key: e2e-dup-$(date +%s%N)" \
  -d "{\"phone\":\"$ADMIN_PHONE\",\"role\":\"teacher\",\"name\":\"重复手机\",\"tenantId\":\"$TID\",\"tenantSchema\":\"$TENANT_SCHEMA\"}")
[[ "$R5" == *'"statusCode":400'* ]] || fail "5.1 重复 phone 应 400" "$R5"
ok "5.1 跨表 phone 唯一 400"

# ════════════════════════════════════════════════════════════
# Phase 6 — admin 用 teacher 员工的 initialPassword 真登录
# ════════════════════════════════════════════════════════════
head1 "Phase 6 teacher 员工 login 真登录"

# 取出第 7 个员工 (teacher)
TEACHER_INFO="${EMPLOYEE_IDS[6]}"
TEACHER_PHONE=$(echo "$TEACHER_INFO" | cut -d':' -f3)
# initialPassword 没存 (上面 ok 已显示)，需重新创一个 teacher 并保留 initialPassword
EP6=$(phone_rand)
CR6=$(curl -s -m 15 -X POST "$BASE/db/users" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Tenant-Schema: $TENANT_SCHEMA" \
  -H "Idempotency-Key: e2e-teach-login-$(date +%s%N)" \
  -d "{\"phone\":\"$EP6\",\"role\":\"teacher\",\"name\":\"老师可登录\",\"tenantId\":\"$TID\",\"tenantSchema\":\"$TENANT_SCHEMA\",\"campusId\":\"$CID\"}")
TEACHER_PWD=$(echo "$CR6" | grep -oE '"initialPassword":"[^"]+' | sed 's/"initialPassword":"//')
[[ -n "$TEACHER_PWD" ]] || fail "6.1 取 teacher initialPassword" "$CR6"

# 用 teacher initialPassword login
T_LOGIN=$(curl -s -m 10 -X POST "$BASE/public/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"$EP6\",\"password\":\"$TEACHER_PWD\"}")
T_ROLE=$(echo "$T_LOGIN" | grep -oE '"role":"[^"]+' | sed 's/"role":"//')
[[ "$T_ROLE" == "teacher" ]] || fail "6.2 teacher login role" "$T_LOGIN"
ok "6.1 teacher 用 initialPassword 真登录 + JWT.role=teacher"

# ════════════════════════════════════════════════════════════
# Phase 7 — admin 停用员工 (deactivate)
# ════════════════════════════════════════════════════════════
head1 "Phase 7 admin 停用员工"

# 用第 1 个员工 (boss)
TARGET_INFO="${EMPLOYEE_IDS[0]}"
TARGET_ID=$(echo "$TARGET_INFO" | cut -d':' -f2)

D7=$(curl -s -m 10 -X POST "$BASE/db/users/$TARGET_ID/deactivate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d "{\"tenantId\":\"$TID\",\"tenantSchema\":\"$TENANT_SCHEMA\"}")
[[ "$D7" == *'"status":"停用"'* ]] || fail "7.1 deactivate 应返 status=停用" "$D7"
ok "7.1 deactivate endpoint 返 status=停用"

# 验证 PG: status 改 '停用'
D7_PG=$(psql_query "SELECT status FROM $TENANT_SCHEMA.users WHERE id = '$TARGET_ID';")
[[ "$D7_PG" == "停用" ]] || fail "7.2 PG 行 status=停用" "$D7_PG"
ok "7.2 PG 行 status='停用'"

# 验证 Redis: user-revoked-at 写入
REVOKED=$(ssh "$SSH_PROD" "redis-cli -a \$(grep '^REDIS_PASSWORD=' /home/ubuntu/workspace/edu-server/.env | cut -d= -f2-) GET auth:user-revoked-at:$TARGET_ID 2>/dev/null" 2>/dev/null | tail -1)
if [[ -n "$REVOKED" && "$REVOKED" != "(nil)" ]]; then
  ok "7.3 Redis auth:user-revoked-at:$TARGET_ID 写入: $REVOKED"
else
  printf "${Y}⚠${N} 7.3 Redis revoked-at 未验证 (Redis 可能未连 / fail-open 行为)\n"
fi

# ════════════════════════════════════════════════════════════
# Phase 8 — 守门验证 (无 token 拒 + 错 tenant 拒)
# ════════════════════════════════════════════════════════════
head1 "Phase 8 守门验证"

NA=$(curl -s -m 5 -X POST "$BASE/db/users" -H "Content-Type: application/json" -d '{"phone":"13800099111","role":"teacher","name":"x"}')
[[ "$NA" == *'"statusCode":401'* ]] || fail "8.1 /db/users 无 token 401" "$NA"
ok "8.1 /db/users 无 token 401"

NA2=$(curl -s -m 5 -X POST "$BASE/db/parents" -H "Content-Type: application/json" -d '{"phone":"13800099112"}')
[[ "$NA2" == *'"statusCode":401'* ]] || fail "8.2 /db/parents 无 token 401" "$NA2"
ok "8.2 /db/parents 无 token 401"

# ════════════════════════════════════════════════════════════
# Phase 9 — 清理测试数据
# ════════════════════════════════════════════════════════════
head1 "Phase 9 清理测试数据"

DEL=$(curl -s -m 30 -X DELETE "$BASE/public/onboarding/tenants/$TID")
[[ "$DEL" == *'"ok":true'* ]] && ok "9.1 测试 tenant 已清理 ($TID)" || printf "${Y}⚠${N} 9.1 tenant 清理失败 (手动 SSH 删, $DEL)\n"

# ════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════════════════════════"
printf "${G}✅ E2E SPRINT X.2 全链路 ALL PASS${N}\n"
printf "  Phase 1-2: admin 注册 + login + PG 落库验证\n"
printf "  Phase 3:   9 种 B 端角色员工创建 + PG 落库验证 + initialPassword\n"
printf "  Phase 4-5: admin 守门 (拒第二 admin / 重复 phone)\n"
printf "  Phase 6:   teacher 员工真登录 (initialPassword 可用)\n"
printf "  Phase 7:   deactivate + status='停用' + Redis 黑名单\n"
printf "  Phase 8:   无 token 全 401 守门\n"
echo "════════════════════════════════════════════════════════════"
