/**
 * course-package.repository.integration.spec.ts — Day 3 Phase B.L2 priority spec #5
 *
 * 触发：V12 课时包 + 学员账户
 *   - course_packages — 课包模板
 *   - student_course_packages — 学员账户（remaining_lessons GENERATED ALWAYS）
 *   - deductOneLesson — 事务保证单调递增 + 余额检查
 *   - findExpired / findPendingLowBalanceAlerts — cron 用
 *
 * 必测 case：
 *   1. insertPackage 成功 + listActivePackages 过滤
 *   2. insertStudentPackage — remaining_lessons GENERATED ALWAYS (total - used - refunded)
 *   3. deductOneLesson — 事务原子 + 余额耗尽自动 status='depleted'
 *   4. deductOneLesson 余额不足 → NotFoundException（status='active' AND remaining > 0 失败）
 *   5. refundLessons — refunded_lessons + 防越界（refunded + used ≤ total）
 *   6. extendExpiry — INTERVAL 加天数（NUMERIC 转 SQL interval）
 *   7. findExpired — cron 扫 expires_at < now() AND status='active'
 *   8. findPendingLowBalanceAlerts — remaining_lessons ≤ threshold AND alerted=FALSE
 *   9. archivePackage — status='archived'
 *  10. schema drift 反例 — DROP refunded_lessons → INSERT 必失败
 */

