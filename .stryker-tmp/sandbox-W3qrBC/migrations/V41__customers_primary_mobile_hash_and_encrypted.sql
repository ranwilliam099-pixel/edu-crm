-- ============================================================
-- V41__customers_primary_mobile_hash_and_encrypted.sql
-- A02-4 customers.primary_mobile 加密（个保法红线 + Sprint E backlog #14）
--
-- 在 __TENANT_SCHEMA__.customers 加两列：
--   1. primary_mobile_hash       BYTEA  — HMAC-SHA256(primary_mobile, HASH_KEY) 32 字节
--                                        用途：UNIQUE 等值查询（学员导入查重防重复客户）
--                                        替代旧 `WHERE primary_mobile = $1` 明文查询
--   2. primary_mobile_encrypted  BYTEA  — AES-256-GCM(primary_mobile, ENCRYPTION_KEY)
--                                        用途：解密后回填 Customer.primaryMobile 给业务用
--                                        格式：[IV 12B][AuthTag 16B][Cipher NB]
--
-- 与 V40（parents.phone）的关键区别：
--   - parents 在 public schema 跨租户共享；customers 在 __TENANT_SCHEMA__ 租户私有
--   - V40 单表 N 行 backfill；V41 需 64 tenants × N 循环 backfill
--   - 占位符 __TENANT_SCHEMA__ 由 backfill 脚本 sed 替换（参考 V34/V35/V36/V37/V39 模式）
--   - 单一 HASH_KEY + ENCRYPTION_KEY，跨租户复用（与 parents 同 key，应用层无 tenant 盐）
--
-- 为什么需要 hash 列（而 V34 opportunities.phone 不需要）：
--   - customers.primary_mobile 有 UNIQUE 约束 + 查重业务（student-import 防重复客户）
--   - AES-GCM 随机 IV 每次加密结果不同 → 不能等值查询 / 不能 UNIQUE 索引
--   - 必须用确定性 hash（HMAC）做等值索引
--   - opportunities.phone 无 UNIQUE 无等值查询 → 只需 encrypted 列即可
--
-- 密钥分离（同 V40）：
--   - HASH_KEY 独立于 ENCRYPTION_KEY，process.env 单独配置
--   - HASH_KEY 泄露 → 攻击者可枚举手机号但无法解密 encrypted 列
--   - ENCRYPTION_KEY 泄露 → 攻击者可解密但无法影响 hash 查询完整性
--
-- 不在本 migration（两阶段 deploy）：
--   - 旧 primary_mobile VARCHAR(16) NOT NULL UNIQUE 列保留（兼容期）；V42+ 单独 DROP
--   - 旧数据 backfill：scripts/backfill-v41-customers-mobile.sh（外层 bash 循环 tenants）
--   - primary_mobile_hash 加 UNIQUE 约束：backfill 完成后 V42 加（防 NULL 干扰）
--
-- 依据：
--   - 用户 2026-05-10 拍板 P0 第 2 项「敏感字段存储层加密」
--   - V40 模板延续（A02-3 parent.phone 已合并 origin/main 0ca1485）
--   - 中华人民共和国个人信息保护法 第五十一条「采取加密、去标识化等安全技术措施」
--
-- 出具：edu-server backend  2026-05-13
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- 加列（nullable，向后兼容；旧数据 *_hash/*_encrypted=NULL，
--   StudentImport 查重走明文 fallback；新写入双写）
-- ----------------------------------------------------------------
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS primary_mobile_hash      BYTEA,
    ADD COLUMN IF NOT EXISTS primary_mobile_encrypted BYTEA;

COMMENT ON COLUMN customers.primary_mobile_hash
    IS 'V41 HMAC-SHA256(primary_mobile, HASH_KEY) 32 bytes — 用于等值查询（学员导入查重 / 防重复客户）';
COMMENT ON COLUMN customers.primary_mobile_encrypted
    IS 'V41 AES-256-GCM(primary_mobile, ENCRYPTION_KEY) — 格式 [IV 12B][AuthTag 16B][Cipher]';

-- ----------------------------------------------------------------
-- 索引：primary_mobile_hash 查询加速（非 UNIQUE — backfill 中可能存在 NULL，
--   防止旧数据回填前的 NULL 冲突；V42 backfill 完成后转 UNIQUE NOT NULL）
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_customers_primary_mobile_hash
    ON customers (primary_mobile_hash);

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   DROP INDEX IF EXISTS idx_customers_primary_mobile_hash;
--   ALTER TABLE customers
--       DROP COLUMN IF EXISTS primary_mobile_hash,
--       DROP COLUMN IF EXISTS primary_mobile_encrypted;
--   COMMIT;
-- ============================================================

-- ============================================================
-- 后续步骤（不在本 migration）：
--   1. .env 已配 HASH_KEY（A02-3 V40 时已加）
--   2. HmacHasher 全局 provider（已 DbModule 注册 + export）
--   3. CustomerRepository 改造：
--      - createWithOpportunity INSERT：三写 primary_mobile（明文）+
--        primary_mobile_hash（hmac）+ primary_mobile_encrypted（aes-gcm）
--   4. StudentImportRepository 改造：
--      - SELECT 查重：hash 列优先；miss 时 fallback 明文 WHERE primary_mobile
--      - INSERT 新行：三写 primary_mobile + primary_mobile_hash + primary_mobile_encrypted
--   5. 数据 backfill：bash scripts/backfill-v41-customers-mobile.sh --apply（64 tenants 循环）
--   6. 灰度验证：抽样比对 hash 列与明文查询结果一致
--   7. V42：primary_mobile_hash NOT NULL UNIQUE + DROP 旧 primary_mobile VARCHAR 列
-- ============================================================
