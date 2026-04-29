# edu-server — 教育培训行业销售 CRM 后端

> **本工程是教育培训机构项目的独立工程域，0 行代码起步。**
> **不引用、不继承企业管理系统主线（`/server/`）的任何字段、模块或守护资产。**

---

## 1. 项目隔离声明（硬约束，不可绕过）

1. **代码隔离**：本目录 `教育培训机构/edu-server/` 不与主线 `/server/` 共享代码、依赖、构建产物。后续将迁出独立 git 仓库。
2. **数据隔离**：本工程仅管理教培项目的 PostgreSQL 数据库；不连接、不读写主线云函数 / Mongo / 任何主线数据源。
3. **守护隔离**：主线 33 静态 + 59 e2e + 13 step + 8 层关账硬决策与本工程无关；本工程的测试将自建独立用例集（不复用、不污染主线 e2e）。
4. **决策隔离**：教培版采用 C 方案"行业插件层"，但实施层面是 0 行代码独立工程，不在主线就地改造，亦不向主线注入 `industryProfile` 配置位。

---

## 2. 技术栈决策书（BE-W0-2 落地，2026-04-29）

| 维度 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（strict mode）| 类型安全，与现有团队主栈对齐，便于测试 |
| 运行时 | **Node.js 24 LTS** | 当前默认 LTS（替代 Node 18，已 deprecated）|
| Web 框架 | **NestJS 10** | 模块化、装饰器、与 TypeORM 一等公民集成；与主线 Nest 经验一致 |
| ORM | **TypeORM 0.3** | 原生支持多 schema、`SET search_path`，满足 schema-per-tenant 隔离要求 |
| 数据库 | **PostgreSQL 14+** | A01 拍板分 schema 多租户隔离方案；schema-per-tenant 是 PG 一等公民能力 |
| 缓存 / 会话 | **Redis 7** | JWT 黑名单、向导自动保存断点、配置缓存 |
| 迁移工具 | **node-pg-migrate** 或 **Flyway**（本周内决策）| 迁移可重复执行；公共 schema + 租户 schema 模板各自一套 |
| ID 生成 | **ULID** | 字段清单 V1.1 已规约 `id string(32) ULID` |
| 包管理 | **pnpm** | monorepo 友好、磁盘占用小、与 NestJS 兼容 |
| CI | GitHub Actions（待 INT-01 与项目经理确认仓库归属）| lint + test + build 三段 |
| 容器 | docker-compose（本地）+ 后续 Kubernetes（生产，待 INT-01）| W0 仅做本地 PG + Redis |

**决策留痕**：本表由研发负责人 2026-04-29 出具；后续如需变更，必须回文档、注明日期、注明影响范围、重新评审（§0 研发不猜测原则第 5 条）。

---

## 3. 工程结构（BE-W0-1 / BE-W0-8）

```
edu-server/
├─ README.md                # 本文件
├─ .gitignore
├─ package.json             # NestJS 依赖
├─ tsconfig.json            # strict mode
├─ nest-cli.json
├─ docker-compose.yml       # 本地 PG14 + Redis7
├─ migrations/
│  ├─ V1__init_public_schema.sql       # 公共 schema 6 表
│  └─ V2__tenant_schema_template.sql   # 租户 schema 模板（W1）
├─ src/
│  ├─ main.ts
│  ├─ app.module.ts
│  └─ modules/
│     ├─ health/                       # GET /api/public/health（BE-W0-6）
│     ├─ auth/                         # JWT + tenantId（W1）
│     ├─ tenant/                       # 租户初始化 worker（W1）
│     ├─ checkout/                     # 微信支付 V3（W2）
│     ├─ onboarding/                   # 5 步配置向导（W3）
│     ├─ workbench/                    # 4 角色工作台（W3）
│     └─ admin/                        # A11 平台超管（W3）
└─ test/                               # 独立单测，不复用主线 e2e
```

接口契约见：[教育培训行业销售CRM-接口改造清单-V1.md](../教育培训行业销售CRM-接口改造清单-V1.md)
字段契约见：[教育培训行业销售CRM-字段清单-V1.md](../教育培训行业销售CRM-字段清单-V1.md)

---

## 4. 启动顺序（W0 五日计划，与任务分配单 V1 §9 对齐）

| 日 | 任务 | 状态 |
|---|---|---|
| D1 (今天) | BE-W0-1 仓库 + README + .gitignore；BE-W0-2 技术栈决策书 | 🟡 进行中（骨架就位，等仓库迁出）|
| D2 | BE-W0-3 docker-compose；BE-W0-4 迁移工具集成 | ⏳ 待 |
| D3 | BE-W0-5 公共 schema 6 表 DDL；联调健康接口准备 | ⏳ 待 |
| D4 | BE-W0-6 健康接口；BE-W0-7 CI | ⏳ 待 |
| D5 | BE-W0-8 NestJS 模块骨架；M1 联调验收 | ⏳ 待 |

---

## 5. 当前外部阻塞（必须由项目经理协调）

| 编号 | 阻塞项 | 影响任务 | 当前处置 |
|---|---|---|---|
| **EXT-01** | 微信支付 V3 商户号 + API 密钥（公司主体）| W2-T1/T3/T4，BE-W2-1~6 | 🔴 立即并行启动申请；W0 只做不依赖支付的代码骨架 |
| **EXT-02** | 现有 CRM 小程序 appId 成交频道路由扩展权限 | W1-T4，FE-W0-1/2 | 🟡 等产品经理确认现有 appId 可扩展范围 |
| **EXT-03** | 独立 H5 文档站域名（A09）| W4-T5 | 🟢 暂用占位 `https://help.placeholder.local`（不卡 W4-T5）|
| **INT-01** | PostgreSQL 14+ 实例（支持 schema-per-tenant）| W1 起所有 | 🔴 W0 用本地 docker；线上需项目经理协调资源 |

阻塞详细见：[阻塞-EXT-01-INT-01-EXT-02.md](../阻塞-EXT-01-INT-01-EXT-02.md)

---

## 6. 关键不变量（每次提交前自查）

1. **不依赖主线**：搜代码不应出现 `cloudfunctions/`、`miniprogram/server/`、`/server/src/` 任何引用。
2. **不破坏主线守护**：任何动作不修改主线文件（`cloudfunctions/`、`miniprogram/`、`server/src/`、根 `package.json`、根 `tests/`）。
3. **schema-per-tenant 强制隔离**：所有租户业务接口必须经过 JWT claims 解析 → tenantId 注入 → ORM session `SET search_path`。任何直接连 `tenant_*` schema 的硬编码视为漏洞。
4. **paid 锁不绕开**（A12）：`payments.paidLocked = true` 时禁止 UPDATE/DELETE 任何 amount/status；调整必须新建 `reverse_orders` 记录。
5. **不猜测需求**：Q01-Q17 字段清单未回填的项，对应模块不开发。

---

## 7. 协同对接

- 项目经理：每日 09:30 站会同步阻塞解除进度
- 产品经理：催 Q01-Q17（业务对象边界 + 状态机）回填
- 营销经理：渠道归因 + 续费字段已就位（字段清单 V1.1 §2.5 + §3.6 占位）
- 测试负责人：W2 出口起开始介入；接口可测后同步测试账号 + 数据准备方式
- 前端工程师：M1 联调时 `GET /api/public/health` 返回 `{ok:true,version:"v1"}`

---

**研发负责人 / 开发总监**
**2026-04-29 W0-D1**
