-- ============================================================
-- V25__sales_customers_pool_and_followup.sql
-- 在 __TENANT_SCHEMA__ 内：
--   1. ALTER opportunities — 加 owner_user_id / 公共池 / cold 30 天
--   2. CREATE customer_follow_log — 跟进时间轴
--
-- 占位：__TENANT_SCHEMA__ 由租户初始化 worker 替换
--
-- 依据：
--   用户 2026-05-07「这个为什么还在开发中」+「公共客户池数据呢」
--   销售工作流 4 页设计（list / pool / detail / contract）
--
-- 出具：研发负责人  2026-05-07
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §25.1 opportunities ALTER：加销售归属 + 公共池字段
-- ----------------------------------------------------------------
ALTER TABLE opportunities
    -- 销售归属（NULL = 在公共池）
    ADD COLUMN IF NOT EXISTS owner_user_id      VARCHAR(32),
    -- 入池时间 + 入池原因（owner_user_id IS NULL 时有意义）
    ADD COLUMN IF NOT EXISTS entered_pool_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS enter_pool_reason  VARCHAR(64),
    -- 上次联系时间（cron 用：30 天无跟进 → 自动入池）
    ADD COLUMN IF NOT EXISTS last_contact_at    TIMESTAMPTZ,
    -- 紧急标记（试听后未跟进 / 老带新等优质线索）
    ADD COLUMN IF NOT EXISTS urgent             BOOLEAN NOT NULL DEFAULT FALSE,
    -- 客户来源（微信广告 / 微信扫码 / 老带新 / 门店来访 / 其它）
    ADD COLUMN IF NOT EXISTS source             VARCHAR(32),
    -- 联系方式
    ADD COLUMN IF NOT EXISTS phone              VARCHAR(20),
    ADD COLUMN IF NOT EXISTS wechat             VARCHAR(64),
    -- 备注
    ADD COLUMN IF NOT EXISTS note               TEXT;

CREATE INDEX IF NOT EXISTS idx_opps_owner
    ON opportunities(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_opps_pool
    ON opportunities(entered_pool_at) WHERE owner_user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_opps_last_contact
    ON opportunities(last_contact_at)
    WHERE owner_user_id IS NOT NULL AND stage NOT IN ('已报名','已失单');

COMMENT ON COLUMN opportunities.owner_user_id
    IS 'V25 客户归属销售（NULL = 公共池）';
COMMENT ON COLUMN opportunities.entered_pool_at
    IS 'V25 入池时间（owner_user_id IS NULL 时有意义）';
COMMENT ON COLUMN opportunities.enter_pool_reason
    IS 'V25 入池原因：new_lead / released_by_sales / cold_30d / sales_quit';
COMMENT ON COLUMN opportunities.urgent
    IS 'V25 紧急标记（优质线索 / 试听后未跟）';

-- ----------------------------------------------------------------
-- §25.2 customer_follow_log — 跟进时间轴
--
-- 类型：lead/consult/trial_invited/trial_done/signed/lost/remark
-- 每次销售操作（电话/微信/试听/签约/失单/手动备注）都写一行
-- 详情页 timeline 直接读
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_follow_log (
    id              VARCHAR(32)  PRIMARY KEY,
    opportunity_id  VARCHAR(32)  NOT NULL REFERENCES opportunities(id),
    follow_type     VARCHAR(32)  NOT NULL
                    CHECK (follow_type IN (
                        'lead','consult','trial_invited','trial_done',
                        'signed','lost','remark','released','claimed'
                    )),
    label           VARCHAR(256) NOT NULL,
    by_user_id      VARCHAR(32),                        -- 操作销售（system 时为 NULL）
    by_label        VARCHAR(64)  NOT NULL DEFAULT '系统', -- 显示名
    occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    extra_json      JSONB
);

CREATE INDEX IF NOT EXISTS idx_cfl_opportunity
    ON customer_follow_log(opportunity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cfl_by_user
    ON customer_follow_log(by_user_id, occurred_at DESC)
    WHERE by_user_id IS NOT NULL;

COMMENT ON TABLE customer_follow_log
    IS 'V25 客户跟进时间轴（详情页 timeline 数据源）';

-- ----------------------------------------------------------------
-- §25.3 contracts ALTER：加销售归属（业绩归属）
-- ----------------------------------------------------------------
ALTER TABLE contracts
    ADD COLUMN IF NOT EXISTS owner_user_id      VARCHAR(32),
    ADD COLUMN IF NOT EXISTS opportunity_id     VARCHAR(32) REFERENCES opportunities(id),
    ADD COLUMN IF NOT EXISTS signed_at          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS status             VARCHAR(16)
                                                NOT NULL DEFAULT 'pending'
                                                CHECK (status IN ('pending','active','expired','cancelled')),
    ADD COLUMN IF NOT EXISTS activated_at       TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contracts_owner
    ON contracts(owner_user_id, signed_at DESC);
CREATE INDEX IF NOT EXISTS idx_contracts_status
    ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_signed_at
    ON contracts(signed_at DESC) WHERE signed_at IS NOT NULL;

COMMENT ON COLUMN contracts.owner_user_id
    IS 'V25 业绩归属销售（与 opportunities.owner_user_id 一致）';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   DROP TABLE IF EXISTS customer_follow_log;
--   ALTER TABLE opportunities
--       DROP COLUMN IF EXISTS owner_user_id,
--       DROP COLUMN IF EXISTS entered_pool_at,
--       DROP COLUMN IF EXISTS enter_pool_reason,
--       DROP COLUMN IF EXISTS last_contact_at,
--       DROP COLUMN IF EXISTS urgent,
--       DROP COLUMN IF EXISTS source,
--       DROP COLUMN IF EXISTS phone,
--       DROP COLUMN IF EXISTS wechat,
--       DROP COLUMN IF EXISTS note;
--   ALTER TABLE contracts
--       DROP COLUMN IF EXISTS owner_user_id,
--       DROP COLUMN IF EXISTS opportunity_id,
--       DROP COLUMN IF EXISTS signed_at,
--       DROP COLUMN IF EXISTS status,
--       DROP COLUMN IF EXISTS activated_at;
--   COMMIT;
-- ============================================================
