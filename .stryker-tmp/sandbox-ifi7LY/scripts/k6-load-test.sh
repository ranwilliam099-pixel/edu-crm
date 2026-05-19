#!/usr/bin/env bash
# ============================================================
# k6-load-test.sh — T13 PgBouncer 升级压测 wrapper
#
# 来源：spec 2026-05-16-T13-pgbouncer-spec.md §6
# 用途：验证 max=10→25 + PgBouncer session mode 后 P95 < 200ms + 0 error
#
# 用法：
#   export EDU_TEST_JWT='<bearer-token>'
#   export EDU_TEST_TENANT='tenant_demo'
#   bash scripts/k6-load-test.sh                       # 默认 http://1.14.127.67
#   bash scripts/k6-load-test.sh http://localhost:3001  # 本地
#
# 验收：P95 < 200ms / http_req_failed < 1% / PgBouncer SHOW POOLS cl_waiting=0
# ============================================================
set -euo pipefail

TARGET="${1:-http://1.14.127.67}"
TOKEN="${EDU_TEST_JWT:-}"
TENANT="${EDU_TEST_TENANT:-tenant_demo}"

[ -z "$TOKEN" ] && { echo "[fail] 需设 EDU_TEST_JWT"; exit 1; }
command -v k6 >/dev/null || { echo "[fail] brew install k6"; exit 1; }

k6 run --vus 50 --duration 30s \
  -e TARGET="$TARGET" -e TOKEN="$TOKEN" -e TENANT="$TENANT" \
  "$(dirname "$0")/k6-dashboard-admin.js"
