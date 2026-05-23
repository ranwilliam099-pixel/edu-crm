-- ============================================================
-- V59__refund_orders_in_tenant_schema.sql
-- 在 __TENANT_SCHEMA__ 内新增「退费工单」(2026-05-23 task #36)
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
--
-- 来源：
--   - SSOT §3.6 财务 home：本月退费总额+待审批 / 待审批退费 待办
--   - SSOT §4.4 财务字段矩阵 (退费 = 财务专属, 教学人员不看)
--   - 拍板：finance 单校开票/退费 (jwt.campusId 范围) — 故表在 tenant schema
--
-- 业务流：
--   1. 销售 / 教务 / 财务 提退费申请 (status='pending')
--   2. 财务审批：approve / reject (decided_at + approver_user_id)
--   3. approve → contract.status='terminated' + 钱包退款 (V60+ 接通)
--   4. reject → 申请人补充材料或撤销
--
-- 角色 @Roles (task #36 控制器):
--   - 申请: teacher / sales / academic / finance / boss / admin
--   - 审批: finance / boss / admin (单校 finance 单校 boss; admin 跨校)
--   - 看清单 (finance-refunds/list): finance / boss / admin (SSOT §4.4)
--   - 教学人员 (teacher/academic) ❌ 不看退费记录
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

CREATE TABLE IF NOT EXISTS refund_orders (
    id                    VARCHAR(32)   PRIMARY KEY,
    contract_id           VARCHAR(32)   NOT NULL REFERENCES contracts(id),
    student_id            VARCHAR(32)   NOT NULL REFERENCES students(id),
    customer_id           VARCHAR(32)   NOT NULL REFERENCES customers(id),
    amount                NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    reason                TEXT,                                            -- 退费原因 (学员搬家/老师调班 等)
    applicant_user_id     VARCHAR(32)   NOT NULL REFERENCES users(id),
    applicant_role        VARCHAR(24)   NOT NULL,                          -- 申请人角色 (老师/销售/教务/财务)
    applied_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    status                VARCHAR(16)   NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected')),
    approver_user_id      VARCHAR(32)   REFERENCES users(id),              -- 审批人 (财务 / 校长 / 老板)
    approver_role         VARCHAR(24),                                     -- 审批角色 (finance/boss/admin)
    decided_at            TIMESTAMPTZ,                                     -- 审批时间
    decision_reason       TEXT,                                            -- 审批意见 (批准/驳回原因)
    campus_id             VARCHAR(32)   NOT NULL REFERENCES campuses(id),  -- 财务 scope: jwt.campusId
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refund_status ON refund_orders(status, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_refund_campus ON refund_orders(campus_id);
CREATE INDEX IF NOT EXISTS idx_refund_contract ON refund_orders(contract_id);
CREATE INDEX IF NOT EXISTS idx_refund_applicant ON refund_orders(applicant_user_id);
CREATE INDEX IF NOT EXISTS idx_refund_pending ON refund_orders(status)
  WHERE status = 'pending';

COMMENT ON TABLE refund_orders IS 'V59 退费工单 (tenant scope, 财务单校审批) — task #36';
COMMENT ON COLUMN refund_orders.status IS 'pending=待审 approved=已批 rejected=已驳回';
COMMENT ON COLUMN refund_orders.approver_role IS '审批角色 finance/boss/admin — finance 单校, boss 本校, admin 跨校';

COMMIT;
