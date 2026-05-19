-- ============================================================
-- V29__contracts_self_filled_fields.sql
-- 在 __TENANT_SCHEMA__ 内：
--   contracts.course_product_id 改 NULLABLE + 加 course_product_name 字段
--   让销售签约时可自填课程包名（不强制从既有 course_products 选）
--
-- 占位：__TENANT_SCHEMA__ 由租户初始化 worker 替换
--
-- 依据：用户 2026-05-07
--   「销售的课时包应该是销售可以自己填的，不是可选」
--   配合 V10「全功能开放，14 天试用」自助 PLG 理念。
--
-- 影响：
--   - 老 contracts（V25 前签的）course_product_id 可能仍 NOT NULL，无影响
--   - 新签合同允许 course_product_id NULL + course_product_name 文本
--   - course_product_name 是销售自填，可与既有 course_products 不对齐
--
-- 出具：研发负责人  2026-05-07
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §29.1 contracts.course_product_id 放宽为 NULLABLE
-- ----------------------------------------------------------------
ALTER TABLE contracts
    ALTER COLUMN course_product_id DROP NOT NULL;

-- ----------------------------------------------------------------
-- §29.2 加 course_product_name（销售自填的课程包名）
-- ----------------------------------------------------------------
ALTER TABLE contracts
    ADD COLUMN IF NOT EXISTS course_product_name VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_contracts_course_name
    ON contracts(course_product_name)
    WHERE course_product_name IS NOT NULL;

COMMENT ON COLUMN contracts.course_product_id
    IS 'V29 NULLABLE — 销售可自填课程名而不绑定既有 course_products';
COMMENT ON COLUMN contracts.course_product_name
    IS 'V29 销售自填的课程包名（如「英语 1v1 35 课时」）；与 course_product_id 二选一';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   -- 注意：回滚前需先把 course_product_id IS NULL 的行删掉，否则 NOT NULL 会失败
--   DELETE FROM contracts WHERE course_product_id IS NULL;
--   ALTER TABLE contracts ALTER COLUMN course_product_id SET NOT NULL;
--   ALTER TABLE contracts DROP COLUMN IF EXISTS course_product_name;
--   COMMIT;
-- ============================================================
