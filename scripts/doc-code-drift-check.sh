#!/usr/bin/env bash
# doc-code-drift-check.sh — T10 (2026-05-16)
# 检测「文档承诺 vs 代码实现」3 处已知 drift（R1 + A3-r2 audit）
#   R1: refreshToken / refresh_tokens 表
#   R2: deactivated_at 软删除列
#   R3: recurring cron @Cron / HTTP 触发器
# exit 0 = clean / exit N = N 个 drift（用作 pre-commit block）
set -u  # 不用 -e / pipefail：grep 0-match 返回 1 会误杀

DOCS_DIR="${DOCS_DIR:-/Users/ranyan/Desktop/edu/edu-mp-sandbox/docs}"
SERVER_SRC="${SERVER_SRC:-/Users/ranyan/Desktop/edu/edu-server/src}"
SERVER_MIG="${SERVER_MIG:-/Users/ranyan/Desktop/edu/edu-server/migrations}"
DRIFT_COUNT=0

# 排除 ~~划掉~~ 行 + // 单行注释 + JSDoc * 行
clean_grep() {
  grep -v "~~.*~~" 2>/dev/null | grep -v "^[[:space:]]*//" 2>/dev/null | grep -v "^[[:space:]]*\*" 2>/dev/null || true
}

# ---------- Rule 1: refreshToken ----------
DOC_REFRESH=$(grep -rh "/auth/refresh\|refresh_tokens" "$DOCS_DIR" 2>/dev/null | clean_grep | wc -l | tr -d ' ')

if [ "$DOC_REFRESH" -gt 0 ]; then
  if ! grep -rq "@Post(['\"]refresh['\"]" "$SERVER_SRC/modules/auth/" 2>/dev/null; then
    echo "DRIFT [R1a]: docs 承诺 POST /api/auth/refresh，src/modules/auth/ 无 @Post('refresh')"
    DRIFT_COUNT=$((DRIFT_COUNT+1))
  fi
  if ! grep -rq "refresh_tokens" "$SERVER_MIG/" 2>/dev/null; then
    echo "DRIFT [R1b]: docs 承诺 refresh_tokens 表，migrations/ 无此表定义"
    DRIFT_COUNT=$((DRIFT_COUNT+1))
  fi
fi

# ---------- Rule 2: deactivated_at ----------
DOC_SOFT=$(grep -rh "deactivated_at" "$DOCS_DIR" 2>/dev/null | clean_grep | wc -l | tr -d ' ')

if [ "$DOC_SOFT" -gt 0 ]; then
  if ! grep -rq "deactivated_at" "$SERVER_MIG/" 2>/dev/null; then
    echo "DRIFT [R2]: docs 承诺 deactivated_at 软删除，migrations/ 无此列"
    DRIFT_COUNT=$((DRIFT_COUNT+1))
  fi
fi

# ---------- Rule 3: recurring cron ----------
CRON_SVC="$SERVER_SRC/modules/cron/cron-jobs.service.ts"
CRON_CTRL="$SERVER_SRC/modules/cron/cron.controller.ts"

if grep -q "expandRecurringSchedules" "$CRON_SVC" 2>/dev/null; then
  HAS_DECORATOR=$(grep -n "@Cron(" "$CRON_SVC" 2>/dev/null | clean_grep | wc -l | tr -d ' ')
  HAS_HTTP=0
  if [ -f "$CRON_CTRL" ] && grep -q "expandRecurring" "$CRON_CTRL" 2>/dev/null; then
    HAS_HTTP=1
  fi
  if [ "$HAS_DECORATOR" -eq 0 ] && [ "$HAS_HTTP" -eq 0 ]; then
    echo "DRIFT [R3]: expandRecurringSchedules 无 @Cron 装饰器 + 无 HTTP endpoint，生产不触发"
    DRIFT_COUNT=$((DRIFT_COUNT+1))
  fi
fi

# ---------- 结果 ----------
if [ "$DRIFT_COUNT" -gt 0 ]; then
  echo ""
  echo "doc-code-drift: $DRIFT_COUNT drift(s) 检测到"
  echo "修复 = 补代码实现 OR 修订文档删除承诺"
  exit "$DRIFT_COUNT"
else
  echo "doc-code-drift: OK ($(date '+%Y-%m-%d %H:%M'))"
  exit 0
fi
