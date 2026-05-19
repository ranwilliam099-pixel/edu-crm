-- ============================================================
-- V19__campuses_and_plan.sql
-- 公共 schema：新增 campuses 表（每租户多校区）+ tenants 表加 plan 字段
-- 依据：用户 2026-05-04 9 个待实现 endpoint #5 (boss/campuses) + #6 (subscription/upgrade)
-- 出具：开发总监 / 研发负责人  2026-05-04
-- 注：本文件不带 __TENANT_SCHEMA__ 占位符 — 是 public 表 + ALTER tenants
-- ============================================================

BEGIN;

-- ----------------------------------------------------------------
-- §19.1 public.campuses — 每租户多校区
--   - status: active | suspended
--   - is_hq:  TRUE 表示总部校区（每租户有且只有一个）
-- 注：原 V2 在 tenant_schema 内有同名表 campuses（机构内部校区）
--      本表是 SaaS 平台层"机构注册的校区列表"，命名统一为 public.campuses 不冲突
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campuses (
    id              VARCHAR(32)   PRIMARY KEY,
    tenant_id       VARCHAR(32)   NOT NULL REFERENCES public.tenants(id),
    name            VARCHAR(64)   NOT NULL,
    city            VARCHAR(32),
    district        VARCHAR(32),
    address         VARCHAR(256),
    student_count   INTEGER       NOT NULL DEFAULT 0,
    teacher_count   INTEGER       NOT NULL DEFAULT 0,
    status          VARCHAR(16)   NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended')),
    is_hq           BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pcampuses_tenant ON public.campuses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pcampuses_status ON public.campuses(status);

-- ----------------------------------------------------------------
-- §19.2 ALTER tenants 加 plan_tier / max_campuses
--   - plan_tier: single | growth | chain
--   - max_campuses: single=1 / growth=3 / chain=99
-- 注：与现有 version 列共存（version 是显示用，plan_tier 是计费用）
-- ----------------------------------------------------------------
ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS plan_tier      VARCHAR(16)
        DEFAULT 'single'
        CHECK (plan_tier IN ('single','growth','chain')),
    ADD COLUMN IF NOT EXISTS max_campuses   INTEGER NOT NULL DEFAULT 1;

COMMENT ON TABLE  public.campuses              IS 'V19 SaaS 平台层：机构注册的校区列表（与 tenant 内部 campuses 不冲突）';
COMMENT ON COLUMN public.tenants.plan_tier     IS 'V19 single/growth/chain 计费档位';
COMMENT ON COLUMN public.tenants.max_campuses  IS 'V19 校区上限（与 plan_tier 同步：single=1/growth=3/chain=99）';

COMMIT;
