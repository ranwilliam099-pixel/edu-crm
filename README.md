# edu-server — 教育培训行业销售 CRM 后端

> **本工程是教育培训机构项目的独立工程域，0 行代码起步。**
> **与 `~/Desktop/企业管理系统项目` 是两个完全独立的项目**（依据评估意见 V1.x 追加 #8 用户级红线）。

---

## 1. 项目隔离声明（追加 #8 红线，不可绕过）

1. **完全独立**：本工程位于 `~/Desktop/edu-server/`，与 `企业管理系统项目` 同级；不引用、不继承、不耦合企业管理系统的任何代码、角色、数据库、守护资产。
2. **零守护资产**：教培项目从零开始，**无既有 33 静态 / 59 e2e / 13 step / 8 层关账等守护**——这些是企业管理系统项目的概念，与本项目无关。
3. **零硬决策继承**：教培项目自身的硬决策起点是 P0 启动必答 A01-A12（已全部拍板）+ 项目经理 V2 §10.4 三条工程纪律 + §0 研发不猜测原则。
4. **可参考、不依赖**：可参考企业管理系统的设计经验、踩坑记录、技术栈选型——但不依赖、不耦合、不共享数据库。

---

## 2. 技术栈决策书（BE-W0-2 落地，2026-04-29）

| 维度 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（strict mode）| 类型安全，便于 NestJS 与测试 |
| 运行时 | **Node.js 24 LTS** | 当前 LTS 默认（替代已 deprecated 的 Node 18）|
| Web 框架 | **NestJS 10** | 模块化、装饰器、与 TypeORM 一等公民集成 |
| ORM | **TypeORM 0.3** | 原生支持多 schema、`SET search_path`，匹配 schema-per-tenant（A01）|
| 数据库 | **PostgreSQL 14+** | A01 已拍板分 schema 多租户；schema-per-tenant 是 PG 一等公民 |
| 缓存 | **Redis 7** | JWT 黑名单、向导自动保存断点、配置缓存 |
| 迁移工具 | **node-pg-migrate**（W0 内决策）| 迁移可重复执行；公共 schema + 租户 schema 模板各自一套 |
| ID 生成 | **ULID** | 字段清单 V1.1 已规约 `id string(32) ULID` |
| 包管理 | **pnpm** | monorepo 友好、磁盘占用小 |
| CI | GitHub Actions（待项目经理决定 origin remote 后接通）| lint + test + build 三段 |
| 容器 | docker-compose（本地）+ 后续 Kubernetes（生产）| W0 仅本地 PG + Redis |

**决策留痕**：本表由开发总监 / 研发负责人 2026-04-29 出具；后续如需变更，必须回文档、注明日期、注明影响范围、重新评审（§0 研发不猜测原则第 5 条）。

---

## 3. 工程结构（BE-W0-1 / BE-W0-8）

```
~/Desktop/edu-server/                      # 独立工程域，与企业管理系统平级
├─ README.md                               # 本文件
├─ .gitignore
├─ package.json                            # NestJS 依赖
├─ tsconfig.json                           # strict mode
├─ nest-cli.json
├─ docker-compose.yml                      # 本地 PG14 + Redis7
├─ .env.example
├─ migrations/
│  ├─ V1__init_public_schema.sql          # 公共 schema 6 表（已落地，含 price_tier 占位）
│  └─ V2__tenant_schema_template.sql      # 租户 schema 模板（W1 起草）
├─ src/
│  ├─ main.ts
│  ├─ app.module.ts
│  └─ modules/
│     ├─ health/                           # GET /api/public/health（已落地）
│     ├─ auth/                             # JWT + tenantId（W1）
│     ├─ tenant/                           # 租户初始化 worker（W1）
│     ├─ checkout/                         # 微信支付 V3（W2）
│     ├─ onboarding/                       # 5 步配置向导（W3）
│     ├─ workbench/                        # 4 角色工作台（W3）
│     └─ admin/                            # A11 平台超管（W3）
└─ test/                                   # 独立测试，自建用例集
```

文档/契约真相源（在 `企业管理系统项目/教育培训机构/`，仅引用不耦合）：
- 字段：`教育培训行业销售CRM-字段清单-V1.md`
- 接口：`教育培训行业销售CRM-接口改造清单-V1.md`
- 页面：`教育培训行业销售CRM-页面改造清单-V1.md`
- A04：`教育培训行业销售CRM-A04退款与发票责任链规约.md`
- A10/A11/A12：`教育培训行业销售CRM-A10A11A12执行细化规约.md`
- 当前有效结论快照：`研发负责人评估意见.md` 追加 #18

