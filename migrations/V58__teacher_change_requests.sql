-- ============================================================
-- V58__teacher_change_requests.sql
-- 老师变更请求 — 2026-05-22 SSOT §6.5 拍板「改老师 = 家长同意」
--
-- 业务规则（SSOT §6.5）:
--   1. 教务发起变更请求 → INSERT status='pending'
--   2. 推送家长 C 端
--   3. 家长 C 端「同意 / 拒绝」→ UPDATE status='approved'/'rejected' + parent_decided_at
--   4. approved → 同事务 UPDATE students.assigned_teacher_id + schedules.teacher_id
--      (只改未来 未 attended 的 schedule rows / 历史 attended 保留原老师)
--   5. audit_log 留痕 3 个事件: change-requested-by-academic / approved-by-parent / rejected-by-parent
--
-- 唯一约束: 一个学员同时只能有 1 个 pending 变更请求 (避免并发冲突)
--
-- 占位: __TENANT_SCHEMA__ 由 scripts/backfill-v58.sh sed 替换
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- teacher_change_requests — 老师变更请求
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teacher_change_requests (
  id                       VARCHAR(32)  PRIMARY KEY,
  student_id               VARCHAR(32)  NOT NULL REFERENCES students(id),
  from_teacher_id          VARCHAR(32)  NOT NULL REFERENCES teachers(id),
  to_teacher_id            VARCHAR(32)  NOT NULL REFERENCES teachers(id),
  requested_by_user_id     VARCHAR(32)  NOT NULL REFERENCES users(id),  -- 教务发起
  reason                   TEXT         NULL,                            -- 申请原因 (可选)
  parent_id                VARCHAR(32)  NOT NULL,                        -- public.parents.id (跨 schema 不加 FK)
  campus_id                VARCHAR(32)  NOT NULL,                        -- 按校区聚合 (academic 本校 scope)
  status                   VARCHAR(16)  NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  parent_decided_at        TIMESTAMPTZ  NULL,                            -- 家长决定时间
  parent_reject_reason     TEXT         NULL,                            -- 家长拒绝原因
  applied_at               TIMESTAMPTZ  NULL,                            -- approved 后 update student+schedules 时间
  schedules_updated_count  INTEGER      NULL,                            -- approved 时 update 的 schedule 行数 (审计参考)
  requested_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- from ≠ to 校验 (业务硬约束 / 不允许同老师变更)
  CONSTRAINT teacher_change_distinct CHECK (from_teacher_id <> to_teacher_id)
);

-- 唯一: 一个学员同时只能有 1 个 pending 请求 (避免并发冲突)
-- partial unique index 跨 status 重复 INSERT 时只限 pending 行
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tcr_student_pending
  ON teacher_change_requests (student_id)
  WHERE status = 'pending';

-- 家长 C 端查询：自己待决定的请求
CREATE INDEX IF NOT EXISTS idx_tcr_parent_pending
  ON teacher_change_requests (parent_id, status, requested_at DESC);

-- 教务工作台：本校 pending 列表
CREATE INDEX IF NOT EXISTS idx_tcr_campus_status
  ON teacher_change_requests (campus_id, status, requested_at DESC);

-- 老师维度：from_teacher_id 历史变更（老师档案页可查）
CREATE INDEX IF NOT EXISTS idx_tcr_from_teacher
  ON teacher_change_requests (from_teacher_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_tcr_to_teacher
  ON teacher_change_requests (to_teacher_id, requested_at DESC);

COMMENT ON TABLE teacher_change_requests IS
  'V58 (2026-05-22 SSOT §6.5) 老师变更请求 — 教务发起 → 家长 C 端同意 → 自动 UPDATE student.assigned_teacher_id + 未来 schedules.teacher_id';

-- V56 教训: ALTER OWNER TO eduapp 让应用层有权限 query (避免 permission denied)
ALTER TABLE teacher_change_requests OWNER TO eduapp;

COMMIT;
