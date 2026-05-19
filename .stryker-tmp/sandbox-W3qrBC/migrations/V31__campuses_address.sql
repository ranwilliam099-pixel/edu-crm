-- ============================================================
-- V31__campuses_address.sql
-- 在 __TENANT_SCHEMA__ 内：
--   campuses 表加 address 字段（V29 R5 wizard 多校区开通时录入校区地址）
--
-- 占位：__TENANT_SCHEMA__ 由租户初始化 worker 替换
--
-- 依据：用户 2026-05-07 wizard 多校区开通时填的校区地址需持久化
--   原 V2 campuses 表仅 id/name/status，遗漏了 address 字段
--
-- 出具：研发负责人  2026-05-07
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

ALTER TABLE campuses
    ADD COLUMN IF NOT EXISTS address VARCHAR(256);

COMMENT ON COLUMN campuses.address
    IS 'V31 校区地址（街道 / 楼栋；可空）';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   ALTER TABLE campuses DROP COLUMN IF EXISTS address;
--   COMMIT;
-- ============================================================
