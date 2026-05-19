-- ============================================================
-- V45__add_subscription_status_to_tenants.sql
-- T9-EPIC 14d 试用 + 订阅状态机（spec 2026-05-16 §2）
--
-- 来源：
--   - 用户 5/16 拍板「注册在前，14d 试用，14d 后只读」
--   - A2 audit P0-A4 修复（pay.js blocked:true 永久死链）
--
-- 与 V1 中文 status 关系（spec §2 拍板）：
--   - V1 tenants.status 中文 enum 给 lifecycle/admin/cron 用（'试用中'/'已付费'/...）
--   - V45 subscription_status 给 TenantSubscriptionGuard / 前端用（'trial'/'active'/'expired'）
--   - 双轨共存不冲突；前者业务生命周期，后者订阅访问门禁
-- ============================================================

BEGIN;
SET LOCAL search_path = public;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(16) NOT NULL DEFAULT 'trial'
    CHECK (subscription_status IN ('trial', 'active', 'expired')),
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS subscribed_until TIMESTAMPTZ NULL;

-- T9-EPIC §11 拍板 2：64 老 tenant（5/13 deploy）backfill 'active' 保护既有客户
-- 新 ADD COLUMN 时 DEFAULT 'trial' 已写入，此处仅修正 trial_ends_at IS NULL 的老 row
UPDATE tenants
  SET subscription_status='active'
  WHERE subscription_status='trial' AND trial_ends_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tenants_subscription_status ON tenants(subscription_status);
CREATE INDEX IF NOT EXISTS idx_tenants_trial_ends_at ON tenants(trial_ends_at)
  WHERE subscription_status='trial';

COMMENT ON COLUMN tenants.subscription_status IS
  'V45 订阅状态：trial(14d 试用) / active(已订阅) / expired(数据只读)';
COMMENT ON COLUMN tenants.trial_ends_at IS
  'V45 试用期满时间（provision-tenant 时 NOW+14d；expired 后保留用于审计）';
COMMENT ON COLUMN tenants.subscribed_until IS
  'V45 订阅期限（付款后 NOW+365d；GREATEST 防多次续费回退）';

COMMIT;
