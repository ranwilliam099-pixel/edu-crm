#!/bin/bash
# ============================================================
# check-seed-gitignore.sh
#
# F5 修复（2026-05-19）：CI guard 防 scripts/seed/demo-users.json 入库
#
# 用法（CI 或 pre-commit hook）：
#   bash scripts/check-seed-gitignore.sh
#
# Exit code:
#   0 = demo-users.json 已被 gitignore（OK）
#   1 = NOT IGNORED（事故）
#
# 出具：edu-server backend Day 1 T5 修红  2026-05-19
# ============================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 必须 ignore 的敏感文件列表
SENSITIVE_FILES=(
  "scripts/seed/demo-users.json"
)

ERRORS=0
for f in "${SENSITIVE_FILES[@]}"; do
  if git check-ignore -q "$f" 2>/dev/null; then
    echo "[OK]   $f → gitignored"
  else
    echo "[FAIL] $f → NOT IGNORED（含 PII 明文密码，立刻加 .gitignore）" >&2
    ERRORS=$((ERRORS + 1))
  fi
done

# 额外检查：scripts/seed/demo-users.json 是否在 git index 内（即使 ignore 也防过往误入）
if git ls-files scripts/seed/demo-users.json 2>/dev/null | grep -q .; then
  echo "[FAIL] scripts/seed/demo-users.json 已被 git tracked（必须 git rm --cached 移除）" >&2
  ERRORS=$((ERRORS + 1))
fi

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "[FAIL] $ERRORS 项 PII 泄露风险"
  exit 1
fi

echo "[OK] gitignore guard passed — 无 PII 泄露风险"
exit 0
