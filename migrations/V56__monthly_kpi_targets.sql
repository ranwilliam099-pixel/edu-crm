-- ============================================================
-- V56__monthly_kpi_targets.sql
-- 月度消课目标 — 2026-05-22 SSOT §6.8 拍板
--
-- 业务规则：
--   - 校长（boss）下发本校 academic / teacher 月度目标
--   - 老板（admin）跨校聚合查看（不日常下发，按 §2.10 元规则）
--   - 目标硬上限：sum(月度目标) ≤ sum(本月可消课时)
--   - 谁设定谁调整 / 线下沟通 / 不在线上做申请调整流程
--
-- KPI 4 字段中「消课目标」字段数据源此表
--   GET /api/db/kpi/teacher-home / academic-home 返 target_lessons
--   POST /api/db/kpi/set-target 校长下发
--
-- 占位：__TENANT_SCHEMA__ 由 scripts/backfill-v56.sh sed 替换
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- monthly_kpi_targets — 月度消课目标表
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monthly_kpi_targets (
  id                    VARCHAR(32)  PRIMARY KEY,
  campus_id             VARCHAR(32)  NOT NULL,
  target_role           VARCHAR(16)  NOT NULL CHECK (target_role IN ('academic', 'teacher')),
  target_user_id        VARCHAR(32)  NOT NULL,
  month                 VARCHAR(7)   NOT NULL,   -- 'YYYY-MM' 格式
  target_lessons        INTEGER      NOT NULL CHECK (target_lessons >= 0),
  set_by_boss_user_id   VARCHAR(32)  NOT NULL,   -- boss 或 admin 设定者
  note                  TEXT,                     -- 可选备注（如「本月活动促销，目标 +20%」）
  set_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 同人同月唯一（防重复下发 / 调整时 UPSERT）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_monthly_kpi_target_user_month
  ON monthly_kpi_targets (target_user_id, month);

-- 校区 + 月度查询索引（boss 查本校 / admin 跨校聚合）
CREATE INDEX IF NOT EXISTS idx_monthly_kpi_target_campus_month
  ON monthly_kpi_targets (campus_id, month);

-- 月度统计索引（KPI endpoint 按月查全 tenant）
CREATE INDEX IF NOT EXISTS idx_monthly_kpi_target_month_role
  ON monthly_kpi_targets (month, target_role);

COMMENT ON TABLE monthly_kpi_targets IS
  'V56 (2026-05-22 SSOT §6.8) 月度消课目标 — 校长下发 / 老板聚合 / 目标硬上限 sum ≤ sum(本月可消课时)';

COMMIT;
