import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CourseBalanceService, CoursePackage, StudentCoursePackage } from './course-balance.service';
import { CoursePackageRepository } from '../db/course-package.repository';

describe('CourseBalanceService InDb (V12)', () => {
  let service: CourseBalanceService;
  let repo: {
    insertPackage: jest.Mock;
    findPackageById: jest.Mock;
    listActivePackages: jest.Mock;
    archivePackage: jest.Mock;
    insertStudentPackage: jest.Mock;
    findStudentPackageById: jest.Mock;
    listActiveByStudent: jest.Mock;
    deductOneLesson: jest.Mock;
    refundLessons: jest.Mock;
    setStatus: jest.Mock;
    markLowBalanceAlerted: jest.Mock;
    extendExpiry: jest.Mock;
    findExpired: jest.Mock;
    findPendingLowBalanceAlerts: jest.Mock;
  };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const STUDENT = 'stu' + '0'.repeat(29);
  const PKG: CoursePackage = {
    id: 'pkg' + '0'.repeat(29),
    courseProductId: 'prod000000000000000000000000A001',
    name: '英语 30 课时',
    totalLessons: 30,
    unitPriceYuan: 200,
    totalPriceYuan: 6000,
    validityMonths: 12,
    status: 'active',
  };
  const SCP: StudentCoursePackage = {
    id: 'scp' + '0'.repeat(29),
    studentId: STUDENT,
    coursePackageId: PKG.id,
    totalLessons: 30,
    usedLessons: 0,
    refundedLessons: 0,
    remainingLessons: 30,
    activatedAt: new Date('2026-05-02'),
    expiresAt: new Date('2027-05-02'),
    status: 'active',
    lowBalanceAlerted: false,
  };

  beforeEach(async () => {
    repo = {
      insertPackage: jest.fn(),
      findPackageById: jest.fn(),
      listActivePackages: jest.fn(),
      archivePackage: jest.fn(),
      insertStudentPackage: jest.fn(),
      findStudentPackageById: jest.fn(),
      listActiveByStudent: jest.fn(),
      deductOneLesson: jest.fn(),
      refundLessons: jest.fn(),
      setStatus: jest.fn(),
      markLowBalanceAlerted: jest.fn(),
      extendExpiry: jest.fn(),
      findExpired: jest.fn(),
      findPendingLowBalanceAlerts: jest.fn(),
    };
    const m = await Test.createTestingModule({
      providers: [CourseBalanceService, { provide: CoursePackageRepository, useValue: repo }],
    }).compile();
    service = m.get(CourseBalanceService);
  });

  it('insertPackageInDb requires 32-char operator', async () => {
    await expect(
      service.insertPackageInDb(PKG, 'short', TENANT),
    ).rejects.toThrow(BadRequestException);
    expect(repo.insertPackage).not.toHaveBeenCalled();
  });

  it('activateStudentPackageInDb fetches package then runs pure logic + persist', async () => {
    repo.findPackageById.mockResolvedValueOnce(PKG);
    repo.insertStudentPackage.mockResolvedValueOnce(SCP);
    const r = await service.activateStudentPackageInDb(
      { id: SCP.id, studentId: STUDENT, coursePackageId: PKG.id },
      TENANT,
    );
    expect(r.id).toBe(SCP.id);
    expect(repo.insertStudentPackage).toHaveBeenCalledTimes(1);
  });

  it('activateStudentPackageInDb NotFoundException on missing package', async () => {
    repo.findPackageById.mockResolvedValueOnce(null);
    await expect(
      service.activateStudentPackageInDb(
        { id: SCP.id, studentId: STUDENT, coursePackageId: PKG.id },
        TENANT,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('deductOnConsumptionInDb marks low balance once when crossing threshold', async () => {
    repo.deductOneLesson.mockResolvedValueOnce({
      ...SCP,
      usedLessons: 26,
      remainingLessons: 4,
      lowBalanceAlerted: false,
    });
    repo.markLowBalanceAlerted.mockResolvedValueOnce({});
    const r = await service.deductOnConsumptionInDb(SCP.id, TENANT);
    expect(r.lowBalanceAlertNow).toBe(true);
    expect(r.updated.lowBalanceAlerted).toBe(true);
    expect(repo.markLowBalanceAlerted).toHaveBeenCalledTimes(1);
  });

  it('deductOnConsumptionInDb does not alert if already alerted', async () => {
    repo.deductOneLesson.mockResolvedValueOnce({
      ...SCP,
      usedLessons: 27,
      remainingLessons: 3,
      lowBalanceAlerted: true,
    });
    const r = await service.deductOnConsumptionInDb(SCP.id, TENANT);
    expect(r.lowBalanceAlertNow).toBe(false);
    expect(repo.markLowBalanceAlerted).not.toHaveBeenCalled();
  });

  it('refundLessonsInDb rejects 0 / negative count', async () => {
    await expect(service.refundLessonsInDb(SCP.id, 0, TENANT)).rejects.toThrow(BadRequestException);
    await expect(service.refundLessonsInDb(SCP.id, -3, TENANT)).rejects.toThrow(BadRequestException);
  });

  it('scanExpiredInDb iterates expired and updates each', async () => {
    repo.findExpired.mockResolvedValueOnce([SCP, { ...SCP, id: 'scp2' }]);
    repo.setStatus.mockResolvedValue({});
    const r = await service.scanExpiredInDb(TENANT, new Date('2027-06-01'));
    expect(r.expired).toBe(2);
    expect(repo.setStatus).toHaveBeenCalledTimes(2);
  });

  it('unfreezeInDb runs validation then extends expiry then sets active', async () => {
    repo.findStudentPackageById.mockResolvedValueOnce({ ...SCP, status: 'frozen' });
    repo.extendExpiry.mockResolvedValueOnce({});
    repo.setStatus.mockResolvedValueOnce({ ...SCP, status: 'active' });
    await service.unfreezeInDb(SCP.id, 7, TENANT);
    expect(repo.extendExpiry).toHaveBeenCalledWith(TENANT, SCP.id, 7);
    expect(repo.setStatus).toHaveBeenCalledWith(TENANT, SCP.id, 'active');
  });

  it('unfreezeInDb rejects when not frozen', async () => {
    repo.findStudentPackageById.mockResolvedValueOnce(SCP);
    await expect(service.unfreezeInDb(SCP.id, 7, TENANT)).rejects.toThrow(); // ConflictException from pure logic
  });

  it('throws when repo not injected', async () => {
    const noRepo = new CourseBalanceService();
    await expect(noRepo.listActiveByStudentInDb(STUDENT, TENANT)).rejects.toThrow(BadRequestException);
  });
});
