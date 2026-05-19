-- ============================================================
-- V50__drop_teachers_hourly_price.sql
-- X1 重构：物理删除 teacher.hourly_price_yuan 字段
--
-- 来源：用户 2026-05-19 拍板 D1.4 X1 方案
--   「老师页面零财务字段」+ 物理 > 逻辑 > 文档保护
--
-- 业务影响：
--   - 课消计算从合同带价（contract.coursePrice / contract.lessonHours）
--     而不是从「老师定价」（每个客户合同价格不同）
--   - 老师档案彻底无财务概念（防御深度：DB 没字段 = 任何 SQL 注入 /
--     API leak 都不会 expose）
--   - SSOT/fields-by-role.md teacher 字段矩阵本来就无此字段，本次代码对齐
--
-- 兼容性：
--   - 调用方已先行改造（teacher.repository + teacher.service + DTO + role-field-filter
--     + 上下游 spec 全部移除 hourlyPriceYuan 字段）
--   - 任何残留 SELECT hourly_price_yuan 会 PG 报错（早期暴露，不允许遗留路径）
--
-- 跟 Sprint Y backlog #2 (phone plaintext dual-write) 同性质遗留清理，
-- 本期一起清。
--
-- 占位符：__TENANT_SCHEMA__ 由 backfill-v50.sh 替换
--
-- 幂等保证：
--   - 用 DO $$ 块包裹 IF EXISTS 列存在性检查，重跑无害
--   - 已 DROP 过的 schema 直接 RAISE NOTICE 后 RETURN
--
-- W3 红线：BEGIN / SET LOCAL search_path / COMMIT 完整事务
-- W4 红线：DROP COLUMN 不可逆，回滚需重建列 + 重新人工录入数据（数据已丢失）
--          但 ALTER TABLE 是 DDL，COMMIT 后无法回滚到 SET LOCAL search_path 之前；
--          backfill-v50.sh 走 W2 pg_dump 备份探测，回滚靠备份恢复
--
-- 出具：edu-server backend  2026-05-19 (Day 2 Phase C X1)
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- 主操作：DROP COLUMN（用 DO 块包裹 IF EXISTS 实现幂等）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'teachers'
      AND column_name = 'hourly_price_yuan'
  ) THEN
    RAISE NOTICE 'V50: column hourly_price_yuan does not exist in %.teachers (already dropped or never created), skip', current_schema();
    RETURN;
  END IF;

  -- 物理删字段（DDL，事务内不可逆；COMMIT 后通过备份恢复）
  ALTER TABLE teachers DROP COLUMN hourly_price_yuan;
  RAISE NOTICE 'V50: dropped teachers.hourly_price_yuan in %', current_schema();
END $$;

COMMIT;

-- ============================================================
-- 回滚（DROP COLUMN 不可逆，需重建列 + 重新录入数据）：
--
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   ALTER TABLE teachers ADD COLUMN hourly_price_yuan NUMERIC(10,2);
--   COMMENT ON COLUMN teachers.hourly_price_yuan
--       IS '课时单价（机构对老师的定价，单位元 / NUMERIC(10,2)）— 回滚自 V50 DROP';
--   -- 数据恢复：需从 pg_dump 备份（backfill-v50.sh --apply 前自动 dump）恢复
--   COMMIT;
--
-- ⚠️ 注意：回滚后必须同步 git revert 应用层 commit（teacher.repository / dto /
--    role-field-filter / spec 全部恢复 hourlyPriceYuan 字段引用）
-- ============================================================
