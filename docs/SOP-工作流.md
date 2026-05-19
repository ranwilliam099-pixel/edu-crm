# 工作流 SOP — Day 6 leader 自补

> 来源：v2.0 主方案 §9 + Day 1-5 实战教训
> 拍板：每次代码改动 4 阶段流程 — 写方案 → 改 → 自测 → 交付
> 目的：防 Day 2 漏三审导致 6 BLOCKER 漏到 Day 3 类事故

---

## 4 阶段流程（每个 PR / 每次 dev agent 派单必走）

### Phase 1: 写方案

- PR 描述必填**影响面预判表**（见附录 B）
- 列出：直接影响（文件/endpoint/SSOT 章节）+ 连带影响（受影响模块/spec/RBAC 矩阵/baseline/前端/业务流）+ 不影响（明确写「不影响 X/Y」证明思考过）
- leader review 加自己想到的影响（compare）
- 用户拍板（如涉及 SSOT 修订或 X1 类破坏性改动）

### Phase 2: 改

- **必须先改 SSOT**（拍板权威）
- 再改代码
- 同步改 spec（unit + integration + RBAC manifest）
- 同步改 baseline schema dump（如 migration）
- 同步改前端（如 endpoint / DTO 变化）
- 跑完整 12 层测试金字塔

### Phase 3: 自测（leader 跑，不是 agent）

```
☑ pnpm test (L1 unit)
☑ pnpm test:integration (L2 真 PG via docker-compose)
☑ bash scripts/verify-tenants-match-reference.sh (L6 schema)
☑ bash scripts/run-business-smoke.sh --tenant-id=<demo-x> (L5 smoke)
☑ pnpm test:mutation (Stryker mutation score Phase 1 ≥ 60% warn / 40% exit)
☑ pnpm jest src/__rbac__ (L9 RBAC 1192+ case)
☑ pnpm jest src/business-flow (L8 业务流 162+ case)
☑ pnpm jest src/chaos (L11 8 scenario + frozen)
☑ pnpm jest src/time-drift (L10 时序漂移 + X1 防回归)
☑ pnpm jest src/__rbac__/generated/batch-d (L9 字段权限)
☑ pnpm test:e2e (L4 demo tenant)
```

任何一项不过 → 不能交付。

### Phase 4: 派 validator 三审 (必走，不能跳)

**Day 2 漏跑导致 6 BLOCKER 漏到 Day 3 + Day 5 漏跑导致 1 BLOCKER + 8 P1**

派 3 validator 并行：
- server-backend-production-validator (P0 8 项 + 测试架构)
- server-business-rules-validator (拍板一致性 + SSOT)
- server-security-auditor (OWASP + PII + 跨租户)

三审 finding：
- 🔴 Blocker → round 2 修红
- 🟡 P1 → round 2 修红 / Sprint Y backlog（按严重性）
- 🟢 P2 → Sprint Y backlog

round 2 修完 → leader trust-but-verify → commit + push。

### Phase 5: Deploy 11 道 Gate（最严，禁人工 override）

```
[Code]
☑ L1 Unit Tests — 全过
☑ Mutation Score ≥ 60% (Phase 1)
☑ L2 Integration Tests — 全过 (when docker-compose ready)
☑ L3 Contract (shared-types tsc + OpenAPI diff) — 0 diff
☑ L4 E2E (跑 demo tenant) — 全过
☑ L8 业务流 162+ case — 全过
☑ L9 RBAC 1192+ case — 全过

[Infra]
☑ L6 Schema Drift (所有 tenant vs baseline) — 0 diff
☑ Migration dry-run on staging — 全过
☑ L11 Chaos 8+1 scenario — 全过

[Production]
☑ Sentry 健康检查 — connected
☑ 一键回滚脚本 — 就绪
```

---

## 影响面预判模板（PR 必填，附录 B）

