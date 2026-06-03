import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException, Logger } from '@nestjs/common';
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
    let repo: { insert: jest.Mock; findById: jest.Mock; findByIdWithMeta: jest.Mock; listByStudent: jest.Mock; update: jest.Mock; markParentRead: jest.Mock };
    let consumptionRepo: {
      findAllPendingByScheduleId: jest.Mock;
      confirmByFeedback: jest.Mock;
    };
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
    // P1 S3 (2026-05-21): consumption mock 默认 stub findAllPendingByScheduleId → []
    //   5/21 round 2 (BLOCKER-2)：单数版废弃，array 版支持多学生小班课
    const PENDING_CONSUMPTION: CourseConsumption = {
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
        findByIdWithMeta: jest.fn(),  // 2026-05-22 Wave A: findInDb 改用 findByIdWithMeta
        listByStudent: jest.fn(),
        update: jest.fn(),
        markParentRead: jest.fn(),
      };
      consumptionRepo = {
        findAllPendingByScheduleId: jest.fn().mockResolvedValue([]),
        confirmByFeedback: jest.fn(),
      };
      const m = await Test.createTestingModule({
        providers: [
          LessonFeedbackService,
          { provide: LessonFeedbackRepository, useValue: repo },
          { provide: CourseConsumptionRepository, useValue: consumptionRepo },
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

    // V68 (SSOT §3.-2 2026-06-03) 反馈级图片附件随提交落库（service 清洗后传 repo.insert）
    it('submitInDb 清洗后把 feedbackAttachments 传 repo.insert（非法丢弃 / 上限保留合法）', async () => {
      repo.insert.mockResolvedValueOnce({ ...FEEDBACK });
      await service.submitInDb(
        {
          id: FEEDBACK.id,
          scheduleId: FEEDBACK.scheduleId,
          studentId: FEEDBACK.studentId,
          teacherId: FEEDBACK.teacherId,
          attendanceStatus: '出勤',
          classroomPerformance: '良好',
          feedbackAttachments: [
            { url: 'https://minxin.top/uploads/a.jpg', type: 'image', filename: 'chat.jpg' },
            { url: 'javascript:alert(1)', type: 'image' }, // 非法 → 丢
          ] as any,
        },
        TENANT,
      );
      const persisted = repo.insert.mock.calls[0][1];
      // 只剩合法那张，非法被静默丢弃
      expect(persisted.feedbackAttachments).toEqual([
        { url: 'https://minxin.top/uploads/a.jpg', type: 'image', filename: 'chat.jpg' },
      ]);
    });

    it('submitInDb 不传 feedbackAttachments → repo.insert 收到 []（缺省）', async () => {
      repo.insert.mockResolvedValueOnce({ ...FEEDBACK });
      await service.submitInDb(
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
      expect(repo.insert.mock.calls[0][1].feedbackAttachments).toEqual([]);
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

    // P1 S3 (2026-05-21) — feedback 提交合并 consumption confirm
    //   5/21 round 2 (BLOCKER-2)：从单数 findPending → 数组 findAllPending（支持多学生小班课）
    //   6 case 覆盖：成功路径 / 数组空 / 单条失败 fail-open / 跨 tenant 隔离 / 多学生小班课 / 部分失败统计
    describe('S3 合并：submitInDb 自动 confirm 同 schedule 下 pending consumption', () => {
      it('成功路径：feedback 写 + consumption 自动 confirm（findAllPending → 1 条 confirmByFeedback 精确）', async () => {
        repo.insert.mockResolvedValueOnce(FEEDBACK);
        consumptionRepo.findAllPendingByScheduleId.mockResolvedValueOnce([PENDING_CONSUMPTION]);
        consumptionRepo.confirmByFeedback.mockResolvedValueOnce({
          ...PENDING_CONSUMPTION,
          status: 'confirmed',
          feedbackId: FEEDBACK.id,
          confirmedAt: new Date(),
        });

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

        // feedback 主流程返回值 = repo.insert 返回值
        expect(r.id).toBe(FEEDBACK.id);
        // findAllPending 调用：tenantSchema + scheduleId
        expect(consumptionRepo.findAllPendingByScheduleId).toHaveBeenCalledTimes(1);
        expect(consumptionRepo.findAllPendingByScheduleId).toHaveBeenCalledWith(
          TENANT,
          FEEDBACK.scheduleId,
        );
        // confirmByFeedback 调用：tenantSchema + consumption.id + 持久化后 feedback.id
        expect(consumptionRepo.confirmByFeedback).toHaveBeenCalledTimes(1);
        expect(consumptionRepo.confirmByFeedback).toHaveBeenCalledWith(
          TENANT,
          PENDING_CONSUMPTION.id,
          FEEDBACK.id,
        );
      });

      it('consumption 数组为空：feedback 写成功 + 不调 confirmByFeedback', async () => {
        repo.insert.mockResolvedValueOnce(FEEDBACK);
        consumptionRepo.findAllPendingByScheduleId.mockResolvedValueOnce([]);

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
        expect(consumptionRepo.findAllPendingByScheduleId).toHaveBeenCalledTimes(1);
        // 关键断言：[] 时 confirmByFeedback 必须不被调
        expect(consumptionRepo.confirmByFeedback).not.toHaveBeenCalled();
      });

      it('单条 confirm 抛错 → fail-open：feedback 仍写成功 + logger.warn 不抛主流程', async () => {
        const warnSpy = jest
          .spyOn((service as any).logger as Logger, 'warn')
          .mockImplementation(() => undefined);

        repo.insert.mockResolvedValueOnce(FEEDBACK);
        consumptionRepo.findAllPendingByScheduleId.mockResolvedValueOnce([PENDING_CONSUMPTION]);
        consumptionRepo.confirmByFeedback.mockRejectedValueOnce(
          new Error('PG connection lost'),
        );

        // fail-open：主 Promise 不 reject
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
        expect(consumptionRepo.confirmByFeedback).toHaveBeenCalledTimes(1);
        // logger.warn 至少 1 次，含 consumption.id + 错误原因（cron scan-and-lock 兜底依赖）
        expect(warnSpy).toHaveBeenCalled();
        const warnMsg = warnSpy.mock.calls[0][0] as string;
        expect(warnMsg).toContain('auto-confirm consumption');
        expect(warnMsg).toContain(PENDING_CONSUMPTION.id);
        expect(warnMsg).toContain('PG connection lost');

        warnSpy.mockRestore();
      });

      it('跨 tenant 隔离：tenantSchema 正确传递到 findAllPending + confirmByFeedback', async () => {
        const OTHER_TENANT = 'tenant_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
        repo.insert.mockResolvedValueOnce(FEEDBACK);
        consumptionRepo.findAllPendingByScheduleId.mockResolvedValueOnce([PENDING_CONSUMPTION]);
        consumptionRepo.confirmByFeedback.mockResolvedValueOnce({
          ...PENDING_CONSUMPTION,
          status: 'confirmed',
        });

        await service.submitInDb(
          {
            id: FEEDBACK.id,
            scheduleId: FEEDBACK.scheduleId,
            studentId: FEEDBACK.studentId,
            teacherId: FEEDBACK.teacherId,
            attendanceStatus: '出勤',
            classroomPerformance: '良好',
          },
          OTHER_TENANT,
        );

        // 3 个 repo 调用同 tenantSchema，杜绝跨租户写入
        expect(repo.insert.mock.calls[0][0]).toBe(OTHER_TENANT);
        expect(consumptionRepo.findAllPendingByScheduleId.mock.calls[0][0]).toBe(OTHER_TENANT);
        expect(consumptionRepo.confirmByFeedback.mock.calls[0][0]).toBe(OTHER_TENANT);
      });

      // 5/21 round 2 (BLOCKER-2 新 case)：多学生小班课
      it('多学生小班课：findAllPending 返 2 条 → 2 次 confirmByFeedback 全调（防 LIMIT 1 静默丢失）', async () => {
        const STUDENT_B = 'stuB' + '0'.repeat(28);
        const PENDING_B: CourseConsumption = {
          ...PENDING_CONSUMPTION,
          id: 'ccB' + '0'.repeat(29),
          studentId: STUDENT_B,
        };

        repo.insert.mockResolvedValueOnce(FEEDBACK);
        consumptionRepo.findAllPendingByScheduleId.mockResolvedValueOnce([
          PENDING_CONSUMPTION,
          PENDING_B,
        ]);
        consumptionRepo.confirmByFeedback
          .mockResolvedValueOnce({ ...PENDING_CONSUMPTION, status: 'confirmed' })
          .mockResolvedValueOnce({ ...PENDING_B, status: 'confirmed' });

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
        // 2 条 consumption 都被 confirm（多学生小班课正确语义）
        expect(consumptionRepo.confirmByFeedback).toHaveBeenCalledTimes(2);
        expect(consumptionRepo.confirmByFeedback).toHaveBeenNthCalledWith(
          1,
          TENANT,
          PENDING_CONSUMPTION.id,
          FEEDBACK.id,
        );
        expect(consumptionRepo.confirmByFeedback).toHaveBeenNthCalledWith(
          2,
          TENANT,
          PENDING_B.id,
          FEEDBACK.id,
        );
      });

      // 5/21 round 2 (BLOCKER-2 新 case)：部分失败统计正确（一条 confirm 失败不影响另一条）
      it('多学生：1 条 confirm 失败 + 1 条成功 → fail-open + logger 统计 confirmed=1/total=2', async () => {
        const PENDING_B: CourseConsumption = {
          ...PENDING_CONSUMPTION,
          id: 'ccB' + '0'.repeat(29),
        };
        const logSpy = jest
          .spyOn((service as any).logger as Logger, 'log')
          .mockImplementation(() => undefined);
        const warnSpy = jest
          .spyOn((service as any).logger as Logger, 'warn')
          .mockImplementation(() => undefined);

        repo.insert.mockResolvedValueOnce(FEEDBACK);
        consumptionRepo.findAllPendingByScheduleId.mockResolvedValueOnce([
          PENDING_CONSUMPTION,
          PENDING_B,
        ]);
        // 第 1 条失败、第 2 条成功 → 部分失败的统计应正确
        consumptionRepo.confirmByFeedback
          .mockRejectedValueOnce(new Error('row-1 locked'))
          .mockResolvedValueOnce({ ...PENDING_B, status: 'confirmed' });

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
        expect(consumptionRepo.confirmByFeedback).toHaveBeenCalledTimes(2);
        // 失败一条 → warn 一条
        expect(warnSpy).toHaveBeenCalledTimes(1);
        // 完成 log 一条含 confirmed=1/total=2 + scheduleId（spy 捕获多条 log，包括 pure submit 的；
        // 用 some() 找到 S3 统计那条）
        const logMessages = logSpy.mock.calls.map((args) => args[0] as string);
        const s3LogMsg = logMessages.find((m) => m.includes('[S3] auto-confirmed'));
        expect(s3LogMsg).toBeDefined();
        expect(s3LogMsg).toContain('1/2');
        expect(s3LogMsg).toContain(FEEDBACK.scheduleId);

        logSpy.mockRestore();
        warnSpy.mockRestore();
      });
    });

    it('findInDb throws NotFoundException when missing', async () => {
      // 2026-05-22 Wave A: findInDb 用 findByIdWithMeta (返扩展 meta)
      repo.findByIdWithMeta.mockResolvedValueOnce(null);
      await expect(service.findInDb('nope', TENANT)).rejects.toThrow(NotFoundException);
    });

    it('findInDb returns feedback with studentName/teacherName/subject', async () => {
      repo.findByIdWithMeta.mockResolvedValueOnce({
        ...FEEDBACK,
        studentName: '学员A',
        teacherName: '老师·王',
        subject: '一对一辅导',
      });
      const r = await service.findInDb(FEEDBACK.id, TENANT);
      expect((r as any).studentName).toBe('学员A');
      expect((r as any).teacherName).toBe('老师·王');
      expect((r as any).subject).toBe('一对一辅导');
    });

    // ============================================================
    // 2026-05-31 SSOT §5.1: teacherInternalNote 按 caller role 剥离
    //   仅 teacher/academic/academic_admin/boss/admin 可见明文；
    //   sales/sales_manager/parent → null（销售只读家长可见内容，家长走 C 端外部报）
    // ============================================================
    describe('teacherInternalNote role-based mask (SSOT §5.1)', () => {
      const FB_ATTS = [
        { url: 'https://minxin.top/uploads/t/202606/chat1.jpg', type: 'image', filename: 'chat1.jpg' },
      ];
      const FB_WITH_NOTE = {
        ...FEEDBACK,
        teacherNote: '家长可见：本次进步明显',
        teacherInternalNote: '内部：家长沟通需跟进，孩子家庭情况特殊',
        // V68 反馈级图片附件（家长可见，与 teacherInternalNote 相反，mask 不剥离）
        feedbackAttachments: FB_ATTS,
        studentName: '学员A',
        teacherName: '老师·王',
        subject: '一对一辅导',
      };

      // ----- findInDb -----
      it('findInDb role=sales → teacherInternalNote=null（teacherNote 等其它字段保留）', async () => {
        repo.findByIdWithMeta.mockResolvedValueOnce({ ...FB_WITH_NOTE });
        const r = await service.findInDb(FEEDBACK.id, TENANT, 'sales');
        expect(r.teacherInternalNote).toBeNull();
        // 其它字段不动
        expect(r.teacherNote).toBe('家长可见：本次进步明显');
        expect((r as any).studentName).toBe('学员A');
      });

      it('findInDb role=sales_manager → teacherInternalNote=null', async () => {
        repo.findByIdWithMeta.mockResolvedValueOnce({ ...FB_WITH_NOTE });
        const r = await service.findInDb(FEEDBACK.id, TENANT, 'sales_manager');
        expect(r.teacherInternalNote).toBeNull();
        expect(r.teacherNote).toBe('家长可见：本次进步明显');
      });

      it('findInDb role=parent → teacherInternalNote=null（C 端家长不可见）', async () => {
        repo.findByIdWithMeta.mockResolvedValueOnce({ ...FB_WITH_NOTE });
        const r = await service.findInDb(FEEDBACK.id, TENANT, 'parent');
        expect(r.teacherInternalNote).toBeNull();
        expect(r.teacherNote).toBe('家长可见：本次进步明显');
      });

      it('findInDb role=teacher → teacherInternalNote 明文保留', async () => {
        repo.findByIdWithMeta.mockResolvedValueOnce({ ...FB_WITH_NOTE });
        const r = await service.findInDb(FEEDBACK.id, TENANT, 'teacher');
        expect(r.teacherInternalNote).toBe('内部：家长沟通需跟进，孩子家庭情况特殊');
      });

      it('findInDb role=academic/academic_admin/boss/admin → teacherInternalNote 明文保留', async () => {
        for (const role of ['academic', 'academic_admin', 'boss', 'admin']) {
          repo.findByIdWithMeta.mockResolvedValueOnce({ ...FB_WITH_NOTE });
          const r = await service.findInDb(FEEDBACK.id, TENANT, role);
          expect(r.teacherInternalNote).toBe('内部：家长沟通需跟进，孩子家庭情况特殊');
        }
      });

      it('findInDb callerRole 省略（cron/内部）→ 保守剥离 teacherInternalNote=null', async () => {
        repo.findByIdWithMeta.mockResolvedValueOnce({ ...FB_WITH_NOTE });
        const r = await service.findInDb(FEEDBACK.id, TENANT);
        expect(r.teacherInternalNote).toBeNull();
      });

      // ----- listByStudentInDb -----
      it('listByStudentInDb role=sales → 每条 teacherInternalNote=null', async () => {
        repo.listByStudent.mockResolvedValueOnce([
          { ...FB_WITH_NOTE },
          { ...FB_WITH_NOTE, id: 'fb' + '1'.repeat(30) },
        ]);
        const list = await service.listByStudentInDb(STUDENT, TENANT, {}, 'sales');
        expect(list).toHaveLength(2);
        for (const fb of list) {
          expect(fb.teacherInternalNote).toBeNull();
          expect(fb.teacherNote).toBe('家长可见：本次进步明显'); // 其它字段不动
        }
      });

      it('listByStudentInDb role=parent → 每条 teacherInternalNote=null', async () => {
        repo.listByStudent.mockResolvedValueOnce([{ ...FB_WITH_NOTE }]);
        const list = await service.listByStudentInDb(STUDENT, TENANT, {}, 'parent');
        expect(list[0].teacherInternalNote).toBeNull();
      });

      it('listByStudentInDb role=teacher → teacherInternalNote 明文保留', async () => {
        repo.listByStudent.mockResolvedValueOnce([{ ...FB_WITH_NOTE }]);
        const list = await service.listByStudentInDb(STUDENT, TENANT, {}, 'teacher');
        expect(list[0].teacherInternalNote).toBe('内部：家长沟通需跟进，孩子家庭情况特殊');
      });

      it('listByStudentInDb callerRole 省略 → 保守剥离', async () => {
        repo.listByStudent.mockResolvedValueOnce([{ ...FB_WITH_NOTE }]);
        const list = await service.listByStudentInDb(STUDENT, TENANT, {});
        expect(list[0].teacherInternalNote).toBeNull();
      });

      // ----- markParentReadInDb (2026-05-31 安全审残留路径修复) -----
      it('markParentReadInDb role=parent → teacherInternalNote=null（家长打已读不泄露内部备注）', async () => {
        repo.markParentRead.mockResolvedValueOnce({ ...FB_WITH_NOTE });
        const r = await service.markParentReadInDb(FEEDBACK.id, TENANT, 'parent');
        expect(r.teacherInternalNote).toBeNull();
        expect(r.teacherNote).toBe('家长可见：本次进步明显');
      });

      it('markParentReadInDb role=teacher → teacherInternalNote 明文保留', async () => {
        repo.markParentRead.mockResolvedValueOnce({ ...FB_WITH_NOTE });
        const r = await service.markParentReadInDb(FEEDBACK.id, TENANT, 'teacher');
        expect(r.teacherInternalNote).toBe('内部：家长沟通需跟进，孩子家庭情况特殊');
      });

      it('markParentReadInDb callerRole 省略 → 保守剥离', async () => {
        repo.markParentRead.mockResolvedValueOnce({ ...FB_WITH_NOTE });
        const r = await service.markParentReadInDb(FEEDBACK.id, TENANT);
        expect(r.teacherInternalNote).toBeNull();
      });

      // ----- V68 (SSOT §3.-2): feedbackAttachments 家长可见 → 对所有 role 都不剥离 -----
      it('findInDb role=parent → feedbackAttachments 保留（家长可见，与 teacherInternalNote 相反）', async () => {
        repo.findByIdWithMeta.mockResolvedValueOnce({ ...FB_WITH_NOTE });
        const r = await service.findInDb(FEEDBACK.id, TENANT, 'parent');
        // 内部备注剥离，但反馈附件保留
        expect(r.teacherInternalNote).toBeNull();
        expect((r as any).feedbackAttachments).toEqual(FB_ATTS);
      });

      it('findInDb role=sales / sales_manager → feedbackAttachments 保留', async () => {
        for (const role of ['sales', 'sales_manager']) {
          repo.findByIdWithMeta.mockResolvedValueOnce({ ...FB_WITH_NOTE });
          const r = await service.findInDb(FEEDBACK.id, TENANT, role);
          expect(r.teacherInternalNote).toBeNull();
          expect((r as any).feedbackAttachments).toEqual(FB_ATTS);
        }
      });

      it('findInDb role=teacher → feedbackAttachments 保留（白名单角色同样不剥离）', async () => {
        repo.findByIdWithMeta.mockResolvedValueOnce({ ...FB_WITH_NOTE });
        const r = await service.findInDb(FEEDBACK.id, TENANT, 'teacher');
        expect((r as any).feedbackAttachments).toEqual(FB_ATTS);
      });

      it('listByStudentInDb role=parent → 每条 feedbackAttachments 保留', async () => {
        repo.listByStudent.mockResolvedValueOnce([{ ...FB_WITH_NOTE }]);
        const list = await service.listByStudentInDb(STUDENT, TENANT, {}, 'parent');
        expect(list[0].teacherInternalNote).toBeNull();
        expect((list[0] as any).feedbackAttachments).toEqual(FB_ATTS);
      });

      it('markParentReadInDb role=parent → feedbackAttachments 保留（C 端打已读后仍可见缩略图）', async () => {
        repo.markParentRead.mockResolvedValueOnce({ ...FB_WITH_NOTE });
        const r = await service.markParentReadInDb(FEEDBACK.id, TENANT, 'parent');
        expect(r.teacherInternalNote).toBeNull();
        expect((r as any).feedbackAttachments).toEqual(FB_ATTS);
      });
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
