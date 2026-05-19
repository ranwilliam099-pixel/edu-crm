-- ============================================================
-- V42__invoices_in_tenant_schema.sql
-- Wave 4A B 端 finance 域开票管理（OOUX contract → invoice 子资源）
--
-- 在 __TENANT_SCHEMA__ 内：
--   1. 新建 invoices 表（独立于 checkout/invoice.service C 端自助开票）
--   2. contracts 表加 invoice_issued BOOLEAN 列（防重复开票 409 检测）
--
-- 占位：__TENANT_SCHEMA__ 由 backfill 脚本 sed 替换（V33/V34/V35/V36/V37/V39/V41 同模式）
--
-- 来源：
--   - 用户 2026-05-14 Wave 4 P0-2 拍板（前端 b/finance-invoices/new 表单）
--   - 设计契约：edu-mp-sandbox/docs/p0-ooux-design-2026-05-14.md Wave 0 commit b334edc
--   - fields-by-role.md：财务作账域（finance/boss/admin），不复用 C 端 checkout/invoice
--
-- 设计要点：
--   1. 与 checkout/invoice_requests 分离（B 端 finance 手动开票 vs C 端 self-help）
--   2. PII 列双轨：receive_phone（明文 NULLABLE 兼容期）+ receive_phone_hash（HMAC 等值）
--                  + receive_phone_encrypted（AES-GCM 加密）— 复用 A02-4 三写模式
--   3. invoice_title / tax_id 不做 hash 但做加密（开票抬头属 PII，但无 UNIQUE 查询需求）
--   4. status: pending（财务已提交，待出票）/ issued（已出票）/ cancelled（已撤销）
--   5. contracts.invoice_issued: 防重复开票（409 Conflict 检测）— 同事务一并写入
--   6. UNIQUE(contract_id)：1 合同 = 1 invoice（业务规则；红冲走 status='cancelled' + 新建）
--      若未来允许 1 contract 多 invoice，DROP UNIQUE 改成普通 index
--
-- 容量预估：30 家 × 50 开票/月 = 1500/月 = 18K/年（单 tenant 平均 280/年），不分区
--
-- 出具：edu-server backend  2026-05-14
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- invoices 表
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
    id                          CHAR(32) PRIMARY KEY,                       -- ULID 32-char（与 contracts/students 一致）
    contract_id                 CHAR(32) NOT NULL,                          -- OOUX 子资源父对象
    student_id                  CHAR(32),                                   -- 派生自 contract.student_id（snapshot 防 contract 改）
    customer_id                 CHAR(32),                                   -- 派生自 student.customer_id（snapshot）
    -- 抬头信息（PII，B 端财务录入）
    title_type                  VARCHAR(8) NOT NULL,                        -- '个人' | '企业'
    invoice_title               TEXT NOT NULL,                              -- 明文（兼容期）
    invoice_title_encrypted     BYTEA,                                      -- AES-256-GCM 加密（V42 新写入双写）
    tax_id                      TEXT,                                       -- 明文（兼容期，企业必填，18 位统一信用代码）
    tax_id_encrypted            BYTEA,                                      -- AES-256-GCM 加密
    -- 接收方式（PII）
    receive_email               TEXT,                                       -- 邮箱（不加密 — 已是接收方 own data）
    receive_phone               VARCHAR(16),                                -- 手机明文（兼容期）
    receive_phone_hash          BYTEA,                                      -- HMAC-SHA256（等值查询，未来防重复填写）
    receive_phone_encrypted     BYTEA,                                      -- AES-256-GCM 加密
    -- 金额（系统派生，财务不可改）
    amount                      NUMERIC(14, 2) NOT NULL,                    -- 元（= contract.total_amount snapshot）
    -- 备注
    remark                      TEXT,                                       -- 自由文本（前端 msgSecCheck 过 wx.security）
    -- 状态机
    status                      VARCHAR(16) NOT NULL DEFAULT 'pending',     -- pending / issued / cancelled
    -- 审计 + 时间戳
    created_by_user_id          CHAR(32) NOT NULL,                          -- 创建人 user.id（finance/boss/admin）
    issued_at                   TIMESTAMPTZ,                                -- 实际出票时间（status='issued' 时填）
    cancelled_at                TIMESTAMPTZ,                                -- 撤销时间
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT invoices_title_type_chk CHECK (title_type IN ('个人', '企业')),
    CONSTRAINT invoices_status_chk     CHECK (status IN ('pending', 'issued', 'cancelled')),
    CONSTRAINT invoices_amount_nonneg  CHECK (amount >= 0)
);

