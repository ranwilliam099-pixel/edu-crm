#!/usr/bin/env bash
# ============================================================
# sync-deploy.sh — edu-server rsync + npm install + nest build + pm2 reload
#
# 来源：2026-05-13 部署 22 commit + 7 schema migration 实战经验沉淀
#
# 用法：
#   bash scripts/sync-deploy.sh           # 默认：rsync + install + build + reload
#   bash scripts/sync-deploy.sh --no-reload # 仅 sync 不 reload
#   bash scripts/sync-deploy.sh --check     # 仅同步检查（dry-run rsync）
#
# 前置（环境变量可覆盖）：
#   - SSH_HOST: pdfserver (默认, 见 ~/.ssh/config)
#   - REMOTE_PATH: /home/ubuntu/workspace/edu-server (默认)
#
# 不做的事（hands-on 单独跑）：
#   - schema migration → bash scripts/backfill-vXX.sh --apply
#   - .env 改动 → ssh pdfserver 手动编辑
#   - V40/V41 数据 backfill → ssh pdfserver + npx ts-node scripts/backfill-vXX.ts --apply
#
# 实战教训（5/13 deploy 踩过）：
#   1. rsync 必 exclude pnpm-lock.yaml（否则服务器 npm install 拒，每次要 rm）
#   2. rsync 必 exclude dump-* / backups/（防把生产备份覆盖回本地空目录）
#   3. rsync 必 exclude .claude/（agent 配置不应跨环境同步）
#   4. nest build 之前先 rm -rf dist/（防旧 dist 残留 stale TS 编译）
#   5. pm2 reload 必加 --update-env（让 pm2 重读 .env 新加的字段如 HASH_KEY）
#   6. reload 后 sleep 5s 等 worker 重建 + 健康检查
# ============================================================

set -euo pipefail

# ===== 参数解析 =====
NO_RELOAD=false
CHECK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --no-reload) NO_RELOAD=true ;;
    --check) CHECK_ONLY=true ;;
    --help|-h)
      echo "Usage: bash scripts/sync-deploy.sh [--no-reload] [--check]"
      exit 0
      ;;
    *) echo "[warn] unknown arg: $arg" ;;
  esac
done

SSH_HOST="${SSH_HOST:-pdfserver}"
REMOTE_PATH="${REMOTE_PATH:-/home/ubuntu/workspace/edu-server}"
LOCAL_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/"

# ===== 日志 =====
B='\033[1m'; R='\033[0;31m'; G='\033[0;32m'; Y='\033[0;33m'; N='\033[0m'
info() { echo -e "${B}[info]${N} $*"; }
ok()   { echo -e "${G}[ok]${N}   $*"; }
warn() { echo -e "${Y}[warn]${N} $*"; }
fail() { echo -e "${R}[fail]${N} $*" >&2; }

# ===== Step 1: rsync =====
info "Step 1/4: rsync $LOCAL_PATH → $SSH_HOST:$REMOTE_PATH"

RSYNC_ARGS=(
  -avz
  --delete
  --exclude='node_modules/'
  --exclude='dist/'
  --exclude='.git/'
  --exclude='.env'
  --exclude='.env.*'        # .env.backup.* 不覆盖
  --exclude='backups/'
  --exclude='dump-*'         # pg_dump 输出目录不覆盖
  --exclude='pnpm-lock.yaml' # 服务器用 npm，pnpm-lock 会冲突
  --exclude='package-lock.json' # 服务器 npm install 生成，本地无，--delete 会误删
  --exclude='*.log'
  --exclude='.DS_Store'
  --exclude='.claude/'       # agent 配置本地专属
  --exclude='coverage/'
  --exclude='.idea/'
  --exclude='.vscode/'
  -e 'ssh -o StrictHostKeyChecking=no'
)

if [ "$CHECK_ONLY" = true ]; then
  info "  [--check] dry-run 模式"
  rsync "${RSYNC_ARGS[@]}" --dry-run --itemize-changes "$LOCAL_PATH" "$SSH_HOST:$REMOTE_PATH" | tail -30
  ok "Step 1 dry-run 完成（仅显示 diff）"
  exit 0
fi

rsync "${RSYNC_ARGS[@]}" "$LOCAL_PATH" "$SSH_HOST:$REMOTE_PATH" | tail -10
ok "Step 1 rsync 完成"
echo ""

# ===== Step 2: npm install + nest build =====
info "Step 2/4: 远端 npm install + nest build"
ssh "$SSH_HOST" << REMOTE
set -e
cd $REMOTE_PATH
echo "  [npm install]"
npm install --no-audit --no-fund 2>&1 | tail -3
echo "  [nest build]"
rm -rf dist/   # 防旧 dist 残留 stale 编译
npm run build 2>&1 | tail -3
ls -lh dist/src/main.js
REMOTE
ok "Step 2 install + build 完成"
echo ""

# ===== Step 3: pm2 reload (可跳过) =====
if [ "$NO_RELOAD" = true ]; then
  warn "Step 3 跳过（--no-reload）— 记得手动 ssh $SSH_HOST 'pm2 reload edu-api --update-env'"
else
  info "Step 3/4: pm2 reload (--update-env 让 pm2 重读 .env)"
  # T17a (2026-05-16): 写入本地 git SHA 到生产 .env SENTRY_RELEASE，让 Sentry 报错带 commit 追溯
  #   - sentry.config.ts:38 读 process.env.SENTRY_RELEASE
  #   - 生产无 .git，必须 deploy-time 注入
  #   - 用 sed/grep 模式 idempotent 替换或追加，pm2 reload --update-env 后生效
  GIT_SHA=$(git -C "${LOCAL_PATH%/}" rev-parse --short HEAD)
  ssh "$SSH_HOST" "cd $REMOTE_PATH && \
    (grep -q '^SENTRY_RELEASE=' .env \
      && sed -i 's|^SENTRY_RELEASE=.*|SENTRY_RELEASE=$GIT_SHA|' .env \
      || echo 'SENTRY_RELEASE=$GIT_SHA' >> .env) && \
    pm2 reload edu-api --update-env" | tail -3
  ok "Step 3 pm2 reload 完成（SENTRY_RELEASE=$GIT_SHA）"
  echo ""
fi

# ===== Step 4: 健康检查 =====
info "Step 4/4: 健康检查（等 5s reload 完成后）"
sleep 5
HEALTH=$(curl -s -m 10 "http://1.14.127.67/api/public/health" || echo '{}')
if echo "$HEALTH" | grep -q '"ok":true'; then
  ok "公网健康检查 PASS: $HEALTH"
else
  fail "公网健康检查失败: $HEALTH"
  ssh "$SSH_HOST" "pm2 logs edu-api --lines 10 --nostream --err 2>&1 | tail -10"
  exit 1
fi

echo ""
echo "================================================================"
ok "✅ sync-deploy 全部完成"
echo "  - 代码已同步到生产"
echo "  - npm install + build OK"
[ "$NO_RELOAD" = false ] && echo "  - pm2 reload OK + 健康检查 200"
echo ""
echo "  下一步（按需）："
echo "  - schema migration: bash scripts/backfill-vXX.sh --apply"
echo "  - 数据 backfill: TENANT_SCHEMA=xxx npx ts-node scripts/backfill-vXX.ts --apply"
echo "  - 业务模拟: bash test/production-full-test.sh"
echo "================================================================"
