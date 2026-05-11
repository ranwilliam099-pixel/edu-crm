-- ============================================================
-- V36__monthly_reports_audience_columns.sql
-- 在 __TENANT_SCHEMA__ 内：
--   monthly_reports 加 5 列承载 parent 版双轨数据（家长侧 vs 老师/内部侧）
--
-- 占位：__TENANT_SCHEMA__ 由租户初始化 worker 或 backfill-v36.sh 替换
--
-- 来源：
--   - main session 5/11 拍板「方案 B」：加 5 列复用同一行（不加 audience 字段、
--     不动 UNIQUE 约束、不破坏 ON CONFLICT）
--   - feedback_教培业务架构-2026-05-10.md 全局规则 #3 双轨数据
--     （老师可美化展示数据 → 家长看的，但系统真实数据另存 → KPI / 续报建议用）
--   - 前端 5/11 commit 3c7693f 已按 parentBlessing / parentHighlights 字段命名提交
--     c/monthly-report/detail 页 → 后端 V36 完全 0 阻抗对接
--
-- 业务隔离硬红线（应用层必须遵守）：
--   - teacher_blessing / renewal_suggestion = 老师内部 / KPI 视角
--     → 仅 teacher / academic / boss / admin 视角可见
--     → audience='parent' 路径 SELECT **绝不** 暴露 renewal_suggestion
--   - parent_blessing / parent_highlights / parent_improvements / parent_next_plan
--     = 家长可见的"温柔版"评语（不含续报话术 + 不含 KPI 数据）
--     → parent role JWT 强制 audience='parent'，自动遮蔽 renewal_suggestion
--   - parent_finalized_at NULL = 家长版尚未填写（前端 fallback 用 teacher 版基础字段 + 隐藏建议）
--
-- 方案 B 完胜理由：
--   ✅ 完全幂等 ADD COLUMN IF NOT EXISTS（重跑安全）
--   ✅ UNIQUE (student_id, month) 不动 → ON CONFLICT 写入路径保留
--   ✅ existing 64 tenants 数据 0 迁移
--   ✅ SQL 层天然隔离: parent endpoint 永不 SELECT renewal_suggestion 列
--   ✅ 前端 detail.js 已按 parentBlessing/parentHighlights 命名 = 0 阻抗对接
--
-- W3 红线：BEGIN / SET LOCAL search_path / COMMIT 完整事务
-- W4 红线：ADD COLUMN 可逆操作（NULL 列）— 回滚 SQL 在文件末尾
--          backfill-v36.sh 仍按规范走 pg_dump 备份探测（保持运维基线一致）
--
-- 出具：研发负责人  2026-05-11
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §36.1 ADD 5 columns to monthly_reports（V9 现有表）
--
-- 现有 V9 字段保留不变：
--   id / student_id / teacher_id / month / attendance_summary /
--   performance_trend / knowledge_summary / teacher_blessing /
--   renewal_suggestion / status / generated_at / finalized_at / parent_read_at
--   UNIQUE (student_id, month) 不动
-- ----------------------------------------------------------------

ALTER TABLE monthly_reports
  ADD COLUMN IF NOT EXISTS parent_blessing       TEXT,
  ADD COLUMN IF NOT EXISTS parent_highlights     JSONB,
  ADD COLUMN IF NOT EXISTS parent_improvements   JSONB,
  ADD COLUMN IF NOT EXISTS parent_next_plan      TEXT,
  ADD COLUMN IF NOT EXISTS parent_finalized_at   TIMESTAMPTZ;

-- ----------------------------------------------------------------
-- §36.2 索引：找到 "teacher 已 finalize 但 parent 版还没写" 的待办
--
-- 用途：home-teacher / home-academic 待办面板：列出该老师/校长当月需要
--   给家长版补充评语的报告（teacher 视角已 final，但 parent 版未生成）
-- ----------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_mr_parent_pending
    ON monthly_reports(student_id, month DESC)
    WHERE parent_finalized_at IS NULL AND status = 'teacher_finalized';

