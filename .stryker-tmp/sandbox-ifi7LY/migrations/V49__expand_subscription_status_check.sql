-- ============================================================
-- V49__expand_subscription_status_check.sql
-- 扩展 tenants.subscription_status CHECK 约束接受 archived + frozen
--
-- 业务背景：
--   V45 原 CHECK 只接受 ('trial', 'active', 'expired')
--   但业务需要：
--     - archived：客户主动归档（停用但数据保留，未来可恢复）
--     - frozen：欠费冻结 / 违规冻结（强制停用，admin 解冻）
--
-- 依据：5/19 leader 决策 D1.1（最严最科学拍板，避免用 expired 凑合）
--
-- 影响：
--   - public.tenants 表（不在 TENANT_MIGRATIONS 列表，无需 per-tenant 跑）
--   - TenantSubscriptionGuard 代码层需读 5 枚举值（非 3）
--   - 部署时手动跑：sudo -u postgres psql -d edu -f migrations/V49__expand_subscription_status_check.sql
-- ============================================================

BEGIN;

SET LOCAL search_path = public;

-- 1. 检查并删除旧 CHECK 约束（DO 块兜底 IF EXISTS）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'tenants'
      AND constraint_name = 'tenants_subscription_status_check'
  ) THEN
    ALTER TABLE tenants DROP CONSTRAINT tenants_subscription_status_check;
  END IF;
END $$;

-- 2. 添加新 CHECK 约束（5 枚举值）
ALTER TABLE tenants
  ADD CONSTRAINT tenants_subscription_status_check
  CHECK (subscription_status IN ('trial', 'active', 'expired', 'archived', 'frozen'));

-- 3. 更新 COMMENT（PG 标准相邻字符串字面量空白自动拼接）
COMMENT ON COLUMN tenants.subscription_status IS
  'V49 订阅状态 5 枚举：'
  'trial(14d 试用) / active(已订阅 365d) / expired(数据只读) / '
  'archived(主动归档保留数据) / frozen(欠费冻结需 admin 解冻)';

COMMIT;

-- 回滚（仅在 V49 部署后回退场景使用，且必须先把所有 archived/frozen 行更新为合法值）：
--   BEGIN;
--   UPDATE public.tenants SET subscription_status='expired'
--       WHERE subscription_status IN ('archived', 'frozen');
--   ALTER TABLE tenants DROP CONSTRAINT tenants_subscription_status_check;
--   ALTER TABLE tenants ADD CONSTRAINT tenants_subscription_status_check
--       CHECK (subscription_status IN ('trial', 'active', 'expired'));
--   COMMIT;
