-- ============================================================
-- V57__parent_communication.sql
-- 家长咨询表 — 2026-05-22 SSOT §3.4 拍板（Sprint Y P2 unreadConsultations 数据源）
--
-- 业务规则：
--   - 家长通过 C 端发起咨询（默认未读 read_at IS NULL）
--   - 教务收到咨询后回复 → replied_at 填值
--   - 教务点击「已读」→ read_at 填值（即便未回复）
--   - 老师也可发起反馈/通知 (sender_role='teacher')
--
-- KPI 数据源：
--   GET /db/kpi/academic-home unreadConsultations.count
--     = COUNT(*) WHERE campus_id=本校 AND sender_role='parent' AND read_at IS NULL
--
-- 跨租户：parent_id 关联 public.parents.id（不加 FK，跨 schema 限制）
--
-- 占位：__TENANT_SCHEMA__ 由 scripts/backfill-v57.sh sed 替换
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- parent_communication — 家长 ↔ 机构 沟通记录
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parent_communication (
  id                  VARCHAR(32)  PRIMARY KEY,
  parent_id           VARCHAR(32)  NOT NULL,                  -- public.parents.id (跨 schema 不加 FK)
  student_id          VARCHAR(32)  NULL REFERENCES students(id),  -- 可空 (学员未绑定时也能咨询)
  campus_id           VARCHAR(32)  NOT NULL,                  -- KPI 按校区聚合 (academic 本校 scope)
  academic_user_id    VARCHAR(32)  NULL REFERENCES users(id), -- 接待教务 (路由后填; 派单系统未起前 NULL)
  sender_role         VARCHAR(16)  NOT NULL
                      CHECK (sender_role IN ('parent', 'academic', 'teacher')),
  message_type        VARCHAR(24)  NOT NULL DEFAULT 'consultation'
                      CHECK (message_type IN ('consultation', 'feedback', 'inquiry')),
  content             TEXT         NOT NULL,                  -- 前端 msgSecCheck 过 wx.security
  attachments         JSONB        NULL,                      -- 图片 url 数组 (imgSecCheck 过滤)
  read_at             TIMESTAMPTZ  NULL,                      -- 教务点击「已读」时间
  replied_at          TIMESTAMPTZ  NULL,                      -- 教务回复时间
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 索引：KPI unreadConsultations 查询 (campus 本校 + 未读 + 家长来源)
CREATE INDEX IF NOT EXISTS idx_parent_comm_campus_unread
  ON parent_communication (campus_id, read_at)
  WHERE read_at IS NULL AND sender_role = 'parent';

-- 索引：academic 个人未读 (派单后 academic_user_id 不为空)
CREATE INDEX IF NOT EXISTS idx_parent_comm_academic_unread
  ON parent_communication (academic_user_id, read_at)
  WHERE read_at IS NULL;

-- 索引：parent_id 倒序 (家长端 C 端查自己历史)
CREATE INDEX IF NOT EXISTS idx_parent_comm_parent
  ON parent_communication (parent_id, created_at DESC);

-- 索引：student_id (学员维度 OOUX 子资源)
CREATE INDEX IF NOT EXISTS idx_parent_comm_student
  ON parent_communication (student_id, created_at DESC)
  WHERE student_id IS NOT NULL;

COMMENT ON TABLE parent_communication IS
  'V57 (2026-05-22 SSOT §3.4) 家长咨询/反馈 — KPI unreadConsultations 数据源 / C 端家长可查自己的';

-- V56 教训: 表 owner 必须是 eduapp, 否则应用层 permission denied + fail-open 兜不住数据
ALTER TABLE parent_communication OWNER TO eduapp;

COMMIT;
