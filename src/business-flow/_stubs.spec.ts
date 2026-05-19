/**
 * L8 业务流 stub 框架 — 14 业务流 it.skip 占位 (~100 case)
 *
 * 来源:
 *   - v2.0 §5 业务流 157 case 全展开
 *   - 已实现: A3 (10) + D1 (14) + C1 (17) = 41 case
 *   - 本 stub 框架: 剩 14 业务流 ~100 case 占位, Day 5 dev 接着实现
 *
 * 规则:
 *   - 每个 stub 用 it.skip('TODO: ...') 占位
 *   - skip 标题含 v2.0 §5 case 编号 + 简短描述
 *   - skip TODO 加 `[L8 stub]` 前缀, Day 5 dev grep 接续
 *   - 禁止填空 body (只 skip 占位)
 *
 * Stub 总计 (按 v2.0 §5):
 *   A1 客户开拓全链 (8)
 *   A2 续费全链 (5)
 *   B1 单次排课 (10)
 *   B2 周期排课 (6)
 *   B3 调课 / 请假 (6)
 *   C2 老师 self-edit 双轨 (5)
 *   D2 学情档案 + 月报 (11)
 *   E1 wxpay 支付 (5)
 *   E2 开票 (5)
 *   E3 退费 / 调价 (4)
 *   F1 离职转交 (4)
 *   F3 跨 tenant 家长 (6)
 *   F4 学员归档 (3)
 *   G1 教师评分 / 月度排行 (8)
 *   G2 学员请假 / 调课 (6)
 *   G3 课时包余额预警 (4)
 *   G4 学员推荐 / 转介绍 (5)
 *   G5 作业 / 评测 / 学情档案 (15)
 *
 *   合计 stub = 116 case (略大于 plan §P1 "~100 case stub")
 */

describe('[L8 stub] A1 客户开拓全链 (8 case)', () => {
  it.skip('[L8 stub A1.1] sales 自建客户 (含 student) → customer + student + opportunity 同事务三写', () => {});
  it.skip('[L8 stub A1.2] sales 自建客户 (不含 student) → 只写 customer', () => {});
  it.skip('[L8 stub A1.3] sales 跟进 opportunity 阶段流转 (初步接触 → 跟进 → 已签)', () => {});
  it.skip('[L8 stub A1.4] sales 关联 customer 到现有 student (避免重复建学员)', () => {});
  it.skip('[L8 stub A1.5] sales 跨 tenant 看 customer → 403', () => {});
  it.skip('[L8 stub A1.6] sales 改其他销售的 owner customer → 403 (owner 字段守门)', () => {});
  it.skip('[L8 stub A1.7] customer.primary_mobile 重复 (hash 命中) → 409 + 友好提示', () => {});
  it.skip('[L8 stub A1.8] admin 跨校建客户必须显式传 campusId (5/15 A-2)', () => {});
});

describe('[L8 stub] A2 续费全链 (5 case)', () => {
  it.skip('[L8 stub A2.1] sales 发起续费 → 新 opportunity (stage=续费) + 新 contract (orderType=续费)', () => {});
  it.skip('[L8 stub A2.2] 续费合同生效后课时包余额累加 (不覆盖旧 balance)', () => {});
  it.skip('[L8 stub A2.3] 续费触发 customer.last_purchased_at 更新', () => {});
  it.skip('[L8 stub A2.4] academic 提醒销售续费 (balance < 5 触发, G3 拍板)', () => {});
  it.skip('[L8 stub A2.5] academic / parent 直接续费 → 403 (必须 sales 发起)', () => {});
});

describe('[L8 stub] B1 单次排课 (10 case)', () => {
  it.skip('[L8 stub B1.1] academic 选学员 → 选老师 → 选时段 → submit → schedule created', () => {});
  it.skip('[L8 stub B1.2] 同一老师同时段已有课 → 冲突检测 → 拒绝 + 提示', () => {});
  it.skip('[L8 stub B1.3] 同一学员同时段已有课 → 冲突检测 → 拒绝', () => {});
  it.skip('[L8 stub B1.4] 学员 contract 课时余额 0 → 拒绝 + 提示「请续费」', () => {});
  it.skip('[L8 stub B1.5] 班型 = 一对多 → 允许多学员同时段同老师', () => {});
  it.skip('[L8 stub B1.6] 班型 = 小班课 → 上限学员数检查 (≤ N)', () => {});
  it.skip('[L8 stub B1.7] sales 排课 → 403', () => {});
  it.skip('[L8 stub B1.8] academic 跨 tenant 排课 → 403', () => {});
  it.skip('[L8 stub B1.9] academic 排已离职老师的课 → 拒绝 + 提示', () => {});
  it.skip('[L8 stub B1.10] academic 排已归档学员的课 → 拒绝', () => {});
});