-- ----------------------------------------------------------------
-- §36.3 注释 — 强调双轨 audience 隔离边界
--
-- 注：comment 重复对 teacher_blessing / renewal_suggestion 也加（V9 没明确说明
-- audience 隔离），帮助新人 onboarding 时一眼看清规则
-- ----------------------------------------------------------------

COMMENT ON COLUMN monthly_reports.teacher_blessing IS
  'V9 teacher/admin/boss 视角的寄语 — 老师补寄语（finalize 时填）。' ||
  '⚠️ 双轨硬红线: parent audience 路径 SELECT 不暴露此字段（前端 c 端走 parent_blessing 渲染）';

COMMENT ON COLUMN monthly_reports.renewal_suggestion IS
  'V9 老师/内部续报建议 — 严禁暴露给家长 c 端。' ||
  '⚠️ 双轨硬红线: parent role JWT 强制 audience=parent，SQL 不返回此列';

COMMENT ON COLUMN monthly_reports.parent_blessing IS
  'V36 家长版"温柔"寄语 — c 端 c/monthly-report/detail 显示。' ||
  '老师可基于 teacher_blessing 改写为家长可读版本（不含 KPI 数据 / 续报话术）';

COMMENT ON COLUMN monthly_reports.parent_highlights IS
  'V36 家长版进步亮点 [{ point: string, lessonCount?: number }, ...] — c 端只读列表渲染。' ||
  '与 teacher 内部 knowledge_summary 隔离，已按家长可读语言加工';

COMMENT ON COLUMN monthly_reports.parent_improvements IS
  'V36 家长版待改进 [{ point: string, suggestion?: string }, ...] — c 端只读列表渲染。' ||
  '注：避免出现 KPI / 排名 / 工资等敏感词，仅含建设性指导';

COMMENT ON COLUMN monthly_reports.parent_next_plan IS
  'V36 家长版下月计划 — c 端可读总览。' ||
  '⚠️ 与 renewal_suggestion 严格隔离：本字段是学习计划而非续报营销';

COMMENT ON COLUMN monthly_reports.parent_finalized_at IS
  'V36 家长版 finalize 时间 — NULL 表示家长版尚未补写（前端 fallback 用基础字段）。' ||
  '查询条件: parent_finalized_at IS NOT NULL → 家长版可见';

COMMIT;

-- ============================================================
-- 回滚（ADD COLUMN 可逆 — 直接 DROP 5 列 + DROP 索引）：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   DROP INDEX IF EXISTS idx_mr_parent_pending;
--   ALTER TABLE monthly_reports
--     DROP COLUMN IF EXISTS parent_blessing,
--     DROP COLUMN IF EXISTS parent_highlights,
--     DROP COLUMN IF EXISTS parent_improvements,
--     DROP COLUMN IF EXISTS parent_next_plan,
--     DROP COLUMN IF EXISTS parent_finalized_at;
--   COMMIT;
-- ============================================================

-- ============================================================
-- 后续步骤（不在本 migration）：
--   1. MonthlyReportRepository:
--      - findById(tenantSchema, id, audience) → audience='parent' 时不 SELECT renewal_suggestion
--      - finalizeTeacher() / finalizeParent() 两方法（前者写老师 4 字段，后者写 parent 5 字段）
--      - mapRow(row, audience) → audience='parent' 屏蔽 renewal_suggestion
--   2. MonthlyReportService:
--      - finalizeParentInDb(id, parentExtras, tenantSchema)
--      - findInDb(id, tenantSchema, audience)
--      - listByStudentInDb(studentId, tenantSchema, audience)
--   3. FeedbackController:
--      - 新 POST /db/monthly-reports/:id/finalize-parent
--      - POST /db/monthly-reports/:id/find body 加 audience?: 'teacher'|'parent'
--      - parent role JWT 强制 audience='parent'（自动遮蔽不 throw）
--   4. audit_log 接入：
--      - action='monthly-report.finalize-teacher' / 'monthly-report.finalize-parent'
--   5. tenant-provision TENANT_MIGRATIONS 加 V36（新租户 schema 自动建 5 列）
-- ============================================================
