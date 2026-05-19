#!/bin/bash
# ============================================================
# lint-test-quality.sh — CI 测试质量门（v2.0 §8.1）
#
# 来源：Day 2 Phase B.L1 (2026-05-19) — 严谨测试方案 v2.0
#       桌面 `~/Desktop/2026-05-19-严谨测试方案-v2.0.md` §8.1
#
# 目的：CI gate 阻断 8 类「偷懒 spec」模式（弱断言 / 死断言 / 注释跳过 / 空 mock 等）。
#
# 用法：
#   bash scripts/lint-test-quality.sh                    # 全量扫描，失败 exit 1
#   bash scripts/lint-test-quality.sh --warn-only        # 仅输出，不阻断（用于 baseline 报告）
#   bash scripts/lint-test-quality.sh --baseline=PATH    # 与 baseline 对比，新增超过 baseline 才 exit 1
#
# 阻断策略（exit 1 触发）：
#   ❌ expect(true).toBe(true)           — 死断言
#   ❌ // expect(...)                    — 注释式跳过
#   ❌ toHaveBeenCalled()                — 正向无参（不含 .not.toHaveBeenCalled()，那是合法 negative assert）
#
# WARN（不阻断，但出报告）：
#   ⚠️  .toBeDefined()             阈值 100（DI smoke 测试合法用法，超阈值才警告）
#   ⚠️  it.skip / describe.skip   任何数量都警告（须配 Sprint backlog ticket 注释）
#   ⚠️  mockResolvedValue({})      — 空对象 mock
#   ⚠️  mockResolvedValue(undefined)  常用于 Promise<void> 方法（auditLog.log / redis.set），WARN 提醒
#   ⚠️  empty it body              — 空壳测试
#
# 退出码：
#   0   全 PASS（或 --warn-only）
#   1   有 BLOCKER（hard fail）
#   2   脚本参数错误
#
# 出具：edu-server backend  2026-05-19
# ============================================================

set -euo pipefail

# ===== 参数解析 =====
WARN_ONLY=false
BASELINE_FILE=""
for arg in "$@"; do
  case "$arg" in
    --warn-only) WARN_ONLY=true ;;
    --baseline=*) BASELINE_FILE="${arg#*=}" ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# //' | head -40
      exit 0
      ;;
    *) echo "[error] unknown arg: $arg"; exit 2 ;;
  esac
done

# ===== 配置 =====
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN_DIR="${REPO_ROOT}/src"
SPEC_GLOB='*.spec.ts'

# 阈值
TO_BE_DEFINED_THRESHOLD=100         # toBeDefined 数量上限（v2.0 §8.1 起点）
EMPTY_MOCK_THRESHOLD=20             # mockResolvedValue({}) 上限
UNDEFINED_MOCK_THRESHOLD=80         # mockResolvedValue(undefined) 上限（多为 Promise<void> 合法）

# ===== 颜色 =====
C_GREEN='\033[32m'
C_RED='\033[31m'
C_YELLOW='\033[33m'
C_CYAN='\033[36m'
C_GRAY='\033[90m'
C_BOLD='\033[1m'
C_RESET='\033[0m'

ok()      { printf "${C_GREEN}OK${C_RESET}      %s\n" "$1"; }
fail()    { printf "${C_RED}BLOCK${C_RESET}   %s\n" "$1"; }
warn()    { printf "${C_YELLOW}WARN${C_RESET}    %s\n" "$1"; }
info()    { printf "${C_CYAN}INFO${C_RESET}    %s\n" "$1"; }
section() { printf "\n${C_BOLD}== %s ==${C_RESET}\n" "$1"; }

# ===== Banner =====
echo ""
echo "==============================================="
echo "  lint-test-quality.sh — 测试质量门 v2.0 §8.1"
echo "==============================================="
echo ""
info "扫描目录: $SCAN_DIR"
info "spec 总数: $(find "$SCAN_DIR" -name "$SPEC_GLOB" | wc -l | tr -d ' ')"
if [ "$WARN_ONLY" = true ]; then
  warn "WARN-ONLY 模式（不阻断，仅出 baseline 报告）"
fi
echo ""

# ===== 统计累计 =====
BLOCKER_COUNT=0
WARN_COUNT=0
INFO_COUNT=0

