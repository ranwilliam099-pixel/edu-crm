# PG 异地备份部署指南（生产架构 P0 第 7 项）

> 目标：每日 02:00 全量 pg_dump → 腾讯云 COS 异地备份。配合 PG WAL 归档（实时同步）实现 RPO < 5min / RTO < 1h。

---

## 一、SSH 上服务器

```bash
ssh pdfserver
cd /home/ubuntu/workspace/edu-server
git pull origin main   # 拉新增的 scripts/backup/*
```

## 二、安装腾讯云 COS CLI（coscmd）

```bash
sudo apt-get install -y python3-pip
pip3 install --user coscmd

# 加 PATH（如果 ~/.local/bin 不在 PATH）
echo 'export PATH=$HOME/.local/bin:$PATH' >> ~/.bashrc
source ~/.bashrc

coscmd --version
```

## 三、配置 COS

1. **登录腾讯云**：https://console.cloud.tencent.com/cos
2. **新建 bucket**：
   - 名称：`edu-backup-<APPID>`（APPID 在账户信息里）
   - 区域：**ap-chongqing**（同机房，省钱+快）
   - 访问权限：私有读写
3. **拿 Secret**：
   - 访问管理 → API 密钥管理 → 新建 API 密钥
   - 拿到 SecretId + SecretKey（仅显示一次，立刻保存）
4. **配 coscmd**：

```bash
coscmd config -a <SecretId> -s <SecretKey> -b edu-backup-<APPID> -r ap-chongqing
# 测试
coscmd list
```

## 四、配 bucket 生命周期（自动按时间分级）

进腾讯云 COS 控制台 → bucket → 基础配置 → 生命周期管理，加规则：

| 前缀 | 转标准存储 | 转低频存储 | 转归档存储 | 删除 |
|---|---|---|---|---|
| `edu-pg/` | 0 天 | 30 天后 | 180 天后 | **365 天后** |

**理由**：
- 0-30 天：日活保留（可能恢复）
- 30-180 天：低频（成本降 50%）
- 180-365 天：归档（成本降 90%，恢复要 1-12h）
- 365 天后：删除（合规要求保留 1 年即可）

## 五、配置 env 文件（含敏感凭据）

```bash
nano ~/.edu-backup-env
```

填：

```bash
# PG 凭据
export PGPASSWORD='edu_2026_secret_pwd'
export PG_HOST=127.0.0.1
export PG_PORT=5432
export PG_USER=eduapp
export PG_DB=edu

# COS 凭据
export COS_BUCKET=edu-backup-<你的APPID>
export COS_REGION=ap-chongqing

# 钉钉告警（可空，第 8 项配置后再填）
export DINGTALK_WEBHOOK=
```

```bash
chmod 600 ~/.edu-backup-env   # 仅自己可读
```

## 六、安装 cron

```bash
bash /home/ubuntu/workspace/edu-server/scripts/backup/install-cron.sh
```

会在 crontab 加一行：

```
0 2 * * * . /home/ubuntu/.edu-backup-env && bash /home/ubuntu/workspace/edu-server/scripts/backup/pg-backup-daily.sh >> /var/log/edu-pg-backup.log 2>&1
```

每天凌晨 02:00 跑。

## 七、立即试跑（不等 02:00）

```bash
. ~/.edu-backup-env
bash /home/ubuntu/workspace/edu-server/scripts/backup/pg-backup-daily.sh
```

预期日志（`/var/log/edu-pg-backup.log`）：

```
[2026-05-10 16:30:00] [BACKUP-START] db=edu host=127.0.0.1
[2026-05-10 16:30:42] [BACKUP-OK] 本地 /var/backups/edu-pg/edu-20260510-163000.sql.gz (12M)
[2026-05-10 16:30:42] [VERIFY-OK] gzip 完整性校验通过
[2026-05-10 16:30:55] [UPLOAD-OK] cos://edu-backup-xxx/edu-pg/edu-20260510-163000.sql.gz
[2026-05-10 16:30:55] [DONE] 总耗时 55s
```

## 八、PG WAL 归档（实时备份）

仅 pg_dump（每日全量）+ WAL（实时变更）双保险才能 RPO < 5min。

### 修改 PG 配置

```bash
sudo nano /etc/postgresql/14/main/postgresql.conf
```

```ini
wal_level = replica                # 归档级别（默认就是 replica）
archive_mode = on
archive_command = 'cp %p /var/lib/postgresql/wal_archive/%f'
archive_timeout = 300              # 5 分钟强制切 WAL（保 RPO < 5min）
```

```bash
sudo mkdir -p /var/lib/postgresql/wal_archive
sudo chown postgres:postgres /var/lib/postgresql/wal_archive

sudo systemctl restart postgresql
```

WAL 文件按日上传 COS（另写脚本，可后期加）。

## 九、恢复演练（每月 1 次）

### 完整恢复（PG 全挂）

```bash
# 1. 从 COS 下最新 dump
coscmd download edu-pg/edu-20260510-020000.sql.gz /tmp/

# 2. 解压
gunzip /tmp/edu-20260510-020000.sql.gz

# 3. 在测试机恢复
PGPASSWORD=xxx psql -h 127.0.0.1 -U eduapp -d edu_recovery_test < /tmp/edu-20260510-020000.sql

# 4. 验证（看表数 + 关键租户数据）
psql -h 127.0.0.1 -U eduapp -d edu_recovery_test -c "\dt public.*"
psql -h 127.0.0.1 -U eduapp -d edu_recovery_test -c "SELECT COUNT(*) FROM public.tenants"
```

### 单租户恢复（误删某机构数据）

```bash
# 仅恢复某 tenant schema
pg_restore --schema=tenant_xxxxxxx --dbname=edu_test backup.dump
```

## 十、监控

cron 每天跑完应有一条钉钉简报（02:xx 时段）。如果连续 2 天没收到 → 立刻 ssh 上来看 `/var/log/edu-pg-backup.log`。

```bash
# 看最近 7 天备份
ls -la /var/backups/edu-pg/

# 看 COS 上的备份
coscmd list edu-pg/

# 验证某次备份能解压
gzip -t /var/backups/edu-pg/edu-20260510-020000.sql.gz && echo OK
```

---

## 十一、文件清单

| 文件 | 用途 |
|---|---|
| [scripts/backup/pg-backup-daily.sh](../scripts/backup/pg-backup-daily.sh) | 每日全量备份脚本 |
| [scripts/backup/install-cron.sh](../scripts/backup/install-cron.sh) | 一键装 cron |
| `~/.edu-backup-env` | 凭据（chmod 600）|
| `/var/log/edu-pg-backup.log` | 运行日志 |
| `/var/backups/edu-pg/` | 本地保留 3 天 |
| `cos://edu-backup-<APPID>/edu-pg/` | 异地长期保留（生命周期分级）|

## 十二、与生产架构其他 P0 项的依赖

- **依赖**：PG 实例已跑（已有 ✅）
- **配合**：
  - P0-3 日志（pino）→ 备份脚本 stdout 通过 cron 写入 logfile
  - P0-8 告警 webhook → 备份失败钉钉告警
- **后续 V35**：单租户增量备份 / 全文搜索导出 等
