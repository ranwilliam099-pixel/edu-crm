-- ============================================================
-- V14__assessments_in_tenant_schema.sql
-- 在 __TENANT_SCHEMA__ 内新增"测评/考试"
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
-- 依据：《教学链路完整设计-V1-2026-05-02.md》§3
-- 出具：开发总监 / 研发负责人  2026-05-02
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §14.1 assessments — 测评/考试定义
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessments (
    id              VARCHAR(32)   PRIMARY KEY,
    teacher_id      VARCHAR(32)   NOT NULL REFERENCES teachers(id),
    title           VARCHAR(128)  NOT NULL,
    subject         VARCHAR(32)   NOT NULL,
    assessment_type VARCHAR(16)   NOT NULL DEFAULT '月考'
                    CHECK (assessment_type IN ('月考','期中','期末','单元测','其他')),
    total_score     NUMERIC(6,2)  NOT NULL DEFAULT 100 CHECK (total_score > 0),
    scheduled_at    TIMESTAMPTZ,
    status          VARCHAR(16)   NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','published','closed')),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_as_teacher ON assessments(teacher_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_as_status  ON assessments(status);

-- ----------------------------------------------------------------
-- §14.2 student_assessment_results — 学员测评成绩
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_assessment_results (
    id                   VARCHAR(32)  PRIMARY KEY,
    assessment_id        VARCHAR(32)  NOT NULL REFERENCES assessments(id),
    student_id           VARCHAR(32)  NOT NULL REFERENCES students(id),
    score                NUMERIC(6,2),
    rank_in_class        INT,
    knowledge_breakdown  JSONB,                                    -- [{name, score, total}]
    teacher_comment      TEXT,
    recorded_at          TIMESTAMPTZ,
    recorded_by_user_id  VARCHAR(32),
    UNIQUE (assessment_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_sar_assessment   ON student_assessment_results(assessment_id);
CREATE INDEX IF NOT EXISTS idx_sar_student_time ON student_assessment_results(student_id, recorded_at DESC);

COMMIT;
