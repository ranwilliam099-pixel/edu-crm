-- ============================================================
-- V12__course_packages_balance_in_tenant_schema.sql
-- 在 __TENANT_SCHEMA__ 内新增"课时包 + 学员课时余额"
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
-- 依据：
--   - 《教学链路完整设计-V1-2026-05-02.md》§1
--   - 用户拍板「完成整个教学链路从开始到结束」
-- 出具：开发总监 / 研发负责人  2026-05-02
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §12.1 course_packages — 课时包定义（基于 course_products 的具体课包）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS course_packages (
    id                 VARCHAR(32)  PRIMARY KEY,
    course_product_id  VARCHAR(32)  NOT NULL REFERENCES course_products(id),
    name               VARCHAR(64)  NOT NULL,
    total_lessons      INT          NOT NULL CHECK (total_lessons > 0),
    unit_price_yuan    NUMERIC(10,2) NOT NULL CHECK (unit_price_yuan >= 0),
    total_price_yuan   NUMERIC(10,2) NOT NULL CHECK (total_price_yuan >= 0),
    validity_months    INT          NOT NULL DEFAULT 12 CHECK (validity_months > 0),
    status             VARCHAR(16)  NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','archived')),
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by         VARCHAR(32)  NOT NULL,
    updated_by         VARCHAR(32)  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cp_product ON course_packages(course_product_id);
CREATE INDEX IF NOT EXISTS idx_cp_status  ON course_packages(status);

-- ----------------------------------------------------------------
-- §12.2 student_course_packages — 学员课时余额账户
-- 一学员一合同对应一条；同一学员可有多个不同包（如英语+数学）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_course_packages (
    id                  VARCHAR(32)  PRIMARY KEY,
    student_id          VARCHAR(32)  NOT NULL REFERENCES students(id),
    course_package_id   VARCHAR(32)  NOT NULL REFERENCES course_packages(id),
    contract_id         VARCHAR(32)  REFERENCES contracts(id),     -- 来源合同（可空：赠送场景）
    total_lessons       INT          NOT NULL CHECK (total_lessons > 0),
    used_lessons        INT          NOT NULL DEFAULT 0,
    refunded_lessons    INT          NOT NULL DEFAULT 0,
    remaining_lessons   INT          GENERATED ALWAYS AS
                          (total_lessons - used_lessons - refunded_lessons) STORED,
    activated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ  NOT NULL,
    status              VARCHAR(24)  NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','expired','depleted','frozen','refunded')),
    low_balance_alerted BOOLEAN      NOT NULL DEFAULT FALSE,       -- 余额提醒幂等标记
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scp_student   ON student_course_packages(student_id);
CREATE INDEX IF NOT EXISTS idx_scp_status    ON student_course_packages(status);
CREATE INDEX IF NOT EXISTS idx_scp_expires   ON student_course_packages(expires_at)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_scp_lowbal    ON student_course_packages(student_id, remaining_lessons)
    WHERE status = 'active' AND low_balance_alerted = FALSE;

COMMIT;
