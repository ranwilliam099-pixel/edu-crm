-- ============================================================
-- V28__students_owner_and_teacher.sql
-- 在 __TENANT_SCHEMA__ 内：
--   students 加销售归属 + 主带老师 字段
--
-- 占位：__TENANT_SCHEMA__ 由租户初始化 worker 替换
--
-- 依据：用户 2026-05-07
--   「学生也可以切换给别的老师和销售」
--   「校长应该有一个员工列表，列表里面可以点这个员工，然后可以切换他的数据给别人」
--
-- 数据语义：
--   - owner_sales_id     学生的销售归属（签约后主跟单销售；区别于 customer 的 owner_user_id）
--   - assigned_teacher_id 学生的主带老师（V8 schedules 一对多排课，但主带老师有唯一指向）
--   - 两者都允许 NULL（学生未分配 / 销售离职后退回池）
--
-- 出具：研发负责人  2026-05-07
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §28.1 students ALTER：销售归属 + 主带老师
-- ----------------------------------------------------------------
ALTER TABLE students
    ADD COLUMN IF NOT EXISTS owner_sales_id        VARCHAR(32) REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS assigned_teacher_id   VARCHAR(32) REFERENCES teachers(id),
    ADD COLUMN IF NOT EXISTS owner_changed_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS owner_change_reason   VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_students_owner_sales
    ON students(owner_sales_id)
    WHERE owner_sales_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_students_assigned_teacher
    ON students(assigned_teacher_id)
    WHERE assigned_teacher_id IS NOT NULL;

COMMENT ON COLUMN students.owner_sales_id
    IS 'V28 学生的销售归属（签约后主跟单销售）';
COMMENT ON COLUMN students.assigned_teacher_id
    IS 'V28 学生的主带老师（区别于 schedules.teacher_id 的具体一节课）';

-- ----------------------------------------------------------------
-- §28.2 backfill 历史 students.owner_sales_id（从 customers 反查）
--   学生 → customer → opportunity.owner_user_id 是当前的销售归属源
--   这一步把已存在的学生归属同步过来，避免老数据 owner_sales_id 全 NULL
-- ----------------------------------------------------------------
UPDATE students s
   SET owner_sales_id = (
     SELECT o.owner_user_id
       FROM opportunities o
      WHERE o.student_id = s.id
        AND o.owner_user_id IS NOT NULL
      ORDER BY o.created_at DESC
      LIMIT 1
   )
 WHERE s.owner_sales_id IS NULL;

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   ALTER TABLE students
--     DROP COLUMN IF EXISTS owner_sales_id,
--     DROP COLUMN IF EXISTS assigned_teacher_id,
--     DROP COLUMN IF EXISTS owner_changed_at,
--     DROP COLUMN IF EXISTS owner_change_reason;
--   COMMIT;
-- ============================================================
