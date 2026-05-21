> ⚠️ **本文件是 [edu-mp-sandbox/docs/fields-by-role.md](../../edu-mp-sandbox/docs/fields-by-role.md) 的同步副本（2026-05-21 D 方案落地）**
>
> **拍板权威是 [../../edu-mp-sandbox/docs/SSOT-拍板权威.md](../../edu-mp-sandbox/docs/SSOT-拍板权威.md) §1/4/5/6**
>
> **禁止在本文件独立修订**：拍板修订必须先改 SSOT → 再 sync 前端版 → 最后 sync 本副本。后端 dev / agent 查阅本文件 OK，但修订必走 SSOT。
>
> 同步时间：2026-05-21 | 备份旧版：`fields-by-role.md.backup-2026-05-21`（5/10 304 行旧版，缺 5/13~5/16 增量 — admin home 4 KPI 升级 / course-product OOUX 升级 / 跨校调动删 / 家长合规元数据）

---

# 教培小程序字段级权限审计（按角色）— 2026-05-10 终版

> 通过 4 轮 16 题（架构）+ 28 题（home）+ 20 题（5 大对象）+ 4 题（18 对象打包）= 52 题拍完。
> 这是字段级最终拍板，覆盖 7 角色 × 43 业务对象 × 490 字段的权限分配。

## 角色简表

| 缩写 | 角色 | 范围 |
|---|---|---|
| **A** | Admin / 平台运营 | 平台级（minxin.top）|
| **老** | 老板（admin role）| 跨校全权 |
| **校** | 校长（boss role）| 单校 |
| **销** | 销售（sales / sales_manager）| 单校线索/客户/签约（OOUX：先建客户后签约）|
| **务** | 教务（academic）| 5/9 引入，单校排课/续费/转介绍/家长沟通 |
| **师** | 老师（teacher）| 单校教学执行（不主动排课）|
| **财** | 财务（finance）| 单校开票/退费（薪资全删）|
| **家** | 家长（parent）| C 端，跨机构共享订阅 |

---

## 一、7 个 home 配置（合并后 1 个动态 home）

合并方案：5 个原 home（home / home-sales / home-academic / home-teacher / home-finance）→ 1 个 `pages/b/home/home`，按 role 切 wxml。

### 老板 home（admin 视角）

```yaml
顶部:
  - 视角切换 chip（老板/校长）
  - 校区 picker（admin 全部校区 default / 选某校区 → 下钻按校区 filter）
  - 问候语 + 今日日期
  - 机构名称

# 5/16 用户拍板：4 KPI 组替代原 1 hero + 3 mini 结构
KPI（4 组，每组主+次要数据，整卡 tap 下钻 Level 2）:
  组 1 本月新签:
    主要: 本月新签金额 ¥
    次要: 签约人数 人
    Level 2 下钻: /pages/b/kpi/signed/ — 销售 + 教务（5/16 Q1 修订：教务也参与新签）
                  显示顺序：销售 list 在前 / 教务 list 在后（教务新签是「次要业绩」）
  组 2 本月续约:
    主要: 本月续约金额 ¥
    次要: 续约人数 人
    Level 2 下钻: /pages/b/kpi/renewal/ — 销售 + 教务
                  显示顺序：教务 list 在前 / 销售 list 在后（5/16 Q1 修订：教务续约是「主要业绩」， 是教务核心 4 件事之一）
  组 3 本月消课:
    主要: 本月消课金额 ¥
    次要: 全部待消课金额 ¥ — 未消课总金额（机构未确认收入语义）
    Level 2 下钻: /pages/b/kpi/consumption/ — 仅教务聚合
  组 4 学员状态:
    主要: 活跃学员 人
    次要: 不活跃学员 人
    Level 2 下钻: /pages/b/kpi/student-activity/ — 活跃+不活跃学员明细 + 教务聚合

OOUX 下钻链路 (5/16 拍板):
  Level 1: home 4 KPI 组（每组 1 大 + 1 小）
  Level 2: 4 个聚合 page（按销售/教务角色聚合 + 当前组主+次要数据 + 校区 picker）
  Level 3: 点某销售/教务 → 该指标关联的学员明细（按业务场景：本指标关联 学员 not 全部负责学员）
  Level 4: 点某学员 → /pages/b/student/detail/detail (OOUX 中心)

震动提醒:
  - 低余额学员需续费
  - 退费审批待处理
  - 员工离职交接待处理
老师业绩榜:
  - Top 3 老师卡片 + 点击进完整榜
关注学员:
  - KPI「需关注 N 人」+ 可下钻 list
快捷入口（grid 4 项）:
  - 招生漏斗 funnel
  - 校区管理 campus
  - 课程产品 products
  - 员工列表 staff
手动 action (5/15 B-1 用户拍板修订):
  # - 跨校调动 → 删除（5/15 拍板「不要」）
  - 看报表 export（本月/季/年） → 推 Sprint Y
  - 漏斗 Top3 流失 + 一键付费提示 → 推 Sprint Y
不该有:
  - + 排课 / + 反馈 / 批改作业 / 考勤记录入口
  - roleEntries（5 home 合并后跳工作台入口删）
  - 漏斗转化率 KPI（5/16 拍板新结构不含漏斗，漏斗走 tabbar 入口）
```

