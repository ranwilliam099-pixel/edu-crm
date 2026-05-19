-- ============================================================
-- V44__add_deleted_at_to_students_teachers_users.sql
-- T12 软删除 — 补齐 students / teachers / users 三表
-- 复用既有 deleted_at 命名（与 customers/contracts/payments V2 一致）
-- 占位 __TENANT_SCHEMA__ 由 backfill 脚本 sed 替换（V35-V42 同模式）
--
-- 来源：R1 audit P0-3 / doc-code-drift CI R2 实测
-- 不在本 migration：状态机迁移 / 90 天 cron / status→deleted_at 同步
-- ============================================================

BEGIN;
SET LOCAL search_path = __TENANT_SCHEMA__, public;

ALTER TABLE students  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;
ALTER TABLE teachers  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_students_deleted_at ON students(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teachers_deleted_at ON teachers(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_deleted_at    ON users(deleted_at)    WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN students.deleted_at IS 'V44 软删除时间戳，NULL=active；状态机走业务字段';
COMMENT ON COLUMN teachers.deleted_at IS 'V44 软删除时间戳，与 status=归档 互补（归档 90 天 → deleted_at）';
COMMENT ON COLUMN users.deleted_at    IS 'V44 软删除时间戳，与 status=停用 互补（停用 90 天 → deleted_at）';

COMMIT;

-- 回滚：DROP INDEX + DROP COLUMN（参考脚本）
