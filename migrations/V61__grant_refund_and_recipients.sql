-- ============================================================
-- V61__grant_refund_and_recipients.sql
-- 一次性补 V59/V60 漏掉的 GRANT (2026-05-23 真机验证发现 P0 生产 bug)
-- 占位：`__TENANT_SCHEMA__` 由 backfill 脚本 sed 替换
--
-- 根因（§14.2「诊断必有佐证」实证）：
--   - pm2 logs: `error: permission denied for table refund_orders
--     at PgPoolService.tenantQuery (pg-pool.service.ts:78:22)
--     at RefundRepository.listPendingInDb (refund.repository.ts:132:18)`
--   - V59 sql 60 行无任何 GRANT 语句 (V60 同样)
--   - 16 tenants 表 CREATE 完毕但 owner=postgres / eduapp 0 privileges
--   - 与 V46__add_password 注释「GRANT 教训（V43 + 2026-05-13 生产实战）」同模式重蹈覆辙
--
-- 影响：
--   - /api/db/refunds/{pending,list,apply,decide,:id} 全 500 (V59 全废)
--   - assessment/record 录分 / counts batch (V60 部分路径未触发 500 但同隐患)
--   - home attentionStats refundPending=0 假值 (kpi/home-alerts SQL fail-open 吞错)
--
-- GRANT 范围 (与 V46 users 同模式)：
--   - refund_orders: SELECT, INSERT, UPDATE (无 DELETE — 审批不删除，audit 留痕)
--   - assessment_recipients: SELECT, INSERT, UPDATE, DELETE (recipients fan-out 可删除重建)
--
-- 幂等：GRANT 重复执行 PG 自动忽略不报错
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- V59 refund_orders
GRANT SELECT, INSERT, UPDATE ON refund_orders TO eduapp;

-- V60 assessment_recipients
GRANT SELECT, INSERT, UPDATE, DELETE ON assessment_recipients TO eduapp;

COMMIT;
