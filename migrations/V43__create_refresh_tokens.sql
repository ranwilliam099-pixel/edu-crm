-- ============================================================
-- V43__create_refresh_tokens.sql
-- T11 refreshToken endpoint 持久化层（R1 audit P0-2 修复）
--
-- 在 public.refresh_tokens 表中存所有 B 端 + C 端 refresh token 元数据
--   - token_hash BYTEA = HMAC-SHA256(raw refresh token, HASH_KEY) — 不存明文
--   - 与 V40 parent.phone_hash 同模式（HMAC 确定性哈希，等值查询）
--   - 与 V34 FieldEncryptor 复用 HASH_KEY ≠ ENCRYPTION_KEY 双钥分离原则
--
-- 为什么 public schema（不进 tenant schema）：
--   - B 端 user + C 端 parent 跨 schema actor，token 撤销是平台级安全机制
--   - 跨 tenant 单点查询效率优先（HMAC token_hash UNIQUE 点查 ~0.5ms）
--   - 与 V10 public.parents / V20 public.promotions 同模式
--
-- 不在本 migration：
--   - HASH_KEY 已生产 .env 配置（V40 已用，复用同一 key）
--   - 旧 access token 无 refresh token 配套（T11 部署后新 login 才有 refresh）
--   - cleanupExpired cron 在应用层（@Cron('0 3 * * *')）
--
-- 依据：
--   - 2026-05-16 T11 architect spec §5
--   - R1 audit P0-2: 文档 §1.4+§1.6 承诺 POST /api/auth/refresh + refresh_tokens 表 / 0 实现
--   - OAuth 2.0 RFC 6749/6819 refresh rotation 业界标准
--
-- 出具：edu-server backend  2026-05-16
-- ============================================================

BEGIN;

SET LOCAL search_path = public;

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id              CHAR(32)    PRIMARY KEY,                            -- ULID 32-char
    subject_type    VARCHAR(16) NOT NULL,                               -- 'b-user' | 'parent'
    subject_id      CHAR(32)    NOT NULL,                               -- users.id 或 parents.id（软引用，无 FK）
    tenant_id       CHAR(32),                                           -- B 端必填，C 端 NULL（见 CHECK）
    token_hash      BYTEA       NOT NULL,                               -- HMAC-SHA256(raw, HASH_KEY) 32 bytes
    jti             CHAR(26)    NOT NULL,                               -- refresh token 自身 jti（ULID 26-char）
    expires_at      TIMESTAMPTZ NOT NULL,                               -- sliding window 终点
    revoked_at      TIMESTAMPTZ,                                        -- NULL = 有效
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ,                                        -- rotation 模式下与 created_at ≈
    user_agent      TEXT,
    ip              INET,

    CONSTRAINT refresh_tokens_subject_type_chk CHECK (subject_type IN ('b-user','parent')),
    CONSTRAINT refresh_tokens_token_hash_uniq  UNIQUE (token_hash),
    CONSTRAINT refresh_tokens_jti_uniq         UNIQUE (jti),
    CONSTRAINT refresh_tokens_tenant_for_b     CHECK (
        (subject_type = 'b-user' AND tenant_id IS NOT NULL)
        OR (subject_type = 'parent' AND tenant_id IS NULL)
    )
);

-- 用户视角 partial index：仅未撤销 token（rotation 后旧 row revoked_at != NULL 占大头，
--   partial index 显著缩小索引体积 + 加快「subject 当前 active token」查询）
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_subject_active
    ON refresh_tokens (subject_type, subject_id)
    WHERE revoked_at IS NULL;

-- cleanupExpired cron 用：每日 03:00 DELETE expires_at < now - 30d
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at
    ON refresh_tokens (expires_at);

COMMENT ON TABLE refresh_tokens
    IS 'V43 T11 refresh token rotation 持久化（OAuth 2.0 RFC 6749/6819 业界标准）';
COMMENT ON COLUMN refresh_tokens.token_hash
    IS 'HMAC-SHA256(raw refresh token, HASH_KEY) — 不存明文，与 V40 parent.phone_hash 同模式';
COMMENT ON COLUMN refresh_tokens.subject_type
    IS 'b-user (B 端员工 user) | parent (C 端家长 parent) — CHECK 强制';
COMMENT ON COLUMN refresh_tokens.tenant_id
    IS 'B 端必填 / C 端 NULL — CHECK 强制（与 V10 parents 跨租户身份一致）';
COMMENT ON COLUMN refresh_tokens.revoked_at
    IS 'NULL=有效；rotation 每次 refresh 写 now()，旧 token 立刻失效（防重放）';

COMMIT;

-- ============================================================
-- 回滚（紧急时用）：
--   BEGIN;
--   DROP INDEX IF EXISTS public.idx_refresh_tokens_expires_at;
--   DROP INDEX IF EXISTS public.idx_refresh_tokens_subject_active;
--   DROP TABLE IF EXISTS public.refresh_tokens;
--   COMMIT;
-- ============================================================
