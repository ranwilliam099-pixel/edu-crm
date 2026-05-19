/**
 * CourseBalanceService 单元测试 — V12 BE-V12-1
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  CourseBalanceService,
  CoursePackage,
  StudentCoursePackage,
  LOW_BALANCE_THRESHOLD,
} from './course-balance.service';

const ULID32_P1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLPK01';
const ULID32_P2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLPK02';
const ULID32_S1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST1';
const ULID32_C1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLCT01';
const ULID32_PROD = '01HX7Y6P5K9N3M2QABCDEFGHIJKLPR01';
const ULID32_SCP1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLSCP1';

describe('CourseBalanceService - V12 BE-V12-1 教学链路 §1', () => {
  let service: CourseBalanceService;

  const samplePackage: CoursePackage = {
    id: ULID32_P1,
    courseProductId: ULID32_PROD,
    name: '英语 60 课时包',
    totalLessons: 60,
    unitPriceYuan: 100,
    totalPriceYuan: 6000,
    validityMonths: 12,
    status: 'active',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CourseBalanceService],
    }).compile();
    service = module.get<CourseBalanceService>(CourseBalanceService);
  });

  describe('activatePackage', () => {
    it('合法激活 → status=active + remaining=total + expires=activated+12 月', () => {
      const activatedAt = new Date('2026-05-02T00:00:00Z');
      const scp = service.activatePackage({
        id: ULID32_SCP1,
        studentId: ULID32_S1,
        coursePackage: samplePackage,
        contractId: ULID32_C1,
        activatedAt,
      });
      expect(scp.totalLessons).toBe(60);
      expect(scp.usedLessons).toBe(0);
      expect(scp.remainingLessons).toBe(60);
      expect(scp.status).toBe('active');
      // 12 个月 = 360 天
      const expectedExpiry = new Date(activatedAt.getTime() + 12 * 30 * 24 * 60 * 60 * 1000);
      expect(scp.expiresAt.getTime()).toBe(expectedExpiry.getTime());
    });

    it('archived package → BadRequestException', () => {
      expect(() =>
        service.activatePackage({
          id: ULID32_SCP1,
          studentId: ULID32_S1,
          coursePackage: { ...samplePackage, status: 'archived' },
        }),
      ).toThrow(BadRequestException);
    });

    it('id 长度非 32 → BadRequestException', () => {
      expect(() =>
        service.activatePackage({
          id: 'short',
          studentId: ULID32_S1,
          coursePackage: samplePackage,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('deductOnConsumption', () => {
    const baseScp: StudentCoursePackage = {
      id: ULID32_SCP1,
      studentId: ULID32_S1,
      coursePackageId: ULID32_P1,
      totalLessons: 60,
      usedLessons: 50,
      refundedLessons: 0,
      remainingLessons: 10,
      activatedAt: new Date('2026-05-02T00:00:00Z'),
      expiresAt: new Date('2027-05-02T00:00:00Z'),
      status: 'active',
      lowBalanceAlerted: false,
    };

    it('正常扣 → used+1, remaining-1', () => {
      const result = service.deductOnConsumption(baseScp);
      expect(result.updated.usedLessons).toBe(51);
      expect(result.updated.remainingLessons).toBe(9);
      expect(result.updated.status).toBe('active');
    });

    it('扣到 5 节剩余 → 触发低余额提醒', () => {
      const scp = { ...baseScp, usedLessons: 54, remainingLessons: 6 };
      const result = service.deductOnConsumption(scp);
      expect(result.updated.remainingLessons).toBe(5);
      expect(result.lowBalanceAlertNow).toBe(true);
      expect(result.updated.lowBalanceAlerted).toBe(true);
    });

    it('已发提醒不重复触发', () => {
      const scp = {
        ...baseScp,
        usedLessons: 55,
        remainingLessons: 5,
        lowBalanceAlerted: true,
      };
      const result = service.deductOnConsumption(scp);
      expect(result.lowBalanceAlertNow).toBe(false);
    });

    it('扣到 0 → status=depleted', () => {
      const scp = { ...baseScp, usedLessons: 59, remainingLessons: 1 };
      const result = service.deductOnConsumption(scp);
      expect(result.updated.remainingLessons).toBe(0);
      expect(result.updated.status).toBe('depleted');
    });

    it('frozen 不能扣 → ConflictException', () => {
      expect(() => service.deductOnConsumption({ ...baseScp, status: 'frozen' })).toThrow(
        ConflictException,
      );
    });

    it('depleted 不能扣 → ConflictException', () => {
      const scp = {
        ...baseScp,
        usedLessons: 60,
        remainingLessons: 0,
        status: 'depleted' as const,
      };
      expect(() => service.deductOnConsumption(scp)).toThrow(ConflictException);
    });
  });

  describe('refundLessons', () => {
    const baseScp: StudentCoursePackage = {
      id: ULID32_SCP1,
      studentId: ULID32_S1,
      coursePackageId: ULID32_P1,
      totalLessons: 60,
      usedLessons: 30,
      refundedLessons: 0,
      remainingLessons: 30,
      activatedAt: new Date(),
      expiresAt: new Date('2027-05-02T00:00:00Z'),
      status: 'active',
      lowBalanceAlerted: false,
    };

    it('退 10 节 → refunded=10, remaining=20', () => {
      const result = service.refundLessons(baseScp, 10);
      expect(result.refundedLessons).toBe(10);
      expect(result.remainingLessons).toBe(20);
      expect(result.status).toBe('active');
    });

    it('退完所有未用 → status=depleted', () => {
      const result = service.refundLessons(baseScp, 30);
      expect(result.refundedLessons).toBe(30);
      expect(result.remainingLessons).toBe(0);
      expect(result.status).toBe('depleted');
    });

    it('退超总数 → BadRequestException', () => {
      expect(() => service.refundLessons(baseScp, 31)).toThrow(BadRequestException);
    });

    it('count <= 0 → BadRequestException', () => {
      expect(() => service.refundLessons(baseScp, 0)).toThrow(BadRequestException);
    });
  });

  describe('checkSchedulable', () => {
    const validScp: StudentCoursePackage = {
      id: ULID32_SCP1,
      studentId: ULID32_S1,
      coursePackageId: ULID32_P1,
      totalLessons: 60,
      usedLessons: 0,
      refundedLessons: 0,
      remainingLessons: 60,
      activatedAt: new Date('2026-05-02T00:00:00Z'),
      expiresAt: new Date('2027-05-02T00:00:00Z'),
      status: 'active',
      lowBalanceAlerted: false,
    };

    it('active + 余额足 + 未过期 → true', () => {
      expect(service.checkSchedulable(validScp).canSchedule).toBe(true);
    });

    it('undefined → NO_PACKAGE', () => {
      expect(service.checkSchedulable(undefined).reason).toBe('NO_PACKAGE');
    });

    it('frozen → PACKAGE_FROZEN', () => {
      expect(service.checkSchedulable({ ...validScp, status: 'frozen' }).reason).toBe(
        'PACKAGE_FROZEN',
      );
    });

    it('depleted → PACKAGE_DEPLETED', () => {
      expect(
        service.checkSchedulable({ ...validScp, status: 'depleted', remainingLessons: 0 }).reason,
      ).toBe('PACKAGE_DEPLETED');
    });

    it('过期 → PACKAGE_EXPIRED', () => {
      expect(
        service.checkSchedulable(
          { ...validScp, expiresAt: new Date('2020-01-01') },
          new Date('2026-05-02T00:00:00Z'),
        ).reason,
      ).toBe('PACKAGE_EXPIRED');
    });
  });

  describe('scanExpired - cron 每天 0 点', () => {
    it('返回应过期的 active 包', () => {
      const now = new Date('2027-06-01T00:00:00Z');
      const packages: StudentCoursePackage[] = [
        {
          id: ULID32_SCP1,
          studentId: ULID32_S1,
          coursePackageId: ULID32_P1,
          totalLessons: 60,
          usedLessons: 30,
          refundedLessons: 0,
          remainingLessons: 30,
          activatedAt: new Date('2026-05-02T00:00:00Z'),
          expiresAt: new Date('2027-05-02T00:00:00Z'), // 已过期
          status: 'active',
          lowBalanceAlerted: false,
        },
      ];
      const result = service.scanExpired(packages, now);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('expired');
    });
  });

  describe('scanLowBalanceAlerts - cron', () => {
    it('返回未发提醒过且余额 <= 5 的包', () => {
      const packages: StudentCoursePackage[] = [
        {
          id: ULID32_SCP1,
          studentId: ULID32_S1,
          coursePackageId: ULID32_P1,
          totalLessons: 60,
          usedLessons: 56,
          refundedLessons: 0,
          remainingLessons: 4,
          activatedAt: new Date(),
          expiresAt: new Date('2027-05-02T00:00:00Z'),
          status: 'active',
          lowBalanceAlerted: false,
        },
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSCP2',
          studentId: ULID32_S1,
          coursePackageId: ULID32_P1,
          totalLessons: 60,
          usedLessons: 56,
          refundedLessons: 0,
          remainingLessons: 4,
          activatedAt: new Date(),
          expiresAt: new Date('2027-05-02T00:00:00Z'),
          status: 'active',
          lowBalanceAlerted: true, // 已发过
        },
      ];
      const result = service.scanLowBalanceAlerts(packages);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(ULID32_SCP1);
    });
  });

  describe('freeze / unfreeze', () => {
    const baseScp: StudentCoursePackage = {
      id: ULID32_SCP1,
      studentId: ULID32_S1,
      coursePackageId: ULID32_P1,
      totalLessons: 60,
      usedLessons: 10,
      refundedLessons: 0,
      remainingLessons: 50,
      activatedAt: new Date('2026-05-02T00:00:00Z'),
      expiresAt: new Date('2027-05-02T00:00:00Z'),
      status: 'active',
      lowBalanceAlerted: false,
    };

    it('active → freeze 合法', () => {
      const result = service.freeze(baseScp);
      expect(result.status).toBe('frozen');
    });

    it('frozen 不能再 freeze → ConflictException', () => {
      expect(() => service.freeze({ ...baseScp, status: 'frozen' })).toThrow(
        ConflictException,
      );
    });

    it('unfreeze 30 天 → expires +30 天 + status=active', () => {
      const frozen = { ...baseScp, status: 'frozen' as const };
      const result = service.unfreeze(frozen, 30);
      expect(result.status).toBe('active');
      expect(result.expiresAt.getTime()).toBe(
        baseScp.expiresAt.getTime() + 30 * 24 * 60 * 60 * 1000,
      );
    });

    it('unfreeze active 状态 → ConflictException', () => {
      expect(() => service.unfreeze(baseScp, 30)).toThrow(ConflictException);
    });

    it('unfreeze frozenDays<0 → BadRequestException', () => {
      expect(() => service.unfreeze({ ...baseScp, status: 'frozen' }, -1)).toThrow(
        BadRequestException,
      );
    });
  });

  describe('LOW_BALANCE_THRESHOLD constant', () => {
    it('为 5 节（设计稿 §9 Q-T2 默认值）', () => {
      expect(LOW_BALANCE_THRESHOLD).toBe(5);
    });
  });
});
