/**
 * FeedbackController unit tests — Sprint B (2026-05-11) self-check 覆盖
 *
 * 重点：
 *   - finalize / finalize-parent 的 teacher self-check（teacher 只能改自己学生的报告）
 *   - admin / boss 跳过 self-check（拍板「老板校长 ✅ 全权」）
 *   - listPendingFinalizeInDb: teacher role 强制按自己 teacher_id 过滤
 *
 * 直接 new — 跳过 NestJS DI（避免 @UseInterceptors(IdempotencyInterceptor) 拉起 RedisService）
 * RbacGuard / TenantScopeGuard / IdempotencyInterceptor 已有独立 spec 覆盖
 */
import { ForbiddenException } from '@nestjs/common';
import { FeedbackController } from './feedback.controller';
import { LessonFeedbackService } from './lesson-feedback.service';
import { CourseConsumptionService } from './course-consumption.service';
import { MonthlyReportService } from './monthly-report.service';
import { TeacherRepository } from '../db/teacher.repository';
import { AuditLogRepository } from '../db/audit-log.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

describe('FeedbackController — Sprint B self-check', () => {
  let controller: FeedbackController;
  let feedbackSvc: { findInDb: jest.Mock; submitInDb: jest.Mock };
  let consumptionSvc: Record<string, jest.Mock>;
  let reportSvc: {
    findInDb: jest.Mock;
    finalizeInDb: jest.Mock;
    finalizeParentInDb: jest.Mock;
    listPendingFinalizeInDb: jest.Mock;
  };
  let teacherRepo: { findById: jest.Mock; findByUserId: jest.Mock };
  let auditLog: { log: jest.Mock };

  const TENANT = 'tenant_teacher_self_check_xxxxxxxx';
  const REPORT_ID = 'rep00000000000000000000000000R001';
  const TEACHER_T1 = 'tch00000000000000000000000000T001';
  const TEACHER_T2 = 'tch00000000000000000000000000T002';
  const USER_U1 = 'usr00000000000000000000000000U001'; // T1 绑定的用户
  const USER_U2 = 'usr00000000000000000000000000U002'; // T2 绑定的用户

  const baseReport = {
    id: REPORT_ID,
    studentId: 'stu00000000000000000000000000S001',
    teacherId: TEACHER_T1,
    month: new Date('2026-05-01'),
    attendanceSummary: { total: 0, attended: 0, absences: [] as never[] },
    teacherBlessing: null,
    renewalSuggestion: null,
    status: 'auto_generated' as const,
    generatedAt: new Date(),
  };

  // Day 2 Phase C X1 (2026-05-19 D1.4 拍板): hourlyPriceYuan 字段物理删除（V50 DROP COLUMN）
  const baseTeacherT1 = {
    id: TEACHER_T1,
    campusId: 'campus_a_00000000000000000000A001',
    name: 'T1',
    phone: undefined,
    userId: USER_U1,
    subjects: ['数学'],
    status: '在职' as const,
  };

  const baseTeacherT2 = {
    id: TEACHER_T2,
    campusId: 'campus_a_00000000000000000000A001',
    name: 'T2',
    phone: undefined,
    userId: USER_U2,
    subjects: ['英语'],
    status: '在职' as const,
  };

  beforeEach(() => {
    feedbackSvc = { findInDb: jest.fn(), submitInDb: jest.fn() };
    consumptionSvc = {};
    reportSvc = {
      findInDb: jest.fn(),
      finalizeInDb: jest.fn(),
      finalizeParentInDb: jest.fn(),
      listPendingFinalizeInDb: jest.fn(),
    };
    teacherRepo = { findById: jest.fn(), findByUserId: jest.fn() };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };

    controller = new FeedbackController(
      feedbackSvc as unknown as LessonFeedbackService,
      consumptionSvc as unknown as CourseConsumptionService,
      reportSvc as unknown as MonthlyReportService,
      teacherRepo as unknown as TeacherRepository,
      auditLog as unknown as AuditLogRepository,
    );
  });

  const mkReq = (overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest =>
    ({
      user: { sub: USER_U1, role: 'teacher', tenantId: 't', campusId: 'c' },
      ip: '1.2.3.4',
      headers: { 'user-agent': 'WeChatMP/8.0', 'x-request-id': 'req-abc' },
      ...overrides,
    }) as AuthenticatedRequest;

  // ============================================================
  // finalize (teacher 视角) self-check
  // ============================================================
  describe('finalizeReportInDb — teacher self-check', () => {
    it('teacher role + 自己学生的报告 (T1 改 T1 学生) → 放行', async () => {
      reportSvc.findInDb.mockResolvedValueOnce(baseReport);
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
      reportSvc.finalizeInDb.mockResolvedValueOnce({
        ...baseReport,
        teacherBlessing: 'bless',
        renewalSuggestion: 'renew',
        status: 'teacher_finalized',
      });

      const r = await controller.finalizeReportInDb(
        REPORT_ID,
        {
          teacherBlessing: 'bless',
          renewalSuggestion: 'renew',
          tenantSchema: TENANT,
        },
        mkReq(),
      );

      expect(r.status).toBe('teacher_finalized');
      // self-check 走 findInDb (audience='teacher') + findByUserId
      expect(reportSvc.findInDb).toHaveBeenCalledWith(REPORT_ID, TENANT, 'teacher');
      expect(teacherRepo.findByUserId).toHaveBeenCalledWith(TENANT, USER_U1);
      expect(reportSvc.finalizeInDb).toHaveBeenCalledTimes(1);
    });

    it('teacher role + 他人学生的报告 (T2 改 T1 学生) → ForbiddenException', async () => {
      // 报告归 T1，但 req.user 是 T2 绑定的 user
      reportSvc.findInDb.mockResolvedValueOnce(baseReport);
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT2);

      await expect(
        controller.finalizeReportInDb(
          REPORT_ID,
          {
            teacherBlessing: 'bless',
            renewalSuggestion: 'renew',
            tenantSchema: TENANT,
          },
          mkReq({ user: { sub: USER_U2, role: 'teacher', tenantId: 't', campusId: 'c' } }),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(reportSvc.finalizeInDb).not.toHaveBeenCalled();
    });

    it('teacher role + req.user.sub 未绑定 teachers 行 → ForbiddenException', async () => {
      reportSvc.findInDb.mockResolvedValueOnce(baseReport);
      teacherRepo.findByUserId.mockResolvedValueOnce(null);

      await expect(
        controller.finalizeReportInDb(
          REPORT_ID,
          {
            teacherBlessing: 'bless',
            renewalSuggestion: 'renew',
            tenantSchema: TENANT,
          },
          mkReq(),
        ),
      ).rejects.toThrow(/no teachers row bound/);
      expect(reportSvc.finalizeInDb).not.toHaveBeenCalled();
    });

    it('admin role → 跳过 self-check（可改任意 teacher_id 的月报）', async () => {
      // 报告归 T1，admin 不需要绑老师档案
      reportSvc.finalizeInDb.mockResolvedValueOnce({
        ...baseReport,
        status: 'teacher_finalized',
      });

      const r = await controller.finalizeReportInDb(
        REPORT_ID,
        { teacherBlessing: 'b', renewalSuggestion: 'r', tenantSchema: TENANT },
        mkReq({
          user: { sub: 'admin_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxA01', role: 'admin', tenantId: null, campusId: null },
        }),
      );
      expect(r.status).toBe('teacher_finalized');
      // admin 不应触发 self-check 的 findInDb / findByUserId
      expect(reportSvc.findInDb).not.toHaveBeenCalled();
      expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
    });

    it('boss role → 跳过 self-check', async () => {
      reportSvc.finalizeInDb.mockResolvedValueOnce({
        ...baseReport,
        status: 'teacher_finalized',
      });
      await controller.finalizeReportInDb(
        REPORT_ID,
        { teacherBlessing: 'b', renewalSuggestion: 'r', tenantSchema: TENANT },
        mkReq({
          user: { sub: 'boss_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxB01', role: 'boss', tenantId: 't', campusId: 'c' },
        }),
      );
      expect(reportSvc.findInDb).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // finalizeParent self-check
  // ============================================================
  describe('finalizeReportParentInDb — teacher self-check', () => {
    it('teacher role + 自己学生的报告 → 放行', async () => {
      reportSvc.findInDb.mockResolvedValueOnce(baseReport);
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
      reportSvc.finalizeParentInDb.mockResolvedValueOnce({ ...baseReport, parentBlessing: 'p' });

      const r = await controller.finalizeReportParentInDb(
        REPORT_ID,
        { parentBlessing: '加油', tenantSchema: TENANT },
        mkReq(),
      );
      expect(r.parentBlessing).toBe('p');
      // teacherRepo.findByUserId 应被调一次（self-check 根据 JWT sub 查 teacher 记录）
      expect(teacherRepo.findByUserId).toHaveBeenCalledTimes(1);
      expect(teacherRepo.findByUserId).toHaveBeenCalledWith(TENANT, USER_U1);
    });

    it('teacher role + 他人学生 → ForbiddenException', async () => {
      reportSvc.findInDb.mockResolvedValueOnce(baseReport);
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT2);
      await expect(
        controller.finalizeReportParentInDb(
          REPORT_ID,
          { parentBlessing: '攻击', tenantSchema: TENANT },
          mkReq({ user: { sub: USER_U2, role: 'teacher', tenantId: 't', campusId: 'c' } }),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(reportSvc.finalizeParentInDb).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // listPendingFinalizeInDb: teacher role 强制按自己 teacher_id 过滤
  // ============================================================
  describe('listPendingFinalizeInDb — teacher 强制按自己 teacher_id 过滤', () => {
    it('teacher role + body 无 teacherId → 用 req.user 反查的 teacher.id 过滤', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
      reportSvc.listPendingFinalizeInDb.mockResolvedValueOnce([baseReport]);

      const r = await controller.listPendingFinalizeInDb(
        { tenantSchema: TENANT },
        mkReq(),
      );
      expect(r).toHaveLength(1);
      expect(reportSvc.listPendingFinalizeInDb).toHaveBeenCalledWith(TENANT, TEACHER_T1);
    });

    it('teacher role + body 传他人 teacherId → 仍强制覆盖为自己（防越权）', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
      reportSvc.listPendingFinalizeInDb.mockResolvedValueOnce([]);

      await controller.listPendingFinalizeInDb(
        { tenantSchema: TENANT, teacherId: TEACHER_T2 }, // 攻击：传他人 id
        mkReq(),
      );
      // 应被强制改为自己 T1
      expect(reportSvc.listPendingFinalizeInDb).toHaveBeenCalledWith(TENANT, TEACHER_T1);
    });

    it('admin role + body 传 teacherId → 透传不覆盖', async () => {
      reportSvc.listPendingFinalizeInDb.mockResolvedValueOnce([baseReport]);
      await controller.listPendingFinalizeInDb(
        { tenantSchema: TENANT, teacherId: TEACHER_T2 },
        mkReq({
          user: { sub: 'admin_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxA01', role: 'admin', tenantId: null, campusId: null },
        }),
      );
      expect(reportSvc.listPendingFinalizeInDb).toHaveBeenCalledWith(TENANT, TEACHER_T2);
      // admin 不应触发 findByUserId
      expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
    });

    it('academic role + body 无 teacherId → 不过滤（教务看全 campus）', async () => {
      reportSvc.listPendingFinalizeInDb.mockResolvedValueOnce([baseReport]);
      await controller.listPendingFinalizeInDb(
        { tenantSchema: TENANT },
        mkReq({
          user: { sub: 'acd_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxA01', role: 'academic', tenantId: 't', campusId: 'c' },
        }),
      );
      expect(reportSvc.listPendingFinalizeInDb).toHaveBeenCalledWith(TENANT, undefined);
    });

    it('teacher role + req.user.sub 未绑定 teacher 档案 → ForbiddenException', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce(null);
      await expect(
        controller.listPendingFinalizeInDb({ tenantSchema: TENANT }, mkReq()),
      ).rejects.toThrow(/no teachers row bound/);
      expect(reportSvc.listPendingFinalizeInDb).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 5/21 round 2 (security BLOCKER-1): submitFeedbackInDb teacher self-check
  // ============================================================
  describe('submitFeedbackInDb — teacher self-check（按 body.teacherId 比对 JWT 反查）', () => {
    const FEEDBACK_ID = 'fb' + '0'.repeat(30);
    const SCHEDULE_ID = 'sched' + '0'.repeat(27);
    const STUDENT_ID = 'stu' + '0'.repeat(29);

    const baseBody = {
      id: FEEDBACK_ID,
      scheduleId: SCHEDULE_ID,
      studentId: STUDENT_ID,
      teacherId: TEACHER_T1,
      attendanceStatus: '出勤' as const,
      classroomPerformance: '良好' as const,
      tenantSchema: TENANT,
    };

    const persistedFeedback = {
      id: FEEDBACK_ID,
      scheduleId: SCHEDULE_ID,
      studentId: STUDENT_ID,
      teacherId: TEACHER_T1,
      attendanceStatus: '出勤' as const,
      classroomPerformance: '良好' as const,
      submittedAt: new Date('2026-05-21T10:00:00Z'),
      updatedAt: new Date('2026-05-21T10:00:00Z'),
    };

    it('teacher role + body.teacherId = 自己 → 放行 + 写 audit_log lesson-feedback.submitted', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
      feedbackSvc.submitInDb.mockResolvedValueOnce(persistedFeedback);

      const r = await controller.submitFeedbackInDb(baseBody, mkReq());

      expect(r.id).toBe(FEEDBACK_ID);
      // self-check 调 findByUserId
      expect(teacherRepo.findByUserId).toHaveBeenCalledWith(TENANT, USER_U1);
      // service submitInDb 被调
      expect(feedbackSvc.submitInDb).toHaveBeenCalledTimes(1);
      // audit_log 必须写 lesson-feedback.submitted
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const [auditTenant, auditEntry] = auditLog.log.mock.calls[0];
      expect(auditTenant).toBe(TENANT);
      expect(auditEntry.action).toBe('lesson-feedback.submitted');
      expect(auditEntry.targetType).toBe('lesson_feedback');
      expect(auditEntry.targetId).toBe(FEEDBACK_ID);
      expect(auditEntry.actorUserId).toBe(USER_U1);
      expect(auditEntry.actorRole).toBe('teacher');
      expect(auditEntry.after).toMatchObject({
        scheduleId: SCHEDULE_ID,
        studentId: STUDENT_ID,
        teacherId: TEACHER_T1,
        attendanceStatus: '出勤',
      });
    });

    it('teacher 伪造 body.teacherId 为他人 → ForbiddenException + 写 audit_log teacher.self-check-failed + 不调 submitInDb', async () => {
      // 攻击：req.user 是 U1 (绑 T1)，但 body.teacherId 传 T2
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);

      await expect(
        controller.submitFeedbackInDb(
          { ...baseBody, teacherId: TEACHER_T2 },
          mkReq(),
        ),
      ).rejects.toThrow(ForbiddenException);

      // submitInDb 必须不被调（self-check 早期拦截）
      expect(feedbackSvc.submitInDb).not.toHaveBeenCalled();
      // 拒绝路径写 audit_log teacher.self-check-failed
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const auditEntry = auditLog.log.mock.calls[0][1];
      expect(auditEntry.action).toBe('teacher.self-check-failed');
      expect(auditEntry.targetType).toBe('lesson_feedback');
      expect(auditEntry.after.attempted_teacher_id).toBe(TEACHER_T2);
      expect(auditEntry.after.own_teacher_id).toBe(TEACHER_T1);
    });

    it('teacher role + req.user.sub 未绑定 teachers 行 → ForbiddenException + 不调 submitInDb', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce(null);

      await expect(
        controller.submitFeedbackInDb(baseBody, mkReq()),
      ).rejects.toThrow(/no teachers row bound/);
      expect(feedbackSvc.submitInDb).not.toHaveBeenCalled();
    });

    it('admin role → 跳过 self-check（可写任意 teacherId） + 仍写 audit_log', async () => {
      // 攻击场景反转：admin 调 body.teacherId=T2 应被放行（拍板「老板校长 ✅ 全权」）
      feedbackSvc.submitInDb.mockResolvedValueOnce({ ...persistedFeedback, teacherId: TEACHER_T2 });

      const r = await controller.submitFeedbackInDb(
        { ...baseBody, teacherId: TEACHER_T2 },
        mkReq({
          user: { sub: 'admin_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxA01', role: 'admin', tenantId: null, campusId: null },
        }),
      );

      expect(r.id).toBe(FEEDBACK_ID);
      // admin 不应触发 self-check 的 findByUserId
      expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
      expect(feedbackSvc.submitInDb).toHaveBeenCalledTimes(1);
      // admin 写成功仍记 audit_log（actorRole='admin'）
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const auditEntry = auditLog.log.mock.calls[0][1];
      expect(auditEntry.action).toBe('lesson-feedback.submitted');
      expect(auditEntry.actorRole).toBe('admin');
    });

    it('boss role → 跳过 self-check', async () => {
      feedbackSvc.submitInDb.mockResolvedValueOnce(persistedFeedback);

      await controller.submitFeedbackInDb(
        baseBody,
        mkReq({
          user: { sub: 'boss_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxB01', role: 'boss', tenantId: 't', campusId: 'c' },
        }),
      );

      expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
      expect(feedbackSvc.submitInDb).toHaveBeenCalledTimes(1);
    });

    it('audit_log 写失败 → fail-open：feedback 仍返回（不抛主流程）', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
      feedbackSvc.submitInDb.mockResolvedValueOnce(persistedFeedback);
      auditLog.log.mockRejectedValueOnce(new Error('audit DB down'));

      const r = await controller.submitFeedbackInDb(baseBody, mkReq());
      expect(r.id).toBe(FEEDBACK_ID);
    });
  });
});
