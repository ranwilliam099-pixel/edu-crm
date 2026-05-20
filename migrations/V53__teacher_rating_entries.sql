-- ============================================================
-- V53__teacher_rating_entries.sql
-- 在 __TENANT_SCHEMA__ 内新增老师评分明细表（家长一对一评分）
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换
--
-- 依据：P4-Y 任务（2026-05-20）— 4 个 C 端 endpoint 之一
--   POST /db/teacher-ratings：家长评老师（5 星 + content + tags）
--   业务规则：
--     - parent + teacher + student 三元组唯一（同一对评分仅 1 条；重复 → PATCH 而非 INSERT）
--     - content 必走 wx.security.msgSecCheck
--     - teacher 必须在 parent 孩子的 binding/schedule 老师范围内
--
-- 与 V24 的差异：
--   - V24 teacher_ratings 是聚合表（PK = teacher_id，每老师 1 行总分平均）
--   - V53 teacher_rating_entries 是明细表（PK = id，每次评分 1 行；UNIQUE(parent,teacher,student)）
--   - V53 写入后由应用层或 cron 同步更新 V24 聚合表（本 migration 仅建表，聚合留 Sprint Y）
--
-- 出具：P4-Y leader  2026-05-20
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §53.1 teacher_rating_entries — 家长老师评分明细表
--
-- 字段：
--   id            32-char ULID PK（与全表风格一致）
--   parent_id     家长 ID（VARCHAR(32) 对应 public.parents.id，跨租户 FK 不加；仅业务校验）
--   teacher_id    老师 ID（FK teachers.id）
--   student_id    学员 ID（FK students.id）
--   stars         评分 1-5 整数
--   content       文本评价（≤ 2000，必走 msgSecCheck）
--   tags          标签数组（JSONB，例 ['#耐心','#讲解清楚']）
--   created_at / updated_at  时间戳
--   created_by    parent_id（与 parent_id 重复，但 audit 一致性留用）
--
-- 业务规则（应用层 + DB 双层）：
--   - 三元组唯一（UNIQUE(parent_id, teacher_id, student_id)）— 重复评分 → PATCH 而非 INSERT
--   - stars CHECK 1-5
--   - content / tags 可空（用户可以只打星不写评论）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teacher_rating_entries (
    id          VARCHAR(32)  PRIMARY KEY,
    parent_id   VARCHAR(32)  NOT NULL,
    -- 5/20 P5 三审 security P2-3 (A05): 老师/学员被物理删除时评分历史 CASCADE
    -- 业务语义：评分是绑定学员-老师 三元组的数据，源数据消失时评分失意义；
    -- 软删（deleted_at）仍保留评分（FK 仍指向行，只是 deleted_at 非空）
    -- 物理 DROP（极少，仅 DROP TABLE 时 / 数据清理脚本）→ CASCADE 避免 23503 阻断
    teacher_id  VARCHAR(32)  NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    student_id  VARCHAR(32)  NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    stars       SMALLINT     NOT NULL CHECK (stars BETWEEN 1 AND 5),
    content     TEXT         NULL,
    tags        JSONB        NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by  VARCHAR(32)  NOT NULL,
    -- 三元组唯一（业务规则：每对 parent×teacher×student 仅一份评分）
    CONSTRAINT uq_tre_parent_teacher_student
        UNIQUE (parent_id, teacher_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_tre_teacher_id ON teacher_rating_entries(teacher_id);
CREATE INDEX IF NOT EXISTS idx_tre_student_id ON teacher_rating_entries(student_id);
CREATE INDEX IF NOT EXISTS idx_tre_parent_id  ON teacher_rating_entries(parent_id);

COMMENT ON TABLE  teacher_rating_entries
    IS 'V53 老师评分明细表（每对 parent×teacher×student 唯一一条）— P4-Y 2026-05-20';
COMMENT ON COLUMN teacher_rating_entries.parent_id
    IS '家长 ID（对应 public.parents.id，跨租户不加 FK 仅业务校验）';
COMMENT ON COLUMN teacher_rating_entries.content
    IS '文本评价（≤ 2000，写入前必走 wx.security.msgSecCheck）';
COMMENT ON COLUMN teacher_rating_entries.tags
    IS '标签数组（JSONB 例 [\"#耐心\",\"#讲解清楚\"]）';

COMMIT;

-- ============================================================
-- 回滚：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   DROP TABLE IF EXISTS teacher_rating_entries;
--   COMMIT;
-- ============================================================
