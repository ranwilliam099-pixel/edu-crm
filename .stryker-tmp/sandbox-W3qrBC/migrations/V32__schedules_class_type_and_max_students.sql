-- ============================================================
-- V32__schedules_class_type_and_max_students.sql
-- 在 __TENANT_SCHEMA__ 内：
--   schedules 加 class_type + max_students 字段
--   配合 V29 R10/R11 老师对象排课时多选学员 + 老师自填最多人数
--
-- 占位：__TENANT_SCHEMA__ 由租户初始化 worker 替换
--
-- 依据：用户 2026-05-07
--   R9：「排课需要注意是一对一还是小班，还是大班，人数什么的，要做数据校验」
--   R11：「校验太严格了，影响灵活性」
--
-- 设计：
--   - class_type：班型标签（'一对一'/'一对二'/'小班'/'大班'/'一对多'）— 仅作 UI 展示
--   - max_students：老师自填的这节课最多人数（柔性，前后端校验上限）
--   - 后端 schedule.repository.insertWithStudents 校验 studentIds.length ≤ max_students
--
-- 出具：研发负责人  2026-05-07
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

ALTER TABLE schedules
    ADD COLUMN IF NOT EXISTS class_type     VARCHAR(32),
    ADD COLUMN IF NOT EXISTS max_students   INT
      CHECK (max_students IS NULL OR max_students >= 1);

CREATE INDEX IF NOT EXISTS idx_schedules_class_type
    ON schedules(class_type)
    WHERE class_type IS NOT NULL;

COMMENT ON COLUMN schedules.class_type
    IS 'V32 班型标签（一对一/一对二/小班/大班/一对多）— 仅 UI 展示';
COMMENT ON COLUMN schedules.max_students
    IS 'V32 老师自填的本节课最多学员数（柔性上限，应用层校验 studentIds 数 ≤ max_students）';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   ALTER TABLE schedules
--     DROP COLUMN IF EXISTS class_type,
--     DROP COLUMN IF EXISTS max_students;
--   COMMIT;
-- ============================================================
