-- ============================================================
-- V34__sensitive_fields_encrypted.sql
-- 在 __TENANT_SCHEMA__ 内：
--   敏感字段 AES-256-GCM 加密列（生产架构 P0 第 2 项）
--
-- 占位：__TENANT_SCHEMA__ 由租户初始化 worker 替换
--
-- 依据：用户 2026-05-10 拍板
--   隐私分级一级（手机/微信号）→ 存储层加密
--   即使数据库泄露，密文也不可读
--
-- 设计：
--   1. 加 *_encrypted BYTEA 列（IV 12B + AuthTag 16B + Cipher）
--   2. 保留旧 phone/wechat VARCHAR 列做 fallback
--      → repository 改造时双写（旧+新）→ 数据迁移 → V35 删旧列
--   3. 此 migration 仅加 BYTEA 列，0 业务影响（旧代码继续读 VARCHAR）
--
-- 受影响表（本 V34 涵盖）：
--   - teachers（V7，tenant schema）：phone
--   - opportunities（V25，tenant schema）：phone, wechat
--
-- 不受影响（留待后续 V35+）：
--   - users.mobile（UNIQUE，登录查询）→ 需 hash 列方案
--   - parents.phone（public schema, UNIQUE，C 端登录）→ 同上
--
-- 出具：研发负责人  2026-05-10
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- 1. teachers 表
ALTER TABLE teachers
    ADD COLUMN IF NOT EXISTS phone_encrypted BYTEA;

COMMENT ON COLUMN teachers.phone_encrypted
    IS 'V34 AES-256-GCM 加密手机号（[IV 12B][AuthTag 16B][Cipher]）— 旧 phone 列灰度后于 V35+ 删除';

-- 2. opportunities 表（即销售客户表，V25 命名，业务上即 customers）
ALTER TABLE opportunities
    ADD COLUMN IF NOT EXISTS phone_encrypted  BYTEA,
    ADD COLUMN IF NOT EXISTS wechat_encrypted BYTEA;

COMMENT ON COLUMN opportunities.phone_encrypted
    IS 'V34 AES-256-GCM 加密客户手机号';
COMMENT ON COLUMN opportunities.wechat_encrypted
    IS 'V34 AES-256-GCM 加密微信号';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   ALTER TABLE teachers       DROP COLUMN IF EXISTS phone_encrypted;
--   ALTER TABLE opportunities  DROP COLUMN IF EXISTS phone_encrypted,
--                              DROP COLUMN IF EXISTS wechat_encrypted;
--   COMMIT;
-- ============================================================

-- ============================================================
-- 后续步骤（不在本 migration）：
--   1. .env 加 ENCRYPTION_KEY（运维用 `openssl rand -base64 32` 生成）
--   2. NestJS 注入 FieldEncryptor 全局 provider
--   3. teacher/customer.repository 改造：
--      - INSERT/UPDATE：双写 phone（明文）+ phone_encrypted（密文）
--      - SELECT：优先读 phone_encrypted 解密；fallback 读 phone
--   4. 数据迁移脚本：批量读 phone → 加密 → 写 phone_encrypted（生产 cron）
--   5. 灰度验证（双读结果一致）
--   6. V35：DROP 旧 phone / wechat 列
-- ============================================================
