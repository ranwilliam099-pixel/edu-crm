-- ============================================================
-- V16__leaves_in_tenant_schema.sql
-- 在 __TENANT_SCHEMA__ 内新增"请假/调课申请"表
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
-- 依据：用户 2026-05-04 9 个待实现 endpoint #1（pages/c/leave/apply 提交请假/调课申请）
-- 出具：开发总监 / 研发负责人  2026-05-04
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §16.1 leaves — 请假 / 调课申请
-- 业务规则：距上课 < 24h 提交时仍接受 status=pending，但 controller 返回 warning
--   - type='leave'      → 请假（不补课）
--   - type='reschedule' → 调课（带 new_date / new_start_at 请求改期）
-- 状态流转：pending → approved | rejected
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leaves (
    id              VARCHAR(32)   PRIMARY KEY,
    student_id      VARCHAR(32)   NOT NULL REFERENCES students(id),
    lesson_id       VARCHAR(32)   REFERENCES schedules(id),                -- 关联课次（schedules.id）
    type            VARCHAR(16)   NOT NULL
                    CHECK (type IN ('leave','reschedule')),
    reason          VARCHAR(64),                                            -- 简要类别（如"生病"/"家事"）
    reason_note     TEXT,                                                   -- 详细备注
    new_date        DATE,                                                   -- type='reschedule' 时填
    new_start_at    TIMESTAMPTZ,                                            -- type='reschedule' 时填
    status          VARCHAR(16)   NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
    reject_reason   TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    decided_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_leaves_student_time ON leaves(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leaves_status       ON leaves(status);
CREATE INDEX IF NOT EXISTS idx_leaves_lesson       ON leaves(lesson_id);

COMMENT ON TABLE  leaves IS '请假/调课申请。距上课 < 24h 提交时 controller 在 response 加 warning';

COMMIT;
