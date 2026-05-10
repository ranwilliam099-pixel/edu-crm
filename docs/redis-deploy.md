# Redis 服务器部署指南（生产架构 P0 第 4 项）

> 目标：在 1.14.127.67（Ubuntu）上部署 Redis 单实例，配合 NestJS 后端做 cache / lock / queue。
> 适用规模：30-100 家机构早鸟期（单实例 + AOF 足够）。

---

## 一、SSH 上服务器

```bash
ssh pdfserver
# 或
ssh -i ~/.ssh/william.pem -p 2222 ubuntu@1.14.127.67
```

## 二、安装 Redis 7

```bash
# 1. 加官方 PPA（拿到 7.x 版本，Ubuntu 默认源较旧）
curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/redis.list

# 2. 安装
sudo apt-get update
sudo apt-get install -y redis

# 3. 验证版本（应 ≥ 7.x）
redis-server --version
```

## 三、生产配置加固

```bash
sudo nano /etc/redis/redis.conf
```

关键参数（找到对应项修改）：

```ini
# 1. 仅监听本机（NestJS 同机部署 → 不用暴露公网）
bind 127.0.0.1 -::1
protected-mode yes

# 2. 端口（默认 6379）
port 6379

# 3. AOF 持久化（防数据丢失）
appendonly yes
appendfsync everysec               # 每秒 fsync 一次（数据丢失 ≤1s，性能可接受）
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb

# 4. RDB 快照（双保险）
save 900 1                         # 900s 内 ≥1 次写 → 快照
save 300 10                        # 300s 内 ≥10 次写 → 快照
save 60 10000                      # 60s 内 ≥10000 次写 → 快照
stop-writes-on-bgsave-error yes

# 5. 内存上限 + 淘汰策略
maxmemory 1gb                      # 早鸟期 1G 够；超过 → 后续升 2G
maxmemory-policy allkeys-lru       # LRU 淘汰最久未用 key

# 6. 密码（强烈建议设，即使本机也防手滑）
requirepass <强密码 32 字符以上>
# 生成：openssl rand -base64 32

# 7. 危险命令禁用（防误删）
rename-command FLUSHALL ""
rename-command FLUSHDB  ""
rename-command CONFIG   "CONFIG_xxx_secret"
rename-command SHUTDOWN ""

# 8. 日志
loglevel notice
logfile /var/log/redis/redis-server.log

# 9. 客户端连接数
maxclients 10000

# 10. 慢查询阈值
slowlog-log-slower-than 10000      # 10ms 以上记慢日志
slowlog-max-len 128
```

## 四、启动 + 开机自启

```bash
# 启用 systemd
sudo systemctl enable redis-server
sudo systemctl start redis-server
sudo systemctl status redis-server

# 验证
redis-cli -a '<密码>' ping          # 应返回 PONG
redis-cli -a '<密码>' info server | head -10
```

## 五、防火墙（确认 6379 不暴露公网）

```bash
sudo ufw status
# 应看到：6379 不在公网开放列表
# 如已 allow，删掉：
sudo ufw delete allow 6379
```

## 六、NestJS 后端接入（edu-server）

### 1. 在服务器上 .env 加配置

```bash
cd /home/ubuntu/workspace/edu-server
nano .env
```

加：
```
REDIS_URL=redis://:<密码>@127.0.0.1:6379/0
REDIS_KEY_PREFIX=edu:
```

### 2. pm2 ecosystem 同步注入

```bash
nano ecosystem.config.js
```

`env` 字段加 `REDIS_URL` `REDIS_KEY_PREFIX`（或直接读 .env，pm2 已配 `dotenv`）。

### 3. 拉新代码 + 重启

```bash
git pull origin main
pnpm install
pnpm build
pm2 reload edu-api
pm2 logs edu-api --lines 30
```

启动日志应看到：
```
[Nest] ... [RedisService] Redis connected: redis://127.0.0.1:6379
```

## 七、验证集成

```bash
# 应用层 ping
curl http://localhost:3001/api/public/health
# 后续加 /health/ready 时会包含 redis 探针

# Redis 端验证 keyPrefix 工作
redis-cli -a '<密码>'
> KEYS edu:*
> SET edu:test foo EX 60
> GET edu:test
```

## 八、监控（运行后 7 天内观察）

```bash
# 每小时 cron 跑一次
redis-cli -a '<密码>' info memory | grep used_memory_human
redis-cli -a '<密码>' info stats | grep keyspace_hits
redis-cli -a '<密码>' info clients | grep connected_clients
redis-cli -a '<密码>' slowlog get 10
```

异常指标 → 钉钉告警（P0 第 8 项做）：
- used_memory > 800M（接近 1G 上限）
- keyspace_misses / keyspace_hits > 50%（缓存命中率低）
- connected_clients > 1000（连接异常多）

## 九、备份策略

| 项 | 频率 | 路径 | 保留 |
|---|---|---|---|
| AOF 实时同步 | every-second | `/var/lib/redis/appendonly.aof` | 实时 |
| RDB 快照 | save 规则触发 | `/var/lib/redis/dump.rdb` | 系统自动覆盖 |
| 每日异地备份 | 02:30 cron | `cos://edu-backup/redis/redis-YYYYMMDD.tar.gz` | 7 天 |

cron 脚本（P0 第 7 项做）：
```bash
#!/bin/bash
# /usr/local/bin/redis-backup.sh
DATE=$(date +%Y%m%d)
tar -czf /tmp/redis-$DATE.tar.gz /var/lib/redis/
# coscmd 上传到腾讯云 COS
coscmd upload /tmp/redis-$DATE.tar.gz redis/redis-$DATE.tar.gz
rm /tmp/redis-$DATE.tar.gz
```

---

## 十、回滚 / 灾难恢复

```bash
# 1. 停 Redis
sudo systemctl stop redis-server

# 2. 恢复 AOF（最新数据）
sudo cp /backup/appendonly.aof /var/lib/redis/

# 3. 启 Redis
sudo systemctl start redis-server

# 4. 验证
redis-cli -a '<密码>' DBSIZE
```

---

## 十一、NestJS 已实现的能力（src/modules/redis/redis.service.ts）

| 能力 | 用途 |
|---|---|
| `get / set / del / exists / expire / ttl` | 通用 K/V |
| `setNX(k, v, ttl)` | 幂等键（idempotency-key 中间件用）|
| `incr / incrBy / decr` | 限流 token / 计数器 / 配额扣减 |
| `acquireLock / releaseLock` | 分布式锁（FCFS 公海抢客 / 排课冲突）|
| `hset / hget / hgetall / hdel` | KPI cache（多字段聚合）|
| `ping()` | 健康检查 |
| `getClient()` | 暴露原始 ioredis 实例（BullMQ 用）|

后续 P0 项（idempotency / rate-limit / queue / cache）全建在此基础上。
