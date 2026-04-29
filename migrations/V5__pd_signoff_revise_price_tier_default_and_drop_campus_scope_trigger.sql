-- ============================================================
-- V5__pd_signoff_revise_price_tier_default_and_drop_campus_scope_trigger.sql
-- 产品经理 V3-V4 自查清单签字回执后的修订(2 项)
-- 出具:开发总监 / 研发负责人  2026-04-30
-- 依据:V3-V4 实现层猜测自查清单 §3.3 产品经理正式签字说明
--      27 项中 25 项 ✅ 同意,2 项修订:
--        (1) payment_orders.price_tier:保留 NOT NULL,取消数据库默认值
--        (2) sales_default_campus_scope:不采用数据库触发器,改为应用层写入
-- ============================================================

BEGIN;

-- ----------------------------------------------------------------
-- 修订 1:取消 payment_orders.price_tier 数据库默认值
-- 产品要求:由应用层(NestJS PaymentOrdersService)显式传入 SKU
-- 保留 NOT NULL 约束 + 4 SKU CHECK 约束
-- ----------------------------------------------------------------
ALTER TABLE public.payment_orders
    ALTER COLUMN price_tier DROP DEFAULT;

COMMENT ON COLUMN public.payment_orders.price_tier IS
    'PD-01 Q.PRICE.c (V5 修订):应用层显式传入 SKU,数据库不再 DEFAULT;NOT NULL + CHECK (trial/standard_1999/school_pro/growth)';

-- ----------------------------------------------------------------
-- 修订 2:去除 sales_default_campus_scope 触发器
-- 产品要求:应用层优先(NestJS UsersService),数据库不加触发器
-- 保留 users.campus_scope 字段(JSONB) + DEFAULT '[]'::jsonb 不变
-- ----------------------------------------------------------------
-- 注意:本 V5 应用到所有现有租户 schema,worker 创建新租户时跑 V2+V4+V5
SET LOCAL search_path = __TENANT_SCHEMA__, public;

DROP TRIGGER IF EXISTS trg_users_sales_default_campus_scope ON users;
DROP FUNCTION  IF EXISTS sales_default_campus_scope();

-- 应用层规约(NestJS UsersService):
--   create(user) {
--     if (user.role === 'sales' && (!user.campusScope || user.campusScope.length === 0)) {
--       user.campusScope = [user.campusId];
--     }
--     ...
--   }

COMMENT ON COLUMN users.campus_scope IS
    'PD-07 §7.3 (V5 修订):应用层 UsersService.create/update 时,sales 角色默认填 [campusId];数据库不再触发器自动填充';

COMMIT;

-- ============================================================
-- 验收检查:
--   -- price_tier 不应有 DEFAULT
--   SELECT column_default FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='payment_orders' AND column_name='price_tier';
--   -- 应返回 NULL
--
--   -- 触发器 + 函数应该被 DROP
--   SELECT trigger_name FROM information_schema.triggers
--    WHERE trigger_name='trg_users_sales_default_campus_scope';
--   -- 应返回 0 行
--
--   SELECT proname FROM pg_proc WHERE proname='sales_default_campus_scope';
--   -- 应返回 0 行
-- ============================================================
