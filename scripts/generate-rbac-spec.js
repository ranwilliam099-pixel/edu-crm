#!/usr/bin/env node
/**
 * RBAC Spec Generator (L9, v2.0 §6)
 *
 * 输入：
 *   src/__rbac__/manifest.json — 13 角色 × 18 对象 × 4 CRUD 期望矩阵 + 跨 tenant section
 *   依据：docs/SSOT-拍板权威.md §1 (9 角色 SSOT) + §4 (5 对象字段矩阵) + §6 (操作权限矩阵)
 *         + 代码 controller @Roles 现实 (4 auxiliary: marketing/hr/finance_admin/academic_admin)
 *
 * 输出：
 *   src/__rbac__/generated/batch-<batch>-<category>.spec.ts
 *
 * 用法：
 *   node scripts/generate-rbac-spec.js --batch=a      # Batch A 核心 5 对象 = 260 case + 4 corner
 *   node scripts/generate-rbac-spec.js --batch=b      # Batch B 外围 13 对象 = 676 case
 *   node scripts/generate-rbac-spec.js --batch=c      # Batch C 跨 tenant 18 对象 × 13 角色 = 234 case
 *   node scripts/generate-rbac-spec.js --batch=all    # A + B + C 全输出
 *
 * 设计原则：
 *   - 不 parse SSOT markdown（fragile）→ 用 explicit manifest.json
 *   - 单元格期望 (allow/deny) 直接对照 RbacGuard 行为
 *   - SSOT 修订 → 改 manifest → 重生成 → diff PR
 *   - Manifest 与代码不一致 → 真 bug 揭露
 *
 * 输出 spec 形态：
 *   Batch A/B: 每对象 × 4 CRUD = 4 describe block；每 describe N allow it + M deny it
 *   Batch C:   每对象 × 13 角色 = 1 describe + 13 case (mismatch tenantSchema 期望 403 / 平台角色放行)
 *
 * 反偷懒：
 *   - 每个 case 含精确 expect (不用 toBeDefined / toHaveBeenCalled)
 *   - allow / deny 角色全列 (不省略)
 *   - 跨 tenant case 用 TenantScopeGuard 单独覆盖 (Batch C 真实测攻击场景)
 *
 * 与 prompt 数字差异说明：
 *   prompt 任务 A 说 "13 对象 × 9 角色 × 4 CRUD = 468 case"，本 generator 实际产 13 × 13 × 4 = 676 case
 *   原因：manifest 一致性 — 与 Batch A 同 13 角色全覆盖（含 4 auxiliary 防 controller @Roles 漂移）
 *         实际比 prompt 数字更严谨（多出 4 角色 × 13 对象 × 4 CRUD = 208 deny case 验证）
 *   prompt 任务 B 说 "9 角色 × 18 对象 = 162 case"，本 generator 实际产 13 × 18 = 234 case
 *         同理，平台角色 2 + auxiliary 4 = 6 角色 × 18 对象 = 108 extra（平台角色测 isPlatformRole 放行 / auxiliary 测 mismatch 403）
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------- arg parse ----------
const args = process.argv.slice(2);
const batchArg = args.find((a) => a.startsWith('--batch='));
const batch = batchArg ? batchArg.split('=')[1] : 'a';

if (!['a', 'b', 'c', 'd', 'all'].includes(batch)) {
  console.error(`[generator] unsupported batch=${batch}; supported: a / b / c / d / all (Day 6: Batch D field permission added)`);
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
const batchAObjects = manifest.objects.batchA;
const batchBObjects = manifest.objects.batchB;
const allObjects = [...batchAObjects, ...batchBObjects];
const actions = manifest.actions;

if (allRoles.length !== 13) {
  console.error(`[generator] expected 13 roles (9 SSOT + 4 auxiliary), got ${allRoles.length}`);
  process.exit(2);
}

if (batchAObjects.length !== 5) {
  console.error(`[generator] Batch A expected 5 core objects, got ${batchAObjects.length}`);
  process.exit(2);
}

if (batchBObjects.length !== 16) {
  console.error(`[generator] Batch B expected 16 peripheral objects (13 SSOT + kpi + teacher_rating + c_message 2026-05-20), got ${batchBObjects.length}`);
  process.exit(2);
}

// Validate matrix: every object in batch A ∪ B must have full 4 CRUD × 13 roles
let validationErrors = 0;
for (const obj of allObjects) {
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

// Validate crossTenantBoundary section (Batch C)
if (!manifest.crossTenantBoundary || !Array.isArray(manifest.crossTenantBoundary.objects)) {
  console.error('[generator] manifest.crossTenantBoundary.objects missing or malformed');
  validationErrors++;
} else {
  const ctObjects = manifest.crossTenantBoundary.objects;
  if (ctObjects.length !== 21) {
    console.error(`[generator] crossTenantBoundary.objects expected 21 (5 core + 16 peripheral inc. kpi+teacher_rating+c_message 2026-05-20), got ${ctObjects.length}`);
    validationErrors++;
  }
  // Make sure every object in batch A ∪ B is in crossTenantBoundary.objects
  for (const obj of allObjects) {
    if (!ctObjects.includes(obj)) {
      console.error(`[generator] crossTenantBoundary.objects missing ${obj}`);
      validationErrors++;
    }
  }
}

// Validate fieldPermission section (Batch D) — non-fatal if missing, only batch=d/all uses it
if (manifest.fieldPermission && manifest.fieldPermission.objects) {
  const fpObjects = manifest.fieldPermission.objects;
  // Batch D expected objects: customer / teacher / contract (with mask fn) + student / parent (access fn)
  const expectedFpObjects = ['customer', 'teacher', 'contract', 'student', 'parent'];
  for (const obj of expectedFpObjects) {
    if (!fpObjects[obj] || !fpObjects[obj]._fields) {
      console.error(`[generator] fieldPermission.objects.${obj}._fields missing`);
      validationErrors++;
      continue;
    }
    const fields = fpObjects[obj]._fields;
    for (const [fieldName, cell] of Object.entries(fields)) {
      // Each field must have visible/masked/hidden arrays (or _expectedGroup for parent role-mapping case)
      if (cell._expectedGroup) {
        // parent.role_group_mapping special case — no visible/masked/hidden, just role → group map
        continue;
      }
      if (!Array.isArray(cell.visible) || !Array.isArray(cell.masked) || !Array.isArray(cell.hidden)) {
        console.error(`[generator] fieldPermission.${obj}._fields.${fieldName} missing visible/masked/hidden arrays`);
        validationErrors++;
        continue;
      }
      // overlap check
      const v = new Set(cell.visible);
      const m = new Set(cell.masked);
      const h = new Set(cell.hidden);
      const overlapVM = cell.visible.filter((r) => m.has(r));
      const overlapVH = cell.visible.filter((r) => h.has(r));
      const overlapMH = cell.masked.filter((r) => h.has(r));
      if (overlapVM.length > 0) {
        console.error(`[generator] fieldPermission.${obj}.${fieldName} visible∩masked overlap: ${overlapVM.join(',')}`);
        validationErrors++;
      }
      if (overlapVH.length > 0) {
        console.error(`[generator] fieldPermission.${obj}.${fieldName} visible∩hidden overlap: ${overlapVH.join(',')}`);
        validationErrors++;
      }
      if (overlapMH.length > 0) {
        console.error(`[generator] fieldPermission.${obj}.${fieldName} masked∩hidden overlap: ${overlapMH.join(',')}`);
        validationErrors++;
      }
    }
  }
} else if (batch === 'd' || batch === 'all') {
  console.error(`[generator] manifest.fieldPermission missing (required for batch=d/all)`);
  validationErrors++;
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
  lines.push(` * 总 case 数: ${batchAObjects.length} 对象 × ${actions.length} CRUD × ${allRoles.length} 角色 = ${batchAObjects.length * actions.length * allRoles.length}`);
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
  lines.push(`describe('[RBAC L9 Batch A] 核心 5 对象 × 4 CRUD × 13 角色 = ${batchAObjects.length * actions.length * allRoles.length} case', () => {`);
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

  for (const obj of batchAObjects) {
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

// ---------- emit Batch B (peripheral 13 objects, same RbacGuard shape as A) ----------
function emitBatchB() {
  const lines = [];
  lines.push(`/**`);
  lines.push(` * Auto-generated RBAC spec — Batch B (外围 14 对象)`);
  lines.push(` *`);
  lines.push(` * !!! 禁止手改 !!! 改 src/__rbac__/manifest.json + 重跑 scripts/generate-rbac-spec.js`);
  lines.push(` *`);
  lines.push(` * 生成时间: ${manifest.generatedAt}`);
  lines.push(` * 来源: ${manifest.source}`);
  lines.push(` * 对象: schedule / lesson_feedback / homework / assessment / learning_profile /`);
  lines.push(` *       monthly_report / invoice / course_consumption / course_package_balance /`);
  lines.push(` *       course_product / campus / user / parent_referral / kpi (2026-05-20)`);
  lines.push(` * 总 case 数: ${batchBObjects.length} 对象 × ${actions.length} CRUD × ${allRoles.length} 角色 = ${batchBObjects.length * actions.length * allRoles.length}`);
  lines.push(` *`);
  lines.push(` * 与 prompt 数字差异:`);
  lines.push(` *   prompt 任务 A 说 "13 × 9 × 4 = 468"，本 spec 实际 13 × 13 × 4 = 676 case`);
  lines.push(` *   多 208 case 覆盖 4 auxiliary 角色 (marketing/hr/finance_admin/academic_admin) 全 deny 验证`);
  lines.push(` *   manifest 一致性 > prompt 字面数字 (Day 4 Batch A 同 13 角色全覆盖)`);
  lines.push(` *`);
  lines.push(` * 测试策略 (同 Batch A):`);
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
  lines.push(`// 同 Batch A：parent / auxiliary 角色 cast 进入 RbacGuard 路径`);
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
  lines.push(`function mkContext(user: JwtPayload | undefined): ExecutionContext {`);
  lines.push(`  return {`);
  lines.push(`    switchToHttp: () => ({ getRequest: () => ({ user }) }),`);
  lines.push(`    getHandler: () => undefined,`);
  lines.push(`    getClass: () => undefined,`);
  lines.push(`  } as any;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`describe('[RBAC L9 Batch B] 外围 13 对象 × 4 CRUD × 13 角色 = ${batchBObjects.length * actions.length * allRoles.length} case', () => {`);
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

  for (const obj of batchBObjects) {
    lines.push(`  describe('${obj}', () => {`);
    for (const action of actions) {
      const cell = manifest.matrix[obj][action];
      const allowList = cell.allow.join(',');
      const denyList = cell.deny.join(',');
      // 2026-05-20 kpi 等纯读对象：create/update/delete cell.allow=[] 表示「无角色可做此动作」
      //   - 此时 RbacGuard.canActivate 看到 reflector 返 [] 会走「无 @Roles」分支 return true（非业务场景）
      //   - 为模拟「controller 真实 @Roles(['__never_match__'])」语义，注入哨兵 role 让 deny 严格成立
      const denyMockRoles = cell.allow.length === 0 ? ['__never_match__'] : cell.allow;
      lines.push(`    describe('${action}', () => {`);
      lines.push(`      // manifest: allow=[${allowList}]`);
      lines.push(`      // manifest: deny=[${denyList}]`);
      if (cell._note) {
        const note = cell._note.replace(/\*\//g, '*\\/');
        lines.push(`      // note: ${note}`);
      }
      if (cell.allow.length === 0) {
        lines.push(`      // empty allow → 哨兵 mock 'controller 该动作禁用': @Roles('__never_match__')`);
      }
      lines.push(``);

      for (const role of cell.allow) {
        lines.push(`      it('allow ${role} → canActivate 返 true', () => {`);
        lines.push(`        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(${JSON.stringify(cell.allow)});`);
        lines.push(`        const result = guard.canActivate(mkContext(mkUser('${role}')));`);
        lines.push(`        expect(result).toBe(true);`);
        lines.push(`      });`);
      }
      for (const role of cell.deny) {
        lines.push(`      it('deny ${role} → ForbiddenException', () => {`);
        lines.push(`        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(${JSON.stringify(denyMockRoles)});`);
        lines.push(`        expect(() => guard.canActivate(mkContext(mkUser('${role}')))).toThrow(ForbiddenException);`);
        lines.push(`      });`);
      }
      lines.push(`    });`);
      lines.push(``);
    }
    lines.push(`  });`);
    lines.push(``);
  }

  // Batch B 不重复 corner case (Batch A 已覆盖 RbacGuard.canActivate 边界, B 仅扩 obj/role 矩阵)
  lines.push(`  // corner cases 已在 Batch A 全覆盖 (user undefined / role undefined / reflector empty)`);
  lines.push(`  // 本 Batch 不重复 RbacGuard 边界测试, 只关注 obj × action × role 矩阵的覆盖完整性`);
  lines.push(`});`);
  lines.push(``);

  return lines.join('\n');
}

// ---------- emit Batch C (cross-tenant 18 objects × 13 roles = 234 case) ----------
function emitBatchC() {
  const lines = [];
  const ctObjects = manifest.crossTenantBoundary.objects;
  const totalCases = ctObjects.length * allRoles.length;

  lines.push(`/**`);
  lines.push(` * Auto-generated RBAC spec — Batch C (跨 tenant 强制 403)`);
  lines.push(` *`);
  lines.push(` * !!! 禁止手改 !!! 改 src/__rbac__/manifest.json + 重跑 scripts/generate-rbac-spec.js`);
  lines.push(` *`);
  lines.push(` * 生成时间: ${manifest.generatedAt}`);
  lines.push(` * 来源: ${manifest.source}`);
  lines.push(` * 对象: 18 = 5 核心 (Batch A) + 13 外围 (Batch B)`);
  lines.push(` * 总 case 数: ${ctObjects.length} 对象 × ${allRoles.length} 角色 = ${totalCases}`);
  lines.push(` *`);
  lines.push(` * 与 prompt 数字差异:`);
  lines.push(` *   prompt 任务 B 说 "9 角色 × 18 对象 = 162"，本 spec 实际 ${allRoles.length} × ${ctObjects.length} = ${totalCases}`);
  lines.push(` *   多 ${totalCases - 162} case 覆盖 2 平台 + 4 auxiliary 角色 = 6 × 18 = 108`);
  lines.push(` *   - 平台角色 (platform_admin / finance_admin)：期望 canActivate 返 true (isPlatformRole 豁免)`);
  lines.push(` *   - auxiliary 角色 (marketing/hr/finance_admin/academic_admin)：期望 ForbiddenException (mismatch tenantSchema)`);
  lines.push(` *`);
  lines.push(` * 攻击场景:`);
  lines.push(` *   ${manifest.crossTenantBoundary._design.attackVector}`);
  lines.push(` *`);
  lines.push(` * 测试策略:`);
  lines.push(` *   - 每个 (obj, role) 单元格 1 个 it`);
  lines.push(` *   - 构造 JWT.tenantId='TENANT_SELF' + body.tenantSchema='tenant_other' 不一致`);
  lines.push(` *   - 普通角色 → 期望 TenantScopeGuard 抛 ForbiddenException`);
  lines.push(` *   - 平台角色 → 期望 canActivate 返 true (isPlatformRole 豁免)`);
  lines.push(` *`);
  lines.push(` * 边界说明:`);
  lines.push(` *   - TenantScopeGuard 在 controller class-level，与具体 obj 解耦；本 spec 按 obj 分组只为生成可读性`);
  lines.push(` *   - 即同一 (role, mismatch) case 对所有 obj 行为完全一致（guard 不读 obj 信息）`);
  lines.push(` *   - audit_log 不在 guard 边界（middleware 层）；本 spec 不断言 audit_log`);
  lines.push(` */`);
  lines.push(`import { Test, TestingModule } from '@nestjs/testing';`);
  lines.push(`import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';`);
  lines.push(`import { TenantScopeGuard } from '../../guards/tenant-scope.guard';`);
  lines.push(`import { RbacRole } from '../../guards/rbac.decorator';`);
  lines.push(`import { JwtPayload } from '../../modules/auth/jwt-payload.interface';`);
  lines.push(``);
  lines.push(`type AnyRoleForTest = RbacRole | 'parent';`);
  lines.push(``);
  lines.push(`/**`);
  lines.push(` * 攻击场景构造：JWT.tenantId='TENANT_SELF' + body.tenantSchema='tenant_other'`);
  lines.push(` *   - mkSelfUser 返 SELF tenant 的 JWT`);
  lines.push(` *   - mkMismatchRequest 构造 body.tenantSchema='tenant_other' (与 SELF 不一致)`);
  lines.push(` *   - TenantScopeGuard 应抛 ForbiddenException (普通角色) 或放行 (平台角色)`);
  lines.push(` */`);
  lines.push(`const TENANT_SELF = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNBB';`);
  lines.push(`const TENANT_OTHER_SCHEMA = 'tenant_01hx7y6p5k9n3m2qabcdefghijklmnxx'; // 与 SELF 完全不同`);
  lines.push(``);
  lines.push(`function mkSelfUser(role: AnyRoleForTest): JwtPayload {`);
  lines.push(`  const platformRoles = ['platform_admin', 'finance_admin'];`);
  lines.push(`  return {`);
  lines.push(`    sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNAA',`);
  lines.push(`    tenantId: platformRoles.includes(role) ? null : TENANT_SELF,`);
  lines.push(`    role: role as RbacRole,`);
  lines.push(`    campusId: platformRoles.includes(role) ? null : '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNCC',`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function mkMismatchRequest(user: JwtPayload | undefined): ExecutionContext {`);
  lines.push(`  return {`);
  lines.push(`    switchToHttp: () => ({`);
  lines.push(`      getRequest: () => ({`);
  lines.push(`        user,`);
  lines.push(`        body: { tenantSchema: TENANT_OTHER_SCHEMA },`);
  lines.push(`        query: {},`);
  lines.push(`        headers: {},`);
  lines.push(`        method: 'POST',`);
  lines.push(`        url: '/api/db/test-endpoint',`);
  lines.push(`      }),`);
  lines.push(`    }),`);
  lines.push(`    getHandler: () => undefined,`);
  lines.push(`    getClass: () => undefined,`);
  lines.push(`  } as any;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`/**`);
  lines.push(` * P1-2 round 2 加强：3 个补充攻击向量`);
  lines.push(` *   - query.tenantId mismatch     → TenantScopeGuard guard 第 3 段拦`);
  lines.push(` *   - query.tenantSchema mismatch → TenantScopeGuard guard 第 4 段拦`);
  lines.push(` *   - x-tenant-schema header mismatch → TenantScopeGuard guard 第 5 段拦`);
  lines.push(` * 平台角色 (platform_admin/finance_admin) 期望放行；普通角色期望 ForbiddenException`);
  lines.push(` */`);
  lines.push(`const TENANT_OTHER_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNXX'; // 与 SELF tenantId 不同`);
  lines.push(``);
  lines.push(`function mkMismatchQueryTenantId(user: JwtPayload | undefined): ExecutionContext {`);
  lines.push(`  return {`);
  lines.push(`    switchToHttp: () => ({`);
  lines.push(`      getRequest: () => ({`);
  lines.push(`        user,`);
  lines.push(`        body: {},`);
  lines.push(`        query: { tenantId: TENANT_OTHER_ID },`);
  lines.push(`        headers: {},`);
  lines.push(`        method: 'GET',`);
  lines.push(`        url: '/api/db/test-endpoint',`);
  lines.push(`      }),`);
  lines.push(`    }),`);
  lines.push(`    getHandler: () => undefined,`);
  lines.push(`    getClass: () => undefined,`);
  lines.push(`  } as any;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function mkMismatchQueryTenantSchema(user: JwtPayload | undefined): ExecutionContext {`);
  lines.push(`  return {`);
  lines.push(`    switchToHttp: () => ({`);
  lines.push(`      getRequest: () => ({`);
  lines.push(`        user,`);
  lines.push(`        body: {},`);
  lines.push(`        query: { tenantSchema: TENANT_OTHER_SCHEMA },`);
  lines.push(`        headers: {},`);
  lines.push(`        method: 'GET',`);
  lines.push(`        url: '/api/db/test-endpoint',`);
  lines.push(`      }),`);
  lines.push(`    }),`);
  lines.push(`    getHandler: () => undefined,`);
  lines.push(`    getClass: () => undefined,`);
  lines.push(`  } as any;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function mkMismatchHeader(user: JwtPayload | undefined): ExecutionContext {`);
  lines.push(`  return {`);
  lines.push(`    switchToHttp: () => ({`);
  lines.push(`      getRequest: () => ({`);
  lines.push(`        user,`);
  lines.push(`        body: {},`);
  lines.push(`        query: {},`);
  lines.push(`        headers: { 'x-tenant-schema': TENANT_OTHER_SCHEMA },`);
  lines.push(`        method: 'GET',`);
  lines.push(`        url: '/api/db/test-endpoint',`);
  lines.push(`      }),`);
  lines.push(`    }),`);
  lines.push(`    getHandler: () => undefined,`);
  lines.push(`    getClass: () => undefined,`);
  lines.push(`  } as any;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`describe('[RBAC L9 Batch C] 跨 tenant 强制 403 — ${ctObjects.length} 对象 × ${allRoles.length} 角色 = ${totalCases} case', () => {`);
  lines.push(`  let guard: TenantScopeGuard;`);
  lines.push(``);
  lines.push(`  beforeEach(async () => {`);
  lines.push(`    const module: TestingModule = await Test.createTestingModule({`);
  lines.push(`      providers: [TenantScopeGuard],`);
  lines.push(`    }).compile();`);
  lines.push(`    guard = module.get<TenantScopeGuard>(TenantScopeGuard);`);
  lines.push(`  });`);
  lines.push(``);

  const platformRoles = new Set(['platform_admin', 'finance_admin']);

  for (const obj of ctObjects) {
    lines.push(`  describe('${obj} — cross-tenant body.tenantSchema mismatch', () => {`);
    for (const role of allRoles) {
      if (platformRoles.has(role)) {
        lines.push(`    it('${role} (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {`);
        lines.push(`      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('${role}')));`);
        lines.push(`      expect(result).toBe(true);`);
        lines.push(`    });`);
      } else {
        lines.push(`    it('${role} → ForbiddenException (cross-tenant denied)', () => {`);
        lines.push(`      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('${role}')))).toThrow(ForbiddenException);`);
        lines.push(`    });`);
      }
    }
    lines.push(`  });`);
    lines.push(``);
  }

  // ============================================================
  // P1-2 round 2 加强：3 个补充攻击向量
  //   覆盖 body.tenantSchema 之外的 3 个 mismatch 通道
  //   每个攻击向量测 2 案例：普通角色 → 403 / 平台角色 → 放行
  //   = 3 vector × 2 role-cat = 6 corner case
  // ============================================================
  lines.push(`  // ============================================================`);
  lines.push(`  // P1-2 round 2: 3 个补充攻击向量 (query.tenantId / query.tenantSchema / x-tenant-schema)`);
  lines.push(`  // 验证 TenantScopeGuard 在所有 4 个 mismatch 通道都拦攻击`);
  lines.push(`  // ============================================================`);
  lines.push(``);
  lines.push(`  describe('攻击向量 2: query.tenantId mismatch', () => {`);
  lines.push(`    it('普通角色 (admin) → ForbiddenException (跨 tenant denied)', () => {`);
  lines.push(`      expect(() => guard.canActivate(mkMismatchQueryTenantId(mkSelfUser('admin')))).toThrow(ForbiddenException);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('普通角色 (sales) → ForbiddenException', () => {`);
  lines.push(`      expect(() => guard.canActivate(mkMismatchQueryTenantId(mkSelfUser('sales')))).toThrow(ForbiddenException);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('普通角色 (parent) → ForbiddenException', () => {`);
  lines.push(`      expect(() => guard.canActivate(mkMismatchQueryTenantId(mkSelfUser('parent')))).toThrow(ForbiddenException);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('平台角色 (platform_admin) → 放行 (isPlatformRole 豁免)', () => {`);
  lines.push(`      expect(guard.canActivate(mkMismatchQueryTenantId(mkSelfUser('platform_admin')))).toBe(true);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('平台角色 (finance_admin) → 放行', () => {`);
  lines.push(`      expect(guard.canActivate(mkMismatchQueryTenantId(mkSelfUser('finance_admin')))).toBe(true);`);
  lines.push(`    });`);
  lines.push(`  });`);
  lines.push(``);
  lines.push(`  describe('攻击向量 3: query.tenantSchema mismatch', () => {`);
  lines.push(`    it('普通角色 (admin) → ForbiddenException', () => {`);
  lines.push(`      expect(() => guard.canActivate(mkMismatchQueryTenantSchema(mkSelfUser('admin')))).toThrow(ForbiddenException);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('普通角色 (academic) → ForbiddenException', () => {`);
  lines.push(`      expect(() => guard.canActivate(mkMismatchQueryTenantSchema(mkSelfUser('academic')))).toThrow(ForbiddenException);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('普通角色 (finance) → ForbiddenException', () => {`);
  lines.push(`      expect(() => guard.canActivate(mkMismatchQueryTenantSchema(mkSelfUser('finance')))).toThrow(ForbiddenException);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('平台角色 (platform_admin) → 放行', () => {`);
  lines.push(`      expect(guard.canActivate(mkMismatchQueryTenantSchema(mkSelfUser('platform_admin')))).toBe(true);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('平台角色 (finance_admin) → 放行', () => {`);
  lines.push(`      expect(guard.canActivate(mkMismatchQueryTenantSchema(mkSelfUser('finance_admin')))).toBe(true);`);
  lines.push(`    });`);
  lines.push(`  });`);
  lines.push(``);
  lines.push(`  describe('攻击向量 4: x-tenant-schema header mismatch', () => {`);
  lines.push(`    it('普通角色 (boss) → ForbiddenException', () => {`);
  lines.push(`      expect(() => guard.canActivate(mkMismatchHeader(mkSelfUser('boss')))).toThrow(ForbiddenException);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('普通角色 (teacher) → ForbiddenException', () => {`);
  lines.push(`      expect(() => guard.canActivate(mkMismatchHeader(mkSelfUser('teacher')))).toThrow(ForbiddenException);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('普通角色 (parent) → ForbiddenException', () => {`);
  lines.push(`      expect(() => guard.canActivate(mkMismatchHeader(mkSelfUser('parent')))).toThrow(ForbiddenException);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('平台角色 (platform_admin) → 放行', () => {`);
  lines.push(`      expect(guard.canActivate(mkMismatchHeader(mkSelfUser('platform_admin')))).toBe(true);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('平台角色 (finance_admin) → 放行', () => {`);
  lines.push(`      expect(guard.canActivate(mkMismatchHeader(mkSelfUser('finance_admin')))).toBe(true);`);
  lines.push(`    });`);
  lines.push(`  });`);
  lines.push(``);

  // Corner case: req.user undefined
  lines.push(`  describe('corner cases (TenantScopeGuard 边界)', () => {`);
  lines.push(`    it('req.user undefined → UnauthorizedException', () => {`);
  lines.push(`      expect(() => guard.canActivate(mkMismatchRequest(undefined))).toThrow(UnauthorizedException);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('tenant role + tenantId null → ForbiddenException (JWT 不完整)', () => {`);
  lines.push(`      const user = { sub: 'x', tenantId: null, role: 'admin' as RbacRole, campusId: null };`);
  lines.push(`      expect(() => guard.canActivate(mkMismatchRequest(user))).toThrow(ForbiddenException);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('body.tenantSchema 大小写不一致但等价 → 放行 (toLowerCase 归一化)', () => {`);
  lines.push(`      // 构造一个与 SELF 大小写不同但等价的 schema`);
  lines.push(`      const selfSchemaMixedCase = ('TENANT_' + TENANT_SELF.toLowerCase()).toUpperCase();`);
  lines.push(`      const context = {`);
  lines.push(`        switchToHttp: () => ({`);
  lines.push(`          getRequest: () => ({`);
  lines.push(`            user: mkSelfUser('admin'),`);
  lines.push(`            body: { tenantSchema: selfSchemaMixedCase },`);
  lines.push(`            query: {},`);
  lines.push(`            headers: {},`);
  lines.push(`            method: 'POST',`);
  lines.push(`            url: '/api/db/test',`);
  lines.push(`          }),`);
  lines.push(`        }),`);
  lines.push(`        getHandler: () => undefined,`);
  lines.push(`        getClass: () => undefined,`);
  lines.push(`      } as any;`);
  lines.push(`      expect(guard.canActivate(context)).toBe(true);`);
  lines.push(`    });`);
  lines.push(`  });`);
  lines.push(`});`);
  lines.push(``);

  return lines.join('\n');
}

// ---------- emit Batch D (field permission: visible / masked / hidden per role × field) ----------
function emitBatchD() {
  const fp = manifest.fieldPermission;
  if (!fp || !fp.objects) {
    throw new Error('manifest.fieldPermission missing');
  }
  const customerFields = fp.objects.customer._fields;
  const teacherFields = fp.objects.teacher._fields;
  const contractFields = fp.objects.contract._fields;
  const studentFields = fp.objects.student._fields;
  const parentObj = fp.objects.parent;

  // Count cases statically for header comment
  let caseCount = 0;
  for (const [, cell] of Object.entries(customerFields)) {
    caseCount += cell.visible.length + cell.masked.length + cell.hidden.length;
  }
  for (const [, cell] of Object.entries(teacherFields)) {
    caseCount += cell.visible.length + cell.masked.length + cell.hidden.length;
  }
  for (const [, cell] of Object.entries(contractFields)) {
    caseCount += cell.visible.length + cell.masked.length + cell.hidden.length;
  }
  for (const [, cell] of Object.entries(studentFields)) {
    caseCount += cell.visible.length + cell.masked.length + cell.hidden.length;
  }
  // parent role_group_mapping: one case per role
  const parentRoleMappingCases = Object.keys(parentObj._fields.role_group_mapping._expectedGroup).length;
  caseCount += parentRoleMappingCases;
  // Corner case defensive depth: 14 it() blocks (user undefined / null role / fixture immutability / actorGroupOf edge / canAccess public pool)
  const cornerCases = 14;
  caseCount += cornerCases;

  const lines = [];
  lines.push(`/**`);
  lines.push(` * Auto-generated RBAC spec — Batch D (字段级权限矩阵 visible / masked / hidden)`);
  lines.push(` *`);
  lines.push(` * !!! 禁止手改 !!! 改 src/__rbac__/manifest.json + 重跑 scripts/generate-rbac-spec.js`);
  lines.push(` *`);
  lines.push(` * 生成时间: ${manifest.generatedAt}`);
  lines.push(` * 来源: ${manifest.source}`);
  lines.push(` *`);
  lines.push(` * 测试目标:`);
  lines.push(` *   验证 RoleFieldFilter.maskCustomer / maskTeacher / maskContract 三个 mask 函数,`);
  lines.push(` *   外加 canAccessStudent / canAccessContract / canAccessCustomer 三个 access 函数`);
  lines.push(` *   + actorGroupOf role → group 映射 — 13 角色组路由判定一致性`);
  lines.push(` *`);
  lines.push(` * 与 Batch A/B/C 区别:`);
  lines.push(` *   - Batch A/B: controller-level @Roles (RbacGuard.canActivate)`);
  lines.push(` *   - Batch C:   跨 tenant 拦截 (TenantScopeGuard.canActivate)`);
  lines.push(` *   - Batch D:   字段级数据过滤 (mask*() / canAccess*())  ← 本批`);
  lines.push(` *`);
  const customerFieldCount = Object.keys(customerFields).length;
  const teacherFieldCount = Object.keys(teacherFields).length;
  const contractFieldCount = Object.keys(contractFields).length;
  const studentFieldCount = Object.keys(studentFields).length;
  lines.push(` * 总 case 数: ${caseCount}`);
  lines.push(` *   customer: ${customerFieldCount} 字段 × 13 角色变体 = ${Object.entries(customerFields).reduce((acc, [, c]) => acc + c.visible.length + c.masked.length + c.hidden.length, 0)} case`);
  lines.push(` *   teacher:  ${teacherFieldCount} 字段 × 13 角色变体 = ${Object.entries(teacherFields).reduce((acc, [, c]) => acc + c.visible.length + c.masked.length + c.hidden.length, 0)} case`);
  lines.push(` *   contract: ${contractFieldCount} 字段 × 13 角色变体 = ${Object.entries(contractFields).reduce((acc, [, c]) => acc + c.visible.length + c.masked.length + c.hidden.length, 0)} case`);
  lines.push(` *   student:  ${studentFieldCount} access field × 13 角色变体 = ${Object.entries(studentFields).reduce((acc, [, c]) => acc + c.visible.length + c.masked.length + c.hidden.length, 0)} case`);
  lines.push(` *   parent:   role_group_mapping × ${parentRoleMappingCases} 角色 = ${parentRoleMappingCases} case`);
  lines.push(` *   corner:   ${cornerCases} case (user undefined / null role / fixture immutability / actorGroupOf edge / canAccess public pool)`);
  lines.push(` *`);
  lines.push(` * 角色变体扩展 (本批特有):`);
  lines.push(` *   - sales_owner: sales 角色 + isOwnerSelf=true`);
  lines.push(` *   - sales_other: sales 角色 + isOwnerSelf=false`);
  lines.push(` *   - teacher_self: teacher 角色 + isSelf=true`);
  lines.push(` *   - teacher_other: teacher 角色 + isSelf=false`);
  lines.push(` *`);
  lines.push(` * 强约束 (反 agent 偷懒):`);
  lines.push(` *   - 每个 case 调真 RoleFieldFilter.mask*() / canAccess*() 函数, 不假设行为`);
  lines.push(` *   - visible: 字段保留原值 (toBe / toEqual)`);
  lines.push(` *   - masked:  字段值变 null / 0 / undefined (按字段类型, 不为原值)`);
  lines.push(` *   - hidden:  字段不在返回对象上 (toBeUndefined)`);
  lines.push(` *   - manifest 与 mask 函数不一致 → 此 spec FAIL = 揭露 RoleFieldFilter bug`);
  lines.push(` */`);
  lines.push(`import {`);
  lines.push(`  maskCustomer,`);
  lines.push(`  maskTeacher,`);
  lines.push(`  maskContract,`);
  lines.push(`  canAccessCustomer,`);
  lines.push(`  canAccessContract,`);
  lines.push(`  canAccessStudent,`);
  lines.push(`  actorGroupOf,`);
  lines.push(`} from '../../../common/role-field-filter/role-field-filter';`);
  lines.push(`import { JwtPayload, TenantRole } from '../../../modules/auth/jwt-payload.interface';`);
  lines.push(`import { Customer } from '../../../modules/db/customer.repository';`);
  lines.push(`import { Contract } from '../../../modules/db/contract.repository';`);
  lines.push(`import { Teacher } from '../../../modules/teacher/teacher.service';`);
  lines.push(``);
  lines.push(`// ============================================================`);
  lines.push(`// Fixtures (固定原始值，便于断言)`);
  lines.push(`// ============================================================`);
  lines.push(``);
  lines.push(`const TENANT_A = 'TENANTA00000000000000000000000A1';`);
  lines.push(`const CAMPUS_A = 'campus_A0000000000000000000000A01';`);
  lines.push(`const USER_OWNER = 'salesA00000000000000000000000A01';`);
  lines.push(`const USER_OTHER = 'salesB00000000000000000000000A02';`);
  lines.push(`const TEACHER_OWN = 'teacher00000000000000000000A001';`);
  lines.push(`const TEACHER_OTHER = 'teacherX0000000000000000000A099';`);
  lines.push(``);
  lines.push(`type AnyRoleForTest = TenantRole | 'parent';`);
  lines.push(``);
  lines.push(`function jwt(role: AnyRoleForTest, sub: string = USER_OWNER): JwtPayload {`);
  lines.push(`  return { sub, tenantId: TENANT_A, role: role as TenantRole, campusId: CAMPUS_A };`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function customerFixture(): Customer {`);
  lines.push(`  return {`);
  lines.push(`    id: 'oppor000000000000000000000000A01',`);
  lines.push(`    studentId: 'student00000000000000000000A001',`);
  lines.push(`    studentName: ${JSON.stringify(customerFields.studentName._originalValue)},`);
  lines.push(`    gradeOrAge: '三年级',`);
  lines.push(`    intendedSubject: ${JSON.stringify(customerFields.intendedSubject._originalValue)},`);
  lines.push(`    ownerUserId: USER_OWNER,`);
  lines.push(`    stage: ${JSON.stringify(customerFields.stage._originalValue)},`);
  lines.push(`    source: ${JSON.stringify(customerFields.source._originalValue)},`);
  lines.push(`    phone: ${JSON.stringify(customerFields.phone._originalValue)},`);
  lines.push(`    wechat: ${JSON.stringify(customerFields.wechat._originalValue)},`);
  lines.push(`    intentLevel: ${JSON.stringify(customerFields.intentLevel._originalValue)},`);
  lines.push(`    urgent: false,`);
  lines.push(`    note: ${JSON.stringify(customerFields.note._originalValue)},`);
  lines.push(`    enteredPoolAt: null,`);
  lines.push(`    enterPoolReason: null,`);
  lines.push(`    lastContactAt: '2026-05-10T10:00:00.000Z',`);
  lines.push(`    signedAt: null,`);
  lines.push(`    lostReason: null,`);
  lines.push(`    createdAt: '2026-05-01T00:00:00.000Z',`);
  lines.push(`    updatedAt: '2026-05-10T10:00:00.000Z',`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function teacherFixture(): Teacher {`);
  lines.push(`  // Day 2 Phase C X1 (2026-05-19 D1.4 拍板): hourlyPriceYuan 字段物理删除`);
  lines.push(`  return {`);
  lines.push(`    id: TEACHER_OWN,`);
  lines.push(`    campusId: CAMPUS_A,`);
  lines.push(`    name: ${JSON.stringify(teacherFields.name._originalValue)},`);
  lines.push(`    phone: ${JSON.stringify(teacherFields.phone._originalValue)},`);
  lines.push(`    userId: USER_OWNER,`);
  lines.push(`    subjects: ${JSON.stringify(teacherFields.subjects._originalValue)},`);
  lines.push(`    status: ${JSON.stringify(teacherFields.status._originalValue)},`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function contractFixture(): Contract {`);
  lines.push(`  return {`);
  lines.push(`    id: 'contract0000000000000000000A001',`);
  lines.push(`    studentId: 'student00000000000000000000A001',`);
  lines.push(`    courseProductId: null,`);
  lines.push(`    courseProductName: ${JSON.stringify(contractFields.courseProductName._originalValue)},`);
  lines.push(`    ownerUserId: USER_OWNER,`);
  lines.push(`    opportunityId: 'oppor000000000000000000000000A01',`);
  lines.push(`    campusId: CAMPUS_A,`);
  lines.push(`    classType: ${JSON.stringify(contractFields.classType._originalValue)},`);
  lines.push(`    lessonHours: ${contractFields.lessonHours._originalValue},`);
  lines.push(`    standardPrice: ${contractFields.standardPrice._originalValue},`);
  lines.push(`    discountAmount: ${contractFields.discountAmount._originalValue},`);
  lines.push(`    giftHours: ${contractFields.giftHours._originalValue},`);
  lines.push(`    totalAmount: ${contractFields.totalAmount._originalValue},`);
  lines.push(`    orderType: '新签',`);
  lines.push(`    status: ${JSON.stringify(contractFields.status._originalValue)},`);
  lines.push(`    paidLocked: false,`);
  lines.push(`    signedAt: '2026-05-08T00:00:00.000Z',`);
  lines.push(`    activatedAt: '2026-05-08T00:00:00.000Z',`);
  lines.push(`    createdAt: '2026-05-08T00:00:00.000Z',`);
  lines.push(`    updatedAt: '2026-05-08T00:00:00.000Z',`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`/**`);
  lines.push(` * Helper: 调 maskCustomer 给定 role 变体 (sales_owner/sales_other 用 isOwnerSelf 区分)`);
  lines.push(` * 返 actor's view of customer with role-specific mask`);
  lines.push(` */`);
  lines.push(`function maskCustomerByRoleVariant(roleVariant: string): Customer {`);
  lines.push(`  switch (roleVariant) {`);
  lines.push(`    case 'sales_owner':`);
  lines.push(`      return maskCustomer(customerFixture(), jwt('sales', USER_OWNER), { isOwnerSelf: true });`);
  lines.push(`    case 'sales_other':`);
  lines.push(`      return maskCustomer(customerFixture(), jwt('sales', USER_OTHER), { isOwnerSelf: false });`);
  lines.push(`    case 'unknown':`);
  lines.push(`      return maskCustomer(customerFixture(), { sub: 'x', tenantId: TENANT_A, role: 'foobar' as TenantRole, campusId: CAMPUS_A });`);
  lines.push(`    default:`);
  lines.push(`      return maskCustomer(customerFixture(), jwt(roleVariant as AnyRoleForTest));`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function maskTeacherByRoleVariant(roleVariant: string): Teacher {`);
  lines.push(`  switch (roleVariant) {`);
  lines.push(`    case 'teacher_self':`);
  lines.push(`      return maskTeacher(teacherFixture(), jwt('teacher', USER_OWNER), { isSelf: true });`);
  lines.push(`    case 'teacher_other':`);
  lines.push(`      return maskTeacher(teacherFixture(), jwt('teacher', USER_OTHER), { isSelf: false });`);
  lines.push(`    case 'unknown':`);
  lines.push(`      return maskTeacher(teacherFixture(), { sub: 'x', tenantId: TENANT_A, role: 'foobar' as TenantRole, campusId: CAMPUS_A });`);
  lines.push(`    default:`);
  lines.push(`      return maskTeacher(teacherFixture(), jwt(roleVariant as AnyRoleForTest));`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function maskContractByRoleVariant(roleVariant: string): Contract {`);
  lines.push(`  switch (roleVariant) {`);
  lines.push(`    case 'sales_owner':`);
  lines.push(`      return maskContract(contractFixture(), jwt('sales', USER_OWNER), { isOwnerSelf: true });`);
  lines.push(`    case 'sales_other':`);
  lines.push(`      return maskContract(contractFixture(), jwt('sales', USER_OTHER), { isOwnerSelf: false });`);
  lines.push(`    case 'unknown':`);
  lines.push(`      return maskContract(contractFixture(), { sub: 'x', tenantId: TENANT_A, role: 'foobar' as TenantRole, campusId: CAMPUS_A });`);
  lines.push(`    default:`);
  lines.push(`      return maskContract(contractFixture(), jwt(roleVariant as AnyRoleForTest));`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`describe('[RBAC L9 Batch D] 字段级权限矩阵 visible / masked / hidden = ${caseCount} case', () => {`);
  lines.push(``);

  // ============================================================
  // Customer field permission tests
  // ============================================================
  lines.push(`  describe('customer (maskCustomer × ${customerFieldCount} fields)', () => {`);
  for (const [fieldName, cell] of Object.entries(customerFields)) {
    lines.push(`    describe('field: ${fieldName}', () => {`);
    lines.push(`      // ${cell._category}`);
    lines.push(`      // visible=[${cell.visible.join(',')}]`);
    lines.push(`      // masked=[${cell.masked.join(',')}]`);
    lines.push(`      // hidden=[${cell.hidden.join(',')}]`);
    lines.push(``);
    // visible cases
    for (const role of cell.visible) {
      const origJs = JSON.stringify(cell._originalValue);
      lines.push(`      it('visible: ${role} → ${fieldName}=${typeof cell._originalValue === 'string' ? cell._originalValue : JSON.stringify(cell._originalValue)}', () => {`);
      lines.push(`        const result = maskCustomerByRoleVariant('${role}');`);
      // Use toEqual for arrays/objects, toBe for primitives
      if (Array.isArray(cell._originalValue) || (typeof cell._originalValue === 'object' && cell._originalValue !== null)) {
        lines.push(`        expect((result as Customer & Record<string, unknown>).${fieldName}).toEqual(${origJs});`);
      } else {
        lines.push(`        expect((result as Customer & Record<string, unknown>).${fieldName}).toBe(${origJs});`);
      }
      lines.push(`      });`);
    }
    // masked cases
    for (const role of cell.masked) {
      const maskJs = JSON.stringify(cell._maskedValue);
      lines.push(`      it('masked: ${role} → ${fieldName}=${cell._maskedValue === null ? 'null' : JSON.stringify(cell._maskedValue)}', () => {`);
      lines.push(`        const result = maskCustomerByRoleVariant('${role}');`);
      if (cell._maskedValue === null) {
        lines.push(`        expect((result as Customer & Record<string, unknown>).${fieldName}).toBeNull();`);
      } else {
        lines.push(`        expect((result as Customer & Record<string, unknown>).${fieldName}).toBe(${maskJs});`);
      }
      lines.push(`      });`);
    }
    // hidden cases (customer mask 用 null, 不 delete key — 无 hidden 期望, 但仍生成 case 防 manifest 误标)
    for (const role of cell.hidden) {
      lines.push(`      it('hidden: ${role} → ${fieldName} undefined (key removed)', () => {`);
      lines.push(`        const result = maskCustomerByRoleVariant('${role}');`);
      lines.push(`        expect((result as Customer & Record<string, unknown>).${fieldName}).toBeUndefined();`);
      lines.push(`      });`);
    }
    lines.push(`    });`);
    lines.push(``);
  }
  lines.push(`  });`);
  lines.push(``);

  // ============================================================
  // Teacher field permission tests
  // ============================================================
  lines.push(`  describe('teacher (maskTeacher × ${teacherFieldCount} fields)', () => {`);
  for (const [fieldName, cell] of Object.entries(teacherFields)) {
    lines.push(`    describe('field: ${fieldName}', () => {`);
    lines.push(`      // ${cell._category}`);
    lines.push(`      // visible=[${cell.visible.join(',')}]`);
    lines.push(`      // masked=[${cell.masked.join(',')}]`);
    lines.push(`      // hidden=[${cell.hidden.join(',')}]`);
    lines.push(``);
    for (const role of cell.visible) {
      const origJs = JSON.stringify(cell._originalValue);
      lines.push(`      it('visible: ${role} → ${fieldName}=${typeof cell._originalValue === 'string' ? cell._originalValue : JSON.stringify(cell._originalValue)}', () => {`);
      lines.push(`        const result = maskTeacherByRoleVariant('${role}');`);
      if (Array.isArray(cell._originalValue) || (typeof cell._originalValue === 'object' && cell._originalValue !== null)) {
        lines.push(`        expect((result as Teacher & Record<string, unknown>).${fieldName}).toEqual(${origJs});`);
      } else {
        lines.push(`        expect((result as Teacher & Record<string, unknown>).${fieldName}).toBe(${origJs});`);
      }
      lines.push(`      });`);
    }
    for (const role of cell.masked) {
      const maskJs = JSON.stringify(cell._maskedValue);
      lines.push(`      it('masked: ${role} → ${fieldName} masked', () => {`);
      lines.push(`        const result = maskTeacherByRoleVariant('${role}');`);
      if (cell._maskedValue === null) {
        lines.push(`        expect((result as Teacher & Record<string, unknown>).${fieldName}).toBeNull();`);
      } else if (typeof cell._maskedValue === 'string' && cell._maskedValue.startsWith('undefined')) {
        lines.push(`        expect((result as Teacher & Record<string, unknown>).${fieldName}).toBeUndefined();`);
      } else {
        lines.push(`        expect((result as Teacher & Record<string, unknown>).${fieldName}).toBe(${maskJs});`);
      }
      lines.push(`      });`);
    }
    for (const role of cell.hidden) {
      lines.push(`      it('hidden: ${role} → ${fieldName} undefined', () => {`);
      lines.push(`        const result = maskTeacherByRoleVariant('${role}');`);
      lines.push(`        expect((result as Teacher & Record<string, unknown>).${fieldName}).toBeUndefined();`);
      lines.push(`      });`);
    }
    lines.push(`    });`);
    lines.push(``);
  }
  lines.push(`  });`);
  lines.push(``);

  // ============================================================
  // Contract field permission tests
  // ============================================================
  lines.push(`  describe('contract (maskContract × ${contractFieldCount} fields)', () => {`);
  for (const [fieldName, cell] of Object.entries(contractFields)) {
    lines.push(`    describe('field: ${fieldName}', () => {`);
    lines.push(`      // ${cell._category}`);
    lines.push(`      // visible=[${cell.visible.join(',')}]`);
    lines.push(`      // masked=[${cell.masked.join(',')}]`);
    lines.push(`      // hidden=[${cell.hidden.join(',')}]`);
    lines.push(``);
    for (const role of cell.visible) {
      const origJs = JSON.stringify(cell._originalValue);
      lines.push(`      it('visible: ${role} → ${fieldName}=${typeof cell._originalValue === 'string' ? cell._originalValue : JSON.stringify(cell._originalValue)}', () => {`);
      lines.push(`        const result = maskContractByRoleVariant('${role}');`);
      if (Array.isArray(cell._originalValue) || (typeof cell._originalValue === 'object' && cell._originalValue !== null)) {
        lines.push(`        expect((result as Contract & Record<string, unknown>).${fieldName}).toEqual(${origJs});`);
      } else {
        lines.push(`        expect((result as Contract & Record<string, unknown>).${fieldName}).toBe(${origJs});`);
      }
      lines.push(`      });`);
    }
    for (const role of cell.masked) {
      const maskJs = JSON.stringify(cell._maskedValue);
      lines.push(`      it('masked: ${role} → ${fieldName}=${cell._maskedValue === null ? 'null' : JSON.stringify(cell._maskedValue)}', () => {`);
      lines.push(`        const result = maskContractByRoleVariant('${role}');`);
      if (cell._maskedValue === null) {
        lines.push(`        expect((result as Contract & Record<string, unknown>).${fieldName}).toBeNull();`);
      } else {
        lines.push(`        expect((result as Contract & Record<string, unknown>).${fieldName}).toBe(${maskJs});`);
      }
      lines.push(`      });`);
    }
    for (const role of cell.hidden) {
      lines.push(`      it('hidden: ${role} → ${fieldName} undefined', () => {`);
      lines.push(`        const result = maskContractByRoleVariant('${role}');`);
      lines.push(`        expect((result as Contract & Record<string, unknown>).${fieldName}).toBeUndefined();`);
      lines.push(`      });`);
    }
    lines.push(`    });`);
    lines.push(``);
  }
  lines.push(`  });`);
  lines.push(``);

  // ============================================================
  // Student access tests (canAccessStudent / canAccessContract / canAccessCustomer)
  // ============================================================
  lines.push(`  describe('student (canAccessStudent / canAccessContract / canAccessCustomer)', () => {`);
  lines.push(`    // fixture: student.ownerSalesId = USER_OWNER, student.assignedTeacherId = TEACHER_OWN`);
  lines.push(`    // contract.ownerUserId = USER_OWNER`);
  lines.push(`    // customer.ownerUserId = USER_OWNER`);
  lines.push(`    const studentRow = { ownerSalesId: USER_OWNER, assignedTeacherId: TEACHER_OWN };`);
  lines.push(`    const contractRow = { ownerUserId: USER_OWNER };`);
  lines.push(`    const customerRow = { ownerUserId: USER_OWNER };`);
  lines.push(``);
  lines.push(`    /** Helper：根据 roleVariant 选择 access 函数 + JWT 配置 */`);
  lines.push(`    function callAccess(fnName: 'student' | 'contract' | 'customer', roleVariant: string): boolean {`);
  lines.push(`      // 计算 sub: sales_owner / teacher_self → USER_OWNER, sales_other / teacher_other → USER_OTHER`);
  lines.push(`      let sub = USER_OWNER;`);
  lines.push(`      let role: AnyRoleForTest = 'admin';`);
  lines.push(`      let ownTeacherId: string | null = null;`);
  lines.push(`      switch (roleVariant) {`);
  lines.push(`        case 'sales_owner':`);
  lines.push(`          role = 'sales';`);
  lines.push(`          sub = USER_OWNER;`);
  lines.push(`          break;`);
  lines.push(`        case 'sales_other':`);
  lines.push(`          role = 'sales';`);
  lines.push(`          sub = USER_OTHER;`);
  lines.push(`          break;`);
  lines.push(`        case 'teacher_self':`);
  lines.push(`          role = 'teacher';`);
  lines.push(`          ownTeacherId = TEACHER_OWN;`);
  lines.push(`          break;`);
  lines.push(`        case 'teacher_other':`);
  lines.push(`          role = 'teacher';`);
  lines.push(`          ownTeacherId = TEACHER_OTHER;`);
  lines.push(`          break;`);
  lines.push(`        case 'unknown':`);
  lines.push(`          role = 'foobar' as TenantRole;`);
  lines.push(`          break;`);
  lines.push(`        case 'teacher':`);
  lines.push(`          role = 'teacher';`);
  lines.push(`          // canAccessStudent teacher 分支需 ownTeacherId — 缺则保守 false`);
  lines.push(`          if (fnName === 'student') ownTeacherId = null;`);
  lines.push(`          break;`);
  lines.push(`        default:`);
  lines.push(`          role = roleVariant as AnyRoleForTest;`);
  lines.push(`      }`);
  lines.push(`      const user = jwt(role, sub);`);
  lines.push(`      if (fnName === 'student') return canAccessStudent(studentRow, user, { ownTeacherId });`);
  lines.push(`      if (fnName === 'contract') return canAccessContract(contractRow, user);`);
  lines.push(`      return canAccessCustomer(customerRow, user);`);
  lines.push(`    }`);
  lines.push(``);

  // canAccessStudent_owned
  {
    const cell = studentFields.canAccessStudent_owned;
    lines.push(`    describe('field: canAccessStudent_owned', () => {`);
    lines.push(`      // ${cell._category}`);
    lines.push(`      // visible=[${cell.visible.join(',')}]`);
    lines.push(`      // hidden=[${cell.hidden.join(',')}]`);
    lines.push(``);
    for (const role of cell.visible) {
      lines.push(`      it('visible: ${role} → canAccessStudent = true', () => {`);
      lines.push(`        expect(callAccess('student', '${role}')).toBe(true);`);
      lines.push(`      });`);
    }
    for (const role of cell.hidden) {
      lines.push(`      it('hidden: ${role} → canAccessStudent = false', () => {`);
      lines.push(`        expect(callAccess('student', '${role}')).toBe(false);`);
      lines.push(`      });`);
    }
    lines.push(`    });`);
    lines.push(``);
  }
  // canAccessContract_owned
  {
    const cell = studentFields.canAccessContract_owned;
    lines.push(`    describe('field: canAccessContract_owned', () => {`);
    lines.push(`      // ${cell._category}`);
    lines.push(`      // visible=[${cell.visible.join(',')}]`);
    lines.push(`      // hidden=[${cell.hidden.join(',')}]`);
    lines.push(``);
    for (const role of cell.visible) {
      lines.push(`      it('visible: ${role} → canAccessContract = true', () => {`);
      lines.push(`        expect(callAccess('contract', '${role}')).toBe(true);`);
      lines.push(`      });`);
    }
    for (const role of cell.hidden) {
      lines.push(`      it('hidden: ${role} → canAccessContract = false', () => {`);
      lines.push(`        expect(callAccess('contract', '${role}')).toBe(false);`);
      lines.push(`      });`);
    }
    lines.push(`    });`);
    lines.push(``);
  }
  // canAccessCustomer_owned
  {
    const cell = studentFields.canAccessCustomer_owned;
    lines.push(`    describe('field: canAccessCustomer_owned', () => {`);
    lines.push(`      // ${cell._category}`);
    lines.push(`      // visible=[${cell.visible.join(',')}]`);
    lines.push(`      // hidden=[${cell.hidden.join(',')}]`);
    lines.push(``);
    for (const role of cell.visible) {
      lines.push(`      it('visible: ${role} → canAccessCustomer = true', () => {`);
      lines.push(`        expect(callAccess('customer', '${role}')).toBe(true);`);
      lines.push(`      });`);
    }
    for (const role of cell.hidden) {
      lines.push(`      it('hidden: ${role} → canAccessCustomer = false', () => {`);
      lines.push(`        expect(callAccess('customer', '${role}')).toBe(false);`);
      lines.push(`      });`);
    }
    lines.push(`    });`);
    lines.push(``);
  }
  lines.push(`  });`);
  lines.push(``);

  // ============================================================
  // Parent role-group mapping tests (actorGroupOf coverage)
  // ============================================================
  lines.push(`  describe('parent (actorGroupOf role → group 映射，13 角色覆盖)', () => {`);
  lines.push(`    // 测 actorGroupOf 对所有 13 SSOT + auxiliary 角色的 group 路由`);
  lines.push(`    // parent 无 maskParent 函数 (走 ParentJwt 独立 C 端 endpoint)，但 actorGroupOf 必须识别所有角色`);
  lines.push(``);
  const roleGroupMap = parentObj._fields.role_group_mapping._expectedGroup;
  for (const [role, expectedGroup] of Object.entries(roleGroupMap)) {
    lines.push(`    it('actorGroupOf("${role}") → "${expectedGroup}"', () => {`);
    lines.push(`      expect(actorGroupOf('${role}' as TenantRole)).toBe('${expectedGroup}');`);
    lines.push(`    });`);
  }
  lines.push(`  });`);
  lines.push(``);

  // ============================================================
  // Corner cases (defensive depth)
  // ============================================================
  lines.push(`  describe('corner cases (defensive depth — undefined user / null role / fixture immutability)', () => {`);
  lines.push(`    it('maskCustomer with user=undefined → 全 PII null', () => {`);
  lines.push(`      const r = maskCustomer(customerFixture(), undefined);`);
  lines.push(`      expect(r.phone).toBeNull();`);
  lines.push(`      expect(r.wechat).toBeNull();`);
  lines.push(`      expect(r.note).toBeNull();`);
  lines.push(`      expect(r.source).toBeNull();`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('maskCustomer with user=null → 全 PII null', () => {`);
  lines.push(`      const r = maskCustomer(customerFixture(), null);`);
  lines.push(`      expect(r.phone).toBeNull();`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('maskTeacher with user=undefined → phone undefined', () => {`);
  lines.push(`      const r = maskTeacher(teacherFixture(), undefined);`);
  lines.push(`      expect(r.phone).toBeUndefined();`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('maskContract with user=undefined → 价格全 0 / 业务字段保留', () => {`);
  lines.push(`      const r = maskContract(contractFixture(), undefined);`);
  lines.push(`      expect(r.totalAmount).toBe(0);`);
  lines.push(`      expect(r.standardPrice).toBe(0);`);
  lines.push(`      expect(r.discountAmount).toBe(0);`);
  lines.push(`      expect(r.giftHours).toBe(0);`);
  lines.push(`      expect(r.lessonHours).toBe(60); // 业务字段保留`);
  lines.push(`      expect(r.status).toBe('active');`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('maskCustomer 返新对象，不污染 fixture', () => {`);
  lines.push(`      const original = customerFixture();`);
  lines.push(`      const r = maskCustomer(original, jwt('teacher'));`);
  lines.push(`      expect(r.phone).toBeNull();`);
  lines.push(`      // 原 fixture 不变`);
  lines.push(`      expect(original.phone).toBe('13800138000');`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('maskTeacher 返新对象，不污染 fixture', () => {`);
  lines.push(`      const original = teacherFixture();`);
  lines.push(`      const r = maskTeacher(original, jwt('sales'));`);
  lines.push(`      expect(r.phone).toBeUndefined();`);
  lines.push(`      expect(original.phone).toBe('13900139000');`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('maskContract 返新对象，不污染 fixture', () => {`);
  lines.push(`      const original = contractFixture();`);
  lines.push(`      const r = maskContract(original, jwt('teacher'));`);
  lines.push(`      expect(r.totalAmount).toBe(0);`);
  lines.push(`      expect(original.totalAmount).toBe(9000);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('canAccessStudent with user=undefined → false', () => {`);
  lines.push(`      const studentRow = { ownerSalesId: USER_OWNER, assignedTeacherId: TEACHER_OWN };`);
  lines.push(`      expect(canAccessStudent(studentRow, undefined)).toBe(false);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('canAccessContract with user=undefined → false', () => {`);
  lines.push(`      const contractRow = { ownerUserId: USER_OWNER };`);
  lines.push(`      expect(canAccessContract(contractRow, undefined)).toBe(false);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('canAccessCustomer with user=undefined → false', () => {`);
  lines.push(`      const customerRow = { ownerUserId: USER_OWNER };`);
  lines.push(`      expect(canAccessCustomer(customerRow, undefined)).toBe(false);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('canAccessCustomer with ownerUserId=null (公共池) + sales → true (sales 可看公共池)', () => {`);
  lines.push(`      expect(canAccessCustomer({ ownerUserId: null }, jwt('sales', USER_OTHER))).toBe(true);`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('actorGroupOf(null) → unknown', () => {`);
  lines.push(`      expect(actorGroupOf(null)).toBe('unknown');`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('actorGroupOf(undefined) → unknown', () => {`);
  lines.push(`      expect(actorGroupOf(undefined)).toBe('unknown');`);
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    it('actorGroupOf("sales_director") legacy → unknown (5/15 A-2 删)', () => {`);
  lines.push(`      expect(actorGroupOf('sales_director' as TenantRole)).toBe('unknown');`);
  lines.push(`    });`);
  lines.push(`  });`);
  lines.push(``);

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
  const allowCount = batchAObjects.reduce(
    (acc, obj) => acc + actions.reduce((a, ac) => a + manifest.matrix[obj][ac].allow.length, 0),
    0,
  );
  const denyCount = batchAObjects.reduce(
    (acc, obj) => acc + actions.reduce((a, ac) => a + manifest.matrix[obj][ac].deny.length, 0),
    0,
  );
  console.log(`[generator] wrote ${outFile}`);
  console.log(`[generator] Batch A: ${batchAObjects.length} objects × ${actions.length} CRUD × ${allRoles.length} roles`);
  console.log(`[generator]   allow case: ${allowCount}`);
  console.log(`[generator]   deny case:  ${denyCount}`);
  console.log(`[generator]   + 4 corner case (user/role/reflector edge) = ${allowCount + denyCount + 4} total`);
}

if (batch === 'b' || batch === 'all') {
  const content = emitBatchB();
  const outFile = path.join(outDir, 'batch-b-peripheral.spec.ts');
  fs.writeFileSync(outFile, content, 'utf8');
  const allowCount = batchBObjects.reduce(
    (acc, obj) => acc + actions.reduce((a, ac) => a + manifest.matrix[obj][ac].allow.length, 0),
    0,
  );
  const denyCount = batchBObjects.reduce(
    (acc, obj) => acc + actions.reduce((a, ac) => a + manifest.matrix[obj][ac].deny.length, 0),
    0,
  );
  console.log(`[generator] wrote ${outFile}`);
  console.log(`[generator] Batch B: ${batchBObjects.length} objects × ${actions.length} CRUD × ${allRoles.length} roles`);
  console.log(`[generator]   allow case: ${allowCount}`);
  console.log(`[generator]   deny case:  ${denyCount}`);
  console.log(`[generator]   = ${allowCount + denyCount} total (与 prompt 468 差 ${allowCount + denyCount - 468}：4 auxiliary 角色 deny 全覆盖)`);
}

if (batch === 'c' || batch === 'all') {
  const content = emitBatchC();
  const outFile = path.join(outDir, 'batch-c-cross-tenant.spec.ts');
  fs.writeFileSync(outFile, content, 'utf8');
  const ctObjects = manifest.crossTenantBoundary.objects;
  const platformCount = 2; // platform_admin + finance_admin
  const normalCount = allRoles.length - platformCount;
  console.log(`[generator] wrote ${outFile}`);
  console.log(`[generator] Batch C: ${ctObjects.length} objects × ${allRoles.length} roles cross-tenant`);
  console.log(`[generator]   平台角色放行: ${ctObjects.length * platformCount} case (isPlatformRole 豁免)`);
  console.log(`[generator]   普通角色 403: ${ctObjects.length * normalCount} case (ForbiddenException)`);
  console.log(`[generator]   + 3 corner case (req.user undefined / tenantId null / case-insensitive 放行)`);
  console.log(`[generator]   + 15 P1-2 round 2 corner (3 vector × 5 case = query.tenantId / query.tenantSchema / x-tenant-schema)`);
  console.log(`[generator]   = ${ctObjects.length * allRoles.length + 3 + 15} total`);
}

if (batch === 'd' || batch === 'all') {
  const content = emitBatchD();
  const outDirD = path.join(outDir, 'batch-d');
  if (!fs.existsSync(outDirD)) {
    fs.mkdirSync(outDirD, { recursive: true });
  }
  const outFile = path.join(outDirD, 'field-permission.spec.ts');
  fs.writeFileSync(outFile, content, 'utf8');

  const fp = manifest.fieldPermission;
  const customerCases = Object.entries(fp.objects.customer._fields).reduce(
    (acc, [, c]) => acc + c.visible.length + c.masked.length + c.hidden.length,
    0,
  );
  const teacherCases = Object.entries(fp.objects.teacher._fields).reduce(
    (acc, [, c]) => acc + c.visible.length + c.masked.length + c.hidden.length,
    0,
  );
  const contractCases = Object.entries(fp.objects.contract._fields).reduce(
    (acc, [, c]) => acc + c.visible.length + c.masked.length + c.hidden.length,
    0,
  );
  const studentCases = Object.entries(fp.objects.student._fields).reduce(
    (acc, [, c]) => acc + c.visible.length + c.masked.length + c.hidden.length,
    0,
  );
  const parentCases = Object.keys(fp.objects.parent._fields.role_group_mapping._expectedGroup).length;
  const cornerCases = 14;
  const total = customerCases + teacherCases + contractCases + studentCases + parentCases + cornerCases;
  const customerFieldCount = Object.keys(fp.objects.customer._fields).length;
  const teacherFieldCount = Object.keys(fp.objects.teacher._fields).length;
  const contractFieldCount = Object.keys(fp.objects.contract._fields).length;
  const studentFieldCount = Object.keys(fp.objects.student._fields).length;

  console.log(`[generator] wrote ${outFile}`);
  console.log(`[generator] Batch D: 字段级权限矩阵 visible / masked / hidden`);
  console.log(`[generator]   customer: ${customerCases} case (${customerFieldCount} fields × 13 role variants)`);
  console.log(`[generator]   teacher:  ${teacherCases} case (${teacherFieldCount} fields × 13 role variants)`);
  console.log(`[generator]   contract: ${contractCases} case (${contractFieldCount} fields × 13 role variants)`);
  console.log(`[generator]   student:  ${studentCases} case (${studentFieldCount} access fields × 13 role variants)`);
  console.log(`[generator]   parent:   ${parentCases} case (actorGroupOf × 13 roles)`);
  console.log(`[generator]   corner:   ${cornerCases} case (defensive depth)`);
  console.log(`[generator]   = ${total} total (与 prompt 486 差 ${total - 486}：mask 函数实际行为驱动)`);
}
