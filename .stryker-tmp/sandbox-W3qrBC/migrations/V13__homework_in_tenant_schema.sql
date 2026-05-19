-- ============================================================
-- V13__homework_in_tenant_schema.sql
-- 在 __TENANT_SCHEMA__ 内新增"作业管理"
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
-- 依据：《教学链路完整设计-V1-2026-05-02.md》§2
-- 出具：开发总监 / 研发负责人  2026-05-02
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §13.1 homework_assignments — 老师布置的作业
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS homework_assignments (
    id              VARCHAR(32)  PRIMARY KEY,
    schedule_id     VARCHAR(32)  REFERENCES schedules(id),       -- 关联课次（可空）
    teacher_id      VARCHAR(32)  NOT NULL REFERENCES teachers(id),
    title           VARCHAR(128) NOT NULL,
    content         TEXT,
    attachments     JSONB,                                        -- [{url,type,filename}]
    due_at          TIMESTAMPTZ,
    difficulty      VARCHAR(8)
                    CHECK (difficulty IN ('易','中','难')),
    status          VARCHAR(16)  NOT NULL DEFAULT 'published'
                    CHECK (status IN ('published','archived')),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ha_teacher  ON homework_assignments(teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ha_schedule ON homework_assignments(schedule_id);
CREATE INDEX IF NOT EXISTS idx_ha_status   ON homework_assignments(status);

-- ----------------------------------------------------------------
-- §13.2 assignment_recipients — 作业接收方（学员维度）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assignment_recipients (
    assignment_id   VARCHAR(32)  NOT NULL REFERENCES homework_assignments(id) ON DELETE CASCADE,
    student_id      VARCHAR(32)  NOT NULL REFERENCES students(id),
    PRIMARY KEY (assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_ar_student ON assignment_recipients(student_id);

-- ----------------------------------------------------------------
-- §13.3 homework_submissions — 学员上交（家长代提交）+ 老师批改
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS homework_submissions (
    id                       VARCHAR(32)  PRIMARY KEY,
    assignment_id            VARCHAR(32)  NOT NULL REFERENCES homework_assignments(id),
    student_id               VARCHAR(32)  NOT NULL REFERENCES students(id),
    submitted_by_parent_id   VARCHAR(32),
    content                  TEXT,
    attachments              JSONB,
    status                   VARCHAR(16)  NOT NULL DEFAULT 'submitted'
                             CHECK (status IN ('submitted','graded','returned')),
    grade                    VARCHAR(8)
                             CHECK (grade IN ('A+','A','B','C','D','须重做')),
    teacher_comment          TEXT,
    graded_at                TIMESTAMPTZ,
    graded_by_user_id        VARCHAR(32),
    submitted_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_hs_status        ON homework_submissions(status);
CREATE INDEX IF NOT EXISTS idx_hs_student_time  ON homework_submissions(student_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_hs_pending_grade ON homework_submissions(graded_at) WHERE status = 'submitted';

COMMIT;
