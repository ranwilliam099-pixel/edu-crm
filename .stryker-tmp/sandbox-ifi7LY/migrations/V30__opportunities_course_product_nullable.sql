-- ============================================================
-- V30__opportunities_course_product_nullable.sql
-- 在 __TENANT_SCHEMA__ 内：
--   opportunities.course_product_id 改 NULLABLE
--   配合 V29 销售自填课程包名（不强制选既有产品）+ Phase 2 销售即时建客户
--
-- 占位：__TENANT_SCHEMA__ 由租户初始化 worker 替换
--
-- 依据：用户 2026-05-07「全做」
--   销售即时建客户时 opportunity 还没确定课程，course_product_id 应 NULL
--
-- 出具：研发负责人  2026-05-07
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

ALTER TABLE opportunities
    ALTER COLUMN course_product_id DROP NOT NULL;

COMMENT ON COLUMN opportunities.course_product_id
    IS 'V30 NULLABLE — 销售即时建客户时课程未定，可后续补；签约时也可不绑既有产品（V29）';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   DELETE FROM opportunities WHERE course_product_id IS NULL;
--   ALTER TABLE opportunities ALTER COLUMN course_product_id SET NOT NULL;
--   COMMIT;
-- ============================================================
