-- ============================================================
-- V20__promotions_in_public_schema.sql
-- 公共 schema：促销折扣体系
--   - public.promotion_tiers      档位字典（早鸟/达人/活动通用）
--   - public.promotion_tier_audit 审计日志
--   - ALTER public.tenants        加 4 列锁定状态 + 实付价 snapshot + 第几年
--
-- 依据：用户 2026-05-05「单独走 promotion 折扣字段，给我一个配置面板」
--       3 轮严谨性复核（reserve/commit/release 状态机 + KOL + 干跑预览）
-- 出具：研发负责人  2026-05-05
-- ============================================================

BEGIN;

-- ----------------------------------------------------------------
-- §20.1 promotion_tiers — 折扣档位主表
--   - id 主键（允许 code 重命名，FK 指 id）
--   - code UNIQUE（业务可见标识）
--   - discount_pct 0..100（含校验）
--   - quota_total NULL = 无限；quota_used 不可超 quota_total（claimQuota 原子保证）
--   - applies_to_plans CHECK 限定三档枚举
--   - source_type: self_service（早鸟自助）/ kol（达人邀请码）/ campaign（活动）
--   - invite_code KOL 专用，UNIQUE（自助档位为 NULL）
--   - version 乐观锁
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.promotion_tiers (
    id                BIGSERIAL    PRIMARY KEY,
    code              VARCHAR(40)  NOT NULL UNIQUE,
    name              VARCHAR(80)  NOT NULL,
    discount_pct      NUMERIC(5,2) NOT NULL
                      CHECK (discount_pct >= 0 AND discount_pct <= 100),
    quota_total       INTEGER      CHECK (quota_total IS NULL OR quota_total >= 0),
    quota_used        INTEGER      NOT NULL DEFAULT 0
                      CHECK (quota_used >= 0),
    active            BOOLEAN      NOT NULL DEFAULT TRUE,
    starts_at         TIMESTAMPTZ,
    ends_at           TIMESTAMPTZ,
    activation_rules  JSONB,
    applies_to_plans  TEXT[]       NOT NULL DEFAULT ARRAY['single','growth','chain']::TEXT[]
                      CHECK (applies_to_plans <@ ARRAY['single','growth','chain']::TEXT[]),
    applies_years     INTEGER      NOT NULL DEFAULT 1
                      CHECK (applies_years >= 1),
    source_type       VARCHAR(20)  NOT NULL DEFAULT 'self_service'
                      CHECK (source_type IN ('self_service','kol','campaign')),
    invite_code       VARCHAR(40)  UNIQUE,
    version           INTEGER      NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT promo_kol_invite_code_invariant
        CHECK (
            (source_type = 'kol' AND invite_code IS NOT NULL)
            OR (source_type <> 'kol' AND invite_code IS NULL)
        )
);

CREATE INDEX IF NOT EXISTS idx_promo_tiers_active
    ON public.promotion_tiers(code) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_promo_tiers_source
    ON public.promotion_tiers(source_type);
CREATE INDEX IF NOT EXISTS idx_promo_tiers_invite_code
    ON public.promotion_tiers(invite_code) WHERE invite_code IS NOT NULL;

COMMENT ON TABLE  public.promotion_tiers
    IS 'V20 SaaS 促销折扣档位（早鸟两波 / KOL / 活动）';
COMMENT ON COLUMN public.promotion_tiers.discount_pct
    IS '折扣百分比 0-100，10=1折，50=5折，100=正价';
COMMENT ON COLUMN public.promotion_tiers.applies_years
    IS '折扣覆盖年数，早鸟=1（仅首年）；KOL 可设 2';
COMMENT ON COLUMN public.promotion_tiers.activation_rules
    IS 'JSONB: {teachers:N,students:N,parents:N,schedules:N} 激活门槛';

