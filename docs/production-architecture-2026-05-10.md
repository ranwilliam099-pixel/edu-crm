# 教培 SaaS 可上架生产架构（2026-05-10）

> 目标：能扛 30 家早鸟同时上线 + 微信小程序审核通过 + 7×24 稳定运行 + 数据零丢失。
> 业务模型：B 端机构小程序 + C 端家长小程序（独立 appId）+ NestJS 后端 + PG 多租户。

---

## 一、上架前合规清单（10 项硬条件）

| # | 项 | 状态 | 阻塞 |
|---|---|---|---|
| 1 | **ICP 备案**（minxin.top）| 🟡 5/4 提交，5/29 ±5 天到 | 等 |
| 2 | **公安备案**（30 天内必做）| ⏳ ICP 后 | ICP |
| 3 | **微信小程序备案** | ⏳ ICP 后，3-7 工作日 | ICP |
| 4 | **HTTPS 证书**（Let's Encrypt 免费）| ⏳ ICP 后 | ICP |
| 5 | **微信支付商户号** | ⏳ 等申请 | 主体资质（已具备）|
| 6 | **律师起草用户协议 + 隐私政策** | ⏳ 找律师 ¥3-5K / 5-7 工作日 | 合同金 |
| 7 | **内容安全 wx.security.msgSecCheck**（文本+图片）| ⏳ 代码集成 | 微信审核硬要求 |
| 8 | **未成年人保护**（教培强相关）| ⏳ 代码集成 | 18+ 注册校验 + 监护人同意 |
| 9 | **数据合规**（用户数据导出 / 删除）| ⏳ 代码集成 | 《个保法》 |
| 10 | **C 端独立小程序 appId** | ⏳ 申请 | 主体资质 |

**最早上线时间**：6/15 左右（ICP 5/29 到 + 备案合并 +HTTPS + 律师协议并行）

---

## 二、3 阶段部署架构（按机构数扩容）

### 阶段 1：30 家早鸟（立即落地）⭐ 推荐起点

```
单机 1.14.127.67 (CVM 4C8G ~¥150/月) — 当前已在用
├─ Nginx :443（HTTPS + WAF + 限流）
├─ NestJS PM2 cluster × 4（4 进程跑满 4 核）
├─ PostgreSQL 14 本机（schema-per-tenant，已有）
├─ Redis 单机 + AOF（新加，session/KPI/queue）
└─ pg_dump 异地备份 → 腾讯云 COS（新加）

外部 SaaS:
├─ Sentry Free（5K err/月免费，错误+性能）
├─ 钉钉/企微 webhook（告警）
└─ COS（备份 + 上传文件）

成本：¥200/月（CVM ¥150 + Redis 内置 + COS ¥30 + 域名/证书 ¥0）
扛量：30-100 家机构 / 5K-15K 用户 / 100 QPS 峰值
```

### 阶段 2：100 家（3-6 月后）

```
2 × CVM 4C8G + 独立 TencentDB PG + 独立 Redis 实例
+ CLB 负载均衡 + 跨可用区 HA
+ ELK 日志聚合 + Grafana 监控

成本：¥800/月
扛量：100-500 家 / 50K 用户 / 500 QPS
```

### 阶段 3：500 家+（1 年后）

```
TKE K8s + 多节点 + 弹性伸缩 + 跨地域容灾
+ 完整可观测（Prometheus + ELK + Jaeger）

成本：¥2200/月起
扛量：1000+ 家 / 100K+ 用户 / 5K+ QPS
```

> 本文档详写阶段 1（即上架方案），阶段 2/3 给方向。

---

## 三、阶段 1 各层落地（边上架边补强）

### 1️⃣ 应用层（NestJS）

| 必加包 | 用途 |
|---|---|
| `@sentry/nestjs` + `@sentry/profiling-node` | 错误自动上报 + 性能 profile |
| `@nestjs/throttler` | 限流（按 IP / tenant / userId 三层）|
| `nestjs-pino` | 结构化日志（替代 console）|
| `@nestjs/terminus` | 健康检查（/health/live + /health/ready）|
| `helmet` | HTTP 安全头（HSTS/CSP/X-Frame-Options）|
| `class-validator` + `class-transformer` | DTO 校验（已有）|