describe('[L8 stub] B2 周期排课 (6 case, 不跳节假日)', () => {
  it.skip('[L8 stub B2.1] academic 建周期模板 (每周二 16:00-18:00 × 10 周) → recurring_schedule created', () => {});
  it.skip('[L8 stub B2.2] cron 每日凌晨展开下周 7 天 schedule', () => {});
  it.skip('[L8 stub B2.3] 周期模板修改 → 影响未来未生成 schedule, 不影响已生成的', () => {});
  it.skip('[L8 stub B2.4] 周期模板 archive → 停止展开', () => {});
  it.skip('[L8 stub B2.5] 节假日不跳, cron 照展开 (拍板 10)', () => {});
  it.skip('[L8 stub B2.6] 老师离职 → 已生成 schedule 自动 cancel + 通知 academic 重排', () => {});
});

describe('[L8 stub] B3 调课 / 请假 (6 case)', () => {
  it.skip('[L8 stub B3.1] parent 提请假 (任意时间, 拍板 G2) → leaves 表 + 状态 pending', () => {});
  it.skip('[L8 stub B3.2] academic 审批通过 → schedule.leave_id set + 课时不扣', () => {});
  it.skip('[L8 stub B3.3] academic 调课 (取消原 schedule + 新建 schedule) → 学员 + 老师 双向通知', () => {});
  it.skip('[L8 stub B3.4] sales 改 schedule → 403', () => {});
  it.skip('[L8 stub B3.5] teacher 自主取消课 → 403 (教务统一调度)', () => {});
  it.skip('[L8 stub B3.6] academic 审批拒绝 → 课正常上 + 课时扣', () => {});
});

describe('[L8 stub] C2 老师 self-edit 双轨 (5 case)', () => {
  it.skip('[L8 stub C2.1] teacher self-edit 自己档案 (姓名 / 联系 / 简介) → 通过', () => {});
  it.skip('[L8 stub C2.2] teacher 改其他老师档案 → 403', () => {});
  it.skip('[L8 stub C2.3] academic 改任何老师档案 → 403 (教务只读拍板)', () => {});
  it.skip('[L8 stub C2.4] admin / boss 改任何老师档案 → 通过', () => {});
  it.skip('[L8 stub C2.5] 老师视图零 ¥ (拍板 11, V50 物理删除 hourly_price_yuan, teacher 完全看不到任何金额)', () => {});
});

describe('[L8 stub] D2 学情档案 + 月报 (11 case)', () => {
  it.skip('[L8 stub D2.1] learning_profile 聚合 feedback + assessment + homework + 出勤', () => {});
  it.skip('[L8 stub D2.2] parent 看自己孩子 learning_profile', () => {});
  it.skip('[L8 stub D2.3] teacher 看自己授课学员 learning_profile', () => {});
  it.skip('[L8 stub D2.4] academic / boss 看所有学员 learning_profile', () => {});
  it.skip('[L8 stub D2.5] sales 看 learning_profile → 403 (教务全只读边界)', () => {});
  it.skip('[L8 stub D2.6] monthly_report 自动聚合 feedback / assessment / consumption', () => {});
  it.skip('[L8 stub D2.7] monthly_report audience=parent → 看自己孩子部分', () => {});
  it.skip('[L8 stub D2.8] monthly_report audience=boss → 看老师 + 学员双视角', () => {});
  it.skip('[L8 stub D2.9] parent 月报 review 评论 (C 端) → msgSecCheck → DB', () => {});
  it.skip('[L8 stub D2.10] parent 评论别孩子月报 → 403', () => {});
  it.skip('[L8 stub D2.11] boss showcase 月报 → 标杆案例 (meta + summary)', () => {});
});