### 校长 home（boss 视角）

```yaml
布局: mirror 老板 4 KPI 组结构（5/16 拍板）+ 多本校业务控制项
校区 picker: boss 单校固定，不显示 picker（与 admin 区分）
Level 2-4 下钻: 同 admin 4 KPI 组下钻链路，仅 scope 限本校
chip: 锁住，点击提示「申请跨校权限」
跨校拦截:
  - 其他校区 KPI / 老师 / 学员
  - 机构 plan_tier / 跨校订阅
  - 老板个人资产报表
  - 跨校调动日志
震动提醒比老板多:
  - 本校班级充余额不足提醒
```

### 销售 home（销售工作台）

```yaml
KPI:
  - 本月个人新签金额 + 排名
  - 我的在跟客户数 + 试听转化率
主按钮:
  - + 新建客户（即时建档）
  # OOUX 拍板：签约是 action，对象是学员，先有客户/学员再签约
  # 不放「+ 新签约」按钮，从客户/学员详情发起
待办 list:
  - 24h 内必须回访客户（3 天未跟进）
  - 即将开始试听课（24h 内）
  - 试听课已结束未跟进（超 24h）
  - 公海「高质量到达」提醒
不该有:
  - 跨校区销售业绩 / 线索
```

### 教务 home（5/9 新角色 · 4 件事工作台）

```yaml
KPI:
  - 本月待接交接单 + 本周已排完
  - 30 天内到期合同（该推续费）
  - 本月转介绍贱出成功数
  - 未读家长咨询 / 未复家长提问
主按钮:
  - + 新建排课（点进 schedule/new）
  # 其他「+ 续费」「+ 转介绍」从 student/detail OOUX 一站式起
待办 list:
  - 销售刚交接的合同未排课
  - 30 天内到期合同（待起续费话术）
  - 老师请假需调课
  - 家长试听到期咨询
不该有:
  - 销售业绩 KPI / 销售个人排名
  - 老师考勤 / 归档 / 业绩详细
```

### 老师 home（教学执行）

```yaml
KPI:
  - 今日课时数 + 最近一节课距今多久
  - 主带学员总数 + 本周未填反馈数
  - 本月家长推荐成功例点（V20）
  - 本月考勤（上课计课时 / 请假 / 调课）
主按钮:
  - + 填反馈（选某节课 → 填）
  - + 批作业
  - + 测评录分
  - + 请假/调课（教务接手）
待办 list:
  - 今日课表（未完成/未反馈高亮）
  - 超 24h 未填反馈的课
  - 学生该考核 / 月报 finalize 待推
  - 本月家长提交推荐问会
不该有:
  - + 新建排课（5/9 拍板：教务主责）
  - 销售业绩 / 客户线索
  - 财务 / 薪资（已全删）
  - 其他老师的课表 / 业绩明细
```

### 财务 home（薪资已全删）

```yaml
KPI:
  - 本月开票总额 + 待开票数
  - 本月退费总额 + 待审批退费数
  - 本月总收入 / 总支出
主按钮:
  - + 手动创建开票
  - + 手动处理待审退费
  - + 导出当月开票报表
  - + 导出退费明细
待办 list:
  - 待开票 × N 项
  - 待审批退费 × N 项
不该有:
  - 销售业绩 / 老师考勤+薪资+业绩 / 学员课表反馈
```

### 家长 home（C 端消费首页）

