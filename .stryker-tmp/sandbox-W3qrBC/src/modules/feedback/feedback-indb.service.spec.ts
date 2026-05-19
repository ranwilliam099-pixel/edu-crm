import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LessonFeedbackService, LessonFeedback } from './lesson-feedback.service';
import { CourseConsumptionService, CourseConsumption } from './course-consumption.service';
import { MonthlyReportService, MonthlyReport } from './monthly-report.service';
import { LessonFeedbackRepository } from '../db/lesson-feedback.repository';
import { CourseConsumptionRepository } from '../db/course-consumption.repository';
import { MonthlyReportRepository } from '../db/monthly-report.repository';

describe('Feedback Services InDb (V9)', () => {
  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const SCHEDULE = 'sched' + '0'.repeat(27);
  const STUDENT = 'stu' + '0'.repeat(29);
  const TEACHER = 'teach' + '0'.repeat(27);

  describe('LessonFeedbackService', () => {
    let service: LessonFeedbackService;
    let repo: { insert: jest.Mock; findById: jest.Mock; listByStudent: jest.Mock; update: jest.Mock; markParentRead: jest.Mock };
    const FEEDBACK: LessonFeedback = {
      id: 'fb' + '0'.repeat(30),
      scheduleId: SCHEDULE,
      studentId: STUDENT,
      teacherId: TEACHER,
      attendanceStatus: '出勤',
      classroomPerformance: '良好',
      submittedAt: new Date('2026-05-02T10:00:00Z'),
      updatedAt: new Date('2026-05-02T10:00:00Z'),
    };

    beforeEach(async () => {
      repo = {
        insert: jest.fn(),
        findById: jest.fn(),
        listByStudent: jest.fn(),
        update: jest.fn(),
        markParentRead: jest.fn(),
      };
      const m = await Test.createTestingModule({
        providers: [
          LessonFeedbackService,
          { provide: LessonFeedbackRepository, useValue: repo },
        ],
      }).compile();
      service = m.get(LessonFeedbackService);
    });

    it('submitInDb runs pure logic + persists', async () => {
      repo.insert.mockResolvedValueOnce(FEEDBACK);
      const r = await service.submitInDb(
        {
          id: FEEDBACK.id,
          scheduleId: FEEDBACK.scheduleId,
          studentId: FEEDBACK.studentId,
          teacherId: FEEDBACK.teacherId,
          attendanceStatus: '出勤',
          classroomPerformance: '良好',
        },
        TENANT,
      );
      expect(r.id).toBe(FEEDBACK.id);
      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert.mock.calls[0][0]).toBe(TENANT);
    });

    it('submitInDb propagates pure-logic validation', async () => {
      await expect(
        service.submitInDb(
          {
            id: 'short',
            scheduleId: SCHEDULE,
            studentId: STUDENT,
            teacherId: TEACHER,
            attendanceStatus: '出勤',
            classroomPerformance: '良好',
          },
          TENANT,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('findInDb throws NotFoundException when missing', async () => {
      repo.findById.mockResolvedValueOnce(null);
      await expect(service.findInDb('nope', TENANT)).rejects.toThrow(NotFoundException);
    });

    it('updateInDb checks 24h via existing record + persists patch', async () => {
      repo.findById.mockResolvedValueOnce(FEEDBACK);
      repo.update.mockResolvedValueOnce({ ...FEEDBACK, teacherNote: '新备注' });
      const now = new Date(FEEDBACK.submittedAt.getTime() + 60 * 60 * 1000);
      const r = await service.updateInDb(FEEDBACK.id, { teacherNote: '新备注' }, TENANT, now);
      expect(r.teacherNote).toBe('新备注');
      expect(repo.update).toHaveBeenCalledTimes(1);
    });

    it('updateInDb rejects after 24h', async () => {
      repo.findById.mockResolvedValueOnce(FEEDBACK);
      const now = new Date(FEEDBACK.submittedAt.getTime() + 25 * 3600 * 1000);
      await expect(
        service.updateInDb(FEEDBACK.id, { teacherNote: '迟' }, TENANT, now),
      ).rejects.toThrow(BadRequestException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('throws when repo not injected', async () => {
      const noRepoService = new LessonFeedbackService();
      await expect(noRepoService.findInDb('x', TENANT)).rejects.toThrow(BadRequestException);
    });
  });

  describe('CourseConsumptionService', () => {
    let service: CourseConsumptionService;
    let repo: {
      insert: jest.Mock;
      findById: jest.Mock;
      findOverdueForLock: jest.Mock;
      confirmByFeedback: jest.Mock;
      lock: jest.Mock;
      cancel: jest.Mock;
      // V38: 删 sumPayrollForTeacher mock（service 层方法已删，repo 层保留但 service 不再调）
    };
    const CC: CourseConsumption = {
      id: 'cc' + '0'.repeat(30),
      scheduleId: SCHEDULE,
      studentId: STUDENT,
      teacherId: TEACHER,
      status: 'pending_feedback',
      amountYuan: 200,
      feedbackDueAt: new Date('2026-05-03T10:00:00Z'),
      createdAt: new Date('2026-05-02T10:00:00Z'),
    };

    beforeEach(async () => {
      repo = {
        insert: jest.fn(),
        findById: jest.fn(),
        findOverdueForLock: jest.fn(),
        confirmByFeedback: jest.fn(),
        lock: jest.fn(),
        cancel: jest.fn(),
        // V38: 删 sumPayrollForTeacher mock
      };
      const m = await Test.createTestingModule({
        providers: [
          CourseConsumptionService,
          { provide: CourseConsumptionRepository, useValue: repo },
        ],
      }).compile();
      service = m.get(CourseConsumptionService);
    });

    it('createConsumptionInDb persists with feedbackDueAt = endAt + 24h', async () => {
      repo.insert.mockResolvedValueOnce(CC);
      await service.createConsumptionInDb(
        {
          id: CC.id,
          scheduleId: SCHEDULE,
          studentId: STUDENT,
          teacherId: TEACHER,
          scheduleEndAt: new Date('2026-05-02T10:00:00Z'),
          amountYuan: 200,
        },
        TENANT,
      );
      const persistedCc = repo.insert.mock.calls[0][1];
      expect(persistedCc.feedbackDueAt.getTime()).toBe(
        new Date('2026-05-03T10:00:00Z').getTime(),
      );
    });

    it('scanAndLockInDb iterates overdue and locks each', async () => {
      const cc2 = { ...CC, id: 'cc' + 'x'.repeat(30) };
      repo.findOverdueForLock.mockResolvedValueOnce([CC, cc2]);
      repo.lock.mockResolvedValue({ ...CC, status: 'locked' });
      const r = await service.scanAndLockInDb(TENANT, new Date('2026-05-04'));
      expect(r.locked).toBe(2);
      expect(r.ids).toHaveLength(2);
      expect(repo.lock).toHaveBeenCalledTimes(2);
    });

    it('scanAndLockInDb tolerates partial failure', async () => {
      repo.findOverdueForLock.mockResolvedValueOnce([CC]);
      repo.lock.mockRejectedValueOnce(new Error('boom'));
      const r = await service.scanAndLockInDb(TENANT, new Date());
      expect(r.locked).toBe(0);
      expect(r.ids).toHaveLength(0);
    });

    it('unlockByLateFeedbackInDb requires existing locked status', async () => {
      repo.findById.mockResolvedValueOnce({ ...CC, status: 'pending_feedback' });
      await expect(
        service.unlockByLateFeedbackInDb(CC.id, 'fb' + 'x'.repeat(30), TENANT),
      ).rejects.toThrow(BadRequestException);
    });

    // V38: 删 sumPayrollForTeacherInDb 单测（service 层方法已删，薪资业务下线）
  });

  describe('MonthlyReportService', () => {
    let service: MonthlyReportService;
    let repo: { insert: jest.Mock; findById: jest.Mock; listByStudent: jest.Mock; listPendingFinalize: jest.Mock; finalizeTeacher: jest.Mock; finalizeParent: jest.Mock; markParentRead: jest.Mock };
    let feedbackRepo: { listByStudentTeacherInRange: jest.Mock };
    const REPORT: MonthlyReport = {
      id: 'rpt' + '0'.repeat(29),
      studentId: STUDENT,
      teacherId: TEACHER,
      month: new Date('2026-05-01'),
      attendanceSummary: { total: 0, '出勤': 0, '迟到': 0, '缺席': 0, '请假': 0 },
      performanceTrend: [],
      knowledgeSummary: [],
      status: 'auto_generated',
      generatedAt: new Date('2026-06-01T00:30:00Z'),
    };

    beforeEach(async () => {
      repo = {
        insert: jest.fn(),
        findById: jest.fn(),
        listByStudent: jest.fn(),
        listPendingFinalize: jest.fn(),
        finalizeTeacher: jest.fn(),
        finalizeParent: jest.fn(),
        markParentRead: jest.fn(),
      };
      feedbackRepo = { listByStudentTeacherInRange: jest.fn() };
      const m = await Test.createTestingModule({
        providers: [
          MonthlyReportService,
          { provide: MonthlyReportRepository, useValue: repo },
          { provide: LessonFeedbackRepository, useValue: feedbackRepo },
        ],
      }).compile();
      service = m.get(MonthlyReportService);
    });

    it('generateInDb pulls month range feedbacks then persists', async () => {
      feedbackRepo.listByStudentTeacherInRange.mockResolvedValueOnce([]);
      repo.insert.mockResolvedValueOnce(REPORT);
      await service.generateInDb(
        {
          id: REPORT.id,
          studentId: STUDENT,
          teacherId: TEACHER,
          month: new Date('2026-05-15'),
        },
        TENANT,
      );
      expect(feedbackRepo.listByStudentTeacherInRange).toHaveBeenCalledTimes(1);
      const args = feedbackRepo.listByStudentTeacherInRange.mock.calls[0];
      // args = [tenantSchema, studentId, teacherId, rangeStart, rangeEnd]
      expect(args[0]).toBe(TENANT);
      expect(args[1]).toBe(STUDENT);
      expect(args[2]).toBe(TEACHER);
      expect(args[3].getMonth()).toBe(4); // May = 4
      expect(args[3].getDate()).toBe(1);
      expect(args[4].getMonth()).toBe(5); // June = 5
    });

    it('finalizeInDb requires non-empty blessing + suggestion', async () => {
      await expect(
        service.finalizeInDb(REPORT.id, '', '续报建议', TENANT, {
          operatorUserId: 'u1',
          actorRole: 'teacher',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.finalizeTeacher).not.toHaveBeenCalled();
    });

    it('finalizeInDb requires operatorUserId (audit_log chain integrity, P2 fix)', async () => {
      await expect(
        service.finalizeInDb(REPORT.id, '加油', '续报建议', TENANT, {
          operatorUserId: '',
          actorRole: 'teacher',
        }),
      ).rejects.toThrow(/operatorUserId required/);
      expect(repo.finalizeTeacher).not.toHaveBeenCalled();
    });

    it('finalizeParentInDb requires parentBlessing', async () => {
      await expect(
        service.finalizeParentInDb(
          REPORT.id,
          { parentBlessing: '' },
          TENANT,
          { operatorUserId: 'u1', actorRole: 'teacher' },
        ),
      ).rejects.toThrow(BadRequestException);
      expect(repo.finalizeParent).not.toHaveBeenCalled();
    });

    it('finalizeParentInDb requires operatorUserId (audit_log chain)', async () => {
      await expect(
        service.finalizeParentInDb(
          REPORT.id,
          { parentBlessing: '简短' },
          TENANT,
          { operatorUserId: '', actorRole: 'teacher' },
        ),
      ).rejects.toThrow(/operatorUserId required/);
      expect(repo.finalizeParent).not.toHaveBeenCalled();
    });

    it('finalizeParentInDb 正常路径 → 委托给 repo.finalizeParent', async () => {
      repo.finalizeParent.mockResolvedValueOnce(REPORT);
      const result = await service.finalizeParentInDb(
        REPORT.id,
        { parentBlessing: '家长版' },
        TENANT,
        { operatorUserId: 'u1', actorRole: 'teacher' },
      );
      expect(result).toBe(REPORT);
      expect(repo.finalizeParent).toHaveBeenCalledTimes(1);
      const args = repo.finalizeParent.mock.calls[0];
      expect(args[0]).toBe(TENANT);
      expect(args[1]).toBe(REPORT.id);
      expect(args[2].parentBlessing).toBe('家长版');
      expect(args[3].operatorUserId).toBe('u1');
    });

    it('findInDb 默认 audience=teacher，可传 parent 透传 repo', async () => {
      repo.findById.mockResolvedValueOnce(REPORT);
      await service.findInDb(REPORT.id, TENANT);
      expect(repo.findById).toHaveBeenLastCalledWith(TENANT, REPORT.id, 'teacher');

      repo.findById.mockResolvedValueOnce(REPORT);
      await service.findInDb(REPORT.id, TENANT, 'parent');
      expect(repo.findById).toHaveBeenLastCalledWith(TENANT, REPORT.id, 'parent');
    });

    it('listByStudentInDb 默认 audience=teacher，可传 parent', async () => {
      repo.listByStudent.mockResolvedValueOnce([REPORT]);
      await service.listByStudentInDb(STUDENT, TENANT);
      expect(repo.listByStudent).toHaveBeenLastCalledWith(TENANT, STUDENT, 'teacher');

      repo.listByStudent.mockResolvedValueOnce([REPORT]);
      await service.listByStudentInDb(STUDENT, TENANT, 'parent');
      expect(repo.listByStudent).toHaveBeenLastCalledWith(TENANT, STUDENT, 'parent');
    });

    it('listPendingFinalizeInDb filters by teacherId when provided', async () => {
      repo.listPendingFinalize.mockResolvedValueOnce([REPORT]);
      await service.listPendingFinalizeInDb(TENANT, TEACHER);
      expect(repo.listPendingFinalize).toHaveBeenCalledWith(TENANT, TEACHER);
    });
  });
});
