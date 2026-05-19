-- ============================================================
-- V52 — schedules 加 campus_id 列 + backfill via teachers.campus_id
-- ============================================================
-- 触发 (5/20 leader)：L2 course-product.repository integration spec 暴露
-- course-product.repository.ts:340 引用不存在的 sc.campus_id 列 → boss/academic
-- 多校区角色调 GET /db/course-products/:id/stats 时 500。
--
-- 方案 C 拍板：加列让 SQL 工作（最一致）。理由：
--   - schedules.campus_id 在业务上是真实概念（这节课在哪个校区上）
--   - 与 teachers.campus_id 一致（一个老师可跨校区排课，但每节课归属一个校区）
--   - 应用层后续校验「老师跨校排课需 boss 同意」更清晰
--
-- 不可逆性：ADD COLUMN + backfill 后 NOT NULL + FK，回滚需 DROP COLUMN。
-- 已知现存 schedules 都通过 teacher.campus_id 推导 campus_id（教师主校区）。
--
-- 步骤：
--   1. ADD COLUMN campus_id VARCHAR(32) NULL（不立即 NOT NULL，避免老数据 fail）
--   2. UPDATE schedules SET campus_id = teachers.campus_id（FROM JOIN backfill）
--   3. 若全部行 backfill 完，ALTER 加 NOT NULL + FK
--   4. CREATE INDEX 加速 boss/academic 多校 scope filter
-- ============================================================
BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- 1. ADD COLUMN（nullable，let 老数据通过）
ALTER TABLE schedules
    ADD COLUMN IF NOT EXISTS campus_id VARCHAR(32);

-- 2. Backfill: schedules.campus_id ← teachers.campus_id（每节课归属教师主校区）
UPDATE schedules s
   SET campus_id = t.campus_id
  FROM teachers t
 WHERE s.teacher_id = t.id
   AND s.campus_id IS NULL;

-- 3. 校验是否全部 backfill 完成；如有未覆盖（孤儿 schedule 缺 teacher）则保留 NULL 警告
--    （正常 schedules.teacher_id 是 NOT NULL REFERENCES teachers，理论上 100% 覆盖）
DO $$
DECLARE
    null_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO null_count FROM schedules WHERE campus_id IS NULL;
    IF null_count > 0 THEN
        RAISE NOTICE 'V52: % rows still NULL campus_id (孤儿 teacher 或 teacher.campus_id NULL)', null_count;
    ELSE
        -- 全部 backfill，安全加 NOT NULL + FK
        ALTER TABLE schedules ALTER COLUMN campus_id SET NOT NULL;
    END IF;
END $$;

-- 4. FK constraint (idempotent — IF NOT EXISTS pattern)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = current_schema()
          AND table_name = 'schedules'
          AND constraint_name = 'schedules_campus_id_fk'
    ) THEN
        ALTER TABLE schedules
            ADD CONSTRAINT schedules_campus_id_fk
            FOREIGN KEY (campus_id) REFERENCES campuses(id);
    END IF;
END $$;

-- 5. Index：boss/academic 多校 scope 查询主索引
CREATE INDEX IF NOT EXISTS idx_schedules_campus_id ON schedules(campus_id);

COMMENT ON COLUMN schedules.campus_id
    IS 'V52 这节课所属校区（来自 teachers.campus_id）。boss/academic 多校 scope filter 主字段';

COMMIT;

-- ============================================================
-- 回滚（开发参考）：
--   ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_campus_id_fk;
--   DROP INDEX IF EXISTS idx_schedules_campus_id;
--   ALTER TABLE schedules DROP COLUMN IF EXISTS campus_id;
-- ============================================================