describe('[L8 stub] E1 wxpay 支付 (5 case)', () => {
  it.skip('[L8 stub E1.1] parent 触发支付 → wx.login → openid → unified-order → wx.requestPayment', () => {});
  it.skip('[L8 stub E1.2] 支付成功 → callback 解密 + 写入 → contract.paidAmount 更新', () => {});
  it.skip('[L8 stub E1.3] 支付失败 / 取消 → 状态保持 + 用户友好提示', () => {});
  it.skip('[L8 stub E1.4] 重复支付 → idempotency 防重', () => {});
  it.skip('[L8 stub E1.5] finance 看自己未授权合同支付 → 403', () => {});
});

describe('[L8 stub] E2 开票 (5 case)', () => {
  it.skip('[L8 stub E2.1] finance 从合同发起开票 → invoices 表 + 状态 pending', () => {});
  it.skip('[L8 stub E2.2] finance 选择发票类型 (普通 / 专用 / 电子)', () => {});
  it.skip('[L8 stub E2.3] finance 上传抬头资料 → msgSecCheck (公司名 / 税号)', () => {});
  it.skip('[L8 stub E2.4] 开票完成 → push 通知 parent', () => {});
  it.skip('[L8 stub E2.5] sales / academic / teacher 看 invoices → 403', () => {});
});

describe('[L8 stub] E3 退费 / 调价 (4 case)', () => {
  it.skip('[L8 stub E3.1] finance 发起退费 → refunds 表 + audit_log', () => {});
  it.skip('[L8 stub E3.2] 退费金额从合同 paidAmount 扣减', () => {});
  it.skip('[L8 stub E3.3] 退费触发 wxpay refund API', () => {});
  it.skip('[L8 stub E3.4] sales 改合同 totalAmount → 403 (财务字段守门)', () => {});
});

describe('[L8 stub] F1 离职转交 (4 case)', () => {
  it.skip('[L8 stub F1.1] admin 在 hr/staff 标记 user.deactivated_at', () => {});
  it.skip('[L8 stub F1.2] 触发 customer.owner_sales_id / student.owner_sales_id 必须 handover', () => {});
  it.skip('[L8 stub F1.3] contract.ownerSalesId 历史保留 (不级联改, 审计透明)', () => {});
  it.skip('[L8 stub F1.4] deactivated user 登录 → JWT 黑名单 → 拒绝', () => {});
});

describe('[L8 stub] F3 跨 tenant 家长 (6 case)', () => {
  it.skip('[L8 stub F3.1] parent 注册 (public.parents)', () => {});
  it.skip('[L8 stub F3.2] parent 绑定 student (public.parent_student_bindings × N tenant)', () => {});
  it.skip('[L8 stub F3.3] parent home 聚合多 tenant 学员视图', () => {});
  it.skip('[L8 stub F3.4] parent 跨 tenant 反馈聚合', () => {});
  it.skip('[L8 stub F3.5] parent.phone 唯一性校验 (V40 phone_hash)', () => {});
  it.skip('[L8 stub F3.6] parent 看非自己绑定的 student → 403', () => {});
});

describe('[L8 stub] F4 学员归档 (3 case)', () => {
  it.skip('[L8 stub F4.1] admin 归档学员 (student.archived_at)', () => {});
  it.skip('[L8 stub F4.2] student 有 active contract → 拒绝归档 (先 archive contract)', () => {});
  it.skip('[L8 stub F4.3] student 有未来 schedule → 拒绝归档 (先 cancel)', () => {});
});

describe('[L8 stub] G1 教师评分 / 月度排行 (8 case)', () => {
  it.skip('[L8 stub G1.1] parent 评分 1-5 星 → teacher_ratings + 触发 monthly_aggregates', () => {});
  it.skip('[L8 stub G1.2] parent 文字评价 → msgSecCheck → 入库', () => {});
  it.skip('[L8 stub G1.3] 老师月度评分聚合 (avg + count + 分布)', () => {});
  it.skip('[L8 stub G1.4] teacher 看自己评分 + 历史趋势 (只读)', () => {});
  it.skip('[L8 stub G1.5] teacher 看月度排行榜 (自己 + 其他老师, 匿名 / 实名按 boss 配置)', () => {});
  it.skip('[L8 stub G1.6] parent 评分非授课老师 → 403', () => {});
  it.skip('[L8 stub G1.7] parent 重复评分 → idempotency 防重', () => {});
  it.skip('[L8 stub G1.8] teacher 看其他老师真实评分 → 403 (boss/admin 可见)', () => {});
});