# ============================================================
# BLOCKER 1: expect(true).toBe(true) — 死断言
# ============================================================
section "BLOCKER 1: expect(true).toBe(true) 死断言"
DEAD_ASSERT_LIST=$(grep -rEn 'expect\(true\)\.toBe\(true\)' "$SCAN_DIR" --include="$SPEC_GLOB" 2>/dev/null || true)
DEAD_ASSERT_COUNT=$(echo -n "$DEAD_ASSERT_LIST" | grep -c '' || true)
if [ "$DEAD_ASSERT_COUNT" -gt 0 ]; then
  fail "发现 $DEAD_ASSERT_COUNT 处 expect(true).toBe(true) 死断言："
  echo "$DEAD_ASSERT_LIST" | sed 's/^/         /'
  BLOCKER_COUNT=$((BLOCKER_COUNT + DEAD_ASSERT_COUNT))
else
  ok "无 expect(true).toBe(true) 死断言"
fi

# expect(false).toBe(true) 同款 dead assert
section "BLOCKER 1b: expect(false).toBe(true) / expect(1).toBe(1) 等死断言"
DEAD_ASSERT_2=$(grep -rEn 'expect\((false|1)\)\.toBe\((true|1)\)' "$SCAN_DIR" --include="$SPEC_GLOB" 2>/dev/null || true)
DEAD_ASSERT_2_COUNT=$(echo -n "$DEAD_ASSERT_2" | grep -c '' || true)
if [ "$DEAD_ASSERT_2_COUNT" -gt 0 ]; then
  fail "发现 $DEAD_ASSERT_2_COUNT 处死断言变体："
  echo "$DEAD_ASSERT_2" | sed 's/^/         /'
  BLOCKER_COUNT=$((BLOCKER_COUNT + DEAD_ASSERT_2_COUNT))
else
  ok "无死断言变体"
fi

# ============================================================
# BLOCKER 2: // expect(...) — 注释式跳过
# ============================================================
section "BLOCKER 2: // expect(...) 注释式跳过"
COMMENTED_EXPECT=$(grep -rEn '^\s*//\s*expect\(' "$SCAN_DIR" --include="$SPEC_GLOB" 2>/dev/null || true)
COMMENTED_EXPECT_COUNT=$(echo -n "$COMMENTED_EXPECT" | grep -c '' || true)
if [ "$COMMENTED_EXPECT_COUNT" -gt 0 ]; then
  fail "发现 $COMMENTED_EXPECT_COUNT 处注释式跳过："
  echo "$COMMENTED_EXPECT" | sed 's/^/         /'
  BLOCKER_COUNT=$((BLOCKER_COUNT + COMMENTED_EXPECT_COUNT))
else
  ok "无注释式跳过"
fi

# ============================================================
# BLOCKER 3: toHaveBeenCalled() 正向无参（弱断言）
# ============================================================
# 合法用法：.not.toHaveBeenCalled() — 验证「不该调用的没调用」是 strict 校验
# 偷懒用法：expect(spy).toHaveBeenCalled() — 不验证调用参数，只验证调过
section "BLOCKER 3: toHaveBeenCalled() 正向无参（弱断言）"
WEAK_CALLED=$(grep -rEn 'toHaveBeenCalled\(\)\s*[;,]?\s*$' "$SCAN_DIR" --include="$SPEC_GLOB" 2>/dev/null | grep -v '\.not\.toHaveBeenCalled' || true)
WEAK_CALLED_COUNT=$(echo -n "$WEAK_CALLED" | grep -c '' || true)
if [ "$WEAK_CALLED_COUNT" -gt 0 ]; then
  fail "发现 $WEAK_CALLED_COUNT 处 toHaveBeenCalled() 无参弱断言（必须用 toHaveBeenCalledWith / toHaveBeenCalledTimes）："
  echo "$WEAK_CALLED" | sed 's/^/         /'
  BLOCKER_COUNT=$((BLOCKER_COUNT + WEAK_CALLED_COUNT))
else
  ok "无 toHaveBeenCalled() 正向无参"
fi

