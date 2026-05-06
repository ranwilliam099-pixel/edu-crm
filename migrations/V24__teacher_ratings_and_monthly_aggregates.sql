-- ============================================================
-- V24__teacher_ratings_and_monthly_aggregates.sql
-- 在 __TENANT_SCHEMA__ 内新增老师评分聚合表 + 月度统计表
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
--
-- 依据：审计报告 P5a + dashboard.repository.ts TODO 标记
--   - rating: 当前返 null（需 teacher_ratings 表）
--   - trend: 当前默认 flat（需 monthly_aggregates 环比）
--
-- 出具：研发负责人  2026-05-05
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §24.1 teacher_ratings — 老师综合评分聚合表
--
-- 由两侧来源汇总：
--   1. parent_recommendations（V17 家长写文字推荐）→ stars 1-5
--   2. lesson_feedbacks 中家长 dimRatings（V18 5 字段：focus/engage/think/homework）
--
-- 每老师 1 行（teacher_id 主键）；触发器或 cron 维护
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teacher_ratings (
    teacher_id          VARCHAR(32)  PRIMARY KEY REFERENCES teachers(id),
    rating_count        INTEGER      NOT NULL DEFAULT 0,
    rating_sum          NUMERIC(10,2) NOT NULL DEFAULT 0,
    avg_stars           NUMERIC(3,2),                 -- ROUND(rating_sum / rating_count, 2)
    last_rated_at       TIMESTAMPTZ,
    -- V18 dimRatings 维度（4 维平均）
    avg_focus           NUMERIC(3,2),
    avg_engage          NUMERIC(3,2),
    avg_think           NUMERIC(3,2),
    avg_homework        NUMERIC(3,2),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tr_avg_stars ON teacher_ratings(avg_stars DESC NULLS LAST);

COMMENT ON TABLE  teacher_ratings IS 'V24 老师评分聚合（V17 家长评 + V18 dim 维度合并）';
COMMENT ON COLUMN teacher_ratings.avg_stars IS '综合评分 1.00-5.00';

-- ----------------------------------------------------------------
-- §24.2 monthly_aggregates — 月度统计快照（用于 trend 环比）
--
-- 每月 1 号 0:30 cron 写一份：
--   key (entity_type, entity_id, month) UNIQUE
--   - entity_type: teacher / campus / tenant
--   - 老师维度：lessons / payroll / fb_count / fb_rate / avg_stars
--
-- dashboard.getTeacherLeaderboard 用本月 vs 上月差比 → trend up/down/flat
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monthly_aggregates (
    id              BIGSERIAL    PRIMARY KEY,
    entity_type     VARCHAR(20)  NOT NULL
                    CHECK (entity_type IN ('teacher','campus','tenant')),
    entity_id       VARCHAR(32)  NOT NULL,
    month           DATE         NOT NULL,             -- 月初 1 号
    -- 通用指标（NULL = 不适用）
    lessons_count   INTEGER,
    payroll_yuan    NUMERIC(12,2),
    feedback_count  INTEGER,
    feedback_rate   NUMERIC(5,2),                      -- 反馈率 0-100%
    avg_stars       NUMERIC(3,2),
    revenue_yuan    NUMERIC(12,2),
    new_signups     INTEGER,
    active_students INTEGER,
    raw_json        JSONB,                             -- 业务自定义字段冗余
    computed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (entity_type, entity_id, month)
);

CREATE INDEX IF NOT EXISTS idx_ma_entity_month
    ON monthly_aggregates(entity_type, entity_id, month DESC);
CREATE INDEX IF NOT EXISTS idx_ma_month
    ON monthly_aggregates(month DESC);

COMMENT ON TABLE  monthly_aggregates
    IS 'V24 月度统计快照（每月 1 号 cron 计算上月数据）';
COMMENT ON COLUMN monthly_aggregates.month
    IS '月份（DATE 类型，月初 1 号）';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   DROP TABLE IF EXISTS monthly_aggregates;
--   DROP TABLE IF EXISTS teacher_ratings;
--   COMMIT;
-- ============================================================
