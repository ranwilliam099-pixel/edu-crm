-- ============================================================
-- V39__rename_hourly_rate_to_hourly_price.sql
-- 在 __TENANT_SCHEMA__ 内：
--   将 teachers.hourly_rate_yuan 列重命名为 hourly_price_yuan
--   并更新列注释（明确语义为「机构对老师的课时定价」，与「工资」解耦）
--
-- 占位：__TENANT_SCHEMA__ 由 backfill-v39.sh 替换
--
-- 依据：
--   - feedback_教培业务架构-2026-05-10.md §4 拍板「薪资全删」
--   - 但 hourly_rate_yuan 字段语义本质是「机构对老师的课时单价」
--     （课消金额计算基础 = 单价 × 已消课时数），与「工资」是两件事
--   - business-rules-validator 红线：字段名 + 注释暗含「工资」语义需解耦
--   - main session 5/11 拍板方案 C：改名 + 改注释，不删字段
--     （删字段会破坏 course-consumption 整条线，影响课消金额计算）
--
-- 业务影响：
--   - 字段名从 hourly_rate_yuan → hourly_price_yuan
--   - 字段语义：从「课时单价（用于工资计算）」→「课时单价（机构对老师的定价）」
--   - 应用层同步：TS field hourlyRateYuan → hourlyPriceYuan（14 处使用点）
--   - 数据库聚合能力中性保留（feedback module 的 course-consumption.amount_yuan
--     是流水字段，跟单价是不同字段，不动）
--
-- 幂等保证：
--   - 用 DO $$ 块包裹 IF EXISTS 列存在性检查，重跑无害
--   - 已 RENAME 过的 schema 直接跳过（INFO NOTICE 无害）
--
-- W3 红线：BEGIN / SET LOCAL search_path / COMMIT 完整事务
-- W4 红线：RENAME COLUMN 是可逆操作，回滚 SQL 在文件末尾
--          但仍按 V37 规范走 pg_dump 备份探测（backfill-v39.sh 含 W2）
--
-- 出具：研发负责人  2026-05-11
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- 主操作：RENAME COLUMN（用 DO 块包裹 IF EXISTS 实现幂等）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'teachers'
      AND column_name = 'hourly_rate_yuan'
  ) THEN
    ALTER TABLE teachers RENAME COLUMN hourly_rate_yuan TO hourly_price_yuan;
    RAISE NOTICE 'V39: renamed teachers.hourly_rate_yuan → hourly_price_yuan in %', current_schema();
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'teachers'
      AND column_name = 'hourly_price_yuan'
  ) THEN
    RAISE NOTICE 'V39: already renamed in %, skip', current_schema();
  ELSE
    RAISE WARNING 'V39: neither hourly_rate_yuan nor hourly_price_yuan found in %.teachers', current_schema();
  END IF;
END $$;

-- 更新列注释（语义明确化：与「工资」解耦）
COMMENT ON COLUMN teachers.hourly_price_yuan
    IS '课时单价（机构对老师的定价，单位元 / NUMERIC(10,2)）— V39 RENAMED from hourly_rate_yuan；与课消金额计算关联，与工资业务无关';

COMMIT;

-- ============================================================
-- 回滚（RENAME 是可逆的，回滚仅需反向 RENAME）：
--
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   DO $$
--   BEGIN
--     IF EXISTS (
--       SELECT 1 FROM information_schema.columns
--       WHERE table_schema = current_schema()
--         AND table_name = 'teachers'
--         AND column_name = 'hourly_price_yuan'
--     ) THEN
--       ALTER TABLE teachers RENAME COLUMN hourly_price_yuan TO hourly_rate_yuan;
--     END IF;
--   END $$;
--   COMMENT ON COLUMN teachers.hourly_rate_yuan IS '课时单价（用于工资计算）';
--   COMMIT;
--
-- ⚠️ 注意：回滚 SQL 仅恢复列名，应用层 TS 代码同步回滚（git revert）
-- ============================================================