-- ----------------------------------------------------------------
-- 索引
-- ----------------------------------------------------------------

-- 1 合同 = 1 active invoice（pending/issued 唯一；cancelled 允许多次重开）
-- 用 partial UNIQUE 实现（PG 特性，比触发器轻量）
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_contract_unique_active
    ON invoices (contract_id)
    WHERE status IN ('pending', 'issued');

-- 待开票列表（财务工作台主查询：status='pending' ORDER BY created_at DESC）
CREATE INDEX IF NOT EXISTS idx_invoices_status_created
    ON invoices (status, created_at DESC);

-- 学员视角（OOUX student → invoices[]，未来扩展）
CREATE INDEX IF NOT EXISTS idx_invoices_student
    ON invoices (student_id)
    WHERE student_id IS NOT NULL;

-- ----------------------------------------------------------------
-- 注释（运维 + 审计可读）
-- ----------------------------------------------------------------
COMMENT ON TABLE  invoices                          IS 'Wave 4A B 端 finance 域开票（与 checkout/invoice_requests C 端自助分离）';
COMMENT ON COLUMN invoices.contract_id              IS 'OOUX 父对象 contracts.id（FK 软引用 - 不加 PG FK 防 tenant schema 迁移困难）';
COMMENT ON COLUMN invoices.student_id               IS '派生 snapshot - 防 contract 改 student 后追溯失真';
COMMENT ON COLUMN invoices.customer_id              IS '派生 snapshot - 财务作账可不查 students/customers 即知归属';
COMMENT ON COLUMN invoices.title_type               IS '抬头类型 - 个人/企业（与设计契约一致）';
COMMENT ON COLUMN invoices.invoice_title            IS '抬头明文（兼容期）- 未来 DROP，仅留 invoice_title_encrypted';
COMMENT ON COLUMN invoices.invoice_title_encrypted  IS 'AES-256-GCM(invoice_title, ENCRYPTION_KEY) - V42 新写入双写';
COMMENT ON COLUMN invoices.tax_id                   IS '税号明文（兼容期）- 企业必填 18 位统一信用代码';
COMMENT ON COLUMN invoices.tax_id_encrypted         IS 'AES-256-GCM(tax_id, ENCRYPTION_KEY)';
COMMENT ON COLUMN invoices.receive_phone_hash       IS 'HMAC-SHA256(receive_phone, HASH_KEY) - 等值查询';
COMMENT ON COLUMN invoices.receive_phone_encrypted  IS 'AES-256-GCM(receive_phone, ENCRYPTION_KEY)';
COMMENT ON COLUMN invoices.amount                   IS '金额（元）- snapshot 自 contracts.total_amount，财务不可改';
COMMENT ON COLUMN invoices.status                   IS 'pending=已提交待出票 / issued=已出票 / cancelled=已撤销（红冲）';

-- ----------------------------------------------------------------
-- contracts 表加 invoice_issued 列（防重复开票 409 检测）
-- ----------------------------------------------------------------
ALTER TABLE contracts
    ADD COLUMN IF NOT EXISTS invoice_issued BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN contracts.invoice_issued
    IS 'Wave 4A V42 - 已开票标志（防重复开票 409 检测）；invoice.status=pending/issued 时该列=true';

-- 索引：财务工作台「待开票合同」过滤（status=signed/active + invoice_issued=false）
-- 注：status 列已在 V25 时有 idx_contracts_status；此处仅加 invoice_issued partial 加速
CREATE INDEX IF NOT EXISTS idx_contracts_pending_invoice
    ON contracts (signed_at DESC)
    WHERE invoice_issued = FALSE AND deleted_at IS NULL;

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   DROP INDEX IF EXISTS idx_contracts_pending_invoice;
--   ALTER TABLE contracts DROP COLUMN IF EXISTS invoice_issued;
--   DROP TABLE IF EXISTS invoices;
--   COMMIT;
-- ============================================================

-- ============================================================
-- 后续步骤（不在本 migration）：
--   1. backfill 脚本：scripts/backfill-v42.sh（64 tenants × ALTER TABLE）
--   2. contracts.invoice_issued 旧数据默认 FALSE（NOT NULL DEFAULT FALSE 时自动填）
--   3. invoices 表新建无旧数据，无需 backfill
--   4. 应用层 InvoiceRepository + InvoiceService + InvoiceController（src/modules/invoice/）
--   5. 灰度验证：抽样 SELECT 测试解密链路 + UNIQUE partial 索引行为
-- ============================================================
