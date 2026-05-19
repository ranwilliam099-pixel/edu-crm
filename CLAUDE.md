# edu-server 后端 — Claude Code 会话引导

## 🎯 启动必读（按顺序）

### 1. 拍板权威 SSOT（**唯一源**，2026-05-16 整合）

📄 `/Users/ranyan/Desktop/edu/edu-mp-sandbox/docs/SSOT-拍板权威.md` — 12 章整合 16 份原始拍板：
- 9 角色清单 + 6 全局规则 + 5 对象字段矩阵 + 18 对象打包
- **操作权限矩阵**（ACTION_ALLOW / @Roles 关键 keys）
- **后端 P0 8 项生产架构合规**（TenantScopeGuard / audit_log V33 / FieldEncryptor / pino / Redis / Idempotency / Sentry / pg_dump）
- 拍板修订时间线（含 5/15 Wave 11 schedule RBAC 反向修复 / 5/15 A-2 删 sales_director）
- **任何 @Roles / RBAC / 字段矩阵改动必须先改 SSOT**，再同步代码

### 2. 系统架构图（模块清单 + 数据流）

📄 `/Users/ranyan/Desktop/edu/edu-mp-sandbox/docs/系统架构图.md` — 后端 38 模块输入/输出/职责
📄 `~/Desktop/2026-05-16-系统架构图.html` — 可视化 HTML（含解耦科学审查 14 项评分）

### 3. Memory（项目最新状态时间线）

📄 `~/.claude/projects/-Users-ranyan-Desktop-edu/memory/MEMORY.md` — 索引
📄 `~/.claude/projects/-Users-ranyan-Desktop-edu/memory/project_education-training.md` — 详细时间线

---

## 当前状态（2026-05-16）

- **分支**: `main` (origin 同步)
- **单测**: 1873/1873 全过 / TS 0 error / nest build clean
- **拍板核心闭环**：
  - 薪资全删 / 老师双轨 / 教务全只读 / 老师 self-edit / 字段权限矩阵 / OOUX 子资源
  - OWASP 4 P0 跨租户漏洞全清 + audit_log V33 17+ endpoint
  - A02 PII 加密 4/4（teacher / customer.opportunities / parent / customer.primary_mobile）
- **5/15 Wave 11 audit 修复**：
  - schedule RBAC 反向修复（@Roles('academic') 教务唯一）
  - course-product/:id/stats 新 endpoint (A-3 sales scope + A-4 campus filter)
  - 删 sales_director 角色（应用层 + spec backfill SQL）
- **ENCRYPTION_KEY / HASH_KEY**: 生产 `.env` 已配 ✅（HASH_KEY ≠ ENCRYPTION_KEY 双钥分离）

---

## SSH 生产

```bash
ssh pdfserver
# 等价: ssh -i ~/.ssh/william.pem -p 2222 ubuntu@1.14.127.67
# 生产路径: /home/ubuntu/workspace/edu-server (无 .git, rsync 部署)
```

部署脚本: `scripts/sync-deploy.sh`（rsync + npm install + nest build + pm2 reload + 健康检查）

---

## 🚨 Migration 操作纪律（5/19 leader D1.3 修订）

### Public schema migration 严禁直接跑

**禁止**：`sudo -u postgres psql -d edu -f migrations/V<N>__*.sql`

**理由**：D1.3 V49 事件 — dry-run 时若 migration 内嵌 `BEGIN; ... COMMIT;`，外层 BEGIN 会被内层 COMMIT 接管，导致 dry-run 真提交（生产不可逆）。

**必走 wrapper**：

```bash
# 干跑（强制 ROLLBACK 验证语法）
bash scripts/migrate-public.sh --dry-run migrations/V<N>__*.sql

# 真跑（含交互式 'APPLY' typed confirmation）
bash scripts/migrate-public.sh --apply migrations/V<N>__*.sql
```

### Tenant schema migration

仍走 backfill 模式（bash 循环 + sed `__TENANT_SCHEMA__` + sudo -u postgres psql），不需 wrapper。

### Clean-slate reset

```bash
# 1. 必先停 pm2（防止 cluster 重连阻挡 DROP CASCADE）
ssh pdfserver 'pm2 stop edu-api'

# 2. 跑 reset（dry-run 验证 → typed confirm 真跑）
bash scripts/reset-all-tenants.sh                              # dry-run
bash scripts/reset-all-tenants.sh --apply                      # 真跑（交互式 'DROP ALL TENANTS' 确认）
bash scripts/reset-all-tenants.sh --apply --force-confirm      # CI 模式跳过确认

# 3. ALLOW_PRODUCTION_RESET 守门（防生产事故）
ALLOW_PRODUCTION_RESET=true bash scripts/reset-all-tenants.sh --apply  # 生产 host 必须显式 opt-in

# 4. pm2 启回
ssh pdfserver 'pm2 start edu-api'
```

审计落地：`~/edu-clean-slate-audit.log` + `~/edu-migrate-public-audit.log`（文件 trail，未来 Sprint Y 移到 `public.platform_admin_audit_log` 表）

---

## ⚠️ 拍板权威修订流程

1. 用户口头拍板 → leader 评估范围 → **先 Edit SSOT 文件**（在 edu-mp-sandbox/docs/）
2. SSOT 修订 commit message 引用日期 + 拍板内容
3. **代码改动（@Roles / RBAC / 字段矩阵）基于 SSOT 之后**
4. agent 派单 prompt **引用 SSOT 章节号**（不再引用 16 份原始文件）

---

## Agent 工作流

`.claude/agents/` 已含 4 个后端 agent (server-backend-developer / server-backend-production-validator / server-business-rules-validator / server-security-auditor)。每个 commit 前必走 3 重审。

---

## 部署 BLOCKER（5/15 累积，未上线）

- 13+ commit 后端代码 + 7 schema migration (V35/V36/V37/V39/V40/V41) **已在生产** ✅（5/13 deploy）
- 5/15 Wave 11 修复 commit (e1aac43 / e3a158d / a7a71ae / 40b5186 / af74320) **未 deploy**
- 评估生产 `auth.users.role = 'sales_director'` 用户数 → 如有跑 `scripts/backfill-a2-sales-director-to-sales-manager.sql`

---

## 跨项目协调

前端改动去 `~/Desktop/edu/edu-mp-sandbox/` 启动 session（前端独立 4 agent）。

`~/Desktop/edu/.claude/agents/` 有 8 个 mp-/server- 前缀 agent 跨目录可调（leader hub 模式）。