```yaml
顶部:
  - 孩子头像卡（多孩切换）
  - 今日课表卡（下节课何时 / 老师）
  # 不勾：订阅状态 / 课时余额（移到「我的」/「孩子档案」）
主入口 grid:
  - 课表 lessons
  - 家长反馈 feedback
  - 作业 homework
  - 月报 monthly-report
待办 list:
  - 作业未提交 代上传
  - 老师反馈待看（红点）
  - 本周即将课提醒
  - 月报已出待阅读
不该有:
  - 孩子起薪 / 机构收入 / 老师业绩 KPI
  - 其他孩子/其他家长的课程
  - owner_sales_id 接棒人记录 / 内部趋动日志
  - 跨机构订阅明细（仅看当前机构）
```

---

## 二、5 个核心对象 × 字段集 × 角色矩阵

### 学员 student/detail（OOUX 中心对象）

| 字段集 | 销 | 师 | 务 | 老校 | 家 |
|---|---|---|---|---|---|
| **基础信息**（姓名/年龄/年级/学校/孩子手机/性别）| ✅ 自己客户 | ✅ 主带 | ✅ 本校 | ✅ | **C 端独立 student-profile，仅看姓名+头像+校区+主带老师** |
| **联系人信息**（家长姓名/手机/微信/应急/住址）| ✅ 自己客户 | ❌ | ✅ 本校 | ✅ | C 端 = 自己 |
| **学习表现**（剩余课时/反馈/作业完成率/学情/月报）| 👁 自己客户只读 | ✅ 主带全权 | 👁 质检 | ✅ | C 端独立详情 |
| **业务关系**（合同/财务记录/转交/推荐）| ✅ 自己客户可转他销售 | ❌ | ✅ 可发起续费 | ✅ | C 端仅看自己订单/订阅 |

> 关键决策：**合同是学员的子对象**，不直接独立列对象，从 student/detail 进。

### 排课 schedule（教务核心 37 字段）

| 字段集 | 务 | 师 | 家 | 销 | 老校 |
|---|---|---|---|---|---|
| **基础**（时间/老师/学员/班型/教室）| ✅ 创建 | ✅ 自己课 | ✅ 孩子课 | 👁 自己客户孩子 | ✅ |
| **班型限制**（class_type/max_students/customMax/contract_class_type 一致性）| ✅ 唯一可改 | ❌ | ❌ | ❌ | ✅ 决策调整 |
| **执行状态**（attendance/feedback_filled/homework_assigned/录像）| 👁 质检 | ✅ 全权 | ✅ 自己孩子 | 👁 自己客户孩子 | ✅ |
| **调动记录**（原因/代课老师/调发人）| ✅ 接手调课 | ✅ 发起人 | ✅ 自己孩子被调提醒 | ❌ | KPI 总量 |

### 教师档案 teacher（23 字段）

| 字段集 | 师自 | 务 | 老校 | 家 | 销 | 同校师 |
|---|---|---|---|---|---|---|
| **基础档案**（姓名/手机/身份证/学历/年限/资质）| ✅ 全编辑 | 👁 不改 | ✅ | ❌ 看不到手机/身份证 | ❌ 同上 | 👁 透明（除手机身份证）|
| **教学业务**（学科/年级/班型/学员数/评分/推荐）| ✅ | ✅ 全看 | ✅ | 走 showcase | 走 showcase | ✅ 透明 |
| **考勤履历**（计课时/请假/调课/未填反馈）| ✅ 自己 | 👁 本校质检 | ✅ | ❌ | ❌ | 👁 透明 |
| **业务展示卡**（头像/简介/视频/评价墙/推荐数/试听）| **✅ 全编辑（系统真实 vs 美化数据双轨）** | ❌ | ✅ | ✅ 选讲老师 | ✅ 推荐给客户 | ✅ 互看参考 |

> 重大决策：**老师 showcase 卡里的数据可以美化**（不影响系统真实数据用于统计）。

### 客户 customer（销售 30 字段）

