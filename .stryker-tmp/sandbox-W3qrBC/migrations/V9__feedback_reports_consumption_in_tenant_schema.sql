-- ============================================================
-- V9__feedback_reports_consumption_in_tenant_schema.sql
-- 在 __TENANT_SCHEMA__ 内新增教学反馈 + 月报 + 课消三表
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
-- 依据：
--   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§4
--   - PD 硬规则 P6（24h 必填）+ P7（月报自动汇总）
-- 出具：开发总监 / 研发负责人  2026-05-02
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §4.1 lesson_feedbacks — 单课时反馈
-- 24h 内必填（P6）：超期未填 → course_consumptions.status='locked'，老师工资不算
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lesson_feedbacks (
    id                       VARCHAR(32)   PRIMARY KEY,
    schedule_id              VARCHAR(32)   NOT NULL REFERENCES schedules(id),
    student_id               VARCHAR(32)   NOT NULL REFERENCES students(id),
    teacher_id               VARCHAR(32)   NOT NULL REFERENCES teachers(id),
    attendance_status        VARCHAR(16)   NOT NULL
                             CHECK (attendance_status IN ('出勤','迟到','缺席','请假')),
    classroom_performance    VARCHAR(16)   NOT NULL
                             CHECK (classroom_performance IN
                               ('优秀','良好','合格','需努力','需关注')),
    knowledge_points         JSONB,
    homework                 TEXT,
    homework_attachments     JSONB,
    teacher_note             TEXT,                                       -- 给家长看的话
    teacher_internal_note    TEXT,                                       -- 内部备注（家长看不到）
    parent_read_at           TIMESTAMPTZ,
    submitted_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (schedule_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_lf_student_time ON lesson_feedbacks(student_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_lf_teacher_time ON lesson_feedbacks(teacher_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_lf_unread       ON lesson_feedbacks(parent_read_at) WHERE parent_read_at IS NULL;

-- ----------------------------------------------------------------
-- §4.1 monthly_reports — 月报
-- cron 每月 1 号 00:30 自动生成（P7），老师补寄语 + 续报建议后 finalize
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monthly_reports (
    id                    VARCHAR(32)   PRIMARY KEY,
    student_id            VARCHAR(32)   NOT NULL REFERENCES students(id),
    teacher_id            VARCHAR(32)   NOT NULL REFERENCES teachers(id),
    month                 DATE          NOT NULL,                       -- YYYY-MM-01
    attendance_summary    JSONB         NOT NULL,
    performance_trend     JSONB         NOT NULL,
    knowledge_summary     JSONB         NOT NULL,
    teacher_blessing      TEXT,                                          -- 老师寄语（finalize 时填）
    renewal_suggestion    TEXT,                                          -- 续报建议（finalize 时填）
    status                VARCHAR(24)   NOT NULL DEFAULT 'auto_generated'
                          CHECK (status IN ('auto_generated','teacher_finalized')),
    generated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    finalized_at          TIMESTAMPTZ,
    parent_read_at        TIMESTAMPTZ,
    UNIQUE (student_id, month)
);
CREATE INDEX IF NOT EXISTS idx_mr_student_month ON monthly_reports(student_id, month DESC);
CREATE INDEX IF NOT EXISTS idx_mr_status        ON monthly_reports(status);

-- ----------------------------------------------------------------
-- §4.2 course_consumptions — 课消候补表
-- 24h 锁定：feedback_due_at < NOW() AND status='pending_feedback' → 自动 locked
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS course_consumptions (
    id                  VARCHAR(32)   PRIMARY KEY,
    schedule_id         VARCHAR(32)   NOT NULL REFERENCES schedules(id),
    student_id          VARCHAR(32)   NOT NULL REFERENCES students(id),
    teacher_id          VARCHAR(32)   NOT NULL REFERENCES teachers(id),
    status              VARCHAR(24)   NOT NULL DEFAULT 'pending_feedback'
                        CHECK (status IN ('pending_feedback','confirmed','locked','cancelled')),
    amount_yuan         NUMERIC(10,2),
    feedback_id         VARCHAR(32)   REFERENCES lesson_feedbacks(id),
    feedback_due_at     TIMESTAMPTZ   NOT NULL,                          -- = schedule.end_at + 24h
    confirmed_at        TIMESTAMPTZ,
    locked_at           TIMESTAMPTZ,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (schedule_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_cc_status_due ON course_consumptions(status, feedback_due_at)
  WHERE status = 'pending_feedback';
CREATE INDEX IF NOT EXISTS idx_cc_teacher_status ON course_consumptions(teacher_id, status);

COMMIT;
