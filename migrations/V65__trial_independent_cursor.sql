-- ============================================================
-- V65__trial_independent_cursor.sql
-- 试听分配两线独立游标（2026-06-02 用户拍板，SSOT §5.3.2）— tenant schema
-- 占位：`__TENANT_SCHEMA__` 由 backfill 脚本 sed 替换（tenant-schema migration）
--
-- 来源：../edu-mp-sandbox/docs/SSOT-拍板权威.md §5.3.2（2026-06-02 拍板：试听与学员分配两线游标独立）
--
-- 背景：原 V64（Phase 4 试听）复用 V63 的 campus_assignment_config.rr_last_academic_id
--   作共享游标（学员/试听同一轮转指针）。2026-06-02 用户拍板改为**两线独立**：
--     学员分配走 rr_last_academic_id（V63 既有）；
--     试听分配走 **独立列 rr_last_trial_academic_id**（本迁移新增）。
--   两线各自轮转互不推进；auto_assign_academic 开关仍共享（学员/试听同一开关）。
--
-- ⚠️ 为何独立 V65 而非编辑 V64：V64 已部署生产（trials 表已建于明心租户），迁移已标记
--   applied 不会重跑 —— 若把加列写进 V64 则生产永不执行 → trial-assignment.service 查不到
--   rr_last_trial_academic_id 列 → runtime 报错。独立 V65（从未 applied）下次部署必跑，
--   对「V64 已跑」「V64 未跑（新租户）」两种状态都正确（IF NOT EXISTS 幂等）。
--
-- 幂等：ADD COLUMN IF NOT EXISTS（重跑无害；新租户 V64 后本迁移加列，列已存在则 no-op）。
-- 可逆（回退）：ALTER TABLE __TENANT_SCHEMA__.campus_assignment_config DROP COLUMN IF EXISTS rr_last_trial_academic_id;
-- OWNER：campus_assignment_config 由 V63 ALTER OWNER eduapp，新列继承表 owner，无需重设。
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- 试听 round-robin 独立游标列（与学员分配 rr_last_academic_id 独立）
ALTER TABLE campus_assignment_config
  ADD COLUMN IF NOT EXISTS rr_last_trial_academic_id VARCHAR(32);

COMMENT ON COLUMN campus_assignment_config.rr_last_trial_academic_id IS
  'V65 (Phase 4) 试听 round-robin 独立游标（上次发到的 academic.id；NULL=从头）；与学员分配 rr_last_academic_id 独立，2026-06-02 拍板两线独立';

COMMIT;