| 字段集 | 销 | 务 | 老校 | 财 |
|---|---|---|---|---|
| **联系人**（家长姓名/手机/微信/孩子信息）| ✅ owner=me 全 | ✅ 本校已成交 | ✅ | ❌ |
| **来源/跟进**（source/entered_pool_at/urgent/follow_log）| ✅ 自己全可改 | ❌ | ✅ KPI 主不改 | ❌ |
| **购业记录**（trial/sign_status/signed_at/contract_amount/refund）| ✅ 自己 | 👁 仅合同金额作续费话术依据 | ✅ | ✅ 作账务 |
| **接棒/关系**（owner_user_id/owner_history/referrer/campaign）| 👁 自己现路状 | ❌ | ✅ 销售主管+老板校长看接棒 | ❌ |

> 决策：source 来源字段**可不填**，未填时统计不展示。

### 合同 contract（学员的子对象 14 字段）

| 字段集 | 销 | 务 | 师 | 老校 | 财 | 家 |
|---|---|---|---|---|---|---|
| **基础**（合同号/客户/学员/销售/产品/班型）| ✅ 自己签 | ✅ 本校 | ❌ | ✅ | ✅ 作账 | ❌ |
| **价格**（原价/折扣/实付/单价/课时/赠课/付款/分期）| ✅ 自己 | 👁 仅付费状态不看金额 | ❌ | ✅ | ✅ | ❌ |
| **时间**（签约/生效/到期/倒计时）| ✅ 自己续费机会 | ✅ 接手看到期 | ❌ | ✅ | ❌ | ✅ 自己合同到期 |
| **状态**（签约/履约/到期/退费/剩余/已消）| ✅ | ✅ | 👁 主带学员剩余课时 | ✅ | ✅ | ✅ 自己 |

> 决策：**教学人员（教务/老师）不看退费记录**。

---

## 三、18 对象打包规则（全按已拍推）

### 老师线 6 对象
`feedback / homework / assessment / learning-profile / monthly-report / lesson`
- 老师 ✅ 全权（自己学生）
- 教务 👁 全只读（质检型）
- 销售 👁 自己客户孩子只读，不能下载
- 家长 ✅ C 端独立详情（不复用 B 端 #49）
- 月报：B 端老师内部报 vs C 端家长外部报，两套数据

### 家长线 6 对象
`subscription / refer / rate / leave / binding / paywall`
- 家长 ✅ 全权（自己/自己孩子）
- B 端老板/校长/教务/老师 看汇总不细节
- subscription：V10 拍板跨机构共享订阅
- refer：V20 推荐机制（老师起点 / 也可教务起）

### 家长注册合规元数据（2026-05-13 leader round 2 补登）

合规元数据非业务字段，但通过 `POST /api/parents/register` body 写入后端 V40 backfill 加的 `consent_*` 列。
登记在此防 5/10 字段矩阵漏对账（3 审 round 2 business validator P2 + security P2-C 共识）。

| 字段 | 写入时机 | 后端列 | 用途 |
|---|---|---|---|
| `consentAt` | parent 注册成功 | `parents.consent_at` (timestamp) | 同意时间（个保法 §17 取证） |
| `consentVersion` | parent 注册成功 | `parents.consent_version` (varchar) | 协议版本（升版触发 onShow 强制重勾） |
| `consentTerms` | parent 注册成功 | `parents.consent_terms` (jsonb) | 同意的协议清单（user-terms/privacy-policy/minor-protection） |
| `birthYear` | parent 注册成功 | `parents.birth_year` (smallint) | 18+ 校验留证（不存完整出生日期，最小化原则） |

依据：
- 个保法 §17 「敏感个人信息单独同意」需留证
- 律师协议 §4.1.2「不满 18 周岁拒绝」需可审计
- 个保法 §47 撤回同意场景下后端需知道用户曾同意过哪个版本

权限：
- 家长 ✅ 自己可查可撤回（C 端《我的 - 隐私设置》触发）
- 老板/校长 👁 仅看 consentVersion + consentAt 不看 birthYear（PII 邻近信息）
- 销售/老师/教务/财务 ❌ 不应触达 consent 元数据（不在业务字段矩阵）

前端实现：`miniprogram/pages/c/auth/login.js` const `CONSENT_VERSION = 'v1.0-2026-05-13'`