```markdown
## 影响面预判表

### 直接影响
- [ ] 改动文件：file1, file2, ...
- [ ] 改动 endpoint：POST /api/db/customers
- [ ] 改动 SSOT 章节：§4 字段矩阵 customer 行

### 连带影响（必填，不能写"无"）
- [ ] 受影响模块：customer.module / contract.module / monthly-report.module
- [ ] 受影响 spec：customer.repository.spec / customer.controller.spec
- [ ] 受影响 RBAC 矩阵：sales/customer/create + finance/customer/read
- [ ] 受影响 baseline schema：是 / 否
- [ ] 受影响前端 page：b/sales-customers/new / b/sales-customers/list
- [ ] 受影响业务流：customer 开拓全链 / 续费全链
- [ ] 受影响 chaos / time-drift / x1 防回归 spec

### 不影响（必填，证明思考过）
- [ ] 不影响：teacher / wxpay / parent / academic
- [ ] 不影响：跨 tenant 隔离 / public.parent_student_bindings
- [ ] 不影响：监控告警阈值

### 测试覆盖
- [ ] L1 unit 新增/修改：N 个
- [ ] L2 integration 新增/修改：N 个
- [ ] L9 RBAC 矩阵自动更新：是 / 否（如是必跑 node scripts/generate-rbac-spec.js）
- [ ] L8 业务流：是否需要更新 e2e

### 部署影响
- [ ] 需要 migration：是 / 否（V<N>）
- [ ] 需要 backfill：是 / 否（脚本：scripts/backfill-v<N>.sh）
- [ ] 需要前端同步 deploy：是 / 否
- [ ] 需要 .env 新增：是 / 否
- [ ] 需要数据 reset：是 / 否
```

---

## 自查 checklist（commit 前 leader 必读）

```
□ 每个新增 spec 跑过单测 PASS
□ 跑过 L2 integration 真 PG (when docker-compose available)
□ 跑过 L6 schema drift 检查
□ Mutation score ≥ 60%（Phase 1）
□ 测试代码 reviewed by leader（不是 agent — agent 输出必 trust-but-verify）
□ 影响面预判表 PR 描述里
□ SSOT 是否需要修订？
□ baseline schema 是否需要 snapshot？
□ 前端 b/teacher/* 零 ¥ 残留（lint #9，X1 防回归）
□ L9 RBAC 矩阵生成器有没有重跑？manifest 是否同步？
□ controller @Roles 是否真改（不只 manifest）？(trust-but-verify Day 5 教训)
```

---

## 用户测试 SOP（Day 8 用）

### D.1 真用户随机操作模拟

- 操作 ★ 业务流（销售开拓 → 教务排课 → 老师反馈 → 家长评分）任意角色
- 双击 / 快速重复点击 / 网络抖动中断 / 回退后再提交

### D.2 边界场景验证

- 跨校 admin 切换 campusId
- 跨 tenant parent 多孩切换
- 离职 user 重新登录拒绝

### D.3 性能感受

- demo-large-scale tenant 月报生成耗时（5000 schedule + 20000 feedback）
- 列表分页流畅度
- 微信小程序冷启动速度

### D.4 安全 / 合规感受

- msgSecCheck 触发场景（敏感词）
- 18+ 注册校验
- 隐私政策弹窗

### D.5 反馈机制

- 任何不顺手的点 → PR comment
- 任何不符合拍板的点 → 引用拍板编号
- 任何漏 case → 加进 L8 业务流

---

## Day 1-5 教训（写入 SOP 永久）

1. **commit 前 3 validator 并行审是 SOP 不能省**（Day 2 漏 → 6 BLOCKER 到 Day 3 / Day 5 漏 → 1 BLOCKER + 8 P1）
2. **dev agent 输出必 trust-but-verify**（Day 5 B1 真 controller @Roles 漂移，manifest 改了但代码未改 — leader 抽样 grep 抓到）
3. **agent 撞 SDK limit 后 leader 必查代码现状**（Day 2 Phase C dev socket 异常断后留 tsc 2 errors，leader 自补 < 30min 收尾）
4. **dev 报告「超预期」必严谨审视**（Day 5 dev B+C 报告 676 + 237 case 是真覆盖不是凑数，但 transparency：测的是 Guard 自身逻辑不是真 @Roles）
5. **mock 层级 transparency 必告知**（L8 inline mock 测规格不测实现，L2 integration 才验真生产）
6. **realCode 字面量是反模式**（Day 5 P1-1 防回归用 fs.readFileSync 读真文件）
7. **真生产 deploy 节奏紧 dev/leader 并发**（Day 2 sync-deploy 跑在 dev 完成前导致 V50 dist 漏 → 必 wait dev 完成才 deploy）
8. **adminName VARCHAR(32) 边界类错误的 stack trace 不准**（Day 2 P0-1 真根因不是 search_path 而是字段长度溢出）
