-- ============================================================
-- V67__parent_communications.sql
-- 家长沟通记录（教务线）— parent_communications 表（tenant schema）
-- 占位：`__TENANT_SCHEMA__` 由 backfill 脚本 sed 替换（tenant-schema migration）
--
-- 来源：SSOT §5.4 parent_communication 家长沟通记录（5/16 拍板；2026-06-02 走查 B 定 spec）
--
-- 业务（教务主要写入；与老师 lesson_feedback 分开，独立对象）：
--   老师线 = 上课点评（lesson_feedback）；教务线 = 家长沟通（本表）。
--   走查 B 起因：教务在学员档案无反馈/沟通填写入口（只有老师点评区）。
--   教务记录跟家长的沟通（微信/电话/当面），含内容 + 选填后续跟进。
--
-- ⚠️ 与 V57 parent_communication（单数，家长 C 端咨询/反馈，KPI unreadConsultations 数据源）
--    是**两个独立对象**：V57 单数=家长发起的咨询（parent_id/sender_role/read_at），
--    本 V67 复数 parent_communications=教务主动记录的家长沟通（created_by 教务 / communication_date / type）。
--
-- RBAC（应用层 controller 强制；repo 不做权限只做数据）：
--   写（create POST /db/communications）           = [academic, academic_admin]
--   读（list POST /db/students/:id/communications） = [academic, academic_admin, boss, admin]
--   跨校：campus_id 取自 JWT，校验 student.campus_id（家庭主档 customers.campus_id 派生）=== caller campus。
--
-- 字段：
--   id                   VARCHAR(32) PK（genId32 = ulid().padEnd(32,'0').slice(0,32)）
--   student_id           VARCHAR(32) NOT NULL（逻辑维度；不加硬 FK，与 trials/assigned_academic_id 风格一致）
--   campus_id            VARCHAR(32) NOT NULL（反范式快照；写入时取 JWT campus，本校聚合/隔离用）
--   communication_date   DATE NOT NULL（沟通日期，前端默认今天）
--   type                 VARCHAR(16) NOT NULL CHECK (wechat|phone|in_person 微信/电话/当面)
--   content              TEXT NOT NULL（沟通内容，过 ContentModerationService.enforceStaffText）
--   follow_up            TEXT NULL（后续跟进，选填，同样过内容安全）
--   created_by           VARCHAR(32) NOT NULL（记录教务 user.id = JWT.sub）
--   created_at / updated_at TIMESTAMPTZ
--
-- index (student_id, communication_date DESC) + (campus_id)。标签暂不做（v1 精简）。
--
-- 可逆（回退）：DROP TABLE IF EXISTS __TENANT_SCHEMA__.parent_communications;
--
-- GRANT：新表须 ALTER OWNER TO eduapp（V56 教训：否则应用层 query permission denied）。
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- parent_communications — 教务家长沟通记录对象
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parent_communications (
  id                   VARCHAR(32)  PRIMARY KEY,
  student_id           VARCHAR(32)  NOT NULL,                       -- 逻辑维度（不加硬 FK，应用层校验本校）
  campus_id            VARCHAR(32)  NOT NULL,                       -- 反范式快照（写入取 JWT campus；本校聚合/隔离）
  communication_date   DATE         NOT NULL,                       -- 沟通日期（前端默认今天）
  type                 VARCHAR(16)  NOT NULL
                         CHECK (type IN ('wechat','phone','in_person')),  -- 微信/电话/当面
  content              TEXT         NOT NULL,                       -- 沟通内容（过内容安全）
  follow_up            TEXT,                                        -- 后续跟进（选填，过内容安全）
  created_by           VARCHAR(32)  NOT NULL,                       -- 记录教务 user.id（JWT.sub）
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE parent_communications IS
  'V67 (SSOT §5.4) 教务家长沟通记录 — 教务主动记录跟家长的沟通（微信/电话/当面）；与老师 lesson_feedback 分开；与 V57 parent_communication（家长 C 端咨询）是两个独立对象';

-- 学员维度倒序（学员详情「教务反馈」section 列表 + OOUX 子资源）
CREATE INDEX IF NOT EXISTS idx_parent_communications_student
  ON parent_communications (student_id, communication_date DESC);

-- 本校聚合/隔离
CREATE INDEX IF NOT EXISTS idx_parent_communications_campus
  ON parent_communications (campus_id);

-- V56 教训：ALTER OWNER TO eduapp 让应用层有权限 query（避免 permission denied）
ALTER TABLE parent_communications OWNER TO eduapp;

COMMIT;
