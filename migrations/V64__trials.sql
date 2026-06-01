-- ============================================================
-- V64__trials.sql
-- 试听课流程（Phase 4，核心·一等公民）— trials 表（tenant schema）
-- 占位：`__TENANT_SCHEMA__` 由 backfill 脚本 sed 替换（tenant-schema migration）
--
-- 来源：../edu-mp-sandbox/docs/2026-06-01-业务链方案-试听激活分配反馈.md Phase 4（需求 #9）
--
-- 业务（试听 = 转化引擎，喂漏斗 + 转化率 KPI）：
--   销售【发起试听】(时间/学员名/科目) ─→ 复用 Phase 3 校长分配规则派教务
--     校长开「自动分配」(campus_assignment_config.auto_assign_academic，与学员分配同一开关) →
--       round-robin 发牌给本校在职 academic + status='pending_teacher'；
--     校长关 → status='pending_assign' 留待校长手动派教务。
--   教务【排老师 + 开启试听】(teacherId/scheduledAt) → status='scheduled'。
--   教务【标记已试听】→ status='done'。
--   销售/教务【试听结果】→ status='converted'（转化签约走既有签约流，不在此自动建合同）/ 'lost'。
--
-- 关键设计决策（prompt 拍板，已定默认）：
--   decision 2：试听挂 **customer（潜客）**，记 student_name（试听学员名，**尚未建正式 student**）
--     + subject。转化签约后才建正式 student。故 trials.student_name 是**反范式字符串**，
--     **不 FK students**（潜客阶段可能还没有正式 student 记录）。
--   decision 3（老师时段冲突）：试听排老师时查老师冲突（该老师该时段不能既有正式课又有试听）。
--     因 trials.student_name 非正式 student（无法塞 schedules 表 — schedules 走 schedule_students
--     FK student_id），改为 trials 自带 teacher_id + scheduled_at，冲突校验**同时查
--     schedules + trials**（该 teacher 该时段段无重叠）。teacher_id 引用 teachers.id（与
--     schedules.teacher_id 同口径），保证两表 teacher 维度可对齐做冲突校验。
--
-- 字段：
--   id                    VARCHAR(32) PK（genId32 = ulid().padEnd(32,'0').slice(0,32)）
--   customer_id           VARCHAR(32) NOT NULL（逻辑 FK → opportunities.id；潜客线索；不加硬 FK，
--                           与 owner_sales_id / assigned_academic_id 风格一致由应用层校验）
--   student_name          VARCHAR(100)（反范式：试听学员名快照，尚未建正式 student）
--   subject               VARCHAR(50)（试听科目）
--   preferred_time        VARCHAR(200)（销售填的期望时间，自由文本，过内容安全）
--   scheduled_at          TIMESTAMPTZ（教务排定的试听时间；冲突校验用）
--   status                VARCHAR(20) NOT NULL DEFAULT 'pending_assign'
--                           CHECK IN (pending_assign / pending_teacher / scheduled / done / converted / lost)
--   assigned_academic_id  VARCHAR(32)（归属教务，逻辑 FK → users.id；NULL = 待分配）
--   teacher_id            VARCHAR(32)（试听老师，逻辑 FK → teachers.id；冲突校验对齐 schedules.teacher_id）
--   campus_id             VARCHAR(32) NOT NULL（试听所在校区；分配池/游标/列表按校区隔离）
--   initiated_by          VARCHAR(32) NOT NULL（发起销售 user.id）
--   result_note           TEXT（试听结果备注，自由文本，过内容安全）
--   converted_contract_id VARCHAR(32)（转化后关联合同 id，可空；预留，本 Phase 不自动写）
--   created_at / updated_at TIMESTAMPTZ DEFAULT now()
--
-- 索引：
--   idx_trials_status               （状态过滤：待分配/待排老师列表）
--   idx_trials_campus               （本校总览/校长待分配）
--   idx_trials_assigned_academic    （教务「我的试听」；部分索引 IS NOT NULL）
--   idx_trials_teacher_scheduled    （decision 3 冲突校验：teacher_id + scheduled_at；部分索引 teacher_id IS NOT NULL）
--
-- 幂等：CREATE TABLE/INDEX IF NOT EXISTS（重跑无害）；无数据 backfill（trials 初始空）。
--
-- 可逆（回退）：DROP TABLE IF EXISTS __TENANT_SCHEMA__.trials;
--             ALTER TABLE __TENANT_SCHEMA__.campus_assignment_config DROP COLUMN IF EXISTS rr_last_trial_academic_id;
--
-- GRANT：新表须 ALTER OWNER TO eduapp（V56 教训：否则应用层 query permission denied）。
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- trials — 试听课对象（完整生命周期）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trials (
  id                     VARCHAR(32)  PRIMARY KEY,
  customer_id            VARCHAR(32)  NOT NULL,                       -- 逻辑 FK → opportunities.id（潜客线索）
  student_name           VARCHAR(100),                               -- 反范式：试听学员名（尚未建正式 student）
  subject                VARCHAR(50),                                -- 试听科目
  preferred_time         VARCHAR(200),                               -- 销售填期望时间（自由文本）
  scheduled_at           TIMESTAMPTZ,                                -- 教务排定试听时间（冲突校验用）
  status                 VARCHAR(20)  NOT NULL DEFAULT 'pending_assign'
                           CHECK (status IN ('pending_assign','pending_teacher','scheduled','done','converted','lost')),
  assigned_academic_id   VARCHAR(32),                                -- 归属教务（逻辑 FK → users.id；NULL = 待分配）
  teacher_id             VARCHAR(32),                                -- 试听老师（逻辑 FK → teachers.id；对齐 schedules.teacher_id）
  campus_id              VARCHAR(32)  NOT NULL,                       -- 试听所在校区
  initiated_by           VARCHAR(32)  NOT NULL,                       -- 发起销售 user.id
  result_note            TEXT,                                       -- 试听结果备注（自由文本）
  converted_contract_id  VARCHAR(32),                                -- 转化后关联合同 id（预留，本 Phase 不自动写）
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE trials IS
  'V64 (Phase 4) 试听课对象 — 销售发起→复用 Phase 3 分配教务→教务排老师/开试听→转化/流失；student_name 反范式（潜客阶段无正式 student，转化后才建）；teacher_id 引用 teachers.id（与 schedules 同口径做冲突校验）';

-- 状态过滤（待分配/待排老师 列表）
CREATE INDEX IF NOT EXISTS idx_trials_status
  ON trials (status);

-- 本校总览/校长待分配
CREATE INDEX IF NOT EXISTS idx_trials_campus
  ON trials (campus_id);

-- 教务「我的试听」（仅索引已分配行）
CREATE INDEX IF NOT EXISTS idx_trials_assigned_academic
  ON trials (assigned_academic_id)
  WHERE assigned_academic_id IS NOT NULL;

-- decision 3 冲突校验：teacher 该时段（仅索引已排老师行）
CREATE INDEX IF NOT EXISTS idx_trials_teacher_scheduled
  ON trials (teacher_id, scheduled_at)
  WHERE teacher_id IS NOT NULL;

-- V56 教训：ALTER OWNER TO eduapp 让应用层有权限 query（避免 permission denied）
ALTER TABLE trials OWNER TO eduapp;

-- ----------------------------------------------------------------
-- 两线独立游标（2026-06-02 用户拍板，SSOT §5.3.2）
--   学员分配（V63）走 campus_assignment_config.rr_last_academic_id；
--   试听分配（本 Phase）走独立列 rr_last_trial_academic_id —— 两线各自轮转互不推进。
--   表 campus_assignment_config 由 V63 创建（版本序先于 V64，此处 ALTER 时已存在）；
--   ADD COLUMN IF NOT EXISTS 幂等（重跑无害）。OWNER 已由 V63 设 eduapp，无需重设。
-- ----------------------------------------------------------------
ALTER TABLE campus_assignment_config
  ADD COLUMN IF NOT EXISTS rr_last_trial_academic_id VARCHAR(32);

COMMENT ON COLUMN campus_assignment_config.rr_last_trial_academic_id IS
  'V64 (Phase 4) 试听 round-robin 独立游标（上次发到的 academic.id；NULL=从头）；与学员分配 rr_last_academic_id 独立，2026-06-02 拍板两线独立';

COMMIT;
