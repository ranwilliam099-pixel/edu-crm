-- ============================================================
-- V54__invoices_payment_method_and_paid_at.sql
-- P1 业务流闭环 S2：invoice mark-paid endpoint 支持
--
-- 在 __TENANT_SCHEMA__ 内：
--   1. invoices 表加 paid_at TIMESTAMPTZ（实际收款时间，可早于 mark-paid 操作时间）
--   2. invoices 表加 payment_method VARCHAR(16) NULLABLE（收款方式枚举）
--
-- 占位：__TENANT_SCHEMA__ 由 backfill 脚本 sed 替换（V33/V34/V35/V36/V37/V39/V41/V42 同模式）
--
-- 来源：
--   - 用户 2026-05-20 P1 业务流闭环 S2 拍板
--   - 业务流暴露的真生产缺口：跑完 contract→invoice 后 invoice 永远 pending
--     无 mark-paid endpoint 财务无法标记付款 → student_course_packages 表永远空
--     stats remainingHours 走 fallback（S1 已修，但根因在此）
--
-- 设计要点：
--   1. payment_method 与 status='issued' 配对：mark-paid 时同时写入两列
--      （status='pending' → 'issued' 的转换 = 财务确认收款 = 合同激活触发点）
--   2. paid_at 与 issued_at 区分：
--      - paid_at：财务输入的「实际到账时间」（用户付款的客观时点）
--      - issued_at：服务端 NOW()（系统确认 mark-paid 的操作时点）
--      允许 paid_at 早于 issued_at（顺延记账场景）
--   3. payment_method 不加 CHECK constraint：
--      - 应用层 enum 已限定 6 种值（微信支付/对公转账/现金/支付宝/银行卡/其他）
--      - DB 层 NULLABLE 兼容历史 invoice 数据（V42 创建的 invoice 没有此列）
--      - 未来加新收款方式不需 ALTER CHECK
--   4. 不加新索引：
--      - payment_method 不参与等值查询热点（财务工作台按 status / created_at 排序）
--      - paid_at 仅展示用途，无聚合 GROUP BY 需求（与 amount/created_at 不同）
--
-- 兼容性：
--   - 旧 invoice 数据（V42 创建）payment_method=NULL / paid_at=NULL
--   - 应用层读取需 fallback：payment_method ?? null / paid_at ? toISOString() : null
--   - mark-paid 后写入新值，旧数据保持 NULL（不回溯填充）
--
-- 出具：edu-server backend  2026-05-20
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- 加 paid_at + payment_method 两列
-- ----------------------------------------------------------------
ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS payment_method VARCHAR(16);

COMMENT ON COLUMN invoices.paid_at
    IS 'P1 业务流 S2 - 财务实际收到款的时间（可早于 issued_at；mark-paid endpoint 写入）';
COMMENT ON COLUMN invoices.payment_method
    IS 'P1 业务流 S2 - 收款方式枚举（微信支付/对公转账/现金/支付宝/银行卡/其他；mark-paid 时写入）';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   ALTER TABLE invoices DROP COLUMN IF EXISTS payment_method;
--   ALTER TABLE invoices DROP COLUMN IF EXISTS paid_at;
--   COMMIT;
-- ============================================================

-- ============================================================
-- 后续步骤（不在本 migration）：
--   1. backfill 脚本：scripts/backfill-v54.sh（64 tenants × ALTER TABLE）
--      参考 scripts/backfill-v42.sh 模式（bash 循环 + sed __TENANT_SCHEMA__ + sudo -u postgres psql）
--   2. 旧 invoice 数据 paid_at/payment_method 留 NULL，不回溯填充
--   3. 应用层 InvoiceRepository.markPaid + InvoiceService.markPaid + InvoiceController.markPaid
--   4. 灰度验证：单笔 mark-paid 流验证 invoice/contract/student_course_package 3 表同步
-- ============================================================