-- ----------------------------------------------------------------
-- §20.2 promotion_tier_audit — 配置变更审计
--   - 任何 create/update/toggle/quota_claim/quota_release 都写一行
--   - before_json/after_json 用于回滚
--   - operator_id 来源平台用户表
--   - operator_role: platform_admin / system / kol_self（KOL 自助核销）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.promotion_tier_audit (
    id            BIGSERIAL    PRIMARY KEY,
    tier_code     VARCHAR(40)  NOT NULL,
    action        VARCHAR(30)  NOT NULL
                  CHECK (action IN (
                      'create','update','toggle','delete',
                      'quota_reserve','quota_commit','quota_release'
                  )),
    before_json   JSONB,
    after_json    JSONB,
    tenant_id     VARCHAR(32),
    operator_id   VARCHAR(64),
    operator_role VARCHAR(40),
    operator_ip   INET,
    note          VARCHAR(256),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_audit_code
    ON public.promotion_tier_audit(tier_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_promo_audit_tenant
    ON public.promotion_tier_audit(tenant_id, created_at DESC)
    WHERE tenant_id IS NOT NULL;

COMMENT ON TABLE public.promotion_tier_audit
    IS 'V20 促销档位审计日志（配置变更 + quota 状态机）';

-- ----------------------------------------------------------------
-- §20.3 ALTER public.tenants — 4 列状态 + 价格 snapshot + 年度
--   - promotion_code: 当前命中的档位 code（NULL = 正价）
--   - promotion_status: reserved（预占，未付款）/ committed（已付款）
--                       / released（释放，门槛失败/退款）/ expired（applies_years 用完）
--   - promotion_locked_at: 命中时间（用于 ends_at = locked_at + applies_years 年）
--   - promotion_price_yuan: 锁定时实付金额 snapshot（防档位改了影响历史）
--   - promotion_year_index: 当前是激活后第几年（1=首年）
-- ----------------------------------------------------------------
ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS promotion_code        VARCHAR(40)
        REFERENCES public.promotion_tiers(code) ON UPDATE CASCADE,
    ADD COLUMN IF NOT EXISTS promotion_status      VARCHAR(20)
        CHECK (promotion_status IN ('reserved','committed','released','expired')),
    ADD COLUMN IF NOT EXISTS promotion_locked_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS promotion_price_yuan  INTEGER
        CHECK (promotion_price_yuan IS NULL OR promotion_price_yuan >= 0),
    ADD COLUMN IF NOT EXISTS promotion_year_index  INTEGER NOT NULL DEFAULT 1
        CHECK (promotion_year_index >= 1);

CREATE INDEX IF NOT EXISTS idx_tenants_promotion
    ON public.tenants(promotion_code, promotion_status)
    WHERE promotion_code IS NOT NULL;

COMMENT ON COLUMN public.tenants.promotion_code
    IS 'V20 命中的折扣档位 code（NULL = 正价）';
COMMENT ON COLUMN public.tenants.promotion_status
    IS 'V20 状态机：reserved/committed/released/expired';
COMMENT ON COLUMN public.tenants.promotion_price_yuan
    IS 'V20 锁定时的实付金额 snapshot（即使档位改也不影响历史）';

-- ----------------------------------------------------------------
-- §20.4 种子数据 — 3 档基础促销
-- ----------------------------------------------------------------
INSERT INTO public.promotion_tiers
    (code, name, discount_pct, quota_total, applies_years, source_type, activation_rules)
VALUES
    ('early_bird_w1', '早鸟波1（前10家）',  10.00, 10,   1, 'self_service',
     '{"teachers":3,"students":5,"parents":5,"schedules":10}'::jsonb),
    ('early_bird_w2', '早鸟波2（11-30家）', 50.00, 20,   1, 'self_service',
     '{"teachers":5,"students":10,"parents":5,"schedules":10}'::jsonb),
    ('regular',       '正价',              100.00, NULL, 1, 'self_service',
     NULL)
ON CONFLICT (code) DO NOTHING;

-- ----------------------------------------------------------------
-- §20.5 回填提示
--   既有 25 个 tenant 默认 promotion_code = NULL（正价）
--   promotion_year_index 列默认 1（已通过 DEFAULT 处理）
--   promotion_status NULL（无锁定档位时）
-- ----------------------------------------------------------------

COMMIT;

-- ============================================================
-- 回滚脚本（如需）：
--   BEGIN;
--   ALTER TABLE public.tenants
--     DROP COLUMN IF EXISTS promotion_year_index,
--     DROP COLUMN IF EXISTS promotion_price_yuan,
--     DROP COLUMN IF EXISTS promotion_locked_at,
--     DROP COLUMN IF EXISTS promotion_status,
--     DROP COLUMN IF EXISTS promotion_code;
--   DROP TABLE IF EXISTS public.promotion_tier_audit;
--   DROP TABLE IF EXISTS public.promotion_tiers;
--   COMMIT;
-- ============================================================
