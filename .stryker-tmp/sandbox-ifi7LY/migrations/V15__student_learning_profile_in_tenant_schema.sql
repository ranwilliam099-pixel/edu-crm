-- ============================================================
-- V15__student_learning_profile_in_tenant_schema.sql
-- 在 __TENANT_SCHEMA__ 内新增"学员学情累计档案"
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
-- 依据：《教学链路完整设计-V1-2026-05-02.md》§4
-- 出具：开发总监 / 研发负责人  2026-05-02
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §15.1 student_learning_profile — 学员学情累计档案（一学员一行）
-- 由 cron 每天 0:00 增量重算（PD §9 Q-T7 默认）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_learning_profile (
    student_id              VARCHAR(32)  PRIMARY KEY REFERENCES students(id),
    total_lessons           INT          NOT NULL DEFAULT 0,
    total_homeworks         INT          NOT NULL DEFAULT 0,
    total_assessments       INT          NOT NULL DEFAULT 0,
    attendance_rate         NUMERIC(5,2) NOT NULL DEFAULT 0,    -- 累计出勤率（百分比）
    avg_homework_grade      VARCHAR(8),                          -- 作业平均等级
    avg_assessment_score    NUMERIC(6,2),                        -- 测评平均分
    knowledge_mastery       JSONB        NOT NULL DEFAULT '[]'::jsonb,
        -- [{name, mastery, lesson_count, last_seen_at}]
    weakness_points         JSONB        NOT NULL DEFAULT '[]'::jsonb,
        -- [{name, mastery, ...}] mastery in (需努力,需关注)
    strength_points         JSONB        NOT NULL DEFAULT '[]'::jsonb,
        -- [{name, mastery, ...}] mastery in (优秀,良好)
    last_updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMIT;
