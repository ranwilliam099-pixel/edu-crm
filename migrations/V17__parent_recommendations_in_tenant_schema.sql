-- ============================================================
-- V17__parent_recommendations_in_tenant_schema.sql
-- 在 __TENANT_SCHEMA__ 内新增"家长推荐"表
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
-- 依据：用户 2026-05-04 9 个待实现 endpoint #2（pages/b/teacher/recommendations/list 老师 toggle）
-- 出具：开发总监 / 研发负责人  2026-05-04
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §17.1 parent_recommendations — 家长对老师的推荐
-- 业务约束：只有 parent_authorized = true 的才允许 toggle 显示
--   - parent_authorized = false → 老师不能勾选"展示在业务卡上"
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parent_recommendations (
    id                  VARCHAR(32)   PRIMARY KEY,
    teacher_id          VARCHAR(32)   NOT NULL REFERENCES teachers(id),
    parent_id           VARCHAR(32)   NOT NULL,                            -- public.parents.id（跨 schema，故无 FK）
    student_id          VARCHAR(32)   NOT NULL REFERENCES students(id),
    stars               SMALLINT      NOT NULL CHECK (stars BETWEEN 1 AND 5),
    content             TEXT,
    tags                JSONB         NOT NULL DEFAULT '[]'::jsonb,        -- ["耐心","专业","风趣"]
    parent_authorized   BOOLEAN       NOT NULL DEFAULT FALSE,              -- 家长是否授权公开
    displayed           BOOLEAN       NOT NULL DEFAULT FALSE,              -- 老师是否选中展示
    submitted_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr_teacher_displayed ON parent_recommendations(teacher_id, displayed);
CREATE INDEX IF NOT EXISTS idx_pr_teacher_time      ON parent_recommendations(teacher_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_pr_parent            ON parent_recommendations(parent_id);

COMMENT ON TABLE  parent_recommendations              IS 'V17 家长推荐。displayed 由老师 toggle，但只有 parent_authorized=true 才可勾选';
COMMENT ON COLUMN parent_recommendations.parent_authorized IS '家长授权公开（隐私必备前置条件）';
COMMENT ON COLUMN parent_recommendations.displayed         IS '老师是否选中展示在业务卡（toggle）';

COMMIT;
