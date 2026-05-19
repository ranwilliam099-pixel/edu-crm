/**
 * X1 防回归 spec — 课消重构（D1.4 拍板）
 *
 * 来源：
 *   - 2026-05-19 D1.4 leader 拍板：「老师页面零财务字段，hourly_price_yuan 物理删除」
 *   - migrations/V50__drop_teachers_hourly_price.sql 已 deploy 15/15 tenant DROP COLUMN
 *   - plan §X1: 「CI 含 grep hourlyPriceYuan src/ 应零命中」
 *
 * 目的：
 *   防止未来 dev 误重新引入 hourly_price_yuan SELECT / INSERT / UPDATE / 字段引用。
 *   一旦真实生产代码（src/modules + src/common）出现该字段任何 SQL 操作 → 此 spec 立即失败。
 *
 * 边界：
 *   - 注释 / 防回归 spec 自身 / migrations / docs 不算回归（明文标注「已删」）
 *   - 仅 SQL 操作（SELECT/INSERT/UPDATE）+ 业务字段引用 算回归
 *
 * 与 X1 双管齐下：
 *   - L1 spec (teacher.repository.spec.ts) 验单元行为
 *   - 本 spec (time-drift) 验「未来不允许复活」
 */

import { execSync } from 'child_process';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

function runGrep(pattern: string, paths: string[]): string {
  // -E 扩展正则 / -r 递归 / -n 行号 / --include 限 .ts
  // || echo "" 容错（无命中时 grep exit 1）
  const includeFlags = '--include="*.ts"';
  const pathsStr = paths.join(' ');
  // 转义双引号包裹的 pattern
  const cmd = `cd ${REPO_ROOT} && grep -rEn ${includeFlags} "${pattern}" ${pathsStr} 2>/dev/null || echo ""`;
  return execSync(cmd, { encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 });
}

describe('[L10 时序漂移 X1] hourly_price_yuan 防回归（D1.4 拍板永久禁用）', () => {
  it('X1.1 src/modules 不含 hourly_price_yuan 在 SELECT / INSERT / UPDATE SQL 中', () => {
    // 严格：任意 SELECT/INSERT/UPDATE 同行出现 hourly_price_yuan
    const out = runGrep('(SELECT|INSERT|UPDATE).*hourly_price_yuan', ['src/modules']);

    // 注释行不算（//、/* */、* 开头）— 但 grep 不区分，所以二次过滤
    const lines = out.split('\n').filter((l) => l.trim().length > 0);
    const realHits = lines.filter((line) => {
      // line format: src/path:N:content
      const contentIdx = line.split(':', 3).join(':').length + 1;
      const content = line.substring(contentIdx).trim();
      if (content.startsWith('//') || content.startsWith('/*') || content.startsWith('*')) {
        return false; // 注释豁免
      }
      return true;
    });

    expect(realHits).toEqual([]); // 应零真实 SQL 命中
  });

  it('X1.2 src/common 不含 hourly_price_yuan 在 SELECT / INSERT / UPDATE SQL 中', () => {
    const out = runGrep('(SELECT|INSERT|UPDATE).*hourly_price_yuan', ['src/common']);
    const lines = out.split('\n').filter((l) => l.trim().length > 0);
    const realHits = lines.filter((line) => {
      const contentIdx = line.split(':', 3).join(':').length + 1;
      const content = line.substring(contentIdx).trim();
      if (content.startsWith('//') || content.startsWith('/*') || content.startsWith('*')) {
        return false;
      }
      return true;
    });
    expect(realHits).toEqual([]);
  });

  it('X1.3 src/ 整体 hourly_price_yuan 仅注释 / migration / spec 防回归 出现（非业务代码）', () => {
    // 全 src/ 找 hourly_price_yuan 任何出现
    const out = runGrep('hourly_price_yuan', ['src']);

    // 接受的来源（路径白名单）：
    //   - src/**/*.spec.ts （单元 / 防回归 spec 含字面量）
    //   - 注释行（// 或 /* 或 * 开头）
    //   - migrations 目录（V50 注释「已 DROP」）
    const lines = out.split('\n').filter((l) => l.trim().length > 0);
    const violations = lines.filter((line) => {
      const parts = line.split(':');
      const filePath = parts[0];
      const contentRaw = parts.slice(2).join(':');
      const content = contentRaw.trim();

      // 1) spec 文件白名单
      if (/\.spec\.ts$/.test(filePath)) return false;
      // 2) migrations 路径白名单
      if (/migrations\//.test(filePath)) return false;
      // 3) 注释豁免
      if (content.startsWith('//') || content.startsWith('/*') || content.startsWith('*')) return false;
      // 4) baseline / docs 文件白名单
      if (/baseline\/|docs\//.test(filePath)) return false;

      // 业务代码引用 hourly_price_yuan = 真实回归
      return true;
    });

    expect(violations).toEqual([]); // 业务代码必须零命中
  });

  it('X1.4 hourlyPriceYuan camelCase 也禁用（前端 DTO / 后端 interface 同步删除）', () => {
    // camelCase 版本（DTO/interface 字段）— 比 snake_case 更容易漏删
    const out = runGrep('hourlyPriceYuan', ['src']);
    const lines = out.split('\n').filter((l) => l.trim().length > 0);
    const violations = lines.filter((line) => {
      const parts = line.split(':');
      const filePath = parts[0];
      const contentRaw = parts.slice(2).join(':');
      const content = contentRaw.trim();

      if (/\.spec\.ts$/.test(filePath)) return false;
      if (/migrations\//.test(filePath)) return false;
      if (/baseline\/|docs\//.test(filePath)) return false;
      if (content.startsWith('//') || content.startsWith('/*') || content.startsWith('*')) return false;

      return true;
    });
    expect(violations).toEqual([]);
  });

  it('X1.5 V50 migration 文件存在（防有人 git rm 重新启用字段）', () => {
    const out = execSync(
      `cd ${REPO_ROOT} && ls migrations/V50__drop_teachers_hourly_price.sql 2>/dev/null || echo ""`,
      { encoding: 'utf-8' },
    );
    expect(out.trim()).toContain('V50__drop_teachers_hourly_price.sql');
  });
});
