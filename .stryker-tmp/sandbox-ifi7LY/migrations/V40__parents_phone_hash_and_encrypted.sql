-- ============================================================
-- V40__parents_phone_hash_and_encrypted.sql
-- A02-3 parent.phone 加密（个保法红线 + Sprint E backlog #2）
--
-- 在 public.parents 加两列：
--   1. phone_hash       BYTEA  — HMAC-SHA256(phone, HASH_KEY) 32 字节
--                              用途：C 端登录等值查询（findParentByPhone）
--                              替代旧 `WHERE phone = $1` 明文查询
--   2. phone_encrypted  BYTEA  — AES-256-GCM(phone, ENCRYPTION_KEY)
--                              用途：解密后回填 Parent.phone 给业务用
--                              格式：[IV 12B][AuthTag 16B][Cipher NB]
--
-- 为什么需要 hash 列而 V34（teacher/customer）不需要：
--   - parents.phone 是 C 端**登录唯一身份**（UNIQUE 等值查询，由 phone 反查 parentId）
--   - AES-GCM 随机 IV 每次加密结果不同 → 不能等值查询
--   - 必须用确定性 hash（HMAC）做等值索引
--   - teacher.phone / opportunities.phone 没有等值查询需求，只需 encrypted 列
--
-- 密钥分离：
--   - HASH_KEY 独立于 ENCRYPTION_KEY，process.env 单独配置
--   - HASH_KEY 泄露 → 攻击者可枚举手机号但无法解密 encrypted 列
--   - ENCRYPTION_KEY 泄露 → 攻击者可解密但无法影响 hash 查询完整性
--
-- 不在本 migration：
--   - 旧 phone VARCHAR 列保留（NOT NULL UNIQUE）兼容期；V41+ 单独 drop（两阶段 deploy）
--   - 旧数据 backfill：手工跑 scripts/backfill-v40-parents-phone.sh
--   - phone_hash 加 UNIQUE 约束：backfill 完成后 V41 加（防 NULL 干扰）
--
-- 表所属 schema：public（V10 拍板 parents 跨租户共享）
--   - 不是 tenant schema 模板 → 不需要 __TENANT_SCHEMA__ 占位
--   - 不是 64 tenants 循环 backfill → 单表 N 行 backfill
--
-- 依据：
--   - 用户 2026-05-13 拍板「方案 A 双列 hash+encrypted」
--   - 2026-05-10「可上架生产架构」P0 第 2 项 + V34 模式延续
--   - 中华人民共和国个人信息保护法 第五十一条「采取加密、去标识化等安全技术措施」
--
-- 出具：edu-server backend  2026-05-13
-- ============================================================

BEGIN;

-- ----------------------------------------------------------------
-- 加列（nullable，向后兼容；旧数据 phone_hash/phone_encrypted=NULL，
--   findParentByPhone 走明文 fallback；新写入双写）
-- ----------------------------------------------------------------
ALTER TABLE public.parents
    ADD COLUMN IF NOT EXISTS phone_hash      BYTEA,
    ADD COLUMN IF NOT EXISTS phone_encrypted BYTEA;

COMMENT ON COLUMN public.parents.phone_hash
    IS 'V40 HMAC-SHA256(phone, HASH_KEY) 32 bytes — 用于等值查询（C 端登录手机号反查 parentId）';
COMMENT ON COLUMN public.parents.phone_encrypted
    IS 'V40 AES-256-GCM(phone, ENCRYPTION_KEY) — 格式 [IV 12B][AuthTag 16B][Cipher]';

-- ----------------------------------------------------------------
-- 索引：phone_hash 查询加速（非 UNIQUE — backfill 中可能存在 NULL，
--   防止旧数据回填前的 NULL 冲突；V41 backfill 完成后转 UNIQUE NOT NULL）
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_parents_phone_hash
    ON public.parents (phone_hash);

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   DROP INDEX IF EXISTS public.idx_parents_phone_hash;
--   ALTER TABLE public.parents
--       DROP COLUMN IF EXISTS phone_hash,
--       DROP COLUMN IF EXISTS phone_encrypted;
--   COMMIT;
-- ============================================================

-- ============================================================
-- 后续步骤（不在本 migration）：
--   1. .env 加 HASH_KEY（运维用 `openssl rand -base64 32` 生成，与 ENCRYPTION_KEY 不同 key）
--   2. NestJS 注入 HmacHasher 全局 provider（src/common/crypto/hmac-hasher.ts）
--   3. ParentRepository 改造：
--      - INSERT/UPDATE：双写 phone（明文）+ phone_hash（hmac）+ phone_encrypted（aes-gcm）
--      - findParentByPhone：hash 查询优先，miss 时 fallback 明文 WHERE
--      - findParentById：mapRow 解密 phone_encrypted，失败 fallback 明文
--   4. 数据 backfill：scripts/backfill-v40-parents-phone.sh --apply
--   5. 灰度验证：抽样比对 hash 列与明文查询结果一致
--   6. V41：phone_hash NOT NULL UNIQUE + DROP 旧 phone VARCHAR 列
-- ============================================================
