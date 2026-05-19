-- ============================================================
-- V27__user_offboard_handover.sql
-- 在 __TENANT_SCHEMA__ 内：
--   员工离职 + 数据交接（owner_user_id 转移留痕）
--
-- 占位：__TENANT_SCHEMA__ 由租户初始化 worker 替换
--
-- 依据：用户 2026-05-07
--   「员工离职，取消账户权限之后自动转到校长名下，校长可以一键将
--    离职人员的数据包转到其他人员跟进，或者自己跟进」
--   「跨校区也当作离职处理」
--
-- 出具：研发负责人  2026-05-07
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §27.1 customer_follow_log.follow_type 加 'transferred' 枚举
-- 用于「离职自动转交」+「校长二次手动转交」两类事件留痕
-- ----------------------------------------------------------------
ALTER TABLE customer_follow_log
    DROP CONSTRAINT IF EXISTS customer_follow_log_follow_type_check;

ALTER TABLE customer_follow_log
    ADD CONSTRAINT customer_follow_log_follow_type_check
    CHECK (follow_type IN (
        'lead', 'consult', 'trial_invited', 'trial_done',
        'signed', 'lost', 'remark', 'released', 'claimed',
        'transferred'
    ));

-- ----------------------------------------------------------------
-- §27.2 opportunities ALTER：加 owner 转交审计字段
-- - owner_changed_at  最近一次 owner 变更时间（NULL = 从未变更，初始 owner）
-- - owner_change_reason 变更原因（'离职转交' / '校长再分配' / '主动认领' / NULL）
-- ----------------------------------------------------------------
ALTER TABLE opportunities
    ADD COLUMN IF NOT EXISTS owner_changed_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS owner_change_reason VARCHAR(64);

-- 校长「待交接客户」筛选索引：owner 为 NULL 或 owner 是离职用户
CREATE INDEX IF NOT EXISTS idx_opps_owner_changed
    ON opportunities(owner_changed_at DESC)
    WHERE owner_changed_at IS NOT NULL;

COMMENT ON COLUMN opportunities.owner_change_reason
    IS 'V27 owner 变更原因：离职转交 / 校长再分配 / 主动认领（用于审计与「待交接」展示）';

-- ----------------------------------------------------------------
-- §27.3 contracts ALTER：同样加 owner 转交审计字段
-- ----------------------------------------------------------------
ALTER TABLE contracts
    ADD COLUMN IF NOT EXISTS owner_changed_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS owner_change_reason VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_contracts_owner_changed
    ON contracts(owner_changed_at DESC)
    WHERE owner_changed_at IS NOT NULL;

COMMENT ON COLUMN contracts.owner_change_reason
    IS 'V27 contract owner 变更原因（业绩归属影响：转交后业绩归新 owner）';

-- ----------------------------------------------------------------
-- §27.4 users.status 不动（V2 已有 '启用'/'停用' 枚举）
-- 离职动作 = UPDATE users SET status='停用'，由 user.repository.deactivate 在事务内一并执行
-- ----------------------------------------------------------------

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   ALTER TABLE opportunities
--     DROP COLUMN IF EXISTS owner_changed_at,
--     DROP COLUMN IF EXISTS owner_change_reason;
--   ALTER TABLE contracts
--     DROP COLUMN IF EXISTS owner_changed_at,
--     DROP COLUMN IF EXISTS owner_change_reason;
--   ALTER TABLE customer_follow_log
--     DROP CONSTRAINT customer_follow_log_follow_type_check;
--   ALTER TABLE customer_follow_log
--     ADD CONSTRAINT customer_follow_log_follow_type_check
--     CHECK (follow_type IN (
--         'lead', 'consult', 'trial_invited', 'trial_done',
--         'signed', 'lost', 'remark', 'released', 'claimed'
--     ));
--   COMMIT;
-- ============================================================
