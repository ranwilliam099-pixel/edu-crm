-- ============================================================
-- V62__students_grade_base_year.sql
-- 学员年级自动升级（computed-on-read）— 新增 students.grade_base_year
-- 占位：`__TENANT_SCHEMA__` 由 backfill 脚本 sed 替换（tenant-schema migration）
--
-- 来源：SSOT §4.1.1「学员年级自动升级（2026-05-31 用户拍板）」
--
-- 设计（computed-on-read，不跑 cron、不改 grade_or_age 库存值）：
--   - grade_or_age      = 录入年级原值（保留不动）
--   - grade_base_year   = 录入时学年（本列新增）
--   - 读学员时按 ladder 推算 currentGrade = advance(grade_or_age, 当前学年 − grade_base_year)，
--     封顶高三；非阶梯值（如「5 岁」「学前」）原样返回豁免。
--
-- 学年定义（与应用层 src/common/grade-ladder.ts academicYear 一致）：
--   日期 D 的学年 = D.month >= 8 ? D.year : D.year - 1（学年起点 8/1）。
--
-- 老数据 backfill：
--   grade_base_year = created_at 的学年
--   = CASE WHEN EXTRACT(MONTH FROM created_at) >= 8
--          THEN EXTRACT(YEAR FROM created_at)
--          ELSE EXTRACT(YEAR FROM created_at) - 1 END
--   仅回填 grade_base_year IS NULL 的行（幂等；ALTER 刚加列时全部为 NULL）。
--   注意：created_at 为 TIMESTAMPTZ，EXTRACT 取的是会话时区下的月/年；
--   生产服务器 TZ = 北京时间（Asia/Shanghai），与应用层 new Date() 本地时区口径一致。
--
-- 幂等：
--   - ADD COLUMN IF NOT EXISTS（重跑无害）
--   - UPDATE ... WHERE grade_base_year IS NULL（已回填的行不再动）
--
-- 可逆（回退）：
--   ALTER TABLE __TENANT_SCHEMA__.students DROP COLUMN IF EXISTS grade_base_year;
--   （读路径对 grade_base_year IS NULL 已用 created_at 学年兜底，DROP 后应用层仍可工作）
--
-- GRANT：未新增表，无需 GRANT（列权限随表继承，eduapp 对 students 已有 DML 权限）。
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- 1. 新增列（录入时学年）
ALTER TABLE students ADD COLUMN IF NOT EXISTS grade_base_year INTEGER;

COMMENT ON COLUMN students.grade_base_year IS
  'V62 录入时学年（SSOT §4.1.1）；读时 currentGrade=advance(grade_or_age, 当前学年−grade_base_year) 封顶高三';

-- 2. 老数据 backfill：grade_base_year = created_at 的学年（学年起点 8/1）
--    仅回填 NULL 行（幂等）
UPDATE students
   SET grade_base_year = CASE
         WHEN EXTRACT(MONTH FROM created_at) >= 8
           THEN EXTRACT(YEAR FROM created_at)::INTEGER
         ELSE (EXTRACT(YEAR FROM created_at)::INTEGER - 1)
       END
 WHERE grade_base_year IS NULL
   AND created_at IS NOT NULL;

COMMIT;
