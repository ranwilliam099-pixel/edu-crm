-- ============================================================
-- V6__price_table_and_lifecycle_jobs.sql
-- 依据:
--   - 《全部人员-审核往来总台账.md》条目 13 用户拍板 Q.PRICE 4 SKU 真值
--   - 条目 14 代码冲刺总授权 §B Track CODE-1 BE-W3-5
--   - AUTH-6 4 SKU 真值正式签字（trial=0 元/14 天 / standard_1999=1999 元/年 / school_pro=4999 元/年 / growth=9999 元/年起）
--   - AUTH-7 A10/A11/A12 全部按规约（A10 状态机 + 时间轴）
--   - AUTH-10 容量边界正式锁定（standard_1999 = 3 校区 + 50 账号 / school_pro = 5 校区 + 100 账号 / growth = 销售实施评估）
--
-- 项目隔离（追加 #8）：本工程是 ~/Desktop/edu-server/，与企业管理系统完全独立
--
-- 本文件结构：
--   §1 public.price_table — 4 SKU 价格表（公共数据，跨租户）
--   §2 public.subscription_lifecycle_jobs — A10 续费提醒 / 冻结 / 清理 cron 调度记录
--   §3 price_table 4 SKU seed 数据（按 AUTH-6 + AUTH-10 落字）
-- ============================================================

-- ============================================================
-- §1 price_table — 4 SKU 价格表
-- ============================================================
-- 业务语义：
--   - 跨租户公共价格表，由 CheckoutService 在创建订单时按 SKU 名查询
--   - 含价格 / 计费周期 / 容量边界（校区数 + 账号数）
--   - 仅含已签字的 SKU；新增需走 V7+ ALTER 路径
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.price_table (
  sku VARCHAR(32) PRIMARY KEY,
  price_cny_yuan NUMERIC(12, 2) NOT NULL,
  billing_period_days INTEGER NOT NULL,
  max_campuses INTEGER NOT NULL,
  max_accounts INTEGER NOT NULL,
  is_quote_based BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT price_table_sku_check CHECK (sku IN ('trial', 'standard_1999', 'school_pro', 'growth')),
  CONSTRAINT price_table_price_check CHECK (price_cny_yuan >= 0),
  CONSTRAINT price_table_period_check CHECK (billing_period_days > 0),
  CONSTRAINT price_table_capacity_check CHECK (max_campuses > 0 AND max_accounts > 0)
);

COMMENT ON TABLE public.price_table IS
  '4 SKU 价格表，依据条目 13 用户拍板 + 条目 14 AUTH-6/10 正式签字。';
COMMENT ON COLUMN public.price_table.sku IS '4 枚举：trial / standard_1999 / school_pro / growth';
COMMENT ON COLUMN public.price_table.price_cny_yuan IS '元/年（CNY），growth 是询价起步价';
COMMENT ON COLUMN public.price_table.billing_period_days IS 'trial=14 天，其他=365 天';
COMMENT ON COLUMN public.price_table.max_campuses IS '容量上限（校区数）— A07/A08 已签字';
COMMENT ON COLUMN public.price_table.max_accounts IS '容量上限（账号数）— A07/A08 已签字';
COMMENT ON COLUMN public.price_table.is_quote_based IS 'growth 询价制 = TRUE，其他 = FALSE';

CREATE INDEX IF NOT EXISTS idx_price_table_active ON public.price_table (is_active);

COMMIT;

-- ============================================================
-- §2 subscription_lifecycle_jobs — A10 状态机调度记录
-- ============================================================
-- 业务语义（A10 §2.1 时间轴）：
--   - D-30: 续费提醒 (renewal_reminder)
--   - D+0: 到期切换状态 expiring → frozen (freeze)
--   - D+90: 冻结期满清理 (cleanup) → pending_delete
-- 表设计：
--   - 每个租户每个生命周期事件一行，by lifecycle_scheduler cron 创建 + 执行
--   - 幂等：(tenant_id, job_type, scheduled_at) 唯一约束
--   - 状态：pending / executed / failed / skipped
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.subscription_lifecycle_jobs (
  id VARCHAR(32) PRIMARY KEY,
  tenant_id VARCHAR(32) NOT NULL REFERENCES public.tenants(id),
  job_type VARCHAR(32) NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  result_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subscription_lifecycle_jobs_type_check CHECK (job_type IN ('renewal_reminder', 'freeze', 'cleanup')),
  CONSTRAINT subscription_lifecycle_jobs_status_check CHECK (status IN ('pending', 'executed', 'failed', 'skipped')),
  CONSTRAINT subscription_lifecycle_jobs_unique UNIQUE (tenant_id, job_type, scheduled_at)
);

COMMENT ON TABLE public.subscription_lifecycle_jobs IS
  'A10 续费提醒 / 冻结 / 清理 cron 调度记录。条目 14 AUTH-7 BE-W3-6 范围。';
COMMENT ON COLUMN public.subscription_lifecycle_jobs.job_type IS
  '3 枚举：renewal_reminder (D-30) / freeze (D+0) / cleanup (D+90)';
COMMENT ON COLUMN public.subscription_lifecycle_jobs.scheduled_at IS '应执行时间，由 scheduler 按租户到期日推算';
COMMENT ON COLUMN public.subscription_lifecycle_jobs.status IS
  '4 枚举：pending（待执行）/ executed（已执行）/ failed（失败）/ skipped（已跳过，如租户已续费）';

CREATE INDEX IF NOT EXISTS idx_lifecycle_jobs_pending ON public.subscription_lifecycle_jobs (status, scheduled_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_lifecycle_jobs_tenant ON public.subscription_lifecycle_jobs (tenant_id, job_type);

COMMIT;

-- ============================================================
-- §3 price_table 4 SKU seed 数据
-- ============================================================
-- 依据 条目 13 §A 用户拍板内容 + AUTH-10 容量边界
-- ============================================================

BEGIN;

INSERT INTO public.price_table (sku, price_cny_yuan, billing_period_days, max_campuses, max_accounts, is_quote_based, is_active, description)
VALUES
  ('trial',         0.00,    14,  3, 50,  FALSE, TRUE, '14 天试用期（同 standard_1999 容量）— 条目 13 用户拍板'),
  ('standard_1999', 1999.00, 365, 3, 50,  FALSE, TRUE, '标准版 1999 元/年 — 3 校区 + 50 账号'),
  ('school_pro',    4999.00, 365, 5, 100, FALSE, TRUE, '校区版 4999 元/年 — 5 校区 + 100 账号'),
  ('growth',        9999.00, 365, 999, 9999, TRUE, TRUE, '增长版 9999 元/年起（询价制）— 销售实施定制容量；max_* 仅作上限边界')
ON CONFLICT (sku) DO UPDATE SET
  price_cny_yuan = EXCLUDED.price_cny_yuan,
  billing_period_days = EXCLUDED.billing_period_days,
  max_campuses = EXCLUDED.max_campuses,
  max_accounts = EXCLUDED.max_accounts,
  is_quote_based = EXCLUDED.is_quote_based,
  is_active = EXCLUDED.is_active,
  description = EXCLUDED.description,
  updated_at = NOW();

COMMIT;
