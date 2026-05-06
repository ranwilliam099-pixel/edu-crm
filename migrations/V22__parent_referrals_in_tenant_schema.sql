-- ============================================================
-- V22__parent_referrals_in_tenant_schema.sql
-- 在 __TENANT_SCHEMA__ 内新增"家长推荐家长"表（V20 推荐机制）
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
--
-- 依据：用户 V10 策略第 17-22 项决策
--   - A 是该老师学员家长 → 推 B 试听 → 评价后老师 +1
--   - 仅小程序码私聊（不朋友圈一键转）
--   - 业务卡 profile 顶部 stats（与评分并排）
--   - 推荐墙文字 + 推荐次数（并存）
--   - A 不限次数，B 唯一（一个家长只能被推荐一次）
--   - 无奖励（V10 阶段）
--
-- 区别 V17 (parent_recommendations)：
--   V17 = 家长写文字推荐内容（老师业务卡展示墙）
--   V22 = A 推 B 的关系链（计数 + 转化追踪）
--
-- 出具：研发负责人  2026-05-05
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §22.1 parent_referrals — A 推 B 关系链
-- 状态机：created → trialed → rated（计数 +1）/ expired
--   - created: A 生成推荐码（pending 状态，未联系到 B）
--   - trialed: B 通过码注册并完成首次试听（teacher 视角是新学员）
--   - rated:   B 评价老师（不论星数）→ 触发计数 +1
--   - expired: 30 天内 B 没试听
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parent_referrals (
    id                       VARCHAR(32)   PRIMARY KEY,
    teacher_id               VARCHAR(32)   NOT NULL REFERENCES teachers(id),
    referrer_parent_id       VARCHAR(32)   NOT NULL,  -- A：推荐人（public.parents 跨 schema 无 FK）
    referrer_student_id      VARCHAR(32)   NOT NULL REFERENCES students(id),
                                                       -- A 的孩子（用于校验"是否该老师学员家长"）
    referee_parent_id        VARCHAR(32),               -- B：被推荐人（绑定后填入；NULL=未到达）
    referee_student_id       VARCHAR(32)  REFERENCES students(id),
                                                       -- B 的孩子（试听后绑定）
    referral_code            VARCHAR(40)   NOT NULL UNIQUE,
                                                       -- 小程序码 / scene 字符串
    status                   VARCHAR(20)   NOT NULL DEFAULT 'created'
                             CHECK (status IN ('created','trialed','rated','expired')),
    trial_schedule_id        VARCHAR(32)   REFERENCES schedules(id),
                                                       -- 触发 trialed 的试听排课
    rating_id                VARCHAR(32),               -- 触发 rated 的评价 id（lesson_feedbacks 或 parent_recommendations）
    rating_id_source         VARCHAR(20)
                             CHECK (rating_id_source IS NULL OR rating_id_source IN ('lesson_feedback','parent_recommendation')),
    created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    trialed_at               TIMESTAMPTZ,
    rated_at                 TIMESTAMPTZ,
    expires_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW() + INTERVAL '30 days',
    note                     VARCHAR(256)
);

-- B 唯一性：每个 referee_parent_id 只能被推荐一次（NULL 不参与 UNIQUE 检查）
CREATE UNIQUE INDEX IF NOT EXISTS uq_pr_referee_parent
    ON parent_referrals(referee_parent_id)
    WHERE referee_parent_id IS NOT NULL;

-- 老师维度计数查询索引
CREATE INDEX IF NOT EXISTS idx_pr_teacher_status
    ON parent_referrals(teacher_id, status);

-- A 维度（一个 A 推几个 B）
CREATE INDEX IF NOT EXISTS idx_pr_referrer
    ON parent_referrals(referrer_parent_id, created_at DESC);

-- 邀请码反查
CREATE INDEX IF NOT EXISTS idx_pr_code
    ON parent_referrals(referral_code);

-- 过期巡检索引（cron 每天扫 created + expires_at < NOW）
CREATE INDEX IF NOT EXISTS idx_pr_pending_expires
    ON parent_referrals(expires_at) WHERE status = 'created';

COMMENT ON TABLE  parent_referrals
    IS 'V22 家长推荐家长关系链（V10 策略 #17-22 推荐机制）';
COMMENT ON COLUMN parent_referrals.referrer_parent_id
    IS 'A：推荐人 parent_id；必须是该 teacher 学员的家长';
COMMENT ON COLUMN parent_referrals.referee_parent_id
    IS 'B：被推荐人 parent_id；UNIQUE（一个家长只能被推荐一次）';
COMMENT ON COLUMN parent_referrals.status
    IS '状态机：created → trialed → rated（计数 +1）/ expired';
COMMENT ON COLUMN parent_referrals.referral_code
    IS '小程序码 scene 字符串（前端生成 wxacode 时传入）';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   DROP TABLE IF EXISTS parent_referrals;
--   COMMIT;
-- ============================================================
