-- ============================================================
-- V18__lesson_feedbacks_extended_fields.sql
-- 在 __TENANT_SCHEMA__.lesson_feedbacks 增加 5 个字段
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
-- 依据：用户 2026-05-04 9 个待实现 endpoint #4（pages/b/feedback/new 已记录但后端未存）
-- 出具：开发总监 / 研发负责人  2026-05-04
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §18.1 lesson_feedbacks 5 个 P0 新字段
--   - knowledge_matrix     [{name, mastery}]  - 知识点矩阵（细于 knowledge_points）
--   - dim_ratings          {focus, engage, think, homework}  - 4 维评分
--   - homework_deadline    timestamptz                       - 作业截止时间
--   - homework_difficulty  basic | medium | hard             - 作业难度
--   - next_preview         text                              - 下次预习提示
-- 注：现有 knowledge_points 字段保留兼容老版本前端
-- ----------------------------------------------------------------
ALTER TABLE lesson_feedbacks
    ADD COLUMN IF NOT EXISTS knowledge_matrix    JSONB,
    ADD COLUMN IF NOT EXISTS dim_ratings         JSONB,
    ADD COLUMN IF NOT EXISTS homework_deadline   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS homework_difficulty VARCHAR(8)
        CHECK (homework_difficulty IS NULL OR homework_difficulty IN ('basic','medium','hard')),
    ADD COLUMN IF NOT EXISTS next_preview        TEXT;

COMMENT ON COLUMN lesson_feedbacks.knowledge_matrix    IS 'V18 知识点矩阵 [{name, mastery}]';
COMMENT ON COLUMN lesson_feedbacks.dim_ratings         IS 'V18 4 维评分 {focus, engage, think, homework}';
COMMENT ON COLUMN lesson_feedbacks.homework_deadline   IS 'V18 作业截止时间';
COMMENT ON COLUMN lesson_feedbacks.homework_difficulty IS 'V18 作业难度 basic|medium|hard';
COMMENT ON COLUMN lesson_feedbacks.next_preview        IS 'V18 下次课预习提示';

COMMIT;