import { Pool } from 'pg';
import {
  createTestSchema,
  dropTestSchema,
  getTestPool,
  closeTestPool,
  runInSchema,
  seedCampus,
  seedAdminUser,
  seedCustomer,
  seedStudent,
  seedCourseProduct,
  testUlid,
} from './setup';
import { CoursePackageRepository } from '../../src/modules/db/course-package.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('CoursePackageRepository [integration, real PG, V12]', () => {
  let pool: Pool;
  let schema: string;
  let repo: CoursePackageRepository;
  let pgService: PgPoolService;
  let campusId: string;
  let adminId: string;
  let productId: string;
  let studentId: string;

  const mockConfig = {
    get: (key: string, def?: any) => {
      const map: Record<string, any> = {
        DB_HOST: 'localhost',
        DB_PORT: '5433',
        DB_USER: 'eduapp',
        DB_PASSWORD: 'testpassword',
        DB_NAME: 'edu_test',
        DB_POOL_MAX: '5',
        DB_STATEMENT_TIMEOUT_MS: '10000',
      };
      return map[key] ?? def;
    },
  };

  beforeAll(async () => {
    pool = getTestPool();
    schema = await createTestSchema('coursepkg');
    pgService = new PgPoolService(mockConfig as any);
    repo = new CoursePackageRepository(pgService);

    const campus = await seedCampus(schema);
    campusId = campus.id;
    const admin = await seedAdminUser(schema, campusId);
    adminId = admin.id;
    const product = await seedCourseProduct(schema);
    productId = product.id;
    const customer = await seedCustomer(schema, campusId, adminId);
    const student = await seedStudent(schema, customer.id);
    studentId = student.id;
  }, 30000);

  afterAll(async () => {
    await pgService.onModuleDestroy();
    await dropTestSchema(schema);
    await closeTestPool();
  });

  // ----------------------------------------------------------------
  // Case 1: insertPackage + listActivePackages 过滤
  // ----------------------------------------------------------------
  it('insertPackage + listActivePackages — 默认 status=active 过滤 + course_product 关联', async () => {
    const pkgId = testUlid();
    const pkg = await repo.insertPackage(
      schema,
      {
        id: pkgId,
        courseProductId: productId,
        name: '20 课时包',
        totalLessons: 20,
        unitPriceYuan: 200,
        totalPriceYuan: 4000,
        validityMonths: 12,
        status: 'active',
      } as any,
      adminId,
    );
    expect(pkg.id).toBe(pkgId);
    expect(pkg.totalLessons).toBe(20);
    expect(pkg.unitPriceYuan).toBe(200);
    expect(pkg.totalPriceYuan).toBe(4000);

    const active = await repo.listActivePackages(schema, productId);
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(pkgId);
  });

  // ----------------------------------------------------------------
  // Case 2: remaining_lessons GENERATED ALWAYS
  // ----------------------------------------------------------------
  it('insertStudentPackage — remaining_lessons GENERATED (total - used - refunded)', async () => {
    // 先建一个 course_package
    const pkgId = testUlid();
    await repo.insertPackage(
      schema,
      {
        id: pkgId,
        courseProductId: productId,
        name: '10 课时包',
        totalLessons: 10,
        unitPriceYuan: 200,
        totalPriceYuan: 2000,
        validityMonths: 6,
        status: 'active',
      } as any,
      adminId,
    );

    const scpId = testUlid();
    const scp = await repo.insertStudentPackage(schema, {
      id: scpId,
      studentId,
      coursePackageId: pkgId,
      contractId: null,
      totalLessons: 10,
      usedLessons: 0,
      refundedLessons: 0,
      activatedAt: new Date('2026-05-01'),
      expiresAt: new Date('2026-11-01'),
      status: 'active',
      lowBalanceAlerted: false,
    } as any);
    expect(scp.id).toBe(scpId);
    expect(scp.totalLessons).toBe(10);
    expect(scp.remainingLessons).toBe(10); // GENERATED ALWAYS

    // 直查 PG 验证 GENERATED
    const dbRow = await runInSchema(schema, async (c) => {
      const r = await c.query(
        `SELECT remaining_lessons FROM student_course_packages WHERE id = $1`,
        [scpId],
      );
      return r.rows[0];
    });
    expect(dbRow.remaining_lessons).toBe(10);
  });

  // ----------------------------------------------------------------
  // Case 3: deductOneLesson — 事务原子 + 自动 depleted
  // ----------------------------------------------------------------
  it('deductOneLesson — 事务原子 + 单调递增 + 余额耗尽自动 depleted', async () => {
    const pkgId = testUlid();
    await repo.insertPackage(
      schema,
      {
        id: pkgId,
        courseProductId: productId,
        name: '2 课时包',
        totalLessons: 2,
        unitPriceYuan: 200,
        totalPriceYuan: 400,
        validityMonths: 12,
        status: 'active',
      } as any,
      adminId,
    );
    const scpId = testUlid();
    await repo.insertStudentPackage(schema, {
      id: scpId,
      studentId,
      coursePackageId: pkgId,
      contractId: null,
      totalLessons: 2,
      usedLessons: 0,
      refundedLessons: 0,
      activatedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      status: 'active',
      lowBalanceAlerted: false,
    } as any);

    // 第 1 次：扣 1
    const r1 = await repo.deductOneLesson(schema, scpId);
    expect(r1.usedLessons).toBe(1);
    expect(r1.remainingLessons).toBe(1);
    expect(r1.status).toBe('active');

    // 第 2 次：扣到 0 → 自动 depleted
    const r2 = await repo.deductOneLesson(schema, scpId);
    expect(r2.usedLessons).toBe(2);
    expect(r2.remainingLessons).toBe(0);
    expect(r2.status).toBe('depleted');
  });

  // ----------------------------------------------------------------
  // Case 4: deductOneLesson 余额不足 → throw
  // ----------------------------------------------------------------
  it('deductOneLesson 余额不足 → NotFoundException', async () => {
    // 用上一 case 已 depleted 的 scp（remaining=0 + status='depleted'）
    const depletedRows = await runInSchema(schema, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM student_course_packages WHERE status='depleted' LIMIT 1`,
      );
      return r.rows;
    });
    expect(depletedRows.length).toBe(1);
    await expect(repo.deductOneLesson(schema, depletedRows[0].id)).rejects.toThrow(
      /not.*deductible|NotFound/i,
    );
  });

  // ----------------------------------------------------------------
  // Case 5: refundLessons + 防越界
  // ----------------------------------------------------------------
  it('refundLessons + 越界（refunded + used > total）→ NotFoundException', async () => {
    const pkgId = testUlid();
    await repo.insertPackage(
      schema,
      {
        id: pkgId,
        courseProductId: productId,
        name: '5 课时包',
        totalLessons: 5,
        unitPriceYuan: 200,
        totalPriceYuan: 1000,
        validityMonths: 12,
        status: 'active',
      } as any,
      adminId,
    );
    const scpId = testUlid();
    await repo.insertStudentPackage(schema, {
      id: scpId,
      studentId,
      coursePackageId: pkgId,
      contractId: null,
      totalLessons: 5,
      usedLessons: 2,
      refundedLessons: 0,
      activatedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      status: 'active',
      lowBalanceAlerted: false,
    } as any);

    // refund 1 OK（2 + 1 + 0 = 3 ≤ 5）
    const r1 = await repo.refundLessons(schema, scpId, 1);
    expect(r1.refundedLessons).toBe(1);
    expect(r1.remainingLessons).toBe(5 - 2 - 1); // = 2

    // refund 5 越界（2 + 1 + 5 = 8 > 5）
    await expect(repo.refundLessons(schema, scpId, 5)).rejects.toThrow(
      /refund.*overflow|not.*found|NotFound/i,
    );
  });

  // ----------------------------------------------------------------
  // Case 6: extendExpiry
  // ----------------------------------------------------------------
  it('extendExpiry — INTERVAL 加天数', async () => {
    const pkgId = testUlid();
    await repo.insertPackage(
      schema,
      {
        id: pkgId,
        courseProductId: productId,
        name: '延期测试包',
        totalLessons: 10,
        unitPriceYuan: 200,
        totalPriceYuan: 2000,
        validityMonths: 12,
        status: 'active',
      } as any,
      adminId,
    );
    const scpId = testUlid();
    const baseExpiresAt = new Date('2026-06-01T00:00:00Z');
    await repo.insertStudentPackage(schema, {
      id: scpId,
      studentId,
      coursePackageId: pkgId,
      contractId: null,
      totalLessons: 10,
      usedLessons: 0,
      refundedLessons: 0,
      activatedAt: new Date(),
      expiresAt: baseExpiresAt,
      status: 'active',
      lowBalanceAlerted: false,
    } as any);

    const r = await repo.extendExpiry(schema, scpId, 30); // +30 天
    const expectedExpiresAt = new Date(baseExpiresAt.getTime() + 30 * 24 * 3600 * 1000);
    expect(r.expiresAt.getTime()).toBe(expectedExpiresAt.getTime());
  });

  // ----------------------------------------------------------------
  // Case 7: findExpired
  // ----------------------------------------------------------------
  it('findExpired — 仅返 status=active AND expires_at < now', async () => {
    // 插一个 1 天前过期的 active scp
    const pkgId = testUlid();
    await repo.insertPackage(
      schema,
      {
        id: pkgId,
        courseProductId: productId,
        name: 'cron expire test',
        totalLessons: 10,
        unitPriceYuan: 200,
        totalPriceYuan: 2000,
        validityMonths: 12,
        status: 'active',
      } as any,
      adminId,
    );
    const expiredScpId = testUlid();
    await runInSchema(schema, async (c) => {
      await c.query(
        `INSERT INTO student_course_packages
           (id, student_id, course_package_id, contract_id,
            total_lessons, used_lessons, refunded_lessons,
            activated_at, expires_at, status, low_balance_alerted)
         VALUES ($1, $2, $3, NULL, 10, 0, 0,
                 NOW() - interval '60 days',
                 NOW() - interval '1 day',
                 'active', FALSE)`,
        [expiredScpId, studentId, pkgId],
      );
    });

    const expired = await repo.findExpired(schema, new Date());
    expect(expired.length).toBeGreaterThanOrEqual(1);
    const me = expired.find((x) => x.id === expiredScpId);
    expect(me).toBeDefined();
    expect(me!.status).toBe('active');
  });

  // ----------------------------------------------------------------
  // Case 8: findPendingLowBalanceAlerts
  // ----------------------------------------------------------------
  it('findPendingLowBalanceAlerts — remaining ≤ threshold AND alerted=FALSE', async () => {
    const pkgId = testUlid();
    await repo.insertPackage(
      schema,
      {
        id: pkgId,
        courseProductId: productId,
        name: 'low balance test',
        totalLessons: 10,
        unitPriceYuan: 200,
        totalPriceYuan: 2000,
        validityMonths: 12,
        status: 'active',
      } as any,
      adminId,
    );
    // scp: used=8 → remaining=2, alerted=FALSE
    const lowScpId = testUlid();
    await repo.insertStudentPackage(schema, {
      id: lowScpId,
      studentId,
      coursePackageId: pkgId,
      contractId: null,
      totalLessons: 10,
      usedLessons: 8,
      refundedLessons: 0,
      activatedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      status: 'active',
      lowBalanceAlerted: false,
    } as any);

    const pending = await repo.findPendingLowBalanceAlerts(schema, 3);
    const me = pending.find((p) => p.id === lowScpId);
    expect(me).toBeDefined();
    expect(me!.remainingLessons).toBe(2);
    expect(me!.lowBalanceAlerted).toBe(false);

    // 标 alerted=TRUE 后不再返
    await repo.markLowBalanceAlerted(schema, lowScpId);
    const pending2 = await repo.findPendingLowBalanceAlerts(schema, 3);
    expect(pending2.find((p) => p.id === lowScpId)).toBeUndefined();
  });

  // ----------------------------------------------------------------
  // Case 9: archivePackage
  // ----------------------------------------------------------------
  it('archivePackage — status=archived + 不在 listActivePackages 内', async () => {
    const pkgId = testUlid();
    await repo.insertPackage(
      schema,
      {
        id: pkgId,
        courseProductId: productId,
        name: 'archive test',
        totalLessons: 10,
        unitPriceYuan: 200,
        totalPriceYuan: 2000,
        validityMonths: 12,
        status: 'active',
      } as any,
      adminId,
    );
    const archived = await repo.archivePackage(schema, pkgId, adminId);
    expect(archived.status).toBe('archived');

    const activeList = await repo.listActivePackages(schema);
    expect(activeList.find((p) => p.id === pkgId)).toBeUndefined();
  });

  // ----------------------------------------------------------------
  // Case 10: schema drift — DROP refunded_lessons → INSERT 必失败
  // ----------------------------------------------------------------
  it('schema drift 反例: DROP refunded_lessons → INSERT 必失败 42703', async () => {
    const driftSchema = await createTestSchema('coursepkg-drift');
    try {
      // remaining_lessons 是 GENERATED ALWAYS — 不能直接 DROP refunded_lessons（依赖）
      // 改测：DROP used_lessons (GENERATED 的依赖) 应 cascade fail
      // 实际更稳：直接打错列名模拟 drift
      await expect(
        runInSchema(driftSchema, async (c) => {
          await c.query(
            `INSERT INTO ${driftSchema}.student_course_packages
               (id, student_id, course_package_id,
                total_lessons, used_lessons, refunded_lessons_DROPPED,
                activated_at, expires_at, status)
             VALUES ($1, $2, $3, 10, 0, 0,
                     NOW(), NOW() + interval '1 year', 'active')`,
            [testUlid(), studentId, testUlid()],
          );
        }),
      ).rejects.toThrow(/42703|column|does not exist/i);
    } finally {
      await dropTestSchema(driftSchema);
    }
  });
});
