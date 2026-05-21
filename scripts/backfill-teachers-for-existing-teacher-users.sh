#!/bin/bash
# ============================================================
# backfill-teachers-for-existing-teacher-users.sh
#
# 用途：修补历史 role='teacher' user 漏建 teachers row（SSOT §6.7 拍板）
#
# 触发：2026-05-22 真机截图实证 — 17623678803「张老师」users 表存在但
#       teachers 表无对应 row → feedback.controller.ts:910 self-check 403
#       「no teachers row bound to user 01KS1...000000」拒写月报/反馈
#
# 根因：5/22 之前 user.controller.createUser 创建 teacher role user 时未
#       联动 INSERT teachers（已在 commit XXX 后端代码修复，新建 teacher
#       自动联动）。本脚本修复**历史**遗漏的 teacher users。
#
# 模式：bash 循环 64 tenants + sed __TENANT_SCHEMA__ + sudo -u postgres psql
#       同 V35/V36/V37/V40/V41 backfill 实战模式
#
# 幂等：INSERT ... WHERE id NOT IN (SELECT user_id FROM teachers WHERE
#       user_id IS NOT NULL) — 已联动的 user 跳过
#
# 用法：
#   bash scripts/backfill-teachers-for-existing-teacher-users.sh             # dry-run
#   bash scripts/backfill-teachers-for-existing-teacher-users.sh --apply     # 真跑
#
# 前置：
#   - 在 PG 主机上执行（sudo -u postgres psql 本机连接）
#   - PG_DB env 默认 'edu'
# ============================================================

set -euo pipefail

PG_DB="${PG_DB:-edu}"
PG_USER_OS="${PG_USER_OS:-postgres}"

APPLY=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    *) echo "[warn] unknown arg: $arg" ;;
  esac
done

# 颜色
C_GREEN='\033[32m'; C_RED='\033[31m'; C_YELLOW='\033[33m'; C_CYAN='\033[36m'; C_RESET='\033[0m'
ok()    { printf "${C_GREEN}OK${C_RESET}    %s\n" "$1"; }
fail()  { printf "${C_RED}FAIL${C_RESET}  %s\n" "$1"; }
info()  { printf "${C_CYAN}INFO${C_RESET}  %s\n" "$1"; }
warn()  { printf "${C_YELLOW}WARN${C_RESET}  %s\n" "$1"; }

# ===== Step 1: 列所有 tenant schemas =====
info "查询全部 tenant schemas..."
TENANTS=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -At -c \
  "SELECT id FROM public.tenants ORDER BY created_at ASC")
TENANT_COUNT=$(echo "$TENANTS" | wc -l | tr -d ' ')
info "共 ${TENANT_COUNT} 个 tenants"

# ===== Step 2: 逐 tenant 修补 =====
TOTAL_INSERTED=0
TOTAL_SKIPPED=0
FAILED_TENANTS=()

for tenant_id in $TENANTS; do
  [ -z "$tenant_id" ] && continue
  schema="tenant_$(echo "$tenant_id" | tr 'A-Z' 'a-z')"

  # 查 teacher role 漏建 teachers row 的 users 数
  MISSING_COUNT=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -At -c "
    SELECT COUNT(*) FROM ${schema}.users u
    WHERE u.role = 'teacher'
      AND u.deleted_at IS NULL
      AND u.id NOT IN (
        SELECT user_id FROM ${schema}.teachers WHERE user_id IS NOT NULL
      );
  " 2>/dev/null || echo "0")

  if [ "$MISSING_COUNT" = "0" ] || [ -z "$MISSING_COUNT" ]; then
    TOTAL_SKIPPED=$((TOTAL_SKIPPED + 1))
    continue
  fi

  printf "${C_YELLOW}TODO${C_RESET}  ${schema}: %s teacher users 漏建 teachers row\n" "$MISSING_COUNT"

  if [ "$APPLY" = false ]; then
    continue
  fi

  # 真跑：INSERT 修补（参考 teacher.repository.ts insert SQL 同 schema）
  # 注意：phone_encrypted 留 NULL（V34 双写 fallback 明文 phone）；admin
  #       backfill 时无加密 key 上下文，让应用层运行时 lazy encrypt
  RESULT=$(sudo -u "$PG_USER_OS" psql -d "$PG_DB" -v ON_ERROR_STOP=1 -At <<SQL 2>&1
    INSERT INTO ${schema}.teachers (
      id, campus_id, name, phone, phone_encrypted, user_id, subjects,
      status, created_by, updated_by, created_at, updated_at
    )
    SELECT
      -- id: 用 user.id 当 teachers.id (32-char ULID, 同 user_id 简化关联)
      u.id,
      u.campus_id,
      u.name,
      u.mobile AS phone,
      NULL::bytea AS phone_encrypted,  -- backfill 不加密，应用层 lazy 处理
      u.id AS user_id,
      '[]'::jsonb AS subjects,
      '在职'::text AS status,
      u.created_by AS created_by,
      u.created_by AS updated_by,
      NOW() AS created_at,
      NOW() AS updated_at
    FROM ${schema}.users u
    WHERE u.role = 'teacher'
      AND u.deleted_at IS NULL
      AND u.id NOT IN (
        SELECT user_id FROM ${schema}.teachers WHERE user_id IS NOT NULL
      )
    RETURNING id;
SQL
  )

  if [ $? -eq 0 ]; then
    INSERTED=$(echo "$RESULT" | wc -l | tr -d ' ')
    TOTAL_INSERTED=$((TOTAL_INSERTED + INSERTED))
    ok "${schema}: INSERTED ${INSERTED} rows"
  else
    fail "${schema}: ${RESULT}"
    FAILED_TENANTS+=("$schema")
  fi
done

# ===== 汇总 =====
echo ""
echo "=========================================="
info "Backfill 完成"
info "扫描 tenants: ${TENANT_COUNT}"
info "跳过（无漏建）: ${TOTAL_SKIPPED}"
if [ "$APPLY" = true ]; then
  info "INSERT 行数: ${TOTAL_INSERTED}"
  if [ ${#FAILED_TENANTS[@]} -gt 0 ]; then
    fail "失败 tenants: ${FAILED_TENANTS[*]}"
    exit 1
  fi
else
  warn "DRY-RUN 模式 — 真跑加 --apply"
fi
echo "=========================================="
