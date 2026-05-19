-- ----------------------------------------------------------------------------
-- 5/15 A-2 backfill：sales_director → sales_manager 数据迁移（备用，需 leader 拍板执行）
--
-- 背景：
--   5/15 用户口头拍板取消 sales_director 岗位（不在 fields-by-role.md 9 角色清单）
--   应用层已全删（@Roles / login validRoles / jwt CROSS_CAMPUS_ROLES / actorGroupOf）
--
--   schema 层 V2 / V33 CHECK constraint 仍允许 sales_director（不可逆，已生产）
--   如生产 PG 实际有 role='sales_director' 用户 → jwt.strategy 拒绝识别为跨校
--   → 该用户登录会即时锁出（403 / 401）
--
-- 三选一策略（用户拍板）：
--   方案 A：sales_director → sales_manager（销售校内主管，单校）
--     - 适用：原 sales_director 实际仅管 1 个 campus 销售团队
--     - 需补 users.campus_id（原跨校 = NULL，sales_manager 单校必填）→ 建议手动逐个核对
--
--   方案 B：sales_director → admin（跨校系统管理员）
--     - 适用：原 sales_director 实际跨多校管理（大区经理）
--     - 数据风险：admin 权限更高，需评估是否合规
--
--   方案 C：sales_director → 离职（status='停用'）
--     - 适用：岗位调整 + 实际无对应人员
--     - 触发 findTransferTarget 自动转交流程
--
-- 本脚本默认实现方案 A（最安全）；方案 B/C 见下方注释
--
-- 执行前：
--   1. pg_dump 备份（参考 scripts/backup/ 目录）
--   2. 逐 tenant 评估实际有多少 sales_director 用户：
--      SELECT id, name, campus_id, status FROM <schema>.users WHERE role = 'sales_director';
--   3. 决定方案 A/B/C
--   4. 单 tenant 跑测，OK 再批量
--
-- 跑法：
--   - schema-per-tenant：__TENANT_SCHEMA__ 占位符由 bash 循环替换
--   - 参考 scripts/backfill-v35.sh 模式
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 方案 A：sales_director → sales_manager（默认，最安全）
-- ----------------------------------------------------------------------------

-- 1. 评估：列出现有 sales_director 用户
-- SELECT id, name, campus_id, status, created_at
--   FROM __TENANT_SCHEMA__.users
--  WHERE role = 'sales_director';

-- 2. 迁移：sales_director → sales_manager
--    - campus_id 必须非空（sales_manager 单校 role）
--    - 如 campus_id 为 NULL（V10 拍板跨校组 = NULL）→ 手动指定主校区
UPDATE __TENANT_SCHEMA__.users
   SET role = 'sales_manager',
       updated_at = NOW()
 WHERE role = 'sales_director'
   AND campus_id IS NOT NULL;  -- 仅迁移有 campus_id 的；NULL 的需手动处理

-- 3. 留痕：audit_log（写入 'system' actor 记录变更）
INSERT INTO __TENANT_SCHEMA__.audit_log
  (actor_user_id, actor_role, action, target_type, target_id, before, after, ip, user_agent, request_id)
SELECT
  NULL,                                      -- actor_user_id（系统操作）
  'system',                                  -- actor_role
  'user.role-migration-a2',                  -- action
  'user',                                    -- target_type
  u.id,                                      -- target_id
  jsonb_build_object('role', 'sales_director'),
  jsonb_build_object('role', 'sales_manager', 'reason', '5/15 A-2 拍板取消 sales_director'),
  NULL, NULL, NULL
FROM __TENANT_SCHEMA__.users u
WHERE u.role = 'sales_manager'
  AND u.updated_at >= NOW() - INTERVAL '1 hour';  -- 仅记录刚刚迁移的

-- 4. 验证：迁移后应为 0
-- SELECT COUNT(*) FROM __TENANT_SCHEMA__.users WHERE role = 'sales_director';
-- 预期：0

-- ----------------------------------------------------------------------------
-- 方案 B：sales_director → admin（仅在确认是大区经理时执行；注释默认禁用）
-- ----------------------------------------------------------------------------
-- UPDATE __TENANT_SCHEMA__.users
--    SET role = 'admin', updated_at = NOW()
--  WHERE role = 'sales_director';

-- ----------------------------------------------------------------------------
-- 方案 C：sales_director → 离职（触发 findTransferTarget 自动转交流程）
-- ----------------------------------------------------------------------------
-- 注：本方案需配合应用层 lifecycle deactivate endpoint，不直接 UPDATE
--     ssh 进生产后调 POST /api/lifecycle/deactivate-user 逐个处理
--     参考 src/modules/lifecycle/lifecycle.controller.ts deactivateUser endpoint

-- ----------------------------------------------------------------------------
-- NULL campus_id 的特殊处理（方案 A 兜底，跨校 sales_director 历史数据）
-- ----------------------------------------------------------------------------
-- 这类用户 campus_id IS NULL（原跨校组），需 leader 决策每个用户的主校区
-- 建议逐个 SQL 手动 UPDATE：
--   UPDATE __TENANT_SCHEMA__.users
--      SET role = 'sales_manager',
--          campus_id = '<assigned_campus_ulid>',
--          updated_at = NOW()
--    WHERE id = '<user_ulid>';