**幂等性中间件**（写操作必须）：
```ts
// idempotency.middleware.ts
@Injectable()
export class IdempotencyMiddleware {
  async use(req, res, next) {
    const key = req.headers['idempotency-key'];
    if (!key || req.method === 'GET') return next();
    const cached = await redis.get(`idem:${key}`);
    if (cached) return res.json(JSON.parse(cached));
    res.on('finish', () => {
      redis.setex(`idem:${key}`, 86400, JSON.stringify(res.locals.body));
    });
    next();
  }
}
```

**优雅退出**（pm2 reload 无停机）：
```ts
async onApplicationShutdown(signal: string) {
  await this.pgPool.end();
  await this.redis.quit();
  await this.bullQueue.close();
}
```

### 2️⃣ 安全层（10 项硬加固）

| # | 项 | 实现 |
|---|---|---|
| 1 | **TenantScopeGuard** ✅ 已有 | body/query/header 三重校验 + 审计 |
| 2 | **RoleFieldFilter**（新加）| 按 user.role 过滤返回字段（fields-by-role.md）|
| 3 | **JWT 双 token** | access 15min / refresh 7day + 黑名单 |
| 4 | **敏感字段加密** | 手机/身份证 AES-256-GCM 列级加密 |
| 5 | **HTTPS** | Let's Encrypt + Nginx 443 + HSTS |
| 6 | **限流** | 同 IP 100 req/min / 同 tenant 1K req/min |
| 7 | **BotID** | 注册/登录前 wx.login + 行为检测 |
| 8 | **审计日志** | 所有写操作 → audit_log（who/what/when/IP）|
| 9 | **SQL 注入防** | parameterized queries（pg 自动）|
| 10 | **小程序内容安全** | wx.security.msgSecCheck（输入文本）+ imgSecCheck（图片）|

### 3️⃣ 数据库层（PG 14）

```sql
-- 1. WAL 归档（point-in-time recovery）
ALTER SYSTEM SET wal_level = 'replica';
ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_command = 'cp %p /var/lib/postgresql/wal_archive/%f';

-- 2. 慢查询日志
ALTER SYSTEM SET log_min_duration_statement = '100ms';

-- 3. 连接池（pg_pool 已有 max 10 → 提升）
-- pg-pool.service.ts: max: 20, idleTimeoutMillis: 30000

-- 4. 列级加密（敏感字段）
CREATE EXTENSION pgcrypto;
-- 写：pgp_sym_encrypt(phone, key, 'cipher-algo=aes256')
-- 读：pgp_sym_decrypt(phone, key)

-- 5. 行级安全（防越权）
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customers
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- 6. 审计表
CREATE TABLE audit_log (
  id BIGSERIAL,
  user_id UUID,
  tenant_id UUID,
  action VARCHAR(64),
  table_name VARCHAR(64),
  record_id UUID,
  before JSONB,
  after JSONB,
  ip INET,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### 4️⃣ 缓存层（Redis）

```
单实例 + AOF every-second + maxmemory 1G + LRU
├─ session:<token>           — 5 min TTL
├─ kpi:<tenant>:<role>       — 30 sec TTL（KPI 缓存）
├─ idem:<key>                — 24h TTL（幂等性）
├─ ratelimit:<ip>:<endpoint> — 滑动窗口
├─ queue:<job_type>          — BullMQ 任务队列
└─ lock:<resource>           — 分布式锁（FCFS 公海抢客）
```

### 5️⃣ 队列层（BullMQ on Redis）

异步任务清单：
| 任务 | 触发 | 用途 |
|---|---|---|
| `report-generate` | 用户点导出 | 生成 Excel + COS + 发短信通知 |
| `monthly-report-fanout` | cron 月初 | 给所有学员生成月报 |
| `sms-send` | 验证码 / 通知 | 短信网关调用 |
| `image-compress` | 上传图片 | 压缩 + 加水印 |
| `wx-content-check` | 用户输入 | wx.security.msgSecCheck 后置 |
| `expire-quota` | cron 02:00 | 早鸟 quota 过期 |
| `reminder-low-balance` | cron 09:00 | 推 KPI / 低余额学员通知 |

### 6️⃣ 监控告警

#### Sentry SaaS（错误 + 性能）
- 后端：`@sentry/nestjs` 自动捕获所有 throw + slow API
- 前端：`@sentry/wechat-miniprogram`（小程序专版）
- 阈值：5xx > 10/min → 钉钉告警

#### 自建 /metrics（Prometheus 格式）
```
http_requests_total{method,status,endpoint}
http_request_duration_ms{endpoint, p50, p99}
db_connection_pool_active / idle / waiting
redis_connected_clients
queue_jobs_waiting / active / failed
tenant_active_users{tenant_id}
```

#### 钉钉/企微 webhook 告警
- 应用：5xx > 10/min / 单接口 p99 > 2s / 健康检查失败
- DB：连接池满 / 慢查询 > 1s / 主备延迟 > 10s
- 业务：注册失败率 > 5% / 支付失败 > 1% / cron 失败

### 7️⃣ 备份恢复（数据零丢失）

| 项 | 频率 | 存储 | RPO | RTO |
|---|---|---|---|---|
| **pg_dump 全量** | 每日 02:00 | 腾讯云 COS（异地）| < 24h | < 4h |
| **WAL 归档** | 实时 | 本机 + COS（5min sync） | < 5min | < 1h |
| **应用代码** | git push | GitHub | 实时 | < 30min |
| **Redis** | AOF every-second | 本机 + 每日 COS | < 1s | < 30min |
| **上传文件** | 实时 | COS（直传）| 实时 | 实时 |

**保留策略**：
- 日备：保留 7 天
- 周备：保留 4 周
- 月备：保留 12 月
- 年备：保留 7 年（合规要求）

**恢复演练**：每月 1 次（在测试机恢复最新备份，验证可用）

### 8️⃣ CI/CD（GitHub Actions）

```yaml
# .github/workflows/deploy.yml
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash tools/verify-design.sh   # 22 项验证
      - run: cd miniprogram && npm test    # 187 单测
      - run: cd ../edu-server && npm test  # 900 单测 + 144 e2e
  deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: ssh pdfserver 'cd /home/ubuntu/workspace/edu-server && git pull && pnpm install && pnpm build && pm2 reload edu-api'
