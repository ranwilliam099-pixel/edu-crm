#!/bin/bash
# ============================================================
# install-cron.sh — 安装 PG 备份 cron 任务
#
# 用法：
#   bash /home/ubuntu/workspace/edu-server/scripts/backup/install-cron.sh
#
# 前置：
#   /home/ubuntu/.edu-backup-env 含必需 env（chmod 600 防泄密）
#     PGPASSWORD=...
#     COS_BUCKET=edu-backup-xxx
#     COS_REGION=ap-chongqing
#     DINGTALK_WEBHOOK=https://...
# ============================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/backup/pg-backup-daily.sh"
ENV_FILE="${ENV_FILE:-$HOME/.edu-backup-env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ env file 不存在: $ENV_FILE"
  echo "请先创建并 chmod 600，含 PGPASSWORD / COS_BUCKET / COS_REGION / DINGTALK_WEBHOOK"
  exit 1
fi

if [ "$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Mp%Lp' "$ENV_FILE")" != "600" ]; then
  echo "⚠️  env file 权限不是 600（敏感凭据），自动修：chmod 600 $ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

CRON_LINE="0 2 * * * . $ENV_FILE && bash $SCRIPT >> /var/log/edu-pg-backup.log 2>&1"

# 安装到当前用户 crontab（不覆盖其他任务）
EXISTING="$(crontab -l 2>/dev/null || true)"
if echo "$EXISTING" | grep -qF "$SCRIPT"; then
  echo "⚠️  crontab 已含此任务，跳过添加"
else
  (echo "$EXISTING"; echo "$CRON_LINE") | crontab -
  echo "✅ crontab 已添加："
  echo "    $CRON_LINE"
fi

echo ""
echo "当前 crontab："
crontab -l | grep -v '^#' | grep -v '^$' | head -20