# ============================================================
# WARN 1: .toBeDefined() — 阈值 100
# ============================================================
section "WARN 1: .toBeDefined() 弱断言（阈值 $TO_BE_DEFINED_THRESHOLD）"
TO_BE_DEFINED=$(grep -rEn '\.toBeDefined\(\)' "$SCAN_DIR" --include="$SPEC_GLOB" 2>/dev/null || true)
TO_BE_DEFINED_COUNT=$(echo -n "$TO_BE_DEFINED" | grep -c '' || true)
if [ "$TO_BE_DEFINED_COUNT" -gt "$TO_BE_DEFINED_THRESHOLD" ]; then
  warn "发现 $TO_BE_DEFINED_COUNT 处 .toBeDefined() (> $TO_BE_DEFINED_THRESHOLD 阈值)"
  echo "$TO_BE_DEFINED" | head -5 | sed 's/^/         /'
  echo "         ... (剩 $((TO_BE_DEFINED_COUNT - 5)) 处，运行 grep -rEn '.toBeDefined()' src/ 查完整)"
  WARN_COUNT=$((WARN_COUNT + TO_BE_DEFINED_COUNT - TO_BE_DEFINED_THRESHOLD))
else
  ok ".toBeDefined() 数量 $TO_BE_DEFINED_COUNT ≤ $TO_BE_DEFINED_THRESHOLD"
fi

# ============================================================
# WARN 2: it.skip / describe.skip / it.todo
# ============================================================
section "WARN 2: it.skip / describe.skip / it.todo / xit"
SKIP_LIST=$(grep -rEn '\b(it|describe|test)\.(skip|todo)\b|\b(xit|xdescribe|xtest)\(' "$SCAN_DIR" --include="$SPEC_GLOB" 2>/dev/null || true)
SKIP_COUNT=$(echo -n "$SKIP_LIST" | grep -c '' || true)
if [ "$SKIP_COUNT" -gt 0 ]; then
  warn "发现 $SKIP_COUNT 处 skip/todo（每个必须配 Sprint backlog ticket 注释）："
  echo "$SKIP_LIST" | sed 's/^/         /'
  # 检查 skip 是否带 ticket 注释（向上 3 行查 backlog / Sprint / TODO ticket reference）
  WARN_COUNT=$((WARN_COUNT + SKIP_COUNT))
else
  ok "无 skip/todo（clean）"
fi

# ============================================================
# WARN 3: mockResolvedValue({}) — 空对象 mock
# ============================================================
section "WARN 3: mockResolvedValue({}) 空对象 mock（阈值 $EMPTY_MOCK_THRESHOLD）"
EMPTY_MOCK=$(grep -rEn 'mockResolvedValue\(\{\}\)' "$SCAN_DIR" --include="$SPEC_GLOB" 2>/dev/null || true)
EMPTY_MOCK_COUNT=$(echo -n "$EMPTY_MOCK" | grep -c '' || true)
if [ "$EMPTY_MOCK_COUNT" -gt "$EMPTY_MOCK_THRESHOLD" ]; then
  warn "发现 $EMPTY_MOCK_COUNT 处 mockResolvedValue({}) (> $EMPTY_MOCK_THRESHOLD 阈值)"
  echo "$EMPTY_MOCK" | head -5 | sed 's/^/         /'
  WARN_COUNT=$((WARN_COUNT + EMPTY_MOCK_COUNT - EMPTY_MOCK_THRESHOLD))
elif [ "$EMPTY_MOCK_COUNT" -gt 0 ]; then
  info "mockResolvedValue({}) 数量 $EMPTY_MOCK_COUNT (阈值 $EMPTY_MOCK_THRESHOLD)"
else
  ok "无 mockResolvedValue({})"
fi

# ============================================================
# WARN 4: mockResolvedValue(undefined) — 阈值 80（多为 Promise<void> 合法）
# ============================================================
section "WARN 4: mockResolvedValue(undefined) (阈值 $UNDEFINED_MOCK_THRESHOLD)"
UNDEF_MOCK=$(grep -rEn 'mockResolvedValue\(undefined\)' "$SCAN_DIR" --include="$SPEC_GLOB" 2>/dev/null || true)
UNDEF_MOCK_COUNT=$(echo -n "$UNDEF_MOCK" | grep -c '' || true)
if [ "$UNDEF_MOCK_COUNT" -gt "$UNDEFINED_MOCK_THRESHOLD" ]; then
  warn "发现 $UNDEF_MOCK_COUNT 处 mockResolvedValue(undefined) (> $UNDEFINED_MOCK_THRESHOLD 阈值)"
  WARN_COUNT=$((WARN_COUNT + UNDEF_MOCK_COUNT - UNDEFINED_MOCK_THRESHOLD))
else
  info "mockResolvedValue(undefined) 数量 $UNDEF_MOCK_COUNT (Promise<void> 多为合法用法)"
fi

