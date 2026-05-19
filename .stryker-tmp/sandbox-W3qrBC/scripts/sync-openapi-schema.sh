#!/usr/bin/env bash
# ============================================================
# sync-openapi-schema.sh — Phase B.L3 (2026-05-19) 后端 → 前端 schema 同步
#
# 用法：
#   bash scripts/sync-openapi-schema.sh         # 重新生成 baseline + 拷到前端
#   bash scripts/sync-openapi-schema.sh --skip-gen  # 仅拷贝（baseline 已存在）
#
# 工作流：
#   1. （默认）pnpm openapi:gen 生成 baseline/openapi.json
#   2. cp baseline/openapi.json → edu-mp-sandbox/miniprogram/utils/openapi-schema.json
#   3. 校验 5 个核心 endpoint 都在 paths（防生成失败 silent）
#
# 反偷懒：必须每次 deploy / git commit 跑一次（防契约漂移）
# ============================================================

set -euo pipefail

SKIP_GEN=false
for arg in "$@"; do
  case "$arg" in
    --skip-gen) SKIP_GEN=true ;;
    --help|-h)
      echo "Usage: bash scripts/sync-openapi-schema.sh [--skip-gen]"
      exit 0
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MP_TARGET="$SERVER_ROOT/../edu-mp-sandbox/miniprogram/utils/openapi-schema.json"

cd "$SERVER_ROOT"

if [ "$SKIP_GEN" = "false" ]; then
  echo "[1/3] generating baseline/openapi.json via pnpm openapi:gen ..."
  pnpm openapi:gen
fi

if [ ! -f "baseline/openapi.json" ]; then
  echo "ERROR: baseline/openapi.json missing — 跑 pnpm openapi:gen 失败" >&2
  exit 1
fi

# 校验 5 核心 endpoint
REQUIRED_PATHS=(
  '/api/db/customers'
  '/api/db/contracts'
  '/api/schedules'
  '/api/db/lesson-feedbacks'
  '/api/db/invoices'
)
echo "[2/3] verifying 5 核心 endpoints in baseline/openapi.json ..."
for p in "${REQUIRED_PATHS[@]}"; do
  if ! jq -e --arg path "$p" '.paths[$path]' baseline/openapi.json > /dev/null; then
    echo "ERROR: baseline/openapi.json 缺核心 endpoint: $p" >&2
    exit 1
  fi
  echo "  OK $p"
done

# 拷到前端
if [ ! -d "$(dirname "$MP_TARGET")" ]; then
  echo "ERROR: 前端 utils 目录不存在: $(dirname "$MP_TARGET")" >&2
  exit 1
fi

echo "[3/3] cp baseline/openapi.json → $MP_TARGET ..."
cp baseline/openapi.json "$MP_TARGET"
echo "DONE. 前端 schema-validator.js 会自动 require 新版本"
