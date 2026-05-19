import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { CoursePackageRepository } from './course-package.repository';
import { PgPoolService } from './pg-pool.service';
import {
  CoursePackage,
  StudentCoursePackage,
} from '../course-balance/course-balance.service';

describe('CoursePackageRepository', () => {
  let repo: CoursePackageRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock; transaction: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const PKG: CoursePackage = {
    id: 'pkg00000000000000000000000000A001',
    courseProductId: 'prod000000000000000000000000A001',
    name: '英语 30 课时包',
    totalLessons: 30,
    unitPriceYuan: 200,
    totalPriceYuan: 6000,
    validityMonths: 12,
    status: 'active',
  };
  const PKG_ROW = {
    id: PKG.id,
    course_product_id: PKG.courseProductId,
    name: PKG.name,
    total_lessons: 30,
    unit_price_yuan: '200.00',
    total_price_yuan: '6000.00',
    validity_months: 12,
    status: 'active',
  };
  const SCP: StudentCoursePackage = {
    id: 'scp00000000000000000000000000A001',
    studentId: 'stu00000000000000000000000000A001',
    coursePackageId: PKG.id,
    contractId: 'ctr00000000000000000000000000A001',
    totalLessons: 30,
    usedLessons: 0,
    refundedLessons: 0,
    remainingLessons: 30,
    activatedAt: new Date('2026-05-02'),
    expiresAt: new Date('2027-05-02'),
    status: 'active',
    lowBalanceAlerted: false,
  };
  const SCP_ROW = {
    id: SCP.id,
    student_id: SCP.studentId,
    course_package_id: SCP.coursePackageId,
    contract_id: SCP.contractId,
    total_lessons: 30,
    used_lessons: 0,
    refunded_lessons: 0,
    remaining_lessons: 30,
    activated_at: SCP.activatedAt,
    expires_at: SCP.expiresAt,
    status: 'active',
    low_balance_alerted: false,
  };

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn(), transaction: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        CoursePackageRepository,
        { provide: PgPoolService, useValue: pg },
      ],
    }).compile();
    repo = m.get(CoursePackageRepository);
  });

  describe('packages', () => {
    it('insertPackage maps row + parses prices', async () => {
      pg.tenantQuery.mockResolvedValueOnce([PKG_ROW]);
      const r = await repo.insertPackage(TENANT, PKG, 'admin' + 'x'.repeat(27));
      expect(r.unitPriceYuan).toBe(200);
      expect(r.totalPriceYuan).toBe(6000);
    });

    it('listActivePackages without filter has no WHERE on product', async () => {
      pg.tenantQuery.mockResolvedValueOnce([PKG_ROW]);
      const list = await repo.listActivePackages(TENANT);
      expect(list).toHaveLength(1);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).not.toContain('course_product_id = $1');
      expect(pg.tenantQuery.mock.calls[0][2]).toBeUndefined();
    });

    it('listActivePackages with product filter', async () => {
      pg.tenantQuery.mockResolvedValueOnce([PKG_ROW]);
      await repo.listActivePackages(TENANT, PKG.courseProductId);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('course_product_id = $1');
    });

    it('archivePackage NotFoundException on 0 rows', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(
        repo.archivePackage(TENANT, 'nope', 'op' + 'x'.repeat(30)),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('student packages', () => {
    it('insertStudentPackage returns calculated remainingLessons from DB', async () => {
      pg.tenantQuery.mockResolvedValueOnce([SCP_ROW]);
      const r = await repo.insertStudentPackage(TENANT, SCP);
      expect(r.remainingLessons).toBe(30);
    });

    it('listActiveByStudent maps multiple rows', async () => {
      pg.tenantQuery.mockResolvedValueOnce([SCP_ROW, { ...SCP_ROW, id: 'scp2' }]);
      const list = await repo.listActiveByStudent(TENANT, SCP.studentId);
      expect(list).toHaveLength(2);
    });

    it('refundLessons NotFoundException on overflow', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(repo.refundLessons(TENANT, SCP.id, 100)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('extendExpiry NotFoundException on missing', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(repo.extendExpiry(TENANT, 'nope', 7)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('findExpired filters by status active + expires_at', async () => {
      pg.tenantQuery.mockResolvedValueOnce([SCP_ROW]);
      const now = new Date('2027-06-01');
      await repo.findExpired(TENANT, now);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain("status = 'active'");
      expect(sql).toContain('expires_at < $1');
    });

    it('findPendingLowBalanceAlerts filters by low_balance_alerted=false', async () => {
      pg.tenantQuery.mockResolvedValueOnce([SCP_ROW]);
      await repo.findPendingLowBalanceAlerts(TENANT, 5);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('low_balance_alerted = FALSE');
      expect(sql).toContain('remaining_lessons <= $1');
      expect(pg.tenantQuery.mock.calls[0][2]).toEqual([5]);
    });
  });

  describe('deductOneLesson (transactional)', () => {
    it('runs in transaction and returns updated row', async () => {
      pg.transaction.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn(async (sql: string) => {
            if (sql.includes('UPDATE student_course_packages') && sql.includes('+ 1')) {
              return { rows: [{ ...SCP_ROW, used_lessons: 1, remaining_lessons: 29 }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
          }),
        };
        return fn(client);
      });
      const r = await repo.deductOneLesson(TENANT, SCP.id);
      expect(r.usedLessons).toBe(1);
      expect(r.remainingLessons).toBe(29);
      // 注：BEGIN/COMMIT 由 PgPoolService.transaction helper 负责
      expect(pg.transaction).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when 0 rows updated (helper rolls back)', async () => {
      pg.transaction.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
        };
        return fn(client);
      });
      await expect(repo.deductOneLesson(TENANT, SCP.id)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('auto sets depleted when remaining hits 0', async () => {
      pg.transaction.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn(async (sql: string) => {
            if (sql.includes('UPDATE student_course_packages') && sql.includes('+ 1')) {
              return {
                rows: [{ ...SCP_ROW, used_lessons: 30, remaining_lessons: 0 }],
                rowCount: 1,
              };
            }
            return { rows: [], rowCount: 0 };
          }),
        };
        return fn(client);
      });
      const r = await repo.deductOneLesson(TENANT, SCP.id);
      expect(r.status).toBe('depleted');
    });
  });
});
