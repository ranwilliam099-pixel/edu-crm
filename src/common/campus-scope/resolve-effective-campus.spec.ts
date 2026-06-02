import { resolveEffectiveCampusId } from './resolve-effective-campus';
import { CampusRepository } from '../../modules/db/campus.repository';
import {
  AuthenticatedRequest,
  JwtPayload,
  TenantRole,
} from '../../modules/auth/jwt-payload.interface';

/**
 * resolve-effective-campus 单元测试（SSOT §3.-2 D）
 *
 * 覆盖矩阵：
 *   - admin override valid（∈ 本租户）→ 用 override
 *   - admin override 校区不存在（findById null）→ 回退 JWT
 *   - admin override 跨租户（findById null，tenant_id 不匹配）→ 回退 JWT
 *   - admin override 格式非法（脏值）→ 不抛错，回退 JWT
 *   - admin override repo 抛错 → fail-open 回退 JWT
 *   - admin 无 override → JWT
 *   - 非 admin（boss/sales/...）有 override → 忽略，恒 JWT
 *   - campusRepo 未注入（isolated spec）→ JWT
 *   - tenantId 缺失 → JWT
 */
describe('resolveEffectiveCampusId (SSOT §3.-2 D)', () => {
  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const JWT_CAMPUS = 'campus0000000000000000000000A001';
  const OVERRIDE_CAMPUS = 'campus0000000000000000000000B002';
  const ADMIN_SUB = 'adminA00000000000000000000000A001';
  const BOSS_SUB = 'boss0000000000000000000000000B001';

  let campusRepo: { findById: jest.Mock };

  function jwt(
    role: TenantRole,
    sub: string,
    campusId: string | null = JWT_CAMPUS,
    tenantId: string | null = TENANT_A,
  ): JwtPayload {
    return { sub, tenantId, role, campusId };
  }

  function req(user?: JwtPayload): AuthenticatedRequest {
    return {
      user,
      headers: {},
      body: {},
      query: {},
      params: {},
      ip: '1.2.3.4',
    } as AuthenticatedRequest;
  }

  function campusFixture(id: string) {
    return {
      id,
      tenantId: TENANT_A,
      name: '分校区',
      studentCount: 0,
      teacherCount: 0,
      status: 'active' as const,
      isHq: false,
      createdAt: new Date(),
    };
  }

  beforeEach(() => {
    campusRepo = { findById: jest.fn() };
  });

  // ============================================================
  // admin override valid → 用 override
  // ============================================================
  it('admin override valid（∈ 本租户 campuses）→ 返 override + findById(tenantId, override) 调用', async () => {
    campusRepo.findById.mockResolvedValueOnce(campusFixture(OVERRIDE_CAMPUS));
    const result = await resolveEffectiveCampusId(
      req(jwt('admin', ADMIN_SUB, JWT_CAMPUS)),
      OVERRIDE_CAMPUS,
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(OVERRIDE_CAMPUS);
    // 校验 ∈ 本租户：findById 以 tenantId（非 schema）+ override 调用
    expect(campusRepo.findById).toHaveBeenCalledWith(TENANT_A, OVERRIDE_CAMPUS);
  });

  it('admin override valid 但 JWT.campusId 为 null（跨校 admin）→ 仍返 override（override 命中）', async () => {
    campusRepo.findById.mockResolvedValueOnce(campusFixture(OVERRIDE_CAMPUS));
    const result = await resolveEffectiveCampusId(
      req(jwt('admin', ADMIN_SUB, null)),
      OVERRIDE_CAMPUS,
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(OVERRIDE_CAMPUS);
  });

  // ============================================================
  // admin override 校区不存在 → 回退 JWT
  // ============================================================
  it('admin override 校区不存在（findById 返 null）→ 回退 JWT.campusId（不抛错）', async () => {
    campusRepo.findById.mockResolvedValueOnce(null);
    const result = await resolveEffectiveCampusId(
      req(jwt('admin', ADMIN_SUB, JWT_CAMPUS)),
      OVERRIDE_CAMPUS,
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(JWT_CAMPUS);
    expect(campusRepo.findById).toHaveBeenCalledWith(TENANT_A, OVERRIDE_CAMPUS);
  });

  it('admin override 跨租户（findById tenant_id 双条件不匹配 → null）→ 回退 JWT（防越权选他租户校区）', async () => {
    // campusRepo.findById WHERE id=$1 AND tenant_id=$2 → 他租户校区返 null
    campusRepo.findById.mockResolvedValueOnce(null);
    const result = await resolveEffectiveCampusId(
      req(jwt('admin', ADMIN_SUB, JWT_CAMPUS)),
      OVERRIDE_CAMPUS,
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(JWT_CAMPUS);
  });

  // ============================================================
  // admin override 格式非法 → 不抛错，回退 JWT
  // ============================================================
  it('admin override 格式非法（脏值短串）→ 不抛错 + 不查 repo + 回退 JWT', async () => {
    const result = await resolveEffectiveCampusId(
      req(jwt('admin', ADMIN_SUB, JWT_CAMPUS)),
      'not-a-ulid',
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(JWT_CAMPUS);
    // 格式非法 → 提前回退，不查 DB
    expect(campusRepo.findById).not.toHaveBeenCalled();
  });

  it('admin override 含注入字符（带分号/引号）→ 格式校验拦截 + 回退 JWT', async () => {
    const result = await resolveEffectiveCampusId(
      req(jwt('admin', ADMIN_SUB, JWT_CAMPUS)),
      "x'; DROP TABLE campuses;--",
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(JWT_CAMPUS);
    expect(campusRepo.findById).not.toHaveBeenCalled();
  });

  it('admin override 33 字符（超长）→ 格式校验拦截 + 回退 JWT', async () => {
    const result = await resolveEffectiveCampusId(
      req(jwt('admin', ADMIN_SUB, JWT_CAMPUS)),
      'a'.repeat(33),
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(JWT_CAMPUS);
    expect(campusRepo.findById).not.toHaveBeenCalled();
  });

  // ============================================================
  // admin override repo 抛错 → fail-open 回退 JWT
  // ============================================================
  it('admin override repo.findById 抛错（DB 抖动）→ fail-open 回退 JWT（不抛 500）', async () => {
    campusRepo.findById.mockRejectedValueOnce(new Error('db down'));
    const result = await resolveEffectiveCampusId(
      req(jwt('admin', ADMIN_SUB, JWT_CAMPUS)),
      OVERRIDE_CAMPUS,
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(JWT_CAMPUS);
  });

  // ============================================================
  // admin 无 override → JWT
  // ============================================================
  it('admin 无 override（undefined）→ JWT.campusId + 不查 repo', async () => {
    const result = await resolveEffectiveCampusId(
      req(jwt('admin', ADMIN_SUB, JWT_CAMPUS)),
      undefined,
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(JWT_CAMPUS);
    expect(campusRepo.findById).not.toHaveBeenCalled();
  });

  it('admin 无 override + JWT.campusId 为 null → 返 null（调用方保留既有 null 兜底）', async () => {
    const result = await resolveEffectiveCampusId(
      req(jwt('admin', ADMIN_SUB, null)),
      undefined,
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBeNull();
  });

  it('admin override 空字符串 → 视为无 override → JWT', async () => {
    const result = await resolveEffectiveCampusId(
      req(jwt('admin', ADMIN_SUB, JWT_CAMPUS)),
      '',
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(JWT_CAMPUS);
    expect(campusRepo.findById).not.toHaveBeenCalled();
  });

  // ============================================================
  // 非 admin override 被忽略 → 恒 JWT（A04 防越权选他校）
  // ============================================================
  it('非 admin（boss）有 valid override → 忽略 override，恒返 JWT + 不查 repo', async () => {
    const result = await resolveEffectiveCampusId(
      req(jwt('boss', BOSS_SUB, JWT_CAMPUS)),
      OVERRIDE_CAMPUS,
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(JWT_CAMPUS);
    // boss 锁本校：连 DB 都不查（override 直接忽略）
    expect(campusRepo.findById).not.toHaveBeenCalled();
  });

  it('非 admin（sales）有 override → 恒返 JWT', async () => {
    const result = await resolveEffectiveCampusId(
      req(jwt('sales', BOSS_SUB, JWT_CAMPUS)),
      OVERRIDE_CAMPUS,
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(JWT_CAMPUS);
    expect(campusRepo.findById).not.toHaveBeenCalled();
  });

  it('非 admin（academic）有 override → 恒返 JWT', async () => {
    const result = await resolveEffectiveCampusId(
      req(jwt('academic', BOSS_SUB, JWT_CAMPUS)),
      OVERRIDE_CAMPUS,
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(JWT_CAMPUS);
    expect(campusRepo.findById).not.toHaveBeenCalled();
  });

  // ============================================================
  // campusRepo 未注入（isolated spec）→ JWT
  // ============================================================
  it('campusRepo 未注入（undefined，isolated spec）+ admin override → 回退 JWT（无法校验归属）', async () => {
    const result = await resolveEffectiveCampusId(
      req(jwt('admin', ADMIN_SUB, JWT_CAMPUS)),
      OVERRIDE_CAMPUS,
      undefined,
    );
    expect(result).toBe(JWT_CAMPUS);
  });

  // ============================================================
  // tenantId 缺失 → JWT（无法 scope 校验）
  // ============================================================
  it('admin override + tenantId 缺失（null）→ 回退 JWT（无法 tenant-scope 校验）', async () => {
    const result = await resolveEffectiveCampusId(
      req(jwt('admin', ADMIN_SUB, JWT_CAMPUS, null)),
      OVERRIDE_CAMPUS,
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBe(JWT_CAMPUS);
    expect(campusRepo.findById).not.toHaveBeenCalled();
  });

  // ============================================================
  // req.user 缺失（理论 framework 已拦）→ role=undefined → 走非 admin 分支 → JWT(null)
  // ============================================================
  it('req.user 缺失 → role=undefined（非 admin 分支）→ 返 null', async () => {
    const result = await resolveEffectiveCampusId(
      req(undefined),
      OVERRIDE_CAMPUS,
      campusRepo as unknown as CampusRepository,
    );
    expect(result).toBeNull();
    expect(campusRepo.findById).not.toHaveBeenCalled();
  });
});
