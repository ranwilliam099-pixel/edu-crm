#!/usr/bin/env bash
# validate-no-cross-tenant.sh — PreToolUse hook for security-auditor agent
# 拦截缺 tenant_id 过滤的 SQL，模式来自 Claude Code 官方 db-reader example
#
# 退出码：
#   0 = 通过
#   2 = 阻断（缺 tenant_id 过滤）
#
# 用法（PreToolUse hook）：
#   hooks:
#     PreToolUse:
#       - matcher: "Bash"
#         cmd: "bash tools/validate-no-cross-tenant.sh"
#       - matcher: "Edit"
#         cmd: "bash tools/validate-no-cross-tenant.sh \"$CLAUDE_FILE_PATHS\""

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RED='\033[0;31m'; YELLOW='\033[0;33m'; GREEN='\033[0;32m'; NC='\033[0m'

# 扫描范围：src/modules/db/**/*.ts（持久化层 SQL 都在这）
SCAN_DIR="$ROOT/src/modules"

EXIT_CODE=0
VIOLATIONS=()

# ============================================================
# 规则 1: SELECT/UPDATE/DELETE 必须有 tenant_id 或 schema 切换
# ============================================================
# 允许的模式：
#   - SET search_path TO tenant_xxx  (schema-per-tenant)
#   - WHERE tenant_id = $1
#   - WHERE tenant_id = current_setting('app.tenant_id')
#   - 在 public schema 表（campuses / tenants / parents 跨租户）

# 找所有 raw SQL（query / execute / pool.query）
# 排除：
#   *.spec.ts — 单测 dummy SQL fixture
#   pg-pool.service.ts — 连接池基础设施（含 SELECT 1 健康检查 + JSDoc 示例），不是业务 SQL
SQL_HITS=$(grep -rEn "\.query\(.*['\"\\\`](SELECT|UPDATE|DELETE)" "$SCAN_DIR" --include='*.ts' --exclude='*.spec.ts' --exclude='pg-pool.service.ts' 2>/dev/null || true)

while IFS= read -r line; do
  [ -z "$line" ] && continue

  # 提取行内容（path:lineno: 后面的部分），跳过 JSDoc/单行注释
  content=$(echo "$line" | cut -d':' -f3-)
  if echo "$content" | grep -qE '^[[:space:]]*(\*|//)'; then
    continue
  fi

  # 检查该行是否含 tenant_id 或 search_path
  if echo "$line" | grep -qE 'tenant_id|search_path|public\.(tenants|campuses|parents|parent_subscriptions|promotion)'; then
    continue  # 通过
  fi

  # 否则报警
  VIOLATIONS+=("$line")
  EXIT_CODE=2
done <<< "$SQL_HITS"

# ============================================================
# 规则 2: Controller 必须装 TenantScopeGuard
# ============================================================
CONTROLLERS=$(grep -rEln '@Controller\(' "$SCAN_DIR" --include='*.ts' 2>/dev/null || true)

while IFS= read -r ctrl_file; do
  [ -z "$ctrl_file" ] && continue

  # 白名单：
  #   public / health / auth(login/register) / onboarding — 公共接口
  #   admin — admin 跨租户，使用 AdminGuard 不是 TenantScopeGuard
  #   parent — parent 在 public schema 跨租户（家长跨机构 5/10 拍板）
  #   cron — 系统内部任务，无用户请求上下文
  #   reverse-order — 平台级 GMV 报表模块，service 无 tenantSchema，仅 platform_admin/finance_admin 可调（待 Sprint C/E 整体设计重构）
  if echo "$ctrl_file" | grep -qE 'public|health|auth|onboarding|admin|parent|cron|reverse-order'; then
    continue
  fi

  if ! grep -qE 'TenantScopeGuard' "$ctrl_file"; then
    VIOLATIONS+=("MISSING-GUARD: $ctrl_file 未装 TenantScopeGuard")
    EXIT_CODE=2
  fi
done <<< "$CONTROLLERS"

# ============================================================
# 报告
# ============================================================
if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}✅ no-cross-tenant 验证通过${NC}"
  exit 0
fi

echo -e "${RED}❌ 跨租户安全检查失败${NC}"
echo "─────────────────────────────────────"
for v in "${VIOLATIONS[@]}"; do
  echo -e "${YELLOW}⚠${NC} $v"
done
echo "─────────────────────────────────────"
echo -e "${RED}阻断：缺 tenant_id 过滤或 TenantScopeGuard。请加白名单或修复${NC}"
exit 2
