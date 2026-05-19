#!/usr/bin/env bash
# install-hooks.sh — 一键安装 git pre-commit hook
# 用户每次 clone repo 后跑一次：bash tools/install-hooks.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK_SRC="$REPO_ROOT/tools/git-hooks/pre-commit"
HOOK_DST="$REPO_ROOT/.git/hooks/pre-commit"

if [ ! -f "$HOOK_SRC" ]; then
  echo "❌ tools/git-hooks/pre-commit 未找到"
  exit 1
fi

if [ -f "$HOOK_DST" ] && [ ! -L "$HOOK_DST" ]; then
  echo "⚠️  现有 pre-commit hook 已备份到 .git/hooks/pre-commit.bak"
  mv "$HOOK_DST" "$HOOK_DST.bak"
fi

ln -sf "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_SRC"
chmod +x "$REPO_ROOT/tools/validate-no-cross-tenant.sh"

echo "✅ pre-commit hook 安装成功"
echo "   每次 git commit src/modules/db/**.ts 时会自动跑跨租户隔离校验"
echo "   每次 git commit src/**.ts 时会自动跑 TypeScript 编译快查"
echo "   紧急绕过：git commit --no-verify"
