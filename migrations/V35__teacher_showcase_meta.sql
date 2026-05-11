-- ============================================================
-- V35__teacher_showcase_meta.sql
-- 在 __TENANT_SCHEMA__ 内：
--   新建 teacher_showcase_meta 美化展示数据表（双轨数据基础设施）
--
-- 占位：__TENANT_SCHEMA__ 由租户初始化 worker 替换
--
-- 依据：
--   - docs/fields-by-role.md 第 III 节「教师档案 teacher（23 字段）」
--   - 重大决策：**老师 showcase 卡里的数据可以美化**（不影响系统真实数据用于统计）
--   - 用户 2026-05-10 全局规则 #3：「老师业务展示卡双轨 — 老师可美化展示数据
--     （家长/销售看的），但系统真实数据另存（用于业绩 KPI / 工资计算）」
--
-- 设计哲学（双轨数据 critical 决策）：
--   teacher 表（V7，不动）= 系统真实数据
--     - phone / hourly_rate_yuan / status / subjects
--     - 给 dashboard / 工资 / KPI / 排课资源池用
--
--   teacher_showcase_meta 表（V35，本 migration）= 老师可美化数据
--     - avatar_url（自传/换脸）
--     - bio（美化简介，可与 teacher.bio 并存 — 见 §冲突处理）
--     - video_urls（教学视频）
--     - testimonials（评价墙）
--     - displayed_recommendations_count（展示推荐数，仅给客户看，不参 KPI）
--     - trial_available（是否提供试听）
--     - 给销售展示卡 / 家长选老师 / 老师业务卡用
--
-- ⚠️ 硬红线（接入层必须遵守）：
--   - KPI / leaderboard / 工资 / 漏斗 → 用 teacher 表 + teacher_ratings (V24)
--   - showcase 展示 / 销售卡 / 家长选讲老师 → 用本表（meta）
--   - 严禁 showcase 字段进入 KPI 统计（硬违规）
--
-- §冲突处理：teacher.bio 与 meta.bio 同名
--   方案 B（已采用）：两表并存，文档化约定
--     - teacher.bio = legacy（系统记录的初始档案简介，不再编辑）
--     - meta.bio    = canonical（老师可随时美化的展示简介）
--     - Repository 读取优先级（C.2 待做）：
--         showcase 视图 → meta.bio ?? teacher.bio ?? null
--         系统视图     → teacher.bio（保持稳定）
--   选项 A（已否决）：teacher.bio 移到 meta — 风险破坏 V7 现有逻辑 + 单测
--
-- 设计：
--   - teacher_id 是 PK（1:1 关系，每老师最多 1 行 meta）
--   - 所有美化字段 NULLABLE（meta 缺失时 fallback 到 teacher 表 / 隐藏 UI 卡）
--   - video_urls / testimonials 用 JSONB（结构化数据，未来扩展灵活）
--   - displayed_recommendations_count 是「老师 toggle 选中的推荐数」
--     与 V17 parent_recommendations.displayed=true 行数对齐
--     冗余存储为 INT 是为了减少 showcase 查询时的 join 成本
--     (C.3 待做：parent_recommendations toggle 时同步本字段)
--   - updated_by_user_id 审计字段，配合 V33 audit_log 记 meta.update 动作
--
-- 容量预估：30 家 × 50 老师 = 1500 行/家平均；全租户合计 ~10K，无分区压力
--
-- 出具：研发负责人  2026-05-11
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

CREATE TABLE IF NOT EXISTS teacher_showcase_meta (
    teacher_id                       VARCHAR(32) PRIMARY KEY
                                     REFERENCES teachers(id) ON DELETE CASCADE,

    -- 美化资料（可空 → 前端 fallback teacher 表或隐藏）
    avatar_url                       TEXT,
    bio                              TEXT,
    video_urls                       JSONB NOT NULL DEFAULT '[]'::jsonb,
    testimonials                     JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- 展示数（老师手选）— 与 KPI 真实数据隔离
    displayed_recommendations_count  INTEGER NOT NULL DEFAULT 0
                                     CHECK (displayed_recommendations_count >= 0),

    -- 试听标识（给销售推荐时显示）
    trial_available                  BOOLEAN NOT NULL DEFAULT FALSE,

    -- 审计字段
    created_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by_user_id               VARCHAR(32)
);

