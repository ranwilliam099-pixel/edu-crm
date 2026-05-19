-- ============================================================
-- V3__pd_01_02_03_public_schema_alter.sql
-- 产品经理 PD-01 (Q.PRICE.c) + PD-02 (A05 5 步) + PD-03 (A06 默认模板) 工程化落地
-- 出具:开发总监 / 研发负责人  2026-04-30
-- 依据:产品经理正式解阻答复-W1-W3-8项细则.md §1 / §2 / §3
-- ============================================================

BEGIN;

-- ----------------------------------------------------------------
-- PD-02 / PD-03:tenants 增加 timezone / locale / init_state / template_version
-- A05 第 1 步默认 Asia/Shanghai + zh-CN
-- A05 §2.5 第 5 步幂等保证:init_state JSON 记录已完成步骤
-- A06 §3.5 默认模板版本号,升级不覆盖已在用租户的人工修改项
-- ----------------------------------------------------------------
ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS timezone         VARCHAR(32)  NOT NULL DEFAULT 'Asia/Shanghai',
    ADD COLUMN IF NOT EXISTS locale           VARCHAR(16)  NOT NULL DEFAULT 'zh-CN',
    ADD COLUMN IF NOT EXISTS init_state       JSONB        NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS template_version INTEGER      NOT NULL DEFAULT 1
        CHECK (template_version > 0);

COMMENT ON COLUMN public.tenants.timezone         IS 'PD-02 A05 第 1 步默认 Asia/Shanghai;IANA 时区标识';
COMMENT ON COLUMN public.tenants.locale           IS 'PD-02 A05 第 1 步默认 zh-CN;BCP47';
COMMENT ON COLUMN public.tenants.init_state       IS 'PD-02 A05 §2.5 幂等保证;记录已完成 init 步骤,失败重试时只跑未完成项';
COMMENT ON COLUMN public.tenants.template_version IS 'PD-03 A06 §3.5 默认模板版本号;升级不覆盖已在用租户的人工修改项';

-- ----------------------------------------------------------------
-- PD-01 Q.PRICE.c:payment_orders 增加 price_tier 字段
-- tenants.version 仍 3 档(标准版/校区版/增长版),不擅自加"单校区入门版"枚举
-- 1999/年由 price_tier='standard_1999' 表达
-- ----------------------------------------------------------------
ALTER TABLE public.payment_orders
    ADD COLUMN IF NOT EXISTS price_tier VARCHAR(32) NOT NULL DEFAULT 'standard_1999'
        CHECK (price_tier IN ('trial', 'standard_1999', 'school_pro', 'growth'));

COMMENT ON COLUMN public.payment_orders.price_tier IS
    'PD-01 Q.PRICE.c:1999/年是 SKU,不是 tenants.version 第 4 枚举;4 个最小档位:trial / standard_1999 / school_pro / growth';

CREATE INDEX IF NOT EXISTS idx_payment_orders_price_tier ON public.payment_orders(price_tier);

COMMIT;

-- ============================================================
-- 验收检查(测试方可手工跑):
--   SELECT column_name, data_type, column_default
--     FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='tenants'
--      AND column_name IN ('timezone','locale','init_state','template_version');
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='payment_orders' AND column_name='price_tier';
--
--   -- 应该返回 4 行 + 1 行
-- ============================================================
