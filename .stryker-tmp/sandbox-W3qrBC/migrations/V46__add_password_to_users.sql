-- ============================================================
-- V46__add_password_to_users.sql
-- Sprint X.2 (2026-05-17) — B 端 user 密码登录改造
--
-- 来源：
--   - SSOT §12.4 admin 唯一创建权 + bcrypt cost=12 初始密码
--   - SSOT §12.7 password_hash 加密 = bcrypt cost=12（V46 migration 新增）
--   - 用户拍板 D2「admin 手动设密码 + modal 显示一次」
--
-- 占位 __TENANT_SCHEMA__ 由 backfill 脚本 sed 替换（V35-V44 同模式）
--
-- 设计：
--   - password_hash VARCHAR(60) NOT NULL DEFAULT ''
--     长度 60 = bcrypt 标准输出（$2b$12$ + 22 char salt + 31 char hash）
--     DEFAULT '' 兜底旧 user row（V46 之前创建的 user，应用层登录时 password_hash='' → 401
--     友好提示「请联系 admin 重置密码」；新 user 必走 admin 创建 endpoint 注入 bcrypt hash）
--   - password_updated_at TIMESTAMPTZ NULL（NULL = 旧 row / 未改密；非 NULL = 改密时间戳）
--
-- 不在本 migration：
--   - parents.password_hash（D3 推 Sprint X+1，C 端家长本 Sprint 仍走 wx-jscode2session）
--   - 老 user backfill 密码（admin 手动重置流程见 backlog）
--   - bcrypt 库安装（应用层依赖，package.json 已加 bcryptjs@^3.0.3 pure JS 无 native binding）
--     Round 2 (2026-05-17 security A06): 早期注释误写 bcrypt@^5.1.1，实际选 bcryptjs 避免 6 HIGH CVE
--     (tar via @mapbox/node-pre-gyp via bcrypt 间接依赖) + node-gyp 编译失败风险
--
-- 出具：edu-server backend  2026-05-17
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(60) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ NULL;

-- GRANT 教训（V43 注释 + 生产 2026-05-13 实战）：新列必须显式 GRANT 给 eduapp user
GRANT SELECT, INSERT, UPDATE ON users TO eduapp;

COMMENT ON COLUMN users.password_hash IS 'V46 bcrypt cost=12; DEFAULT '''' 兜底旧 row, 应用层 login 校验 hash!='''' 否则 401';
COMMENT ON COLUMN users.password_updated_at IS 'V46 最后改密时间; NULL = 旧 row 或未改密';

COMMIT;

-- ============================================================
-- 回滚（紧急时用）：
--   BEGIN;
--   SET LOCAL search_path = __TENANT_SCHEMA__, public;
--   ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
--   ALTER TABLE users DROP COLUMN IF EXISTS password_updated_at;
--   COMMIT;
-- ============================================================
