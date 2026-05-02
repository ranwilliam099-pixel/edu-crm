-- ============================================================
-- V7__teachers_in_tenant_schema.sql
-- 在 __TENANT_SCHEMA__ 内新增 teachers 独立表
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换为 `tenant_<tenant_id>`
-- 依据：
--   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§2
--   - 用户拍板《全部人员-审核往来总台账.md》条目 29 方向 B（独立 teachers 表，与 users 解耦）
--   - 用户拍板条目 31 #2（teachers.user_id NULLABLE，部分老师纯档案不登录）
-- 出具：开发总监 / 研发负责人  2026-05-02
-- 项目隔离：本工程是 ~/Desktop/edu-server/，与 企业管理系统项目 完全独立
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- 教师独立档案表（教师不一定要在 users 表有登录账号）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teachers (
    id               VARCHAR(32)   PRIMARY KEY,                        -- 32-char ULID
    campus_id        VARCHAR(32)   NOT NULL REFERENCES campuses(id),   -- 主校区
    name             VARCHAR(64)   NOT NULL,
    phone            VARCHAR(16),                                       -- 可空（老师可不留电话）
    user_id          VARCHAR(32)   REFERENCES users(id),                -- 可空（条目 31 #2 部分老师纯档案）
    subjects         JSONB         NOT NULL DEFAULT '[]'::jsonb,        -- 教学科目数组 ["数学","英语"]
    bio              TEXT,
    hourly_rate_yuan NUMERIC(10,2),                                     -- 课时单价（用于工资计算）
    status           VARCHAR(16)   NOT NULL DEFAULT '在职'
                     CHECK (status IN ('在职','请假','归档')),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by       VARCHAR(32)   NOT NULL,
    updated_by       VARCHAR(32)   NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_teachers_campus_id ON teachers(campus_id);
CREATE INDEX IF NOT EXISTS idx_teachers_user_id   ON teachers(user_id);
CREATE INDEX IF NOT EXISTS idx_teachers_status    ON teachers(status);

-- 跨校区排课资源池豁免说明（V8 ScheduleService 会跨 campus_id 查所有 teachers）：
--   campus_id 是教师"主校区"，仅用于显示和默认搜索；
--   排课 API getSchedulableTeachers(currentUser) 不限 campus_id，按 tenant 内全部 active 教师返回。

COMMIT;
