-- ============================================================
-- V21__promotion_audit_quota_expire_action.sql
-- 给 promotion_tier_audit.action CHECK 加新枚举值 'quota_expire'
-- 用途：PromotionQuotaService.expirePromotions cron 巡检（applies_years 用完）
-- 出具：研发负责人  2026-05-05
-- ============================================================

BEGIN;

ALTER TABLE public.promotion_tier_audit
    DROP CONSTRAINT IF EXISTS promotion_tier_audit_action_check;

ALTER TABLE public.promotion_tier_audit
    ADD CONSTRAINT promotion_tier_audit_action_check
    CHECK (action IN (
        'create','update','toggle','delete',
        'quota_reserve','quota_commit','quota_release','quota_expire'
    ));

COMMIT;

-- 回滚：
--   BEGIN;
--   ALTER TABLE public.promotion_tier_audit DROP CONSTRAINT IF EXISTS promotion_tier_audit_action_check;
--   ALTER TABLE public.promotion_tier_audit
--       ADD CONSTRAINT promotion_tier_audit_action_check
--       CHECK (action IN ('create','update','toggle','delete',
--                         'quota_reserve','quota_commit','quota_release'));
--   COMMIT;
