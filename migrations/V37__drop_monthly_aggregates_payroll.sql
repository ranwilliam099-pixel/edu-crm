-- ============================================================
-- V37__drop_monthly_aggregates_payroll.sql
-- 在 __TENANT_SCHEMA__ 内：
--   删除 monthly_aggregates.payroll_yuan 列（薪资业务全面下线）
--
-- 占位：__TENANT_SCHEMA__ 由 backfill-v37.sh 替换
--
-- 依据：
--   - docs/fields-by-role.md  字段矩阵：薪资字段全部下线
--   - feedback_教培业务架构-2026-05-10.md 拍板 §4：「薪资全删」
--     （含 showcase 字段 + leaderboard sortBy）
--   - 老板/校长/老师/家长/财务 home 均不显示工资 → 数据库不留入口
--
-- 业务影响：
--   - dashboard.getTeacherLeaderboard.trend 块（V24 monthly_aggregates 上月对比）
--     失去 payroll_yuan 来源 → 同步在 V37 commit 内移除 trend try/catch
--     （Option A：drop trend，理由：cron 未实现 monthly_aggregates 写入，trend 实际一直返 'flat'）
--   - 其他指标列（lessons_count / feedback_count / feedback_rate / avg_stars
--     / revenue_yuan / new_signups / active_students）保留
--   - 通用索引 idx_ma_entity_month / idx_ma_month 不受影响
--
-- W3 红线：BEGIN / SET LOCAL search_path / COMMIT 完整事务
-- W4 红线：回滚 SQL 仅恢复列结构，不恢复数值
--          数值需从 pre-DROP pg_dump 还原（备份策略：scripts/backfill-v37.sh 前置探测）
--
-- 出具：研发负责人  2026-05-11
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- 主操作：删除 payroll_yuan 列（幂等，IF EXISTS 防重跑报错）
ALTER TABLE monthly_aggregates
    DROP COLUMN IF EXISTS payroll_yuan;

COMMIT;

-- ============================================================
-- 回滚（仅恢复列结构，**不恢复数值**）：
--
--   ⚠️ 重要：本 migration 是不可逆数据删除。
--   - 恢复列定义可用如下 SQL（数值字段恢复为 NULL）
--   - 历史 payroll_yuan 数值**必须**从 pre-DROP pg_dump 备份还原
--     恢复脚本（人工触发）：
--       1. 从 COS 拉 V37 部署前最近一次 pg_dump 备份
--       2. pg_restore --table=monthly_aggregates --data-only 到临时表
--       3. UPDATE monthly_aggregates ma
--          SET payroll_yuan = tmp.payroll_yuan
--          FROM tmp_ma_restore tmp
--          WHERE ma.entity_type = tmp.entity_type
--            AND ma.entity_id   = tmp.entity_id
--            AND ma.month       = tmp.month;
--
--   仅恢复列结构（不含数据）：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   ALTER TABLE monthly_aggregates
--       ADD COLUMN IF NOT EXISTS payroll_yuan NUMERIC(12,2);
--   COMMIT;
-- ============================================================
