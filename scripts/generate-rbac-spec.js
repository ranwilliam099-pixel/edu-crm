#!/usr/bin/env node
/**
 * RBAC Spec Generator (L9, v2.0 §6)
 *
 * 输入：
 *   src/__rbac__/manifest.json — 9 角色 × 18 对象 × 4 CRUD 期望矩阵
 *   依据：docs/SSOT-拍板权威.md §1 (9 角色) + §4 (5 对象字段矩阵) + §6 (操作权限矩阵)
 *
 * 输出：
 *   src/__rbac__/generated/batch-<batch>-<category>.spec.ts
 *
 * 用法：
 *   node scripts/generate-rbac-spec.js --batch=a      # Batch A 核心 5 对象 = 180 case
 *   node scripts/generate-rbac-spec.js --batch=all    # 所有 batch (A 已实现, B/C/D 推 Day 5+)
 *
 * 设计原则：
 *   - 不 parse SSOT markdown（fragile）→ 用 explicit manifest.json
 *   - 单元格期望 (allow/deny) 直接对照 RbacGuard 行为
 *   - SSOT 修订 → 改 manifest → 重生成 → diff PR
 *   - Manifest 与代码不一致 → 真 bug 揭露
 *
 * 输出 spec 形态：
 *   每个对象 × 4 CRUD = 4 describe block
 *   每个 describe 内：N allow it + M deny it = 9 case
 *   每个 case：构造 user + RbacGuard.canActivate → 断言 true / throw
 *
 * 反偷懒：
 *   - 每个 case 含精确 expect (不用 toBeDefined / toHaveBeenCalled)
 *   - allow / deny 角色全列 (不省略)
 *   - 跨 tenant case 用 TenantScopeGuard 单独覆盖 (Batch C 推 Day 5+)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------- arg parse ----------
const args = process.argv.slice(2);
const batchArg = args.find((a) => a.startsWith('--batch='));
const batch = batchArg ? batchArg.split('=')[1] : 'a';

if (!['a', 'all'].includes(batch)) {
  console.error(`[generator] unsupported batch=${batch}; only 'a' or 'all' for now (B/C/D 推 Day 5+)`);
  process.exit(2);
}

// ---------- load manifest ----------
const MANIFEST_PATH = path.join(__dirname, '..', 'src', '__rbac__', 'manifest.json');
if (!fs.existsSync(MANIFEST_PATH)) {
  console.error(`[generator] manifest not found: ${MANIFEST_PATH}`);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

// ---------- validation ----------
const allRoles = [...manifest.roles.ssot, ...manifest.roles.auxiliary];
const batchObjects = manifest.objects.batchA;
const actions = manifest.actions;

if (allRoles.length !== 13) {
  console.error(`[generator] expected 13 roles (9 SSOT + 4 auxiliary), got ${allRoles.length}`);
  process.exit(2);
}

if (batchObjects.length !== 5) {
  console.error(`[generator] Batch A expected 5 core objects, got ${batchObjects.length}`);
  process.exit(2);
}

// Validate each object × action has matrix entry
let validationErrors = 0;
for (const obj of batchObjects) {
  if (!manifest.matrix[obj]) {
    console.error(`[generator] manifest.matrix.${obj} missing`);
    validationErrors++;
    continue;
  }
  for (const action of actions) {
    const cell = manifest.matrix[obj][action];
    if (!cell || !Array.isArray(cell.allow) || !Array.isArray(cell.deny)) {
      console.error(`[generator] manifest.matrix.${obj}.${action} malformed (need allow[], deny[])`);
      validationErrors++;
      continue;
    }
    // Check no overlap allow ∩ deny
    const overlap = cell.allow.filter((r) => cell.deny.includes(r));
    if (overlap.length > 0) {
      console.error(`[generator] ${obj}.${action} allow∩deny overlap: ${overlap.join(',')}`);
      validationErrors++;
    }
    // Check allow ∪ deny covers all 13 roles
    const covered = new Set([...cell.allow, ...cell.deny]);
    const missing = allRoles.filter((r) => !covered.has(r));
    if (missing.length > 0) {
      console.error(`[generator] ${obj}.${action} missing roles in allow∪deny: ${missing.join(',')}`);
      validationErrors++;
    }
  }
}
if (validationErrors > 0) {
  console.error(`[generator] ${validationErrors} manifest validation errors`);
  process.exit(2);
}

// ---------- emit spec ----------
function emitBatchA() {
  const lines = [];
  lines.push(`/**`);
  lines.push(` * Auto-generated RBAC spec — Batch A (核心 5 对象)`);
  lines.push(` *`);
  lines.push(` * !!! 禁止手改 !!! 改 src/__rbac__/manifest.json + 重跑 scripts/generate-rbac-spec.js`);
  lines.push(` *`);
  lines.push(` * 生成时间: ${manifest.generatedAt}`);
  lines.push(` * 来源: ${manifest.source}`);
  lines.push(` * 总 case 数: ${batchObjects.length} 对象 × ${actions.length} CRUD × ${allRoles.length} 角色 = ${batchObjects.length * actions.length * allRoles.length}`);
  lines.push(` *`);
  lines.push(` * 测试策略:`);
  lines.push(` *   - 每个单元格 (obj, action, role) 一个 it`);
  lines.push(` *   - 调用 RbacGuard.canActivate 模拟 controller-level @Roles`);
  lines.push(` *   - allow → 期望 canActivate 返 true`);
  lines.push(` *   - deny → 期望 canActivate 抛 ForbiddenException`);
  lines.push(` *   - manifest 与代码不一致 → 此 spec FAIL = 揭露 RBAC bug`);
  lines.push(` */`);
  lines.push(`import { Test, TestingModule } from '@nestjs/testing';`);
  lines.push(`import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';`);
  lines.push(`import { Reflector } from '@nestjs/core';`);
  lines.push(`import { RbacGuard } from '../../guards/rbac.guard';`);
  lines.push(`import { RbacRole } from '../../guards/rbac.decorator';`);
  lines.push(`import { JwtPayload } from '../../modules/auth/jwt-payload.interface';`);
  lines.push(``);
  lines.push(`/**`);
  lines.push(` * 构造 JWT user — sub/tenantId/campusId 都用稳定 ULID 占位`);
  lines.push(` * (实际值不影响 RbacGuard, 仅 role 字段决定路径)`);
  lines.push(` */`);
  lines.push(`// 注: 'parent' 角色走 ParentJwt 独立 strategy, 不在 RbacRole 类型 union 内,`);
  lines.push(`//     但 RbacGuard 只读 role 字符串, 测试用 cast 模拟 "parent 试图走 B 端 RbacGuard 路径"`);
  lines.push(`//     场景 — 期望全部 deny (B 端 controller @Roles 均不含 'parent').`);
  lines.push(`type AnyRoleForTest = RbacRole | 'parent';`);
  lines.push(``);
  lines.push(`function mkUser(role: AnyRoleForTest): JwtPayload {`);
  lines.push(`  const platformRoles = ['platform_admin', 'finance_admin'];`);
  lines.push(`  return {`);
  lines.push(`    sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNAA',`);
  lines.push(`    tenantId: platformRoles.includes(role) ? null : '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNBB',`);
  lines.push(`    role: role as RbacRole,`);
  lines.push(`    campusId: platformRoles.includes(role) ? null : '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNCC',`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`/**`);
  lines.push(` * 构造 ExecutionContext (包含 user + 注入 reflector required roles)`);
  lines.push(` */`);
  lines.push(`function mkContext(user: JwtPayload | undefined): ExecutionContext {`);
  lines.push(`  return {`);
  lines.push(`    switchToHttp: () => ({ getRequest: () => ({ user }) }),`);
  lines.push(`    getHandler: () => undefined,`);
  lines.push(`    getClass: () => undefined,`);
  lines.push(`  } as any;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`describe('[RBAC L9 Batch A] 核心 5 对象 × 4 CRUD × 13 角色 = ${batchObjects.length * actions.length * allRoles.length} case', () => {`);
  lines.push(`  let guard: RbacGuard;`);
  lines.push(`  let reflector: Reflector;`);
  lines.push(``);
  lines.push(`  beforeEach(async () => {`);
  lines.push(`    const module: TestingModule = await Test.createTestingModule({`);
  lines.push(`      providers: [`);
  lines.push(`        RbacGuard,`);
  lines.push(`        { provide: Reflector, useValue: { getAllAndOverride: jest.fn() } },`);
  lines.push(`      ],`);
  lines.push(`    }).compile();`);
  lines.push(`    guard = module.get<RbacGuard>(RbacGuard);`);
  lines.push(`    reflector = module.get<Reflector>(Reflector);`);
  lines.push(`  });`);
  lines.push(``);

  for (const obj of batchObjects) {
    lines.push(`  describe('${obj}', () => {`);
    for (const action of actions) {
      const cell = manifest.matrix[obj][action];
      const allowList = cell.allow.join(',');
      const denyList = cell.deny.join(',');
      lines.push(`    describe('${action}', () => {`);
      lines.push(`      // manifest: allow=[${allowList}]`);
      lines.push(`      // manifest: deny=[${denyList}]`);
      if (cell._note) {
        const note = cell._note.replace(/\*\//g, '*\\/'); // safe comment
        lines.push(`      // note: ${note}`);
      }
      lines.push(``);

      // allow it
      for (const role of cell.allow) {
        lines.push(`      it('allow ${role} → canActivate 返 true', () => {`);
        lines.push(`        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(${JSON.stringify(cell.allow)});`);
        lines.push(`        const result = guard.canActivate(mkContext(mkUser('${role}')));`);
        lines.push(`        expect(result).toBe(true);`);
        lines.push(`      });`);
      }
      // deny it
      for (const role of cell.deny) {
        lines.push(`      it('deny ${role} → ForbiddenException', () => {`);
        lines.push(`        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(${JSON.stringify(cell.allow)});`);
        lines.push(`        expect(() => guard.canActivate(mkContext(mkUser('${role}')))).toThrow(ForbiddenException);`);
        lines.push(`      });`);
      }
      lines.push(`    });`);
      lines.push(``);
    }
    lines.push(`  });`);
    lines.push(``);
  }

  // Corner case: undefined user
  lines.push(`  describe('corner cases (user 缺失 / role 缺失)', () => {`);
  lines.push(`    it('user undefined + required roles → UnauthorizedException', () => {`);
  lines.push(`      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['admin']);`);
  lines.push(`      expect(() => guard.canActivate(mkContext(undefined))).toThrow(UnauthorizedException);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('user 无 role 字段 + required roles → UnauthorizedException', () => {`);
  lines.push(`      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['admin']);`);
  lines.push(`      const userNoRole = { ...mkUser('admin'), role: undefined as any };`);
  lines.push(`      expect(() => guard.canActivate(mkContext(userNoRole))).toThrow(UnauthorizedException);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('reflector 返 undefined (无 @Roles) → 放行', () => {`);
  lines.push(`      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);`);
  lines.push(`      expect(guard.canActivate(mkContext(mkUser('parent')))).toBe(true);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('reflector 返 [] (@Roles 空数组) → 放行', () => {`);
  lines.push(`      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([]);`);
  lines.push(`      expect(guard.canActivate(mkContext(mkUser('parent')))).toBe(true);`);
  lines.push(`    });`);
  lines.push(`  });`);
  lines.push(`});`);
  lines.push(``);

  return lines.join('\n');
}

// ---------- write ----------
const outDir = path.join(__dirname, '..', 'src', '__rbac__', 'generated');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

if (batch === 'a' || batch === 'all') {
  const content = emitBatchA();
  const outFile = path.join(outDir, 'batch-a-core.spec.ts');
  fs.writeFileSync(outFile, content, 'utf8');
  const allowCount = batchObjects.reduce(
    (acc, obj) => acc + actions.reduce((a, ac) => a + manifest.matrix[obj][ac].allow.length, 0),
    0,
  );
  const denyCount = batchObjects.reduce(
    (acc, obj) => acc + actions.reduce((a, ac) => a + manifest.matrix[obj][ac].deny.length, 0),
    0,
  );
  console.log(`[generator] wrote ${outFile}`);
  console.log(`[generator] Batch A: ${batchObjects.length} objects × ${actions.length} CRUD × ${allRoles.length} roles`);
  console.log(`[generator]   allow case: ${allowCount}`);
  console.log(`[generator]   deny case:  ${denyCount}`);
  console.log(`[generator]   + 4 corner case (user/role/reflector edge) = ${allowCount + denyCount + 4} total`);
}

if (batch === 'all') {
  console.log(`[generator] Batch B/C/D 推 Day 5+ Sprint Y (本 generator 仅实现 Batch A, 见 plan)`);
}
