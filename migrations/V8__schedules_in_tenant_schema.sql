-- ============================================================
-- V8__schedules_in_tenant_schema.sql
-- 在 __TENANT_SCHEMA__ 内新增排课相关表
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
-- 依据：
--   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§3
--   - PD 硬规则 P1-P5（资源仅老师+学生 / 老师销售可排课 / 销售只能跟进学员 /
--     老师跨校豁免 / 冲突硬阻塞）
--   - 用户拍板《全部人员-审核往来总台账.md》条目 31 #2（老师 RBAC 反查链路）
-- 出具：开发总监 / 研发负责人  2026-05-02
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §3.1 schedules — 单次排课
-- end_at = start_at + duration_min（GENERATED）用于冲突检测的 tstzrange 计算
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedules (
    id                  VARCHAR(32)  PRIMARY KEY,                       -- 32-char ULID
    course_product_id   VARCHAR(32),                                    -- 可选（临时辅导无产品）
    teacher_id          VARCHAR(32)  NOT NULL REFERENCES teachers(id),
    start_at            TIMESTAMPTZ  NOT NULL,
    duration_min        INT          NOT NULL CHECK (duration_min > 0 AND duration_min <= 480),
    end_at              TIMESTAMPTZ  GENERATED ALWAYS AS
                          (start_at + (duration_min || ' minutes')::interval) STORED,
    status              VARCHAR(16)  NOT NULL DEFAULT '已排课'
                        CHECK (status IN ('已排课','已完成','已取消','缺席')),
    source              VARCHAR(24)  NOT NULL DEFAULT 'one_off'
                        CHECK (source IN ('one_off','recurring_expansion')),
    recurring_schedule_id VARCHAR(32),                                  -- 周期模板 FK（V8.1）
    created_by_user_id  VARCHAR(32)  NOT NULL REFERENCES users(id),
    created_by_role     VARCHAR(24)  NOT NULL,                          -- 审计（teacher/sales）
    notes               TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_schedules_teacher_time ON schedules(teacher_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_schedules_course       ON schedules(course_product_id);
CREATE INDEX IF NOT EXISTS idx_schedules_status       ON schedules(status);
CREATE INDEX IF NOT EXISTS idx_schedules_recurring    ON schedules(recurring_schedule_id);

-- ----------------------------------------------------------------
-- §3.1 schedule_students — 多对多关系
-- 一节课可关联 1~N 学员（小班课 / 1对1 都用此结构）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedule_students (
    schedule_id         VARCHAR(32)  NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    student_id          VARCHAR(32)  NOT NULL REFERENCES students(id),
    attendance_status   VARCHAR(16)  NOT NULL DEFAULT '待出勤'
                        CHECK (attendance_status IN ('待出勤','出勤','迟到','缺席','请假')),
    joined_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (schedule_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_schedule_students_student ON schedule_students(student_id);
CREATE INDEX IF NOT EXISTS idx_schedule_students_attendance ON schedule_students(attendance_status);

-- 模板展开幂等键（V8.1 周期性课表）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_recurring_expansion
  ON schedules(recurring_schedule_id, start_at)
  WHERE source = 'recurring_expansion';

COMMIT;
