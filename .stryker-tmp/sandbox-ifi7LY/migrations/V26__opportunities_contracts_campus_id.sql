-- ============================================================
-- V26__opportunities_contracts_campus_id.sql
-- 在 __TENANT_SCHEMA__ 内：
--   opportunities + contracts 加 campus_id（老板视角校区切换的基础）
--
-- 占位：__TENANT_SCHEMA__ 由租户初始化 worker 替换
--
-- 依据：用户 2026-05-07「需要一个老板账户，可以切换校区看信息」
--   - admin role = 老板（跨校）
--   - boss role  = 校长（单校）
--   - 客户 / 签约都需要 campus 归属，老板按校区过滤
--
-- 出具：研发负责人  2026-05-07
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §26.1 opportunities ALTER：加 campus_id
-- 客户的归属校区（销售在哪个校区跟单）
-- ----------------------------------------------------------------
ALTER TABLE opportunities
    ADD COLUMN IF NOT EXISTS campus_id VARCHAR(32) REFERENCES campuses(id);

CREATE INDEX IF NOT EXISTS idx_opps_campus
    ON opportunities(campus_id);
CREATE INDEX IF NOT EXISTS idx_opps_owner_campus
    ON opportunities(owner_user_id, campus_id)
    WHERE owner_user_id IS NOT NULL;

COMMENT ON COLUMN opportunities.campus_id
    IS 'V26 客户归属校区（老板视角切换过滤；NULL = 跨校或未指定）';

-- ----------------------------------------------------------------
-- §26.2 contracts ALTER：加 campus_id
-- 签约归属校区（业绩按校区聚合）
-- ----------------------------------------------------------------
ALTER TABLE contracts
    ADD COLUMN IF NOT EXISTS campus_id VARCHAR(32) REFERENCES campuses(id);

CREATE INDEX IF NOT EXISTS idx_contracts_campus
    ON contracts(campus_id, signed_at DESC);

COMMENT ON COLUMN contracts.campus_id
    IS 'V26 签约归属校区（业绩按校区聚合 + 老板视角切换）';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   ALTER TABLE opportunities DROP COLUMN IF EXISTS campus_id;
--   ALTER TABLE contracts DROP COLUMN IF EXISTS campus_id;
--   COMMIT;
-- ============================================================
