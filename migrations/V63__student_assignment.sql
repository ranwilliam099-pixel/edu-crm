-- ============================================================
-- V63__student_assignment.sql
-- 学员→教务分配机制（Phase 3）— students.assigned_academic_id + campus_assignment_config
-- 占位：`__TENANT_SCHEMA__` 由 backfill 脚本 sed 替换（tenant-schema migration）
--
-- 来源：../edu-mp-sandbox/docs/2026-06-01-业务链方案-试听激活分配反馈.md Phase 3（需求 #8）
--
-- 业务（合同激活后触发分配教务）：
--   校长（boss）配「是否自动分配」开关（campus_assignment_config.auto_assign_academic）：
--     开 → 合同激活后 round-robin 发牌给本校在职 academic（A→B→C→A 环绕），
--          游标存 campus_assignment_config.rr_last_academic_id；
--     关 → 学员 assigned_academic_id 留 NULL → 自然进「待分配」列表（校长手动派）。
--   学员当前归属教务 = students.assigned_academic_id（NULL = 待分配）。
--
-- 1. students.assigned_academic_id（新列）
--    - VARCHAR(32) NULL，逻辑 FK → users.id（同 schema 的教务 user）
--    - 不加硬 FK：与 owner_sales_id / assigned_teacher_id 风格一致由应用层校验，
--      且离职/转移场景不希望 DB FK 阻塞（V28 既有约定）
--    - 部分索引 idx_students_assigned_academic 仅索引 assigned_academic_id IS NOT NULL 行
--      （加速「某教务名下学员」查询；待分配列表走 IS NULL 全表小量扫足够）
--
-- 2. campus_assignment_config（新表）
--    - campus_id PRIMARY KEY（public.campuses.id；跨 schema 不加硬 FK，与 V58 parent_id 同风格）
--    - auto_assign_academic BOOLEAN NOT NULL DEFAULT false（默认关 = 校长手动）
--    - rr_last_academic_id VARCHAR(32)（round-robin 游标 = 上次发到的 academic.id；NULL=从头）
--    - updated_by / updated_at（审计辅助；权威审计仍在 audit_log V33）
--
-- 幂等：
--   - ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
--   - 无数据 backfill（assigned_academic_id 全租户初始 NULL = 全部待分配，符合语义；
--     存量学员是否补分配交由校长开开关后新激活触发 / 手动分，不在 migration 强行回填）
--
-- 可逆（回退）：
--   ALTER TABLE __TENANT_SCHEMA__.students DROP COLUMN IF EXISTS assigned_academic_id;
--   DROP TABLE IF EXISTS __TENANT_SCHEMA__.campus_assignment_config;
--
-- GRANT：新表须 ALTER OWNER TO eduapp（V56 教训：否则应用层 query permission denied）。
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- 1. students.assigned_academic_id — 学员当前归属教务
-- ----------------------------------------------------------------
ALTER TABLE students ADD COLUMN IF NOT EXISTS assigned_academic_id VARCHAR(32);

COMMENT ON COLUMN students.assigned_academic_id IS
  'V63 学员归属教务（逻辑 FK → users.id）；NULL = 待分配（自然进校长待分配列表）。激活后 round-robin 或校长手动赋值';

-- 部分索引：仅索引已分配行，加速「某教务名下学员」查询；
--   待分配列表（IS NULL）量小，全表扫足够，不进部分索引（条件相反）
CREATE INDEX IF NOT EXISTS idx_students_assigned_academic
  ON students (assigned_academic_id)
  WHERE assigned_academic_id IS NOT NULL;

-- ----------------------------------------------------------------
-- 2. campus_assignment_config — 校长「是否自动分配」开关 + round-robin 游标
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campus_assignment_config (
  campus_id             VARCHAR(32)  PRIMARY KEY,          -- public.campuses.id（跨 schema 不加硬 FK）
  auto_assign_academic  BOOLEAN      NOT NULL DEFAULT false, -- 默认关 = 校长手动分配
  rr_last_academic_id   VARCHAR(32),                        -- round-robin 游标（上次发到的 academic.id；NULL=从头）
  updated_by            VARCHAR(32),                        -- 最近一次改配置的 user.id（审计辅助）
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE campus_assignment_config IS
  'V63 (Phase 3) 校区学员分配配置 — auto_assign_academic 开关 + rr_last_academic_id round-robin 游标；权威审计在 audit_log';

-- V56 教训：ALTER OWNER TO eduapp 让应用层有权限 query（避免 permission denied）
ALTER TABLE campus_assignment_config OWNER TO eduapp;

COMMIT;
