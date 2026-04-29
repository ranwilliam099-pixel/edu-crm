-- ============================================================
-- V5__pd_signed_corrections.sql
-- 依据：产品经理 2026-04-30 在以下两份文档中签字：
--   - 教育培训行业销售CRM-V3-V4实现层猜测自查清单-2026-04-30.md §3.3
--   - 研发请项目经理协调-V3V4产品签字-2026-04-30.md §3.1
--
-- 产品经理对 V3+V4（commit bcc06c5）签字结论：
--   - 25 项采信（其余实现保留）
--   - 2 处修订：
--     修订 1：payment_orders.price_tier 取消 DB DEFAULT（保留 NOT NULL）
--     修订 2：删除 sales 默认 campus_scope 触发器（改应用层处理）
--
-- 项目隔离（追加 #8）：本工程是 ~/Desktop/edu-server/，与企业管理系统完全独立
--
-- 本文件结构：
--   §1 public schema：直接执行（修订 V3 引入的 price_tier DEFAULT）
--   §2 tenant schema 模板：含 __TENANT_SCHEMA__ 占位，由 TenantService 在每次新建租户时执行
--      （已创建的租户由应用层维护脚本另行跑，本工程当前 0 真实租户，无遗留）
-- ============================================================

-- ============================================================
-- §1 修订 1：public.payment_orders.price_tier 取消 DEFAULT
-- ============================================================
-- V3 原 DDL（line 34）：
--   ADD COLUMN IF NOT EXISTS price_tier VARCHAR(32) NOT NULL DEFAULT 'standard_1999'
-- 产品签字版本：保留 NOT NULL + CHECK 4 枚举，取消 DB DEFAULT；由应用层 CheckoutService
-- 在创建 payment_orders 时显式赋 trial / standard_1999 / school_pro / growth 之一。
--
-- 设计意图：避免 INSERT 不带 price_tier 时静默落 'standard_1999'，强制业务层显式定档位。
-- ============================================================

BEGIN;

ALTER TABLE public.payment_orders ALTER COLUMN price_tier DROP DEFAULT;

COMMENT ON COLUMN public.payment_orders.price_tier IS
  'price_tier 4 SKU 枚举：trial / standard_1999 / school_pro / growth。'
  '产品经理 2026-04-30 V3V4 协调函签字：保留 NOT NULL + CHECK，取消 DB DEFAULT；'
  '由应用层 CheckoutService 在创建订单时显式赋值。';

COMMIT;

-- ============================================================
-- §2 修订 2：tenant schema 删除 sales 默认 campus_scope 触发器（改应用层）
-- ============================================================
-- V4 原 DDL（line 117-131）：
--   CREATE OR REPLACE FUNCTION sales_default_campus_scope() RETURNS TRIGGER AS $$
--     BEGIN IF NEW.role = 'sales' AND ... THEN NEW.campus_scope = ... ; END IF; RETURN NEW; END $$
--   CREATE TRIGGER trg_users_sales_default_campus_scope BEFORE INSERT/UPDATE ON users
--     FOR EACH ROW EXECUTE FUNCTION sales_default_campus_scope();
--
-- 产品签字版本：删除触发器 + 函数；由 NestJS 应用层 UserService 在创建 sales 用户时
-- 显式写入 campus_scope=[campus_id]（更易调试 + 业务规则集中在代码）。
--
-- 注意：本段含 __TENANT_SCHEMA__ 占位，由 src/modules/tenant/tenant.service.ts
-- TenantService.renderTenantSchemaSQL() 替换为 tenant_<id> 后执行。
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

DROP TRIGGER IF EXISTS trg_users_sales_default_campus_scope ON users;
DROP FUNCTION IF EXISTS sales_default_campus_scope() CASCADE;

COMMENT ON COLUMN users.campus_scope IS
  'campus_scope JSONB 数组（校区 ID 列表）。'
  '产品经理 2026-04-30 V3V4 协调函签字：sales 默认 campus_scope=[campus_id] 由 NestJS 应用层 '
  'UserService 在创建用户时显式写入，不使用 DB 触发器。'
  '默认值仍为 ''[]''::jsonb（V4 已设），应用层负责按 role=sales 时的填充逻辑。';

COMMIT;
