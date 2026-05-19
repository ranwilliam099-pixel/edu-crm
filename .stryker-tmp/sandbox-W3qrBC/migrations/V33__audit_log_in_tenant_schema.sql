-- ============================================================
-- V33__audit_log_in_tenant_schema.sql
-- 在 __TENANT_SCHEMA__ 内：
--   新建 audit_log 审计日志表（生产架构 P0 第 1 项）
--
-- 占位：__TENANT_SCHEMA__ 由租户初始化 worker 替换
--
-- 依据：用户 2026-05-10 拍板「可上架生产架构」
--   隐私分级三级机制 + 所有 sensitive 操作记审计日志 + RPO 数据安全
--
-- 设计：
--   - 每个 tenant schema 独立审计表（数据隔离 + 单租户量级低）
--   - id BIGSERIAL（教培业务量预期 1M/年级，BIGSERIAL 节省空间，无需 UUID）
--   - actor_user_id NULLABLE（系统动作 cron / migration 等无具体操作人时填 NULL，actor_role='system'）
--   - before/after JSONB（更新类操作记前后状态；create 仅 after，delete 仅 before）
--   - request_id 链路追踪用，与日志框架（pino X-Request-Id）联动
--
-- 容量预估：30 家 × 500 操作/天 = 15K/天 = 5.5M/年（单 tenant 平均 ~180K/年），不分区
--
-- 出具：研发负责人  2026-05-10
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGSERIAL PRIMARY KEY,
    actor_user_id   UUID,
    actor_role      VARCHAR(32) NOT NULL,
    action          VARCHAR(64) NOT NULL,
    target_type     VARCHAR(64) NOT NULL,
    target_id       UUID,
    before          JSONB,
    after           JSONB,
    ip              INET,
    user_agent      TEXT,
    request_id      VARCHAR(64),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT audit_log_actor_role_chk CHECK (
        actor_role IN ('admin','boss','sales','sales_manager','sales_director',
                       'academic','academic_admin','edu_admin','ops',
                       'teacher','finance','hr','parent','platform_admin','system')
    )
);

-- 时间序列查询（最近 N 条）
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
    ON audit_log (created_at DESC);

-- 某用户操作历史（actor 不为 NULL 时）
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_created
    ON audit_log (actor_user_id, created_at DESC)
    WHERE actor_user_id IS NOT NULL;

-- 某对象变更历史（OOUX：从 student/detail 看变更）
CREATE INDEX IF NOT EXISTS idx_audit_log_target_created
    ON audit_log (target_type, target_id, created_at DESC)
    WHERE target_id IS NOT NULL;

-- 某动作发生频率（监控用）
CREATE INDEX IF NOT EXISTS idx_audit_log_action_created
    ON audit_log (action, created_at DESC);

COMMENT ON TABLE  audit_log               IS 'V33 审计日志（生产架构 P0）— 所有 sensitive 写操作落库';
COMMENT ON COLUMN audit_log.actor_user_id IS '操作人 user.id；NULL 表示系统动作（cron/migration），actor_role=''system''';
COMMENT ON COLUMN audit_log.actor_role    IS '操作时角色（admin/boss/sales/academic/teacher/finance/parent/system 等）';
COMMENT ON COLUMN audit_log.action        IS '动作标识（如 student.transfer-sales / contract.activate / user.deactivate）';
COMMENT ON COLUMN audit_log.target_type   IS '目标对象类型（student/teacher/customer/contract/schedule 等）';
COMMENT ON COLUMN audit_log.target_id     IS '目标对象 id（UUID）';
COMMENT ON COLUMN audit_log.before        IS '更新前 JSON 快照（仅 update/delete 类动作）';
COMMENT ON COLUMN audit_log.after         IS '更新后 JSON 快照（仅 create/update 类动作）';
COMMENT ON COLUMN audit_log.ip            IS '操作 IP';
COMMENT ON COLUMN audit_log.user_agent    IS 'User-Agent 字符串';
COMMENT ON COLUMN audit_log.request_id    IS '链路追踪 ID（X-Request-Id），与日志框架联动';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   DROP TABLE IF EXISTS audit_log;
--   COMMIT;
-- ============================================================