-- 索引：trial_available 用于销售推荐筛选「可试听老师」
CREATE INDEX IF NOT EXISTS idx_tsm_trial_available
    ON teacher_showcase_meta(trial_available)
    WHERE trial_available = TRUE;

-- 索引：displayed_recommendations_count 用于按推荐数排序展示
CREATE INDEX IF NOT EXISTS idx_tsm_disp_rec_count
    ON teacher_showcase_meta(displayed_recommendations_count DESC);

-- 索引：updated_at 用于 cron 增量同步
CREATE INDEX IF NOT EXISTS idx_tsm_updated_at
    ON teacher_showcase_meta(updated_at DESC);

COMMENT ON TABLE  teacher_showcase_meta
    IS 'V35 老师 showcase 美化数据表（双轨：与 teachers 系统真实数据隔离，仅展示用，严禁参与 KPI）';
COMMENT ON COLUMN teacher_showcase_meta.teacher_id
    IS '老师 ID（FK to teachers.id，PK 即 1:1，每老师最多 1 行 meta）';
COMMENT ON COLUMN teacher_showcase_meta.avatar_url
    IS '美化头像 URL（销售卡 / 家长选老师页显示；与 dashboard avatar 共用 fallback：meta.avatar_url 优先）';
COMMENT ON COLUMN teacher_showcase_meta.bio
    IS 'V35 美化简介（canonical）— teacher.bio 已变 legacy。读取规则：showcase 视图 meta.bio ?? teacher.bio；系统视图 teacher.bio';
COMMENT ON COLUMN teacher_showcase_meta.video_urls
    IS '教学视频 URL 列表 [{ "url": ..., "title": ..., "duration_seconds": ... }]';
COMMENT ON COLUMN teacher_showcase_meta.testimonials
    IS '评价墙 [{ "anon_name": "...", "content": "...", "stars": 5, "submitted_at": "..." }]（与 V17 parent_recommendations 区分：本字段是老师自填的外部好评，可手动编辑）';
COMMENT ON COLUMN teacher_showcase_meta.displayed_recommendations_count
    IS '老师勾选「展示在业务卡」的推荐数（与 V17 parent_recommendations.displayed=true 同步，C.3 待做）；严禁进 KPI/leaderboard 统计';
COMMENT ON COLUMN teacher_showcase_meta.trial_available
    IS '是否提供试听课（销售推荐时筛选；只影响 UI 展示）';
COMMENT ON COLUMN teacher_showcase_meta.updated_by_user_id
    IS '最后一次美化编辑操作人 user.id（配合 V33 audit_log 追溯）';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   DROP TABLE IF EXISTS teacher_showcase_meta;
--   COMMIT;
-- ============================================================

-- ============================================================
-- 后续步骤（不在本 migration）：
--   C.2 Repository / Service / Controller 改造：
--     1. src/modules/db/teacher-showcase-meta.repository.ts
--        - getMeta(tenantSchema, teacherId) → TeacherShowcaseMeta | null
--        - upsertMeta(tenantSchema, teacherId, payload, operator) → upsert + audit_log
--        - syncDisplayedRecCount(tenantSchema, teacherId) → 重算 V17.displayed=true
--     2. TeacherShowcaseController GET /db/teachers/:id/showcase 改造
--        - 当前 11 项 KPI 聚合（保留，仍走系统真实数据）
--        - 新增 meta 字段（avatar_url / bio / video_urls / testimonials / trial_available）
--        - 顶层结构：{ teacher, summary（系统真实 KPI）, meta（美化展示）}
--     3. 新 endpoint：PUT /db/teachers/:id/showcase-meta（老师自己编辑）
--        - @UseGuards(TenantScopeGuard) + @UseInterceptors(IdempotencyInterceptor)
--        - audit_log 记 'teacher.showcase-meta.update'
--        - RoleFieldFilter：仅 teacher（self）/ admin / boss 可改
--
--   C.3 V17.displayed toggle 时同步 meta.displayed_recommendations_count
--     - parent-recommendation.repository.toggleDisplayed → 事务内更新 meta count
--
--   迁移历史 bio 数据（可选，不强制）：
--     INSERT INTO teacher_showcase_meta (teacher_id, bio, created_at, updated_at)
--     SELECT id, bio, NOW(), NOW() FROM teachers WHERE bio IS NOT NULL
--     ON CONFLICT (teacher_id) DO NOTHING;
-- ============================================================
