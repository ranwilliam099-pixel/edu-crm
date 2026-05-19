-- ============================================================
-- V51 — audit_log.actor_user_id + target_id: UUID → VARCHAR(32)
-- ============================================================
-- 触发 (5/20 leader 自补)：L2 monthly-report integration spec 暴露 V33 audit_log
-- 字段类型与应用传值不匹配 — actor_user_id + target_id 定义 UUID 但应用传 32-char ULID。
--
-- 影响：64 tenant 生产 audit_log 抽查全 0 行 — fail-open 兜底导致 5/10 V33 P0 audit_log
-- 上线后从未真正写入过一条业务日志。Memory 已记录该 silent fail（"V33 audit_log 5/10 P0
-- deploy 实际 0/64 silent fail"）但根因未查。本次定位 + 修复。
--
-- 修复策略：
--   - actor_user_id: UUID → VARCHAR(32) （配 tenant_xxx.users.id VARCHAR(32) ULID）
--   - target_id:     UUID → VARCHAR(32) （配 tenant_xxx 业务表 ULID）
--   - 现存数据：0 行，无需 backfill 内容（仅 DDL 改类型）
--   - 索引：partial index WHERE 子句保留（类型变换自动适配）
--
-- 不可逆性：UUID 列空表无数据，理论上 ALTER 安全。即便后续回滚也不影响业务。
-- ============================================================
BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- 1. 类型变换：UUID → VARCHAR(32)
ALTER TABLE audit_log
    ALTER COLUMN actor_user_id TYPE VARCHAR(32) USING actor_user_id::text;

ALTER TABLE audit_log
    ALTER COLUMN target_id TYPE VARCHAR(32) USING target_id::text;

-- 2. COMMENT 更新（UUID 字样改 ULID）
COMMENT ON COLUMN audit_log.actor_user_id IS '操作人 user.id (32-char ULID)；NULL 表示系统动作 (cron/migration)，actor_role=''system''';
COMMENT ON COLUMN audit_log.target_id     IS '目标对象 id (32-char ULID)';

COMMIT;

-- ============================================================
-- 回滚（开发参考，不写代码）：
--   ALTER TABLE audit_log ALTER COLUMN actor_user_id TYPE UUID USING actor_user_id::uuid;
--   ALTER TABLE audit_log ALTER COLUMN target_id     TYPE UUID USING target_id::uuid;
--   （只能在表为空时回滚；有 ULID 行则 ::uuid cast 失败）
-- ============================================================
