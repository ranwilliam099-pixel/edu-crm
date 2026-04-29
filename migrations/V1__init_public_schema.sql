-- ============================================================
-- V1__init_public_schema.sql
-- 公共 schema 6 表 DDL（BE-W0-5）
-- 依据：教育培训行业销售CRM-字段清单-V1.md §2 + A04 责任链规约 + A10/A11/A12 执行细化
-- 出具：研发负责人 / 开发总监  2026-04-29
-- 注意：本文件是教培项目独立工程，不引用、不污染主线 33 静态 + 59 e2e + 13 step 守护
-- ============================================================

BEGIN;

-- ----------------------------------------------------------------
-- 2.1 tenants（租户主表）
-- A01 schema-per-tenant：schema 名 = tenant_<id>
-- A07 标准版账号上限 50；A08 校区上限 3
-- A10 状态流转：试用中 → 已付费 → 已到期 → 已冻结 → 已删除
-- 054 价格锚点：单校区入门版 1999/年（version 枚举可后续扩展）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenants (
    id              VARCHAR(32)  PRIMARY KEY,
    name            VARCHAR(64)  NOT NULL,
    status          VARCHAR(16)  NOT NULL DEFAULT '试用中'
                    CHECK (status IN ('试用中','已付费','已到期','已冻结','已删除')),
    version         VARCHAR(16)  NOT NULL DEFAULT '标准版'
                    CHECK (version IN ('单校区入门版','标准版','校区版','增长版')),
    campus_limit    INTEGER      NOT NULL DEFAULT 3
                    CHECK (campus_limit > 0),
    account_limit   INTEGER      NOT NULL DEFAULT 50
                    CHECK (account_limit > 0),
    paid_until      TIMESTAMPTZ  NULL,
    frozen_at       TIMESTAMPTZ  NULL,
    keep_until      TIMESTAMPTZ  NULL,                       -- A10 §2.5 保留标记
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tenants_status      ON public.tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_paid_until  ON public.tenants(paid_until);

-- ----------------------------------------------------------------
-- 2.2 payment_orders（商户订单 — 公司主体收教育机构软件费，A04）
-- A04 §1.4：仅服务"我方向机构收取的软件费订单"，与租户内 contracts/payments 严格分离
-- A04 §5.1 状态：待支付 / 已支付 / 退款处理中 / 已退款 / 已取消
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_orders (
    id                  VARCHAR(32)   PRIMARY KEY,
    tenant_id           VARCHAR(32)   NOT NULL REFERENCES public.tenants(id),
    version             VARCHAR(16)   NOT NULL,                      -- 购买版本（与 tenants.version 同枚举）
    amount              NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    status              VARCHAR(16)   NOT NULL DEFAULT '待支付'
                        CHECK (status IN ('待支付','已支付','退款处理中','已退款','已取消')),
    wx_transaction_id   VARCHAR(64)   NULL,                          -- A02 V3 微信交易号
    paid_at             TIMESTAMPTZ   NULL,                          -- 支付成功时间，触发租户 schema 创建
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_orders_tenant_id ON public.payment_orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status    ON public.payment_orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_orders_wx_tx
    ON public.payment_orders(wx_transaction_id) WHERE wx_transaction_id IS NOT NULL;

-- ----------------------------------------------------------------
-- 2.3 payment_refunds（退款记录 — 公司主体处理）
-- A04 §3 退款责任：平台超管/财务审核；不允许直接修改原始 payment_orders
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_refunds (
    id           VARCHAR(32)   PRIMARY KEY,
    order_id     VARCHAR(32)   NOT NULL REFERENCES public.payment_orders(id),
    amount       NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    reason       VARCHAR(256)  NOT NULL,
    status       VARCHAR(16)   NOT NULL DEFAULT '待审核'
                 CHECK (status IN ('待审核','已批准','已退款','已拒绝')),
    reviewed_by  VARCHAR(32)   NULL,                                 -- platform admin id
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_order_id ON public.payment_refunds(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_status   ON public.payment_refunds(status);

-- ----------------------------------------------------------------
-- 2.4 invoice_requests（发票申请 — 公司主体开票）
-- A04 §4：开票主体我方公司，向购买软件的教育机构开具
-- A04 §5.3 状态：待审核 / 已批准 / 已开具 / 已拒绝 / 红冲处理中
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoice_requests (
    id              VARCHAR(32)   PRIMARY KEY,
    order_id        VARCHAR(32)   NOT NULL REFERENCES public.payment_orders(id),
    invoice_title   VARCHAR(128)  NOT NULL,                          -- 脱敏矩阵 finance/admin FULL
    tax_number      VARCHAR(32)   NULL,                              -- 同上
    contact_email   VARCHAR(128)  NULL,
    remark          VARCHAR(256)  NULL,
    status          VARCHAR(16)   NOT NULL DEFAULT '待审核'
                    CHECK (status IN ('待审核','已批准','已开具','已拒绝','红冲处理中')),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoice_requests_order_id ON public.invoice_requests(order_id);
CREATE INDEX IF NOT EXISTS idx_invoice_requests_status   ON public.invoice_requests(status);

-- ----------------------------------------------------------------
-- 2.5 marketing_channels（渠道枚举主表 — M01 三级结构）
-- 待营销经理回填 Q18 完整枚举（§11.5 Q18）；本表仅建结构，数据后续 seed
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_channels (
    id        VARCHAR(32)  PRIMARY KEY,
    level     SMALLINT     NOT NULL CHECK (level IN (1,2,3)),
    level1    VARCHAR(32)  NOT NULL,
    level2    VARCHAR(64)  NULL,
    level3    VARCHAR(128) NULL,
    status    VARCHAR(16)  NOT NULL DEFAULT '启用'
              CHECK (status IN ('启用','停用'))
);
CREATE INDEX IF NOT EXISTS idx_marketing_channels_level1 ON public.marketing_channels(level1);

-- ----------------------------------------------------------------
-- 2.6 platform_admin_logs（A11 平台超管操作日志）
-- A11 §3.4 + A10 §2.5 操作枚举：查看/批准退款/拒绝退款/批准开票/拒绝开票/手工冻结/
--          手工解冻/添加保留标记/移除保留标记/手工延长保留期
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_admin_logs (
    id                VARCHAR(32) PRIMARY KEY,
    operator_id       VARCHAR(32) NOT NULL,
    action            VARCHAR(32) NOT NULL
                      CHECK (action IN (
                          '查看','批准退款','拒绝退款','批准开票','拒绝开票',
                          '手工冻结','手工解冻','添加保留标记','移除保留标记','手工延长保留期'
                      )),
    target_tenant_id  VARCHAR(32) NULL,
    meta              JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_admin_logs_operator     ON public.platform_admin_logs(operator_id);
CREATE INDEX IF NOT EXISTS idx_platform_admin_logs_target       ON public.platform_admin_logs(target_tenant_id);
CREATE INDEX IF NOT EXISTS idx_platform_admin_logs_created_at   ON public.platform_admin_logs(created_at);

-- ----------------------------------------------------------------
-- A10 paid_until / frozen_at / keep_until 守护提示
-- 应用层 Job 计算续费提醒、到期冻结、3 个月清理时点
-- ----------------------------------------------------------------
COMMENT ON COLUMN public.tenants.paid_until IS '到期时间，A10 续费提醒锚点';
COMMENT ON COLUMN public.tenants.frozen_at  IS '冻结时间，A10 到期后冻结';
COMMENT ON COLUMN public.tenants.keep_until IS 'A10 §2.5 平台超管设置的保留标记，清理前必须校验';

COMMIT;
