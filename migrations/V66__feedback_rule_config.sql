-- ============================================================
-- V66__feedback_rule_config.sql
-- 反馈提醒规则配置（Phase 5，2026-06-01 用户拍板走查 #7b）— tenant schema
-- 占位：`__TENANT_SCHEMA__` 由 backfill 脚本 sed 替换（tenant-schema migration）
--
-- 来源：../edu-mp-sandbox/docs/SSOT-拍板权威.md §5.3.3（V66 Phase 5 反馈规则 + 教务反馈页）
--
-- 业务（业务链末段）：
--   校长（boss）配「反馈提醒规则」两维度（reminder_days 时间 / every_n_lessons 次数，OR 任一命中）：
--     → 系统按规则算「每个教务名下」（students.assigned_academic_id=该教务，承接 §5.3.1）待反馈学员
--     → 进教务反馈页（待办列表，只读监控；§6「教务全只读老师线」红线不变 —— 教务不写 lesson_feedback）。
--   - reminder_days  (int, NULL=不启用)：距该学员最后一次 lesson_feedback（MAX(submitted_at)）超过 N 天命中；
--       从未反馈 → 以首次消课 MIN(course_consumptions.created_at) 为基准算天数；无消课无反馈 → 不命中（未开课不催）。
--   - every_n_lessons(int, NULL=不启用)：该学员自上次反馈后消课数（COUNT(consumption WHERE created_at > 上次 submitted_at）≥ N 命中；
--       从未反馈则全部消课计数。
--   - 各维度可单开/双开/全关（全关=无待办，空列表）。
--
-- 表 feedback_rule_config（per campus；仿 campus_assignment_config V63 形态，独立新表不复用）：
--   campus_id        PRIMARY KEY（public.campuses.id；跨 schema 不加硬 FK，与 V63 campus_assignment_config 同风格）
--   reminder_days    INT NULL（时间维度阈值；NULL = 不启用此维度）
--   every_n_lessons  INT NULL（次数维度阈值；NULL = 不启用此维度）
--   updated_by       VARCHAR(32)（最近改规则的 user.id；审计辅助，权威审计在 audit_log V33 = 'feedback-rule.set'）
--   updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
--
-- ⚠️ 为何独立 V66 而非编辑已部署旧迁移：本迁移从未 applied，下次部署必跑（正确）。
--   禁止把此表/列加进已部署的旧迁移（V64 trials 表已建于生产）—— 已 applied 迁移不会重跑，
--   生产将永不执行（与 V65 同教训）。独立新表 CREATE TABLE IF NOT EXISTS 对全/未跑两态都幂等。
--
-- 幂等：CREATE TABLE IF NOT EXISTS（重跑无害；无数据 backfill —— 无行 = 规则全关，调用方兜默认 null/null）。
-- 可逆（回退）：DROP TABLE IF EXISTS __TENANT_SCHEMA__.feedback_rule_config;
-- GRANT：新表须 ALTER OWNER TO eduapp（V56 教训：否则应用层 query permission denied）。
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

CREATE TABLE IF NOT EXISTS feedback_rule_config (
  campus_id        VARCHAR(32)  PRIMARY KEY,        -- public.campuses.id（跨 schema 不加硬 FK）
  reminder_days    INT,                             -- 时间维度阈值（NULL=不启用）
  every_n_lessons  INT,                             -- 次数维度阈值（NULL=不启用）
  updated_by       VARCHAR(32),                     -- 最近改规则的 user.id（审计辅助）
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE feedback_rule_config IS
  'V66 (Phase 5) 反馈提醒规则配置（per campus）— reminder_days 时间维度 / every_n_lessons 次数维度，OR 任一命中；NULL=该维度不启用；权威审计在 audit_log = feedback-rule.set';
COMMENT ON COLUMN feedback_rule_config.reminder_days IS
  'V66 时间维度：距学员最后一次 lesson_feedback 超过 N 天命中（从未反馈以首次消课为基准）；NULL=不启用';
COMMENT ON COLUMN feedback_rule_config.every_n_lessons IS
  'V66 次数维度：学员自上次反馈后消课数 ≥ N 命中（从未反馈则全部消课计数）；NULL=不启用';

-- V56 教训：ALTER OWNER TO eduapp 让应用层有权限 query（避免 permission denied）
ALTER TABLE feedback_rule_config OWNER TO eduapp;

COMMIT;
