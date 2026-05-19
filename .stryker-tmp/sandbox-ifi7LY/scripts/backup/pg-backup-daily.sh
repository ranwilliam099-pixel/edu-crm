#!/bin/bash
# ============================================================
# pg-backup-daily.sh — 生产架构 P0 第 7 项
#
# 来源：用户 2026-05-10 「可上架生产架构」P0 第 7 项
#
# 用途：
#   每日 02:00 全量 pg_dump 教培业务库 → 压缩 → 上传腾讯云 COS（异地）
#   配合 PG 自带 WAL 归档（实时同步）实现 RPO < 5min / RTO < 1h
#
# 容灾设计：
#   - 失败时钉钉告警（hook URL 从 env 读，未配置时仅记本地日志）
#   - 本地保留 3 天（防 COS 故障时短期可恢复）
#   - COS 保留：日 7 天 / 周 4 周 / 月 12 月（cos lifecycle 配置）
#
# 必需 ENV:
#   PGPASSWORD          — PG 密码
#   PG_HOST             — PG 主机（默认 127.0.0.1）
#   PG_PORT             — PG 端口（默认 5432）
#   PG_USER             — PG 用户（默认 eduapp）
#   PG_DB               — PG 库名（默认 edu）
#   COS_BUCKET          — 腾讯云 COS bucket（如 edu-backup-1234567890）
#   COS_REGION          — 区域（如 ap-chongqing）
#   DINGTALK_WEBHOOK    — 钉钉群机器人 webhook（可选）
#
# 用法：
#   bash /home/ubuntu/workspace/edu-server/scripts/backup/pg-backup-daily.sh
#
# 安装 cron：
#   bash /home/ubuntu/workspace/edu-server/scripts/backup/install-cron.sh
# ============================================================

set -euo pipefail

# ===== 配置 =====
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-eduapp}"
PG_DB="${PG_DB:-edu}"
COS_BUCKET="${COS_BUCKET:-}"
COS_REGION="${COS_REGION:-ap-chongqing}"
DINGTALK_WEBHOOK="${DINGTALK_WEBHOOK:-}"

LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-/var/backups/edu-pg}"
LOCAL_RETAIN_DAYS=3

LOG_FILE="${LOG_FILE:-/var/log/edu-pg-backup.log}"
DATE=$(date +%Y%m%d-%H%M%S)
DUMP_NAME="edu-${DATE}.sql.gz"
DUMP_PATH="${LOCAL_BACKUP_DIR}/${DUMP_NAME}"

# ===== 工具函数 =====
log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg" | tee -a "$LOG_FILE"
}

alert_dingtalk() {
  local title="$1"
  local content="$2"
  if [ -z "$DINGTALK_WEBHOOK" ]; then
    log "[ALERT-LOCAL] $title: $content"
    return
  fi
  local payload
  payload=$(cat <<EOF
{
  "msgtype": "markdown",
  "markdown": {
    "title": "$title",
    "text": "## ⚠️ $title\n\n**主机**: $(hostname)\n\n**时间**: $(date '+%Y-%m-%d %H:%M:%S')\n\n**详情**: $content"
  }
}
EOF
)
  curl -s -m 10 -X POST -H "Content-Type: application/json" \
    -d "$payload" "$DINGTALK_WEBHOOK" >> "$LOG_FILE" 2>&1 || true
}

cleanup_local() {
  # 保留近 N 天本地备份
  find "$LOCAL_BACKUP_DIR" -name 'edu-*.sql.gz' -type f -mtime "+$LOCAL_RETAIN_DAYS" -delete 2>/dev/null || true
}

# ===== 前置检查 =====
mkdir -p "$LOCAL_BACKUP_DIR"
chmod 700 "$LOCAL_BACKUP_DIR"
mkdir -p "$(dirname "$LOG_FILE")"

if [ -z "${PGPASSWORD:-}" ]; then
  log "[FATAL] PGPASSWORD env 未设"
  alert_dingtalk "PG 备份失败" "PGPASSWORD env 未设"
  exit 1
fi

# ===== 1. pg_dump → 本地 .sql.gz =====
log "[BACKUP-START] db=$PG_DB host=$PG_HOST"
START_TS=$(date +%s)

if pg_dump \
    --host="$PG_HOST" \
    --port="$PG_PORT" \
    --username="$PG_USER" \
    --dbname="$PG_DB" \
    --no-owner \
    --no-acl \
    --format=plain \
    --verbose 2>>"$LOG_FILE" | gzip -9 > "$DUMP_PATH"; then
  DUMP_SIZE=$(du -h "$DUMP_PATH" | awk '{print $1}')
  log "[BACKUP-OK] 本地 $DUMP_PATH ($DUMP_SIZE)"
else
  log "[BACKUP-FAIL] pg_dump 失败"
  rm -f "$DUMP_PATH"
  alert_dingtalk "PG 备份失败" "pg_dump 退出码非 0，详见 $LOG_FILE"
  exit 1
fi

# ===== 2. 校验 dump 完整性（gzip integrity）=====
if ! gzip -t "$DUMP_PATH" 2>/dev/null; then
  log "[VERIFY-FAIL] gzip 完整性校验失败"
  rm -f "$DUMP_PATH"
  alert_dingtalk "PG 备份失败" "gzip integrity check 不通过"
  exit 1
fi
log "[VERIFY-OK] gzip 完整性校验通过"

# ===== 3. 上传 COS =====
if [ -z "$COS_BUCKET" ]; then
  log "[SKIP-UPLOAD] COS_BUCKET 未配置 - 仅本地备份"
else
  if command -v coscmd >/dev/null 2>&1; then
    if coscmd upload "$DUMP_PATH" "edu-pg/$DUMP_NAME" >>"$LOG_FILE" 2>&1; then
      log "[UPLOAD-OK] cos://$COS_BUCKET/edu-pg/$DUMP_NAME"
    else
      log "[UPLOAD-FAIL] coscmd 失败"
      alert_dingtalk "PG 备份上传失败" "coscmd upload 失败，本地备份保留：$DUMP_PATH"
      # 不 exit — 本地备份已成功，仅上传失败
    fi
  else
    log "[SKIP-UPLOAD] coscmd 未安装 - 跳过上传"
    alert_dingtalk "PG 备份未上传" "coscmd 未安装，本地备份：$DUMP_PATH"
  fi
fi

# ===== 4. 清理本地老备份 =====
cleanup_local

# ===== 5. 完成 =====
DURATION=$(( $(date +%s) - START_TS ))
log "[DONE] 总耗时 ${DURATION}s"

# 成功通知（仅每日成功简报，频繁告警噪音）
if [ "$(date '+%H')" = "02" ]; then
  alert_dingtalk "PG 备份完成" "$DUMP_NAME ($DUMP_SIZE) 用时 ${DURATION}s"
fi
