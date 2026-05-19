-- ============================================================
-- V23__c_side_quarterly_and_free_slots.sql
-- C 端家长 9.9 月付 + 季度集采 23.76 + 校区 10 slot FCFS
--
-- 依据 V10 策略：
--   - C 端自付 ¥9.9/月（按月，无折扣）
--   - C 端集采 ¥23.76/家长/季度（8 折，3 月起，仅集采才有 8 折）
--   - C 端 slot 10/校区 FCFS 3 月免费轮转
--
-- 注：C 端小程序需独立 appId 申请；本 migration 仅落库 + 共享后端 API
--
-- 出具：研发负责人  2026-05-05
-- ============================================================

BEGIN;

-- ----------------------------------------------------------------
-- §23.1 ALTER parent_subscriptions：账单周期 + 付款模式
-- ----------------------------------------------------------------
ALTER TABLE public.parent_subscriptions
    ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(16)
        NOT NULL DEFAULT 'monthly'
        CHECK (billing_cycle IN ('monthly','quarterly')),
    ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20)
        NOT NULL DEFAULT 'self_pay'
        CHECK (payment_mode IN ('self_pay','school_bulk','free_slot')),
    ADD COLUMN IF NOT EXISTS free_slot_id BIGINT,
    ADD COLUMN IF NOT EXISTS bulk_purchase_id VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_ps_payment_mode
    ON public.parent_subscriptions(payment_mode);

COMMENT ON COLUMN public.parent_subscriptions.billing_cycle
    IS 'V23: monthly=¥9.9/月; quarterly=¥23.76/3月（8折，仅集采）';
COMMENT ON COLUMN public.parent_subscriptions.payment_mode
    IS 'V23: self_pay 自付月付 / school_bulk 校区集采季付 / free_slot 校区赠送 3 月免费';

-- ----------------------------------------------------------------
-- §23.2 校区 free slot 池 — 每校区固定 10 名额，FCFS 抢占
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campus_free_slots (
    id              BIGSERIAL    PRIMARY KEY,
    campus_id       VARCHAR(32)  NOT NULL REFERENCES public.campuses(id),
    slot_index      INTEGER      NOT NULL CHECK (slot_index BETWEEN 1 AND 10),
    parent_id       VARCHAR(32)  REFERENCES public.parents(id),  -- NULL = 空槽
    granted_at      TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,                                 -- granted_at + 3 months
    status          VARCHAR(16)  NOT NULL DEFAULT 'empty'
                    CHECK (status IN ('empty','occupied','expired')),
    version         INTEGER      NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (campus_id, slot_index)
);

CREATE INDEX IF NOT EXISTS idx_cfs_campus_status
    ON public.campus_free_slots(campus_id, status);
CREATE INDEX IF NOT EXISTS idx_cfs_parent
    ON public.campus_free_slots(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cfs_expires
    ON public.campus_free_slots(expires_at) WHERE status = 'occupied';

COMMENT ON TABLE  public.campus_free_slots
    IS 'V23 C 端校区赠送 slot：每校区 10 个，FCFS 抢占，3 个月免费';
COMMENT ON COLUMN public.campus_free_slots.slot_index
    IS '校区内 1-10 槽位（slot_index UNIQUE per campus）';

-- ----------------------------------------------------------------
-- §23.3 触发器：新校区自动初始化 10 个 empty slot
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_init_campus_free_slots()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.campus_free_slots (campus_id, slot_index, status)
    SELECT NEW.id, gs, 'empty'
      FROM generate_series(1, 10) AS gs
     ON CONFLICT (campus_id, slot_index) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_init_campus_free_slots ON public.campuses;
CREATE TRIGGER trg_init_campus_free_slots
    AFTER INSERT ON public.campuses
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_init_campus_free_slots();

-- ----------------------------------------------------------------
-- §23.4 回填：现有 campus 都补 10 slot
-- ----------------------------------------------------------------
INSERT INTO public.campus_free_slots (campus_id, slot_index, status)
SELECT c.id, gs, 'empty'
  FROM public.campuses c
       CROSS JOIN generate_series(1, 10) AS gs
 ON CONFLICT (campus_id, slot_index) DO NOTHING;

-- ----------------------------------------------------------------
-- §23.5 parent_payment_orders 增加 sku 枚举值（季度集采）
-- ----------------------------------------------------------------
ALTER TABLE public.parent_payment_orders
    DROP CONSTRAINT IF EXISTS parent_payment_orders_sku_check;

ALTER TABLE public.parent_payment_orders
    ADD CONSTRAINT parent_payment_orders_sku_check
    CHECK (sku IN ('parent_monthly_9_9','parent_quarterly_23_76'));

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_init_campus_free_slots ON public.campuses;
--   DROP FUNCTION IF EXISTS public.fn_init_campus_free_slots;
--   DROP TABLE IF EXISTS public.campus_free_slots;
--   ALTER TABLE public.parent_subscriptions
--       DROP COLUMN IF EXISTS bulk_purchase_id,
--       DROP COLUMN IF EXISTS free_slot_id,
--       DROP COLUMN IF EXISTS payment_mode,
--       DROP COLUMN IF EXISTS billing_cycle;
--   ALTER TABLE public.parent_payment_orders DROP CONSTRAINT IF EXISTS parent_payment_orders_sku_check;
--   ALTER TABLE public.parent_payment_orders
--       ADD CONSTRAINT parent_payment_orders_sku_check CHECK (sku = 'parent_monthly_9_9');
--   COMMIT;
-- ============================================================
