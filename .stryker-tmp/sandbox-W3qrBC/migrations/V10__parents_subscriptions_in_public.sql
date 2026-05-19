-- ============================================================
-- V10__parents_subscriptions_in_public.sql
-- 在 public schema 内新增家长 + 订阅相关 4 张表（C 端跨租户身份）
-- 依据：
--   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§5
--   - 用户拍板《全部人员-审核往来总台账.md》条目 31:
--     #3 跨机构家长共享 1 笔订阅 / #4 7 天免费试用 / #5 boss 默认单校
--   - 用户拍板条目 32:
--     #9 不开发票 / #10 退订后保留绑定
--
-- USER-AUTH(2026-05-02): 家长身份在 public（C 端跨租户）；学员仍在 tenant schema
-- 出具：开发总监 / 研发负责人  2026-05-02
-- ============================================================

BEGIN;

-- ----------------------------------------------------------------
-- §5.1 parents — 家长身份（C 端，跨租户）
-- 手机号全平台唯一（不区分租户）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parents (
    id              VARCHAR(32)  PRIMARY KEY,                          -- 32-char ULID
    phone           VARCHAR(16)  NOT NULL UNIQUE,                      -- 手机号唯一（C 端身份）
    wechat_openid   VARCHAR(128) UNIQUE,                               -- 微信小程序 openid
    wechat_unionid  VARCHAR(128),
    name            VARCHAR(64),
    avatar_url      TEXT,
    status          VARCHAR(16)  NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','deleted')),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parents_status ON parents(status);

-- ----------------------------------------------------------------
-- §5.1 parent_student_bindings — 家长-学员绑定关系
-- 跨租户引用 students：FK 约束因 schema-per-tenant 由应用层校验（注释说明）
-- 单孩最多 3 家长（DB 触发器硬约束 — P8）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parent_student_bindings (
    id              VARCHAR(32)  PRIMARY KEY,                          -- 32-char ULID
    parent_id       VARCHAR(32)  NOT NULL REFERENCES parents(id),
    student_id      VARCHAR(32)  NOT NULL,                             -- 学员 ID（在 tenant schema，应用层校验存在）
    tenant_id       VARCHAR(32)  NOT NULL REFERENCES tenants(id),      -- 冗余字段，避免跨 schema 查
    is_primary      BOOLEAN      NOT NULL DEFAULT FALSE,               -- 是否主家长
    relationship    VARCHAR(16)  NOT NULL
                    CHECK (relationship IN
                      ('father','mother','grandfather','grandmother','guardian','other')),
    binding_status  VARCHAR(16)  NOT NULL DEFAULT 'active'
                    CHECK (binding_status IN ('active','unbound')),
    bound_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    unbound_at      TIMESTAMPTZ,
    UNIQUE (parent_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_psb_parent  ON parent_student_bindings(parent_id);
CREATE INDEX IF NOT EXISTS idx_psb_student ON parent_student_bindings(student_id);
CREATE INDEX IF NOT EXISTS idx_psb_tenant  ON parent_student_bindings(tenant_id);

-- 单孩最多 3 家长触发器（P8）
CREATE OR REPLACE FUNCTION check_max_3_parents() RETURNS TRIGGER AS $$
DECLARE
  active_count INT;
BEGIN
  IF NEW.binding_status = 'active' THEN
    SELECT COUNT(*) INTO active_count
    FROM parent_student_bindings
    WHERE student_id = NEW.student_id
      AND binding_status = 'active'
      AND id <> COALESCE(NEW.id, '');
    IF active_count >= 3 THEN
      RAISE EXCEPTION 'STUDENT_MAX_3_PARENTS_EXCEEDED'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_max_3_parents ON parent_student_bindings;
CREATE TRIGGER trg_max_3_parents
  BEFORE INSERT OR UPDATE ON parent_student_bindings
  FOR EACH ROW EXECUTE FUNCTION check_max_3_parents();

-- ----------------------------------------------------------------
-- §5.1 parent_subscriptions — 家长订阅
-- 1 家长 1 订阅（条目 31 #3 跨机构共享方案）
-- 含 trialing 状态（条目 31 #4 7 天免费试用）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parent_subscriptions (
    id                    VARCHAR(32)  PRIMARY KEY,
    parent_id             VARCHAR(32)  NOT NULL REFERENCES parents(id) UNIQUE,  -- 1 家长 1 订阅
    status                VARCHAR(24)  NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','trialing','active','past_due','cancelled')),
    current_period_end    TIMESTAMPTZ,
    trial_end_at          TIMESTAMPTZ,                                          -- 7 天试用结束时间
    auto_renew            BOOLEAN      NOT NULL DEFAULT TRUE,
    cancel_at_period_end  BOOLEAN      NOT NULL DEFAULT FALSE,
    last_payment_id       VARCHAR(32),                                          -- 见 parent_payment_orders
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ps_status            ON parent_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_ps_current_period_end ON parent_subscriptions(current_period_end);

-- ----------------------------------------------------------------
-- §5.1 parent_payment_orders — C 端 9.9/月订单
-- 不混入 B 端 payment_orders 表（条目 31 #3 PD §5.2 拍板：分两表）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parent_payment_orders (
    id                    VARCHAR(32)  PRIMARY KEY,
    parent_id             VARCHAR(32)  NOT NULL REFERENCES parents(id),
    subscription_id       VARCHAR(32)  REFERENCES parent_subscriptions(id),
    amount_yuan           NUMERIC(10,2) NOT NULL,                              -- 9.90 元
    sku                   VARCHAR(32)  NOT NULL DEFAULT 'parent_monthly_9_9'
                          CHECK (sku = 'parent_monthly_9_9'),
    status                VARCHAR(16)  NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','paid','failed','refunded')),
    wxpay_out_trade_no    VARCHAR(64)  UNIQUE,
    wxpay_transaction_id  VARCHAR(64),
    paid_at               TIMESTAMPTZ,
    refunded_at           TIMESTAMPTZ,
    failure_reason        TEXT,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ppo_parent       ON parent_payment_orders(parent_id);
CREATE INDEX IF NOT EXISTS idx_ppo_subscription ON parent_payment_orders(subscription_id);
CREATE INDEX IF NOT EXISTS idx_ppo_status       ON parent_payment_orders(status);

COMMIT;
