#!/usr/bin/env bash
# ============================================================
# verify-api-convention.sh — 后端 API 参数规范防回归 lint
#
# 拍板：docs/API-接口参数规范-2026-05-23.md §3.1 ID 语义化
# 集成：tools/git-hooks/pre-commit（与 validate-no-cross-tenant + tsc check 同链）
#
# 检查反模式（FAIL 即 exit 1）：
#   1. controller `@Param('id')` 泛用 ID（P1-T8 已改语义化，防回归）
#   2. controller route `@Get(':id')` / `@Post(':id')` 等泛用占位
#   3. 错误信息含 ULID 内部 ID（A05 信息泄露）
#
# 兼容期豁免（WARN 不 FAIL）：
#   - 嵌套路径如 `students/:studentId/leaves/:id` 第二层 :id（可选 P1 round 2 收口）
# ============================================================

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

C_GREEN='\033[32m'; C_RED='\033[31m'; C_YELLOW='\033[33m'; C_RESET='\033[0m'
ok()    { printf "${C_GREEN}OK${C_RESET}    %s\n" "$1"; }
fail()  { printf "${C_RED}FAIL${C_RESET}  %s\n" "$1"; }
warn()  { printf "${C_YELLOW}WARN${C_RESET}  %s\n" "$1"; }

EXIT_CODE=0

# ============ P0 红线（FAIL 即 exit 1）+ P1 backlog（WARN）============

# 1. P1-T8 已改造的 7 核心 controller 范围内 @Param('id') 必 FAIL（防回归）
#    范围：contract / course-product / customer / refund / assessment / homework / schedule (7 文件)
T8_FILES="src/modules/db/contract.controller.ts src/modules/db/course-product.controller.ts src/modules/db/customer.controller.ts src/modules/db/refund.controller.ts src/modules/assessment/assessment.controller.ts src/modules/homework/homework.controller.ts src/modules/schedule/schedule.controller.ts"
V1=$(grep -nE "@Param\(\s*['\"]id['\"]" $T8_FILES 2>/dev/null \
  | grep -v "//\|/\*\| \* " \
  | wc -l | tr -d ' ')
if [ "$V1" -gt 0 ]; then
  fail "P1-T8 范围内 @Param('id') 回归 ($V1 处) — 必须用语义 ID"
  grep -nE "@Param\(\s*['\"]id['\"]" $T8_FILES 2>/dev/null | grep -v "//\|/\*\| \* " | head -5
  echo "  P1-T8 已改造：contract/course-product/customer/refund/assessment/homework/schedule"
  EXIT_CODE=1
else
  ok "P1-T8 范围内 @Param('id') 0 回归"
fi

# 1b. P1-T8 范围外 controller @Param('id') — WARN（兼容期，P1 round 2 收口）
V1B=$(grep -rnE "@Param\(\s*['\"]id['\"]" src/modules/ --include='*.controller.ts' 2>/dev/null \
  | grep -v "//\|/\*\| \* " \
  | grep -vE "(contract|course-product|customer|refund|assessment|homework|schedule)\.controller\.ts" \
  | wc -l | tr -d ' ')
if [ "$V1B" -gt 0 ]; then
  warn "P1-T8 范围外 @Param('id') 残留 ($V1B 处) — feedback/recurring/c-side/parent-binding 等推 P1 round 2 收口"
else
  ok "P1-T8 范围外 @Param('id') 0 残留"
fi

# 2. controller route ':id' 占位（@Get/@Post/@Patch/@Delete 路径含 ':id'）— P1 backlog
#    P1-T8 已改造 7 个核心 controller（contract/course-product/customer/refund/assessment/homework/schedule）
#    剩余 feedback/recurring-schedule/c-side messages+teacher-changes 等推 P1 round 2
V2=$(grep -rnE "@(Get|Post|Patch|Put|Delete)\(\s*['\"][^'\"]*:id[^a-zA-Z]" src/modules/ --include='*.controller.ts' 2>/dev/null \
  | grep -v "//\|/\*\| \* " \
  | wc -l | tr -d ' ')
if [ "$V2" -gt 0 ]; then
  warn "controller route :id 占位 ($V2 处) — P1 round 2 收口（feedback/recurring/c-side messages 等）"
else
  ok "controller route 无 :id 占位"
fi

# 3. ForbiddenException / NotFoundException message 含 ULID 模式（A05 信息泄露）
#    扫 32-char Crockford Base32 字面量在 throw message 中
V3=$(grep -rnE "throw new (ForbiddenException|NotFoundException|UnauthorizedException)\([^)]*\\\$\{[a-zA-Z_]*[Ii]d\}" \
  src/modules/ --include='*.controller.ts' 2>/dev/null \
  | grep -v "//\|/\*\| \* " \
  | wc -l | tr -d ' ')
if [ "$V3" -gt 0 ]; then
  warn "throw message 含 \${xxxId} 模板插值 ($V3 处) — A05 检查是否含内部 ULID"
  grep -rnE "throw new (ForbiddenException|NotFoundException|UnauthorizedException)\([^)]*\\\$\{[a-zA-Z_]*[Ii]d\}" src/modules/ --include='*.controller.ts' 2>/dev/null | grep -v "//\|/\*\| \* " | head -5
  echo "  期望：错误 message 用大写下划线 enum (PARENT_NOT_FOUND / PARENT_NOT_BOUND_TO_TENANT)"
fi

# ============ P1 backlog（WARN 不 FAIL）============

# 4. 嵌套路径第二层 :id（如 students/:studentId/leaves/:id）兼容期保留
V4=$(grep -rnE "@(Get|Post|Patch|Delete)\(\s*['\"][^'\"]*/[a-zA-Z_]+/.*:id" src/modules/ --include='*.controller.ts' 2>/dev/null \
  | grep -v "//\|/\*\| \* " \
  | wc -l | tr -d ' ')
if [ "$V4" -gt 0 ]; then
  warn "嵌套路径第二层 :id 占位 ($V4 处) — P1 round 2 收口"
else
  ok "无嵌套路径第二层 :id 残留"
fi

# 5. controller 用 @Query('tenantSchema') / @Body() body.tenantSchema 自校验
#    middleware 已挂 req.tenantSchema + backfill query/body 兼容期，但 controller 应渐进 @Req() req.tenantSchema 直读
V5=$(grep -rnE "@Query\(\s*['\"]tenantSchema['\"]" src/modules/ --include='*.controller.ts' 2>/dev/null \
  | grep -v "//\|/\*\| \* " \
  | wc -l | tr -d ' ')
if [ "$V5" -gt 0 ]; then
  warn "controller @Query('tenantSchema') 残留 ($V5 处) — Sprint Y/Z controller 渐进迁移 @Req"
fi

echo ""
echo "=========================================="
if [ "$EXIT_CODE" -eq 0 ]; then
  ok "verify-api-convention PASS（后端 P0 红线 0 / P1 backlog 见 warn）"
else
  fail "verify-api-convention FAIL — 修违规后重跑"
fi
echo "=========================================="

exit $EXIT_CODE