```

**灰度策略**：pm2 reload（无停机滚动重启）+ 健康检查 +失败自动 rollback。

### 9️⃣ 微信小程序生产化

```
B 端 appId: wxb50d2f6bb9c679ff（已有）
C 端 appId: 待申请（V10 拍板独立）

提交审核前必做:
├─ navigationStyle 全部 custom + 兼容刘海屏
├─ 所有用户输入：wx.security.msgSecCheck
├─ 所有用户上传图片：wx.security.imgSecCheck
├─ 实名认证：getUserInfo + 手机号授权
├─ 未成年人保护：注册时 18+ 校验弹窗
├─ 隐私政策弹窗（首次启动）+ 隐私清单
├─ 内容举报入口（footer）
├─ 客服按钮（contact）
└─ 性能：首屏 < 1.5s / 主包 < 2MB / 分包 < 8MB
```

### 🔟 法律 + 合规（必须找律师）

```
《用户协议》— 平台责任 / 用户责任 / 知识产权 / 仲裁
《隐私政策》— 收集 / 使用 / 共享 / 删除 / 第三方（微信/腾讯云）
《数据处理协议》— B 端机构作为数据处理者
《服务等级协议 SLA》— 99.9% uptime（每月停 < 45min）
《未成年人保护说明》— 监护人同意 + 限时
《教培行业资质声明》— 机构需 ICP + 教育局备案
```

成本：律师 ¥3-5K / 5-7 工作日。

---

## 四、6 大需求 × 落地映射

| 需求 | 阶段 1 实现 | 阶段 2 升级 |
|---|---|---|
| **UX** | warm-envelope v1.0 + 22 验证 + Sentry RUM + 骨架屏 + 离线缓存 | CDN 加速 + 多端预加载 |
| **稳定** | PM2 cluster × 4 + 优雅退出 + 健康检查 + 自动重启 | 多节点 HA + 跨可用区 |
| **鲁棒** | idempotency + 重试 + 降级（KPI 出错给历史值）+ 双校验 | 熔断（Hystrix-style）+ 异步降级 |
| **安全** | 10 项硬加固（见 §2）+ HTTPS + audit_log | WAF + DDoS + Hawkeye 渗透 |
| **并发** | PG 行锁 + 乐观锁 + Redis cache + BullMQ + 三层限流 | 读写分离 + Redis 集群 |
| **数据安全** | schema 隔离 + 列加密 + WAL + 异地备份 + audit | TDE + 多活 + 跨地域容灾 |

---

## 五、立即开工 P0 清单（在 ICP 等待期内做）

按优先级（**今天 5/10** → ICP 5/29 大概 19 天窗口）：

### 第 1 周（5/10-5/16）— 基础设施
- [ ] 装 Sentry（后端 + 小程序）
- [ ] 装 Redis 单机 + AOF
- [ ] 写 pg_dump 异地备份脚本 → COS
- [ ] 加 audit_log 表（V33 migration）
- [ ] 加敏感字段加密（V34 migration，phone/id_number）
- [ ] 钉钉/企微告警 webhook

### 第 2 周（5/17-5/23）— 业务整改
- [ ] 整改 P0-P2（按 [integration-plan-2026-05-10.md](integration-plan-2026-05-10.md)）
- [ ] 整改 P3-P4（删页加页）
- [ ] 集成 wx.security.msgSecCheck / imgSecCheck
- [ ] 加 idempotency-key middleware

### 第 3 周（5/24-5/30）— 整改 + 合规
- [ ] 整改 P5（5 home 合并）
- [ ] 整改 P6（字段权限）
- [ ] 律师起草 3 份协议初稿
- [ ] 未成年人保护代码
- [ ] **ICP 拿到** ← 关键节点

### 第 4 周（5/31-6/6）— 上架冲刺
- [ ] 整改 P7-P8 收尾
- [ ] HTTPS + 公安备案 + 微信小程序备案
- [ ] BotID + 三层限流
- [ ] BullMQ 队列搭建
- [ ] /metrics + Grafana

### 第 5 周（6/7-6/13）— 测试 + 演练
- [ ] 全链路压测（30 家并发模拟）
- [ ] 备份恢复演练
- [ ] 安全渗透测试（找朋友测）
- [ ] 早鸟 5 家内测

### 第 6 周（6/14-6/20）— 上架
- [ ] 微信小程序提交审核
- [ ] 早鸟 30 家分批激活
- [ ] 监控告警 7×24 值守

---

## 六、成本预算（30 家早鸟年）

| 项 | 月 | 年 | 备注 |
|---|---|---|---|
| 腾讯云 CVM 4C8G | ¥150 | ¥1,800 | 现有 |
| 域名 minxin.top | — | ¥55 | 已付 |
| HTTPS（Let's Encrypt）| 0 | 0 | 免费 |
| 腾讯云 COS（备份）| ¥30 | ¥360 | 50G |
| Sentry SaaS Free | 0 | 0 | 5K err/月内免费 |
| 短信网关 | ¥100 | ¥1,200 | 验证码 |
| 律师协议（一次性）| — | ¥4,000 | |
| ICP 备案（一次性）| — | 0 | 免费 |
| C 端 appId | — | 0 | 免费 |
| **合计** | **¥280** | **~¥7,400** | |

vs 早鸟 30 家年收入：
- B 端：30 × 1×¥1,999（前 10 家 1 折）+ 20×¥999.5（11-30 家 5 折）≈ ¥40K/年
- C 端：估 30 校 × 5 家长 × ¥9.9×12 ≈ ¥18K/年
- **首年净 ~¥50K**（成本 ¥7K + 推广待算）

---

## 七、Done 标准（生产可上架）

1. ✅ ICP / 公安 / 小程序备案 全过
2. ✅ HTTPS + 律师 3 份协议
3. ✅ 整改 8 阶段全完
4. ✅ 22 项验证 pre-commit + GitHub Actions
5. ✅ Sentry / 钉钉告警 7×24 在线
6. ✅ 备份恢复演练成功（RPO < 5min / RTO < 1h）
7. ✅ 30 家并发压测通过（p99 < 500ms）
8. ✅ 微信小程序 wx.security 全集成
9. ✅ 早鸟 5 家内测 0 严重 bug
10. ✅ 监控大盘清晰可读

---

## 八、配套文档

- [docs/integration-plan-2026-05-10.md](integration-plan-2026-05-10.md) — 8 阶段整改计划
- [docs/fields-by-role.md](fields-by-role.md) — 字段级权限矩阵
- [docs/pages-inventory-roles.md](pages-inventory-roles.md) — 业务架构
- [docs/icp-beian-guide.md](icp-beian-guide.md) — ICP 备案
- 本文档 — 生产架构 + 6 周上架时间表
