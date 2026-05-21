-- ============================================================
-- V55__customers_students_extra_fields.sql
-- 客户/学员字段重构 — 2026-05-21 用户拍板
--
-- 业务规则：
--   Section 1 学员信息（可空，签约前必填）:
--     - gender         学员性别（男/女/其他）
--     - school         就读学校（含「未上学」）
--     - phone          学员本人电话（区别于 customer.primary_mobile 家长电话）
--     - available_time 支持上课时间 TEXT[]（slot keys: mon-am / mon-pm / mon-eve / ... / sun-eve 共 21 槽位）
--
--   Section 2 家长信息（新建客户必填姓名+电话，性别可空）:
--     - parent_gender  家长性别（男/女/其他）
--     - parent_name    现有列 ✅
--     - primary_mobile 现有列 ✅
--
-- 占位：__TENANT_SCHEMA__ 由 scripts/backfill-v55.sh sed 替换
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- students 加 4 列
-- ----------------------------------------------------------------
ALTER TABLE students
    ADD COLUMN IF NOT EXISTS gender         VARCHAR(8),
    ADD COLUMN IF NOT EXISTS school         TEXT,
    ADD COLUMN IF NOT EXISTS phone          VARCHAR(20),
    ADD COLUMN IF NOT EXISTS available_time TEXT[];

COMMENT ON COLUMN students.gender         IS 'V55 学员性别（男/女/其他）';
COMMENT ON COLUMN students.school         IS 'V55 就读学校（含「未上学」字面值）';
COMMENT ON COLUMN students.phone          IS 'V55 学员本人电话（区别于 customer.primary_mobile 家长电话）';
COMMENT ON COLUMN students.available_time IS 'V55 支持上课时间 TEXT[] 21 slot key: mon-am/pm/eve, tue-..., ..., sun-eve';

-- ----------------------------------------------------------------
-- customers 加 parent_gender 列
-- ----------------------------------------------------------------
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS parent_gender VARCHAR(8);

COMMENT ON COLUMN customers.parent_gender IS 'V55 家长性别（男/女/其他）';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   ALTER TABLE students DROP COLUMN IF EXISTS gender, DROP COLUMN IF EXISTS school,
--                        DROP COLUMN IF EXISTS phone,  DROP COLUMN IF EXISTS available_time;
--   ALTER TABLE customers DROP COLUMN IF EXISTS parent_gender;
--   COMMIT;
-- ============================================================
