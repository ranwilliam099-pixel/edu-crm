-- ============================================================
-- V47__parents_status_chinese.sql
-- Sprint X.2 (2026-05-17) — public.parents.status 切中文枚举
--
-- 来源：
--   - SSOT §12.6 失效逻辑统一 status='停用' (B 端 + C 端)
--   - SSOT §12.7 V46 同步加 parents.status 列（与 users.status 中文枚举对齐）
--   - 用户拍板 D9「parents.status 完全切中文 backfill active→启用 / suspended,deleted→停用」
--   - 用户拍板 D3「C 端家长本 Sprint 不实施密码登录」→ 本次只切 status，不加 password_hash
--
-- 改动：
--   - V10 schema: CHECK (status IN ('active','suspended','deleted')) DEFAULT 'active'
--   - V47:        CHECK (status IN ('启用','停用'))                  DEFAULT '启用' (语义合并)
--     active     → 启用
--     suspended  → 停用 (合并)
--     deleted    → 停用 (合并)
--
-- 业务理由（D9）：
--   - 失效语义统一（V27 users.status 中文，对齐 C 端 parents 统一只两态）
--   - suspended / deleted 区别在数据层无业务调用方 (5/15 grep 验证)
--   - 实际「软删」走 V44 deleted_at 时间戳, status 仅控登录闸门
--
-- 安全约束：
--   - DROP CONSTRAINT 之前必须 backfill 完所有旧 row, 否则新 CHECK 立即违反
--   - 顺序：UPDATE → DROP CONSTRAINT → ADD CONSTRAINT（事务内一气呵成）
--
-- 不在本 migration（D3 推 Sprint X+1）：
--   - parents.password_hash VARCHAR(60) DEFAULT ''
--   - parents.password_updated_at TIMESTAMPTZ NULL
--   - SMS 验证码登录 endpoint
--
-- 出具：edu-server backend  2026-05-17
-- ============================================================

BEGIN;

-- ⚠️ 顺序必须 DROP → UPDATE → ADD（CHECK 不能在 UPDATE 前还存在，否则旧 enum 写新中文违反）
--    2026-05-17 生产实战 P0 修复：原版本注释「CHECK 删除前任意写入都合法」是错的，
--    PG CHECK 是立即评估的（per-row），UPDATE 'active'→'启用' 会立即违反 V10
--    CHECK (status IN ('active','suspended','deleted'))，事务 ROLLBACK 全部 UPDATE 不生效。

-- 1. 先删旧 CHECK (按 V10 命名)
--    旧约束名 = 'parents_status_check' (PG 默认 <table>_<col>_check 命名)
ALTER TABLE public.parents DROP CONSTRAINT IF EXISTS parents_status_check;

-- 2. backfill (旧 row 'active'/'suspended'/'deleted' → 中文)
--    此时无 CHECK，任意 status 值都可写入
UPDATE public.parents SET status = '启用' WHERE status = 'active';
UPDATE public.parents SET status = '停用' WHERE status IN ('suspended', 'deleted');

-- 3. 加新 CHECK (中文双态)
--    backfill 之后所有 row 都是 '启用'/'停用'，CHECK 通过
ALTER TABLE public.parents
  ADD CONSTRAINT parents_status_check CHECK (status IN ('启用', '停用'));

-- GRANT 教训：public.parents 之前已 GRANT 给 eduapp (V10 时), 但 CHECK 变更
--   保险起见再 GRANT 一次 (PG GRANT 幂等, 无副作用)
GRANT SELECT, INSERT, UPDATE ON public.parents TO eduapp;

COMMENT ON COLUMN public.parents.status IS 'V47 中文双态 (启用/停用) 取代 V10 active/suspended/deleted; 失效逻辑见 SSOT §12.6';

COMMIT;

-- ============================================================
-- 回滚（紧急时用）：
--   BEGIN;
--   UPDATE public.parents SET status = 'active'   WHERE status = '启用';
--   UPDATE public.parents SET status = 'deleted'  WHERE status = '停用';
--   ALTER TABLE public.parents DROP CONSTRAINT IF EXISTS parents_status_check;
--   ALTER TABLE public.parents
--     ADD CONSTRAINT parents_status_check CHECK (status IN ('active','suspended','deleted'));
--   COMMIT;
-- ============================================================