### 后台 5 对象
`campus / course-product / user / promotion / tenant`
- campus：老板 ✅ / 校长 👁 本校
- course-product：老板 ✅ / 校长 ✅ 本校 / 教务 👁
  - **5/15 增量**：course-product 是 OOUX 中心对象之一（与 student 并列），从课程下钻到关联学员/老师/排课
  - **聚合字段**（detail page 展示）：`studentCount` / `teacherCount` / `weeklyConsumedYuan`
  - **金额可见角色**（5/15 r2 用户拍板）：**sales / academic / boss / admin** 4 角色可看 `standardPrice` + `weeklyConsumedYuan`（真实价格和产品定价）
    - 与 L233 合同价格矩阵区分：合同金额（个体学员折扣后实付）属隐私二级；课程产品定价是机构经营层指标，4 角色可见
    - **不可见角色**：teacher / finance / parent
    - 当前实施 `boss.products.view` ACTION_ALLOW = `[admin, boss, academic]`，sales 加入推 Sprint X（需配 scope filter 防 sales 看其他销售的客户名单 + 后端学员 list 加 `?ownerSalesId=` 参数）
  - **关联 list**（detail page 展示）：
    - `students[]`（关联此课程的学员，按 contract.course_product_id 过滤 active）
    - `teachers[]`（关联此课程的在职老师，通过 schedule.course_product_id 派生）
  - **OOUX 下钻链路**：
    1. tabbar「课程」(admin/boss) → `pages/b/boss/products/list` 课程 list（5/15 拍板加 tabbar 入口）
    2. list 卡 tap → `pages/b/boss/products/detail?productId=xxx` 课程详情
    3. detail 学员卡 tap → `pages/b/student/detail?id=xxx` student/detail（OOUX 一站式）
    4. detail 老师卡 tap → `pages/b/schedule/calendar?teacherId=xxx` 老师课表（schedule 维度查阅）
  - **后端 endpoint**：`GET /api/db/course-products/:productId/stats` 聚合返回上述字段
  - **PII mask**：teacher.phone/idCard 一级隐私不返回（按 fields-by-role.md L210）；student.name 按 student.basic 矩阵
- user：老板 ✅ / 校长 ✅ 本校 / 教务 👁 本校
- promotion：仅 Admin 平台方（minxin.top），机构内 ❌
- tenant 订阅：仅老板（admin）

### checkout 开通流程 45 字段
- 现状保留，按已拍访问限制：
  - wizard 仅首次开通可进
  - invoice 需登录后 admin/finance 可进
  - binding/scan + binding/children 需登录
  - 其他 6 页全公开
- 新增 `b/auth/login` 独立 B 端登录页

---

## 四、隐含的几条全局规则

1. **OOUX 中心化**：student 是中心对象，contract 和 lesson 是 student 的子对象，从 student/detail 一站式发起 action。
2. **签约不是从 home 起**：销售/教务发起签约都从 customer 或 student 详情起，home 不放「+ 新签约」大按钮。
3. **老师业务展示卡双轨**：老师可美化展示数据（家长/销售看的），但系统真实数据另存（用于业绩 KPI / 工资计算 — 工资已删但其他 KPI 用）。
4. **教务全只读老师线**：老师线 6 对象（feedback/homework/assessment/learning-profile/monthly-report/lesson）教务全部 👁，不允许"代填"（前面拍板留疑，目前以全只读为准；老师请假场景由「请假/调课」子流程接手而非教务代填反馈）。
5. **隐私分级**：
   - 一级（手机/身份证）：仅自己/老板校长可见
   - 二级（金额/业绩 KPI）：相关角色可见，越界角色不可见
   - 三级（薪资/接棒人记录/调动日志）：全删 / 仅老板可见
6. **家长跨机构**：家长 C 端订阅跨机构共享，但学员档案仅限当前机构。
7. **来源可空**：customer.source 字段可不填，统计时跳过未填项。

---

## 五、待补讨论（4 处疑点）

1. **多身份切换**：某人既是家长又是老师 / 销售 → home 顶部 chip 切换 role 还是不切？（前文未拍）
2. **教务代填反馈**：老师请假场景下教务能否代填？（暂以"全只读"为准，需老师调课流程接手）
3. **微信支付商户号到位后** pay 页字段补充
4. **多孩子家长的订阅状态聚合呈现**

---

## 六、配套文件

- [docs/pages-inventory-roles.md](pages-inventory-roles.md) — 业务架构重构（删 7 加 5 = 64 页 / 5 home 合并 / 薪资全删）
- [docs/fields-by-object.md](fields-by-object.md) — 43 对象 / 490 字段原始清单（按对象组织）
- 本文档（fields-by-role.md）— **按角色 × 字段集** 权限矩阵（决策版）
