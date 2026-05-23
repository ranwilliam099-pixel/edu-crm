-- ============================================================
-- V60__assessment_recipients_in_tenant_schema.sql
-- 在 __TENANT_SCHEMA__ 内新增「测评接收方」(2026-05-23 task #33)
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
--
-- 来源：
--   - 5/22 真机验证发现 V14 assessment 缺 recipients 表
--   - record 页只能列已录学员 (student_assessment_results), 未录学员清单无数据源
--   - 类比 V13 homework_assignments → assignment_recipients 设计模式
--
-- 业务流：
--   1. 老师创建 assessment (assessments INSERT) — 业务起点
--   2. 老师指定接收学员 (assessment_recipients fan-out)
--      - 默认: 老师主带学员 (student_teacher_bindings.status='active')
--      - 可选: 手动覆盖 (跨绑定测评)
--   3. 老师录分 (student_assessment_results UPSERT)
--   4. 录分完成 = recipients 都有对应 result
--
-- record 页能力升级:
--   - 之前: 仅列 student_assessment_results (已录)
--   - 现在: 列 assessment_recipients (全员) merge results (区分已录/未录)
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

CREATE TABLE IF NOT EXISTS assessment_recipients (
    assessment_id   VARCHAR(32)  NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    student_id      VARCHAR(32)  NOT NULL REFERENCES students(id),
    PRIMARY KEY (assessment_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_ar_assessment_student ON assessment_recipients(student_id);

COMMENT ON TABLE assessment_recipients IS 'V60 测评接收方 — task #33 (类比 V13 assignment_recipients)';

COMMIT;