# ============================================================
# WARN 5: 空 it 体 — it('xxx', () => {})
# ============================================================
section "WARN 5: 空 it body"
EMPTY_IT=$(grep -rEn '^\s*it\(.*\)\s*=>\s*\{\s*\}\s*\)?\s*;?\s*$' "$SCAN_DIR" --include="$SPEC_GLOB" 2>/dev/null || true)
EMPTY_IT_COUNT=$(echo -n "$EMPTY_IT" | grep -c '' || true)
if [ "$EMPTY_IT_COUNT" -gt 0 ]; then
  warn "发现 $EMPTY_IT_COUNT 处空 it body"
  echo "$EMPTY_IT" | sed 's/^/         /'
  WARN_COUNT=$((WARN_COUNT + EMPTY_IT_COUNT))
else
  ok "无空 it body"
fi

# ============================================================
# INFO 1: spec 复制粘贴检测（jscpd）
# ============================================================
section "INFO 1: jscpd spec 重复度（如未安装则跳过）"
if command -v npx >/dev/null 2>&1 && [ -d "$REPO_ROOT/node_modules" ]; then
  # 仅扫 spec 目录避免污染业务代码统计
  if npx --no-install jscpd --version >/dev/null 2>&1; then
    info "运行 jscpd（min-tokens=70, threshold=10%）..."
    JSCPD_OUT=$(npx --no-install jscpd "$SCAN_DIR" --pattern '**/*.spec.ts' --min-tokens 70 --threshold 10 --silent 2>&1 || true)
    if echo "$JSCPD_OUT" | grep -q 'Threshold exceeded'; then
      warn "jscpd 检测到 spec 重复度 > 10%（CI 仅 WARN，未来严格 enforce）"
      echo "$JSCPD_OUT" | head -8 | sed 's/^/         /'
      INFO_COUNT=$((INFO_COUNT + 1))
    else
      ok "jscpd 重复度 < 10%"
    fi
  else
    info "jscpd 未安装（pnpm add -D jscpd 可启用）— 跳过"
  fi
else
  info "npx / node_modules 不可用 — 跳过"
fi

# ============================================================
# Summary
# ============================================================
echo ""
echo "==============================================="
echo "  Summary"
echo "==============================================="
printf "  ${C_RED}BLOCKER${C_RESET}: %d\n" "$BLOCKER_COUNT"
printf "  ${C_YELLOW}WARN${C_RESET}:    %d\n" "$WARN_COUNT"
printf "  ${C_CYAN}INFO${C_RESET}:    %d\n" "$INFO_COUNT"
echo ""

# 详细分类统计输出（用于 baseline 报告解析）
echo "==============================================="
echo "  Detailed counts (machine-readable)"
echo "==============================================="
echo "DEAD_ASSERT_TRUE_TRUE=$DEAD_ASSERT_COUNT"
echo "DEAD_ASSERT_VARIANT=$DEAD_ASSERT_2_COUNT"
echo "COMMENTED_EXPECT=$COMMENTED_EXPECT_COUNT"
echo "WEAK_TO_HAVE_BEEN_CALLED=$WEAK_CALLED_COUNT"
echo "TO_BE_DEFINED=$TO_BE_DEFINED_COUNT"
echo "SKIP_OR_TODO=$SKIP_COUNT"
echo "EMPTY_OBJECT_MOCK=$EMPTY_MOCK_COUNT"
echo "UNDEFINED_MOCK=$UNDEF_MOCK_COUNT"
echo "EMPTY_IT_BODY=$EMPTY_IT_COUNT"
echo ""

# ===== 退出 =====
if [ "$WARN_ONLY" = true ]; then
  info "WARN-ONLY 模式 → exit 0（baseline 报告用途）"
  exit 0
fi

if [ "$BLOCKER_COUNT" -gt 0 ]; then
  fail "$BLOCKER_COUNT 个 BLOCKER 命中 — CI 阻断 (exit 1)"
  echo ""
  echo "修复指引："
  echo "  • expect(true).toBe(true)  → 删除该 test 或换具体断言（验证业务行为）"
  echo "  • // expect(...)           → 取消注释 + 修正断言，或删除该断言"
  echo "  • toHaveBeenCalled()       → 改为 toHaveBeenCalledWith({精确参数}) 或 toHaveBeenCalledTimes(N)"
  exit 1
fi

ok "全部 BLOCKER 检测通过（WARN/INFO 不阻断）"
exit 0
