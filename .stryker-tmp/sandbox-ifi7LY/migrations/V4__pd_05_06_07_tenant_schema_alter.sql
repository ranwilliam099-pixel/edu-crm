-- ============================================================
-- V4__pd_05_06_07_tenant_schema_alter.sql
-- 产品经理 PD-05 (F05 referrals + renewals 双表)
--          PD-06 (Q08 历史保护 - opportunities + contracts 加 4 个 Snapshot)
--          PD-07 (§7.3 跨校区 - users 加 campus_scope)
--          PD-08 (D-Mask-02 - Student 不收集 idCard,本文件不建)
--
-- 出具:开发总监 / 研发负责人  2026-04-30
-- 依据:产品经理正式解阻答复-W1-W3-8项细则.md §5 / §6 / §7 / §8
-- 适用:租户 schema 模板,worker 创建 tenant_<id> schema 后,先跑 V2,再跑本 V4
-- 注意:本文件用 __TENANT_SCHEMA__ 占位符,worker 实际执行时替换为 tenant_<id>
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- PD-05 F05:referrals 老客转介绍表(13 列)
-- 第一阶段独立表,不混进 customers 主表
-- 状态枚举:new / contacted / converted / invalid
-- 奖励状态枚举:none / pending / granted / cancelled
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referrals (
    id                     VARCHAR(32)  PRIMARY KEY,
    tenant_id              VARCHAR(32)  NOT NULL,
    referrer_customer_id   VARCHAR(32)  NOT NULL REFERENCES customers(id),
    referrer_student_id    VARCHAR(32)  NULL     REFERENCES students(id),
    referred_parent_name   VARCHAR(32)  NOT NULL,
    referred_mobile        VARCHAR(16)  NOT NULL,
    referred_student_name  VARCHAR(32)  NULL,
    campus_id              VARCHAR(32)  NOT NULL REFERENCES campuses(id),
    status                 VARCHAR(16)  NOT NULL DEFAULT 'new'
                           CHECK (status IN ('new','contacted','converted','invalid')),
    reward_status          VARCHAR(16)  NOT NULL DEFAULT 'none'
                           CHECK (reward_status IN ('none','pending','granted','cancelled')),
    source_lead_id         VARCHAR(32)  NULL     REFERENCES leads(id),
    converted_customer_id  VARCHAR(32)  NULL     REFERENCES customers(id),
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- PD-05 §5.1 同租户 + 同手机号唯一,防重复推荐
    CONSTRAINT uq_referrals_tenant_mobile UNIQUE (tenant_id, referred_mobile)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer        ON referrals(referrer_customer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status          ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_referrals_reward_status   ON referrals(reward_status);
CREATE INDEX IF NOT EXISTS idx_referrals_campus          ON referrals(campus_id);
CREATE INDEX IF NOT EXISTS idx_referrals_created_at      ON referrals(created_at);

-- ----------------------------------------------------------------
-- PD-05 F05:renewals 续费机会池(13 列)
-- 状态枚举:to_renew / contacting / renewed / lost
-- 由 contracts.endAt 触发(应用层 cron 创建续费机会)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS renewals (
    id                   VARCHAR(32)   PRIMARY KEY,
    tenant_id            VARCHAR(32)   NOT NULL,
    source_contract_id   VARCHAR(32)   NOT NULL REFERENCES contracts(id),
    customer_id          VARCHAR(32)   NOT NULL REFERENCES customers(id),
    student_id           VARCHAR(32)   NOT NULL REFERENCES students(id),
    campus_id            VARCHAR(32)   NOT NULL REFERENCES campuses(id),
    course_product_id    VARCHAR(32)   NOT NULL REFERENCES course_products(id),
    due_at               TIMESTAMPTZ   NOT NULL,
    status               VARCHAR(16)   NOT NULL DEFAULT 'to_renew'
                         CHECK (status IN ('to_renew','contacting','renewed','lost')),
    owner_id             VARCHAR(32)   NOT NULL REFERENCES users(id),
    expected_amount      NUMERIC(12,2) NULL CHECK (expected_amount IS NULL OR expected_amount >= 0),
    renewed_contract_id  VARCHAR(32)   NULL REFERENCES contracts(id),
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_renewals_source       ON renewals(source_contract_id);
CREATE INDEX IF NOT EXISTS idx_renewals_status       ON renewals(status);
CREATE INDEX IF NOT EXISTS idx_renewals_due_at       ON renewals(due_at);
CREATE INDEX IF NOT EXISTS idx_renewals_owner        ON renewals(owner_id);
CREATE INDEX IF NOT EXISTS idx_renewals_campus       ON renewals(campus_id);

-- ----------------------------------------------------------------
-- PD-06 Q08:opportunities 加 4 个 Snapshot 字段
-- 历史保护:course_products 改名/改价不回写历史商机
-- ----------------------------------------------------------------
ALTER TABLE opportunities
    ADD COLUMN IF NOT EXISTS course_product_name_snapshot VARCHAR(64)   NULL,
    ADD COLUMN IF NOT EXISTS course_line_snapshot         VARCHAR(32)   NULL,
    ADD COLUMN IF NOT EXISTS class_type_snapshot          VARCHAR(32)   NULL,
    ADD COLUMN IF NOT EXISTS standard_price_snapshot      NUMERIC(12,2) NULL CHECK (standard_price_snapshot IS NULL OR standard_price_snapshot >= 0);

COMMENT ON COLUMN opportunities.course_product_name_snapshot IS 'PD-06 Q08 写入瞬间 course_products.name 快照,改名不回写';
COMMENT ON COLUMN opportunities.course_line_snapshot         IS 'PD-06 Q08 写入瞬间 course_products.line_category 快照';
COMMENT ON COLUMN opportunities.class_type_snapshot          IS 'PD-06 Q08 写入瞬间 course_products.class_type 快照';
COMMENT ON COLUMN opportunities.standard_price_snapshot      IS 'PD-06 Q08 写入瞬间 course_products.standard_price 快照,改价不回写';

-- ----------------------------------------------------------------
-- PD-06 Q08:contracts 加 4 个 Snapshot 字段(同上)
-- ----------------------------------------------------------------
ALTER TABLE contracts
    ADD COLUMN IF NOT EXISTS course_product_name_snapshot VARCHAR(64)   NULL,
    ADD COLUMN IF NOT EXISTS course_line_snapshot         VARCHAR(32)   NULL,
    ADD COLUMN IF NOT EXISTS class_type_snapshot          VARCHAR(32)   NULL,
    ADD COLUMN IF NOT EXISTS standard_price_snapshot      NUMERIC(12,2) NULL CHECK (standard_price_snapshot IS NULL OR standard_price_snapshot >= 0);

COMMENT ON COLUMN contracts.course_product_name_snapshot IS 'PD-06 Q08 历史保护快照';
COMMENT ON COLUMN contracts.standard_price_snapshot      IS 'PD-06 Q08 历史合同永远按当时快照,主档改价不污染';

-- ----------------------------------------------------------------
-- PD-07 §7.3 跨校区可见性:users 加 campus_scope 字段
-- sales 默认 campus_scope = 单校区(本人 campus_id)
-- sales_manager 可扩到本校区+下属
-- boss / finance 可扩到全部授权校区
-- 用 JSONB 存校区 ID 数组,便于灵活扩展
-- ----------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS campus_scope JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN users.campus_scope IS
    'PD-07 §7.3 跨校区可见性;sales 默认 [campus_id] 单校区;sales_manager/boss/finance 可包含多个校区 ID';

-- 触发器:users 创建/更新时,sales 角色 campus_scope 自动设为 [campus_id]
CREATE OR REPLACE FUNCTION sales_default_campus_scope()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.role = 'sales' AND (NEW.campus_scope IS NULL OR NEW.campus_scope = '[]'::jsonb) THEN
        NEW.campus_scope = jsonb_build_array(NEW.campus_id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_sales_default_campus_scope ON users;
CREATE TRIGGER trg_users_sales_default_campus_scope
    BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION sales_default_campus_scope();

-- ----------------------------------------------------------------
-- PD-08 D-Mask-02:Student 不收集 idCard 字段
-- 本文件不建任何 idCard / id_card / id_number 字段
-- 后续若要加,需满足 PD-08 §8.3 三个条件(业务场景 + 法务 + 脱敏方案)
-- ----------------------------------------------------------------
-- (no-op,显式不建)

COMMIT;

-- ============================================================
-- 验收检查(测试方可手工跑):
--   -- referrals 13 列存在
--   SELECT column_name FROM information_schema.columns
--     WHERE table_schema = '__TENANT_SCHEMA__' AND table_name = 'referrals'
--     ORDER BY ordinal_position;
--   -- 应返回 13 行
--
--   -- renewals 13 列存在
--   SELECT column_name FROM information_schema.columns
--     WHERE table_schema = '__TENANT_SCHEMA__' AND table_name = 'renewals'
--     ORDER BY ordinal_position;
--   -- 应返回 13 行
--
--   -- opportunities + contracts 各加 4 字段
--   SELECT table_name, column_name FROM information_schema.columns
--     WHERE table_schema = '__TENANT_SCHEMA__'
--       AND table_name IN ('opportunities','contracts')
--       AND column_name LIKE '%_snapshot';
--   -- 应返回 8 行 (4×2)
--
--   -- users.campus_scope 存在
--   SELECT column_name, data_type FROM information_schema.columns
--     WHERE table_schema='__TENANT_SCHEMA__' AND table_name='users' AND column_name='campus_scope';
--   -- 应返回 1 行 (jsonb)
--
--   -- D-Mask-02 验证:Student 表不应有 id_card 字段
--   SELECT column_name FROM information_schema.columns
--     WHERE table_schema='__TENANT_SCHEMA__' AND table_name='students'
--       AND column_name IN ('id_card','idCard','id_number');
--   -- 应返回 0 行
-- ============================================================
