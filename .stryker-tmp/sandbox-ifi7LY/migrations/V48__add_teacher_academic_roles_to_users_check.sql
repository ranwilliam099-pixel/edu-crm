-- ============================================================
-- V48__add_teacher_academic_roles_to_users_check.sql
-- Sprint X.2 round 5 (2026-05-17) — 修 users.role CHECK 缺 teacher/academic/academic_admin P0
--
-- 来源：2026-05-17 22:37 生产实战 E2E #2 发现
--   POST /api/db/users { role: 'teacher' } → 500
--   error: new row for relation "users" violates check constraint "users_role_check"
--
-- 原 V2 schema CHECK 白名单 8 role：
--   sales, sales_manager, sales_director, marketing, finance, boss, admin, hr
-- 缺失 3 个新 role：
--   teacher (Sprint X.1 老师双轨实施时加)
--   academic (5/12 Sprint B.6 教务角色)
--   academic_admin (5/12 Sprint B.6 教务主管)
--
-- 5/15 A-2 拍板删 sales_director (应用层 jwt 不发) — schema 仍保留 (audit_log 同模式)
--   兼容历史 row.role='sales_director'，新增 INSERT 由应用层 jwt 不发兜底
--
-- 占位 __TENANT_SCHEMA__ 由 backfill 脚本 sed 替换（同 V46/V47 模式）
--
-- 出具：edu-server backend  2026-05-17
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- 1. 删旧 CHECK
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

-- 2. 加新 CHECK (11 role 全集 = 旧 8 + 新 3)
--    sales_director 保留兼容历史 row (5/15 A-2 应用层删但 schema 保留)
ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role::text = ANY (ARRAY[
    'admin'::character varying,
    'boss'::character varying,
    'sales'::character varying,
    'sales_manager'::character varying,
    'sales_director'::character varying,
    'marketing'::character varying,
    'finance'::character varying,
    'hr'::character varying,
    'teacher'::character varying,
    'academic'::character varying,
    'academic_admin'::character varying
  ]::text[]));

COMMENT ON CONSTRAINT users_role_check ON users IS
  'V48 (2026-05-17): 11 role 白名单 (admin/boss/sales/sales_manager/sales_director/marketing/finance/hr/teacher/academic/academic_admin); sales_director 历史兼容应用层 jwt 不再发';

COMMIT;

-- ============================================================
-- 回滚（紧急）：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
--   ALTER TABLE users
--     ADD CONSTRAINT users_role_check CHECK (role IN (
--       'sales', 'sales_manager', 'sales_director', 'marketing',
--       'finance', 'boss', 'admin', 'hr'
--     ));
--   COMMIT;
-- ============================================================