describe('[L8 stub] G2 学员请假 / 调课 (6 case, 任意时间)', () => {
  it.skip('[L8 stub G2.1] parent 任意时间提请假 (拍板 G2)', () => {});
  it.skip('[L8 stub G2.2] academic 审批通过 → leave_id set + 课时不扣', () => {});
  it.skip('[L8 stub G2.3] academic 审批拒绝 → 课正常 + 课时扣', () => {});
  it.skip('[L8 stub G2.4] academic 调课 (cancel + 新建) → 双向通知', () => {});
  it.skip('[L8 stub G2.5] sales 改 schedule → 403', () => {});
  it.skip('[L8 stub G2.6] teacher 自主取消 → 403', () => {});
});

describe('[L8 stub] G3 课时包余额预警 (4 case, < 5 单阈值)', () => {
  it.skip('[L8 stub G3.1] course_packages_balance < 5 课时 → C 端 home 顶部 badge', () => {});
  it.skip('[L8 stub G3.2] balance < 5 → push 推送家长「续费提醒」(拍板 G3 单阈值)', () => {});
  it.skip('[L8 stub G3.3] balance = 0 → 排课 API 拒绝 + 提示「请续费」', () => {});
  it.skip('[L8 stub G3.4] 续费后 balance 累加 + push 通知', () => {});
});

describe('[L8 stub] G4 学员推荐 / 转介绍 (5 case, 课时奖励)', () => {
  it.skip('[L8 stub G4.1] parent 在 C 端生成专属推荐码 → parent_referrals.code', () => {});
  it.skip('[L8 stub G4.2] 新 parent 注册时填推荐码 → 关联 referred_by', () => {});
  it.skip('[L8 stub G4.3] 新 parent 完成首次签约 → 老 parent 课时奖励 (自动到课时包, 拍板 G4)', () => {});
  it.skip('[L8 stub G4.4] admin 看推荐排行', () => {});
  it.skip('[L8 stub G4.5] parent 推荐自己 (手机号已存在) → 拒绝', () => {});
});

describe('[L8 stub] G5 作业 / 评测 / 学情档案 (15 case)', () => {
  // 作业 5 case
  it.skip('[L8 stub G5.1] teacher 课后布置 homework → msgSecCheck → DB', () => {});
  it.skip('[L8 stub G5.2] parent 看作业列表 + 状态 pending', () => {});
  it.skip('[L8 stub G5.3] parent 提交完成 (含图 → wx.security.imgSecCheck) → 状态 submitted', () => {});
  it.skip('[L8 stub G5.4] teacher 批改 → 评语 + 状态 graded', () => {});
  it.skip('[L8 stub G5.5] parent 提交非自己孩子作业 → 403', () => {});

  // 评测 5 case
  it.skip('[L8 stub G5.6] teacher 创建 assessment → DB', () => {});
  it.skip('[L8 stub G5.7] teacher 给学员评分 (每维度 + 总分 + 评语)', () => {});
  it.skip('[L8 stub G5.8] parent 看评测结果', () => {});
  it.skip('[L8 stub G5.9] 评测自动汇入 learning_profile', () => {});
  it.skip('[L8 stub G5.10] parent 看其他学员评测 → 403', () => {});

  // 学情档案 5 case
  it.skip('[L8 stub G5.11] learning_profile 聚合 feedback + assessment + homework + 出勤', () => {});
  it.skip('[L8 stub G5.12] parent 看自己孩子学情档案', () => {});
  it.skip('[L8 stub G5.13] teacher 看自己授课学员学情档案', () => {});
  it.skip('[L8 stub G5.14] academic / boss 看所有学员学情档案', () => {});
  it.skip('[L8 stub G5.15] sales 看学情档案 → 403', () => {});
});

/**
 * Stub 总览 (跑完 jest 显示):
 *   A1 (8) + A2 (5) + B1 (10) + B2 (6) + B3 (6) + C2 (5)
 *   + D2 (11) + E1 (5) + E2 (5) + E3 (4) + F1 (4) + F3 (6) + F4 (3)
 *   + G1 (8) + G2 (6) + G3 (4) + G4 (5) + G5 (15)
 *   = 116 case stub
 *
 * 加 A3 (10) + D1 (14) + C1 (17) 已实现 = 41 case
 * 合计 = 157 case (匹配 v2.0 §5 业务流 157 case)
 */
