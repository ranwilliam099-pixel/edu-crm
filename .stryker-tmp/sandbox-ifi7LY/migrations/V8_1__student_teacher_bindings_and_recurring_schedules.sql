-- ============================================================
-- V8_1__student_teacher_bindings_and_recurring_schedules.sql
-- 在 __TENANT_SCHEMA__ 内新增"学员-老师固定绑定 + 周期性课表模板"
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
-- 依据：
--   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§3.6
--   - PD 硬规则 P12（默认排课走"学员-老师固定绑定 + 周期性课表模板"）
-- 出具：开发总监 / 研发负责人  2026-05-02
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- 学员-老师固定绑定（按科目可多对多）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_teacher_bindings (
    id                 VARCHAR(32)  PRIMARY KEY,
    student_id         VARCHAR(32)  NOT NULL REFERENCES students(id),
    teacher_id         VARCHAR(32)  NOT NULL REFERENCES teachers(id),
    subject            VARCHAR(64),                                    -- 数学 / 英语 / 物理 / 综合
    status             VARCHAR(16)  NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','unbound')),
    bound_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    unbound_at         TIMESTAMPTZ,
    bound_by_user_id   VARCHAR(32)  NOT NULL REFERENCES users(id),
    UNIQUE (student_id, teacher_id, subject)
);
CREATE INDEX IF NOT EXISTS idx_stb_student ON student_teacher_bindings(student_id);
CREATE INDEX IF NOT EXISTS idx_stb_teacher ON student_teacher_bindings(teacher_id);
CREATE INDEX IF NOT EXISTS idx_stb_status  ON student_teacher_bindings(status);

-- ----------------------------------------------------------------
-- 周期性排课模板
-- 简化 RRULE：BYDAY 字段为 ["MO","WE","FR"] JSONB 数组 + start_minutes 整数（0-1439）
-- 完整 iCal RRULE 后续用 rrule.js 库扩展（V12+ 待开）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recurring_schedules (
    id                  VARCHAR(32)  PRIMARY KEY,
    binding_id          VARCHAR(32)  NOT NULL REFERENCES student_teacher_bindings(id),
    student_id          VARCHAR(32)  NOT NULL REFERENCES students(id),    -- 冗余反查
    teacher_id          VARCHAR(32)  NOT NULL REFERENCES teachers(id),    -- 冗余反查
    course_product_id   VARCHAR(32),
    by_day              JSONB        NOT NULL,                            -- ["MO","WE"]
    start_minutes       INT          NOT NULL CHECK (start_minutes BETWEEN 0 AND 1439),
    duration_min        INT          NOT NULL CHECK (duration_min > 0 AND duration_min <= 480),
    start_date          DATE         NOT NULL,
    end_date            DATE,                                             -- NULL = 无限期
    status              VARCHAR(16)  NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','archived')),
    created_by_user_id  VARCHAR(32)  NOT NULL REFERENCES users(id),
    created_by_role     VARCHAR(24)  NOT NULL,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    archived_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_rs_binding ON recurring_schedules(binding_id);
CREATE INDEX IF NOT EXISTS idx_rs_student ON recurring_schedules(student_id);
CREATE INDEX IF NOT EXISTS idx_rs_teacher ON recurring_schedules(teacher_id);
CREATE INDEX IF NOT EXISTS idx_rs_active  ON recurring_schedules(status) WHERE status = 'active';

COMMIT;