---

## 4. 启动顺序（W0 五日计划）

| 日 | 任务 | 状态 |
|---|---|---|
| D1 | BE-W0-1 仓库 + README + .gitignore；BE-W0-2 技术栈决策书 | ✅ 完成（位置已修正到独立工程域）|
| D1 | BE-W0-3 docker-compose；BE-W0-4 迁移工具；BE-W0-5 公共 schema 6 表 DDL；BE-W0-6 健康接口；BE-W0-8 NestJS 骨架 | ✅ 完成 |
| D2 | BE-W0-7 CI（待 GitHub origin remote 确认后接通）；起草 V2 租户 schema 模板 | ⏳ 待 |
| D3 | 联调健康接口准备；M1 验收 | ⏳ 待 |

---

## 5. 当前外部阻塞

| 编号 | 阻塞项 | 影响任务 | 当前处置 |
|---|---|---|---|
| **EXT-01** | 微信支付 V3 商户号 + API 密钥（公司主体）| BE-W2-1/2/3/4/5/6 | 🔴 立即并行启动；W0 用 mock + sandbox SDK 推进非依赖代码（用户已授权 mock 策略）|
| **EXT-02** | 现有 CRM 小程序 appId 成交频道路由扩展权限 | FE-W0-1/2、W1-T4 | 🟡 前端在独立 sandbox 静态稿；等权限到位再合入 |
| **EXT-03** | 独立 H5 文档站域名（A09）| W4-T5 | 🟢 占位 `https://help.placeholder.local`，不卡 W4-T5 |
| **INT-01** | 线上 PostgreSQL 14+ 实例 | W1 起所有 | 🔴 W0 用本地 docker；线上需项目经理协调 |
| **EXT-04** | 教培项目独立 git 仓库远程 origin | 整体协同 | 🟡 本地 git init 完成；远程仓库待项目经理决定 |
| **HR-01** | 后端 1 + 前端 1 资源到岗 | 全局 | 🔴 当前仅开发总监在岗推进 W0 |

阻塞详细见 `企业管理系统项目/教育培训机构/阻塞-EXT-01-INT-01-EXT-02.md`。

---

## 6. 关键不变量（每次提交前自查）

1. **完全独立**：本工程不引用 `~/Desktop/企业管理系统项目/` 任何文件、模块、依赖。任何 import / require 路径都不能跨出本工程根。
2. **不污染企业管理系统**：本工程不修改 `企业管理系统项目/cloudfunctions/`、`miniprogram/`、`server/src/` 任一文件——它们是另一个项目。
3. **schema-per-tenant 强制隔离**（A01）：所有租户业务接口必须经过 JWT claims 解析 → tenantId 注入 → ORM session `SET search_path`。任何直接连 `tenant_*` schema 的硬编码视为漏洞。
4. **A12 paid 锁不绕开**：`payments.paidLocked = true` 时禁止 UPDATE/DELETE 任何 amount/status；调整必须新建 `reverse_orders` 记录。
5. **A04 责任链严格隔离**：公共 schema `payment_orders/payment_refunds/invoice_requests` 仅服务公司向机构收 SaaS 费；租户 schema `contracts/payments` 服务机构内部学费——禁止混用。
6. **§0 不猜测**：Q.PRICE / A05/A06 详细规约 / F05 / Q08 等未答字段对应模块不开发；遇到模糊措辞停下追问。

---

## 7. 协同对接（按角色）

- 项目经理：每日 09:30 站会同步阻塞解除进度
- 产品经理：催 Q.PRICE / A05 5 步必填项 / A06 默认模板内容 / A12 状态机 / F05 Referral 字段 / Q08 课程产品历史保护
- 营销经理：渠道归因口径已就位（V1.1 §2.5 marketing_channels 表）
- 测试负责人：W0 末可对 health 接口 + migration + schema 静态校验做第一轮验收（055 §6 下一步 2）
- 前端工程师：M1 联调 `GET /api/public/health` → `{ok:true,version:'v1',timestamp}`

---

**开发总监 / 研发负责人**
**2026-04-29 W0-D1（位置修正版 + 项目隔离原则修订版）**
