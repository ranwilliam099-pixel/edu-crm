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
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { FeedbackController } from './feedback.controller';
import { LessonFeedbackService } from './lesson-feedback.service';
import { CourseConsumptionService } from './course-consumption.service';
import { MonthlyReportService } from './monthly-report.service';
import { TeacherRepository } from '../db/teacher.repository';
import { StudentRepository } from '../db/student.repository';
import { ParentRepository } from '../db/parent.repository';
import { AuditLogRepository } from '../db/audit-log.repository';
import { ContentModerationService } from '../security/content-moderation.service';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

describe('FeedbackController — Sprint B self-check', () => {
  let controller: FeedbackController;
  let feedbackSvc: {
    findInDb: jest.Mock;
    submitInDb: jest.Mock;
    updateInDb: jest.Mock;
    listByStudentInDb: jest.Mock;
    markParentReadInDb: jest.Mock;
  };
  let consumptionSvc: Record<string, jest.Mock>;
  let reportSvc: {
    findInDb: jest.Mock;
    finalizeInDb: jest.Mock;
    finalizeParentInDb: jest.Mock;
    listPendingFinalizeInDb: jest.Mock;
    listByStudentInDb: jest.Mock;
    markParentReadInDb: jest.Mock;
  };
  let teacherRepo: { findById: jest.Mock; findByUserId: jest.Mock };
  let studentRepo: { findBrief: jest.Mock };
  let parentRepo: { findChildrenByParent: jest.Mock };
  let auditLog: { log: jest.Mock };
  let contentModeration: { enforceStaffText: jest.Mock };

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
    feedbackSvc = {
      findInDb: jest.fn(),
      submitInDb: jest.fn(),
      updateInDb: jest.fn(),
      listByStudentInDb: jest.fn().mockResolvedValue([]),
      markParentReadInDb: jest.fn(),
    };
    consumptionSvc = {};
    reportSvc = {
      findInDb: jest.fn(),
      finalizeInDb: jest.fn(),
      finalizeParentInDb: jest.fn(),
      listPendingFinalizeInDb: jest.fn(),
      listByStudentInDb: jest.fn().mockResolvedValue([]),
      markParentReadInDb: jest.fn(),
    };
    teacherRepo = { findById: jest.fn(), findByUserId: jest.fn() };
    studentRepo = { findBrief: jest.fn() };
    parentRepo = { findChildrenByParent: jest.fn() };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    contentModeration = { enforceStaffText: jest.fn().mockResolvedValue(undefined) };

    controller = new FeedbackController(
      feedbackSvc as unknown as LessonFeedbackService,
      consumptionSvc as unknown as CourseConsumptionService,
      reportSvc as unknown as MonthlyReportService,
      teacherRepo as unknown as TeacherRepository,
      contentModeration as unknown as ContentModerationService,
      auditLog as unknown as AuditLogRepository,
      studentRepo as unknown as StudentRepository,
      parentRepo as unknown as ParentRepository,
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

  // ============================================================
  // #24: B 端自由文本内容安全（submit / update 写库前 enforceStaffText）
  // ============================================================
  describe('#24 content moderation — lesson-feedback', () => {
    const FB_ID = 'fbk00000000000000000000000000F24';
    const SCH_ID = 'sch00000000000000000000000000S24';
    const STU_ID = 'stu00000000000000000000000000S24';

    const textBody = {
      id: FB_ID,
      scheduleId: SCH_ID,
      studentId: STU_ID,
      teacherId: TEACHER_T1,
      attendanceStatus: '出勤' as const,
      classroomPerformance: '良好' as const,
      homework: '完成 P32 习题',
      teacherNote: '今天表现积极',
      teacherInternalNote: '家长沟通需跟进',
      nextPreview: '下节预习三角函数',
      tenantSchema: TENANT,
    };

    it('submitFeedbackInDb → enforceStaffText 收 4 个自由文本字段 + ctx，写库前调', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
      feedbackSvc.submitInDb.mockResolvedValueOnce({ id: FB_ID });

      await controller.submitFeedbackInDb(textBody, mkReq());

      expect(contentModeration.enforceStaffText).toHaveBeenCalledWith(
        TENANT,
        ['完成 P32 习题', '今天表现积极', '家长沟通需跟进', '下节预习三角函数'],
        expect.objectContaining({
          action: 'lesson-feedback',
          targetType: 'lesson_feedback',
          targetId: FB_ID,
        }),
      );
      // 校验在写库前（enforceStaffText 先于 submitInDb）
      const modOrder = contentModeration.enforceStaffText.mock.invocationCallOrder[0];
      const writeOrder = feedbackSvc.submitInDb.mock.invocationCallOrder[0];
      expect(modOrder).toBeLessThan(writeOrder);
    });

    it('submitFeedbackInDb → 嵌套 knowledgePoints/knowledgeMatrix 的 name 也纳入校验（覆盖缺口修复）', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
      feedbackSvc.submitInDb.mockResolvedValueOnce({ id: FB_ID });

      await controller.submitFeedbackInDb(
        {
          ...textBody,
          knowledgePoints: [{ name: '一元二次方程', mastery: '良好' as const }],
          knowledgeMatrix: [{ name: '函数图像', mastery: 'good' }],
        },
        mkReq(),
      );

      const texts = contentModeration.enforceStaffText.mock.calls[0][1] as string[];
      expect(texts).toContain('一元二次方程');
      expect(texts).toContain('函数图像');
    });

    it('submitFeedbackInDb risky → enforceStaffText 抛 400，不落库', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
      contentModeration.enforceStaffText.mockRejectedValueOnce(
        new BadRequestException('content violates content policy'),
      );

      await expect(controller.submitFeedbackInDb(textBody, mkReq())).rejects.toThrow(
        BadRequestException,
      );
      expect(feedbackSvc.submitInDb).not.toHaveBeenCalled();
    });

    it('updateFeedbackInDb → enforceStaffText 收 patch 自由文本 + req，写库前调', async () => {
      feedbackSvc.updateInDb.mockResolvedValueOnce({ id: FB_ID });

      await controller.updateFeedbackInDb(
        FB_ID,
        {
          patch: { homework: '改后作业', teacherNote: '改后评语' },
          tenantSchema: TENANT,
        },
        mkReq(),
      );

      expect(contentModeration.enforceStaffText).toHaveBeenCalledWith(
        TENANT,
        ['改后作业', '改后评语', undefined, undefined],
        expect.objectContaining({
          action: 'lesson-feedback',
          targetType: 'lesson_feedback',
          targetId: FB_ID,
        }),
      );
      expect(feedbackSvc.updateInDb).toHaveBeenCalledTimes(1);
    });

    it('updateFeedbackInDb risky → 抛 400，不落库', async () => {
      contentModeration.enforceStaffText.mockRejectedValueOnce(
        new BadRequestException('content violates content policy'),
      );

      await expect(
        controller.updateFeedbackInDb(
          FB_ID,
          { patch: { teacherNote: '违规评语' }, tenantSchema: TENANT },
          mkReq(),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(feedbackSvc.updateInDb).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // #24: 月报 finalize / finalize-parent 内容安全
  // ============================================================
  describe('#24 content moderation — monthly-report', () => {
    it('finalizeReportInDb → enforceStaffText 收 blessing/suggestion + 嵌套 highlights/improvements 文本', async () => {
      reportSvc.findInDb.mockResolvedValueOnce(baseReport);
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
      reportSvc.finalizeInDb.mockResolvedValueOnce({ ...baseReport, status: 'teacher_finalized' });

      await controller.finalizeReportInDb(
        REPORT_ID,
        {
          teacherBlessing: '继续加油',
          renewalSuggestion: '建议续报',
          parentHighlights: [{ point: '审题认真', lessonCount: 3 }],
          parentImprovements: [{ point: '计算粗心', suggestion: '多练口算' }],
          tenantSchema: TENANT,
        },
        mkReq(),
      );

      const texts = contentModeration.enforceStaffText.mock.calls[0][1] as Array<string | undefined>;
      expect(texts).toEqual(
        expect.arrayContaining(['继续加油', '建议续报', '审题认真', '计算粗心', '多练口算']),
      );
      expect(contentModeration.enforceStaffText.mock.calls[0][2]).toMatchObject({
        action: 'monthly-report',
        targetType: 'monthly_report',
        targetId: REPORT_ID,
      });
    });

    it('finalizeReportInDb risky → 抛 400，不写库', async () => {
      reportSvc.findInDb.mockResolvedValueOnce(baseReport);
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
      contentModeration.enforceStaffText.mockRejectedValueOnce(
        new BadRequestException('content violates content policy'),
      );

      await expect(
        controller.finalizeReportInDb(
          REPORT_ID,
          { teacherBlessing: '违规', renewalSuggestion: '', tenantSchema: TENANT },
          mkReq(),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(reportSvc.finalizeInDb).not.toHaveBeenCalled();
    });

    it('finalizeReportParentInDb → enforceStaffText 收 parent 字段 + 嵌套文本，写库前调', async () => {
      reportSvc.findInDb.mockResolvedValueOnce(baseReport);
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
      reportSvc.finalizeParentInDb.mockResolvedValueOnce({ ...baseReport, parentBlessing: 'p' });

      await controller.finalizeReportParentInDb(
        REPORT_ID,
        {
          parentBlessing: '家长版寄语',
          parentNextPlan: '下阶段计划',
          parentImprovements: [{ point: '专注度', suggestion: '番茄钟' }],
          tenantSchema: TENANT,
        },
        mkReq(),
      );

      const texts = contentModeration.enforceStaffText.mock.calls[0][1] as Array<string | undefined>;
      expect(texts).toEqual(
        expect.arrayContaining(['家长版寄语', '下阶段计划', '专注度', '番茄钟']),
      );
      const modOrder = contentModeration.enforceStaffText.mock.invocationCallOrder[0];
      const writeOrder = reportSvc.finalizeParentInDb.mock.invocationCallOrder[0];
      expect(modOrder).toBeLessThan(writeOrder);
    });

    it('finalizeReportParentInDb risky → 抛 400，不写库', async () => {
      reportSvc.findInDb.mockResolvedValueOnce(baseReport);
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
      contentModeration.enforceStaffText.mockRejectedValueOnce(
        new BadRequestException('content violates content policy'),
      );

      await expect(
        controller.finalizeReportParentInDb(
          REPORT_ID,
          { parentBlessing: '违规寄语', tenantSchema: TENANT },
          mkReq(),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(reportSvc.finalizeParentInDb).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 2026-06-01 同租户 by-student IDOR 修复：listFeedbacksByStudentInDb owner-scope
  //   - teacher 只看自己班学员（assignedTeacherId）；sales 只看自己客户学员（ownerSalesId）
  //   - academic group / admin / finance 本校放行；parent c 端 bypass；越权 → 403
  // ============================================================
  describe('listFeedbacksByStudentInDb — by-student owner-scope（IDOR 修复）', () => {
    const STUDENT = 'stu00000000000000000000000000S001';
    const SALES_A = 'salesA0000000000000000000000A001';
    const SALES_B = 'salesB0000000000000000000000B001';

    // student 归属：默认 owner=SALES_A / assignedTeacher=TEACHER_T1
    function mockStudent(
      overrides: Partial<{ ownerSalesId: string | null; assignedTeacherId: string | null }> = {},
    ) {
      studentRepo.findBrief.mockResolvedValueOnce({
        id: STUDENT,
        studentName: '小明',
        customerId: 'cust00000000000000000000000000A1',
        ownerSalesId: SALES_A,
        assignedTeacherId: TEACHER_T1,
        ownerChangedAt: null,
        ownerChangeReason: null,
        gradeOrAge: null,
        currentGrade: null,
        gradeBaseYear: null,
        intendedSubject: null,
        ...overrides,
      });
    }

    const body = { tenantSchema: TENANT };

    it('teacher 自己班学员（assignedTeacherId === 反查 teachers.id）→ 放行', async () => {
      mockStudent({ assignedTeacherId: TEACHER_T1 });
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1); // U1 → T1
      const r = await controller.listFeedbacksByStudentInDb(STUDENT, body, mkReq());
      expect(r).toEqual([]);
      expect(feedbackSvc.listByStudentInDb).toHaveBeenCalledWith(
        STUDENT,
        TENANT,
        { limit: undefined, offset: undefined },
        'teacher',
      );
    });

    it('teacher 非自己班学员（assignedTeacherId !== 反查 teachers.id）→ 403，不查反馈', async () => {
      mockStudent({ assignedTeacherId: TEACHER_T2 }); // 学员归 T2
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1); // 调用者反查得 T1
      await expect(
        controller.listFeedbacksByStudentInDb(STUDENT, body, mkReq()),
      ).rejects.toThrow(ForbiddenException);
      expect(feedbackSvc.listByStudentInDb).not.toHaveBeenCalled();
    });

    it('teacher 未绑 teachers 档案 → 403', async () => {
      mockStudent();
      teacherRepo.findByUserId.mockResolvedValueOnce(null);
      await expect(
        controller.listFeedbacksByStudentInDb(STUDENT, body, mkReq()),
      ).rejects.toThrow(ForbiddenException);
      expect(feedbackSvc.listByStudentInDb).not.toHaveBeenCalled();
    });

    it('sales 自己客户学员（ownerSalesId === me）→ 放行', async () => {
      mockStudent({ ownerSalesId: SALES_A });
      const r = await controller.listFeedbacksByStudentInDb(
        STUDENT,
        body,
        mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
      );
      expect(r).toEqual([]);
      expect(feedbackSvc.listByStudentInDb).toHaveBeenCalledWith(
        STUDENT,
        TENANT,
        { limit: undefined, offset: undefined },
        'sales',
      );
      // sales 不走 teacher 反查
      expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
    });

    it('sales 他人客户学员（ownerSalesId !== me）→ 403，不查反馈', async () => {
      mockStudent({ ownerSalesId: SALES_B });
      await expect(
        controller.listFeedbacksByStudentInDb(
          STUDENT,
          body,
          mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(feedbackSvc.listByStudentInDb).not.toHaveBeenCalled();
    });

    it('academic 本校任意学员 → 放行（不 owner 收口）', async () => {
      mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
      const r = await controller.listFeedbacksByStudentInDb(
        STUDENT,
        body,
        mkReq({ user: { sub: 'acd000000000000000000000000A001', role: 'academic', tenantId: 't', campusId: 'c' } }),
      );
      expect(r).toEqual([]);
      expect(feedbackSvc.listByStudentInDb).toHaveBeenCalledTimes(1);
    });

    it('marketing 本校任意学员 → 放行（academic group）', async () => {
      mockStudent({ ownerSalesId: SALES_B });
      await controller.listFeedbacksByStudentInDb(
        STUDENT,
        body,
        mkReq({ user: { sub: 'mkt000000000000000000000000M001', role: 'marketing', tenantId: 't', campusId: 'c' } }),
      );
      expect(feedbackSvc.listByStudentInDb).toHaveBeenCalledTimes(1);
    });

    it('admin 任意学员 → 放行', async () => {
      mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
      await controller.listFeedbacksByStudentInDb(
        STUDENT,
        body,
        mkReq({ user: { sub: 'adm000000000000000000000000A001', role: 'admin', tenantId: null, campusId: null } }),
      );
      expect(feedbackSvc.listByStudentInDb).toHaveBeenCalledTimes(1);
    });

    // 2026-06-01 parent↔student 绑定 IDOR 修复：parent c 端流不再无条件 bypass
    //   TENANT = 'tenant_teacher_self_check_xxxxxxxx' → 派生 tenantId = 'teacher_self_check_xxxxxxxx'
    const PARENT_ID = 'parent000000000000000000000P001';
    const TENANT_ID_RAW = 'teacher_self_check_xxxxxxxx';
    const parentReqOpts = {
      user: { sub: PARENT_ID, role: 'parent' as any, tenantId: 't', campusId: null },
      parent: { sub: PARENT_ID, parentId: PARENT_ID, role: 'parent' as const },
    };

    it('parent c 端流 自己孩子（studentId ∈ active 绑定）→ 放行（service 按 role 剥离）', async () => {
      mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
      parentRepo.findChildrenByParent.mockResolvedValueOnce([
        { studentId: STUDENT, tenantId: TENANT_ID_RAW, bindingStatus: 'active' },
      ]);
      await controller.listFeedbacksByStudentInDb(STUDENT, body, mkReq(parentReqOpts));
      expect(parentRepo.findChildrenByParent).toHaveBeenCalledWith(PARENT_ID);
      expect(feedbackSvc.listByStudentInDb).toHaveBeenCalledTimes(1);
      // parent 自己孩子：不做 teacher own-class 反查
      expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
    });

    it('parent c 端流 他人孩子（studentId ∉ active 绑定）→ 403，不查反馈（同租户 IDOR 拦截）', async () => {
      mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
      parentRepo.findChildrenByParent.mockResolvedValueOnce([
        { studentId: 'otherChild00000000000000000O001', tenantId: TENANT_ID_RAW, bindingStatus: 'active' },
      ]);
      await expect(
        controller.listFeedbacksByStudentInDb(STUDENT, body, mkReq(parentReqOpts)),
      ).rejects.toThrow(ForbiddenException);
      expect(feedbackSvc.listByStudentInDb).not.toHaveBeenCalled();
    });

    it('parent 流但 parentRepo 未注入 → 保守拒绝（fail-safe）', async () => {
      const c = new FeedbackController(
        feedbackSvc as unknown as LessonFeedbackService,
        consumptionSvc as unknown as CourseConsumptionService,
        reportSvc as unknown as MonthlyReportService,
        teacherRepo as unknown as TeacherRepository,
        contentModeration as unknown as ContentModerationService,
        auditLog as unknown as AuditLogRepository,
        studentRepo as unknown as StudentRepository,
        // parentRepo 缺失
      );
      mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
      await expect(
        c.listFeedbacksByStudentInDb(STUDENT, body, mkReq(parentReqOpts)),
      ).rejects.toThrow(ForbiddenException);
      expect(feedbackSvc.listByStudentInDb).not.toHaveBeenCalled();
    });

    it('学员不存在（findBrief=null）→ 放行（避免 enumeration 侧信道，service 返空）', async () => {
      studentRepo.findBrief.mockResolvedValueOnce(null);
      const r = await controller.listFeedbacksByStudentInDb(
        STUDENT,
        body,
        mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
      );
      expect(r).toEqual([]);
      expect(feedbackSvc.listByStudentInDb).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // 2026-06-01 安全审 MEDIUM-2：listReportsByStudentInDb owner-scope（同租户 by-student IDOR）
  //   月报含孩子教学数据=隐私；本端点在 middleware isParentDbPath 白名单内但原缺 owner-scope →
  //   家长可读同租户任意孩子月报。复刻 feedbacks by-student scope（scope 在前 / audience 遮蔽在后）。
  // ============================================================
  describe('listReportsByStudentInDb — by-student owner-scope（IDOR 修复）', () => {
    const STUDENT = 'stu00000000000000000000000000S001';
    const SALES_A = 'salesA0000000000000000000000A001';
    const SALES_B = 'salesB0000000000000000000000B001';

    function mockStudent(
      overrides: Partial<{ ownerSalesId: string | null; assignedTeacherId: string | null }> = {},
    ) {
      studentRepo.findBrief.mockResolvedValueOnce({
        id: STUDENT,
        studentName: '小明',
        customerId: 'cust00000000000000000000000000A1',
        ownerSalesId: SALES_A,
        assignedTeacherId: TEACHER_T1,
        ownerChangedAt: null,
        ownerChangeReason: null,
        gradeOrAge: null,
        currentGrade: null,
        gradeBaseYear: null,
        intendedSubject: null,
        ...overrides,
      });
    }

    const body = { tenantSchema: TENANT };

    it('teacher 自己班学员 → 放行（service 收口 audience=teacher）', async () => {
      mockStudent({ assignedTeacherId: TEACHER_T1 });
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1); // U1 → T1
      const r = await controller.listReportsByStudentInDb(STUDENT, body, mkReq());
      expect(r).toEqual([]);
      // scope 在前，resolveAudience 在后：teacher role 默认 audience='teacher'
      expect(reportSvc.listByStudentInDb).toHaveBeenCalledWith(STUDENT, TENANT, 'teacher');
    });

    it('teacher 非自己班学员 → 403，不查月报', async () => {
      mockStudent({ assignedTeacherId: TEACHER_T2 }); // 学员归 T2
      teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1); // 调用者反查得 T1
      await expect(
        controller.listReportsByStudentInDb(STUDENT, body, mkReq()),
      ).rejects.toThrow(ForbiddenException);
      expect(reportSvc.listByStudentInDb).not.toHaveBeenCalled();
    });

    it('sales 自己客户学员（ownerSalesId === me）→ 放行', async () => {
      mockStudent({ ownerSalesId: SALES_A });
      const r = await controller.listReportsByStudentInDb(
        STUDENT,
        body,
        mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
      );
      expect(r).toEqual([]);
      expect(reportSvc.listByStudentInDb).toHaveBeenCalledTimes(1);
      expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
    });

    it('sales 他人客户学员（ownerSalesId !== me）→ 403，不查月报', async () => {
      mockStudent({ ownerSalesId: SALES_B });
      await expect(
        controller.listReportsByStudentInDb(
          STUDENT,
          body,
          mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(reportSvc.listByStudentInDb).not.toHaveBeenCalled();
    });

    it('academic 本校任意学员 → 放行（不 owner 收口）', async () => {
      mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
      await controller.listReportsByStudentInDb(
        STUDENT,
        body,
        mkReq({ user: { sub: 'acd000000000000000000000000A001', role: 'academic', tenantId: 't', campusId: 'c' } }),
      );
      expect(reportSvc.listByStudentInDb).toHaveBeenCalledTimes(1);
    });

    // parent c 端流：scope 校验在前（绑定校验），audience='parent' 遮蔽在后，两者并存
    //   TENANT = 'tenant_teacher_self_check_xxxxxxxx' → 派生 tenantId = 'teacher_self_check_xxxxxxxx'
    const PARENT_ID = 'parent000000000000000000000P001';
    const TENANT_ID_RAW = 'teacher_self_check_xxxxxxxx';
    const parentReqOpts = {
      user: { sub: PARENT_ID, role: 'parent' as any, tenantId: 't', campusId: null },
      parent: { sub: PARENT_ID, parentId: PARENT_ID, role: 'parent' as const },
    };

    it('parent c 端流 自己孩子（studentId ∈ active 绑定）→ 放行 + audience 强制 parent', async () => {
      mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
      parentRepo.findChildrenByParent.mockResolvedValueOnce([
        { studentId: STUDENT, tenantId: TENANT_ID_RAW, bindingStatus: 'active' },
      ]);
      await controller.listReportsByStudentInDb(STUDENT, body, mkReq(parentReqOpts));
      expect(parentRepo.findChildrenByParent).toHaveBeenCalledWith(PARENT_ID);
      // scope 通过后 resolveAudience(req.parent) 强制 'parent'（家长视角遮蔽仍生效）
      expect(reportSvc.listByStudentInDb).toHaveBeenCalledWith(STUDENT, TENANT, 'parent');
    });

    it('parent c 端流 他人孩子（studentId ∉ active 绑定）→ 403，不查月报（同租户 IDOR 拦截）', async () => {
      mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
      parentRepo.findChildrenByParent.mockResolvedValueOnce([
        { studentId: 'otherChild00000000000000000O001', tenantId: TENANT_ID_RAW, bindingStatus: 'active' },
      ]);
      await expect(
        controller.listReportsByStudentInDb(STUDENT, body, mkReq(parentReqOpts)),
      ).rejects.toThrow(ForbiddenException);
      expect(reportSvc.listByStudentInDb).not.toHaveBeenCalled();
    });

    it('学员不存在（findBrief=null）→ 放行（避免 enumeration 侧信道，service 返空）', async () => {
      studentRepo.findBrief.mockResolvedValueOnce(null);
      const r = await controller.listReportsByStudentInDb(
        STUDENT,
        body,
        mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
      );
      expect(r).toEqual([]);
      expect(reportSvc.listByStudentInDb).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // 2026-06-01 parent↔resource 单资源 IDOR 收口（by-student 列表之外的残留）
  //   B markParentReadFeedbackInDb / C findReportInDb / D markParentReadReportInDb
  //   middleware 仅验 parent↔租户，单资源端点（feedbackId/reportId）原缺 parent↔child 绑定校验。
  //   TENANT = 'tenant_teacher_self_check_xxxxxxxx' → 派生 tenantId = 'teacher_self_check_xxxxxxxx'
  // ============================================================
  describe('parent↔resource 单资源 IDOR（B/C/D）', () => {
    const STUDENT_MINE = 'stu00000000000000000000000mine01'; // 家长自己孩子
    const STUDENT_OTHER = 'stu0000000000000000000000other01'; // 他人孩子
    const FEEDBACK_ID = 'fbk00000000000000000000000000F001';
    const PARENT_ID = 'parent000000000000000000000P001';
    const TENANT_ID_RAW = 'teacher_self_check_xxxxxxxx';
    const body = { tenantSchema: TENANT };

    const parentReq = () =>
      mkReq({
        user: { sub: PARENT_ID, role: 'parent' as any, tenantId: 't', campusId: null },
        parent: { sub: PARENT_ID, parentId: PARENT_ID, role: 'parent' as const },
      });

    // B 端运营回放角色（admin）：无 req.parent → 不做绑定校验、不 pre-fetch
    const adminReq = () =>
      mkReq({ user: { sub: 'adm000000000000000000000000A001', role: 'admin', tenantId: null, campusId: null } });

    const bindMine = () =>
      parentRepo.findChildrenByParent.mockResolvedValueOnce([
        { studentId: STUDENT_MINE, tenantId: TENANT_ID_RAW, bindingStatus: 'active' },
      ]);

    // ---------- B: lesson-feedbacks/:id/parent-read（写） ----------
    describe('B markParentReadFeedbackInDb', () => {
      it('parent 自己孩子的反馈 → 校验通过后写"已读"', async () => {
        feedbackSvc.findInDb.mockResolvedValueOnce({ id: FEEDBACK_ID, studentId: STUDENT_MINE });
        feedbackSvc.markParentReadInDb.mockResolvedValueOnce({ id: FEEDBACK_ID, studentId: STUDENT_MINE });
        bindMine();
        const r = await controller.markParentReadFeedbackInDb(FEEDBACK_ID, body, parentReq());
        expect(r).toEqual({ id: FEEDBACK_ID, studentId: STUDENT_MINE });
        // 写前先 findInDb 拿 studentId 校验归属，再写
        expect(feedbackSvc.findInDb).toHaveBeenCalledWith(FEEDBACK_ID, TENANT, 'parent');
        expect(feedbackSvc.markParentReadInDb).toHaveBeenCalledTimes(1);
      });

      it('parent 他人孩子的 feedbackId → 403，且不写"已读"（同租户跨家庭拦截）', async () => {
        feedbackSvc.findInDb.mockResolvedValueOnce({ id: FEEDBACK_ID, studentId: STUDENT_OTHER });
        bindMine(); // 绑定只含 STUDENT_MINE
        await expect(
          controller.markParentReadFeedbackInDb(FEEDBACK_ID, body, parentReq()),
        ).rejects.toThrow(ForbiddenException);
        expect(feedbackSvc.markParentReadInDb).not.toHaveBeenCalled();
      });

      it('parent 流但 parentRepo 未注入 → 保守拒绝（fail-safe），不写', async () => {
        const c = new FeedbackController(
          feedbackSvc as unknown as LessonFeedbackService,
          consumptionSvc as unknown as CourseConsumptionService,
          reportSvc as unknown as MonthlyReportService,
          teacherRepo as unknown as TeacherRepository,
          contentModeration as unknown as ContentModerationService,
          auditLog as unknown as AuditLogRepository,
          studentRepo as unknown as StudentRepository,
          // parentRepo 缺失
        );
        feedbackSvc.findInDb.mockResolvedValueOnce({ id: FEEDBACK_ID, studentId: STUDENT_MINE });
        await expect(
          c.markParentReadFeedbackInDb(FEEDBACK_ID, body, parentReq()),
        ).rejects.toThrow(ForbiddenException);
        expect(feedbackSvc.markParentReadInDb).not.toHaveBeenCalled();
      });

      it('B 端 admin（无 req.parent）→ 不做绑定校验、不 pre-fetch，直接写', async () => {
        feedbackSvc.markParentReadInDb.mockResolvedValueOnce({ id: FEEDBACK_ID, studentId: STUDENT_OTHER });
        await controller.markParentReadFeedbackInDb(FEEDBACK_ID, body, adminReq());
        // admin 运营回放保持既有可达性：不预读、不查绑定
        expect(feedbackSvc.findInDb).not.toHaveBeenCalled();
        expect(parentRepo.findChildrenByParent).not.toHaveBeenCalled();
        expect(feedbackSvc.markParentReadInDb).toHaveBeenCalledTimes(1);
      });
    });

    // ---------- C: monthly-reports/:id/find（读） ----------
    describe('C findReportInDb', () => {
      const REPORT_ID2 = 'rep00000000000000000000000000R002';

      it('parent 自己孩子的月报 → 放行（复用返回 row.studentId 校验，无额外查库）', async () => {
        reportSvc.findInDb.mockResolvedValueOnce({ id: REPORT_ID2, studentId: STUDENT_MINE });
        bindMine();
        const r = await controller.findReportInDb(REPORT_ID2, body, parentReq());
        expect(r).toEqual({ id: REPORT_ID2, studentId: STUDENT_MINE });
        // parent JWT 强制 audience='parent'
        expect(reportSvc.findInDb).toHaveBeenCalledWith(REPORT_ID2, TENANT, 'parent');
        expect(parentRepo.findChildrenByParent).toHaveBeenCalledWith(PARENT_ID);
      });

      it('parent 他人孩子的 reportId → 403（响应体不返出）', async () => {
        reportSvc.findInDb.mockResolvedValueOnce({ id: REPORT_ID2, studentId: STUDENT_OTHER });
        bindMine();
        await expect(
          controller.findReportInDb(REPORT_ID2, body, parentReq()),
        ).rejects.toThrow(ForbiddenException);
      });

      it('B 端 teacher（无 req.parent）→ 不校验绑定，按 audience=teacher 返回', async () => {
        reportSvc.findInDb.mockResolvedValueOnce({ id: REPORT_ID2, studentId: STUDENT_OTHER });
        const r = await controller.findReportInDb(REPORT_ID2, body, mkReq());
        expect(r).toEqual({ id: REPORT_ID2, studentId: STUDENT_OTHER });
        expect(reportSvc.findInDb).toHaveBeenCalledWith(REPORT_ID2, TENANT, 'teacher');
        expect(parentRepo.findChildrenByParent).not.toHaveBeenCalled();
      });
    });

    // ---------- D: monthly-reports/:id/parent-read（写） ----------
    describe('D markParentReadReportInDb', () => {
      const REPORT_ID3 = 'rep00000000000000000000000000R003';

      it('parent 自己孩子的月报 → 校验通过后写"已读"', async () => {
        reportSvc.findInDb.mockResolvedValueOnce({ id: REPORT_ID3, studentId: STUDENT_MINE });
        reportSvc.markParentReadInDb.mockResolvedValueOnce({ id: REPORT_ID3, studentId: STUDENT_MINE });
        bindMine();
        const r = await controller.markParentReadReportInDb(REPORT_ID3, body, parentReq());
        expect(r).toEqual({ id: REPORT_ID3, studentId: STUDENT_MINE });
        expect(reportSvc.findInDb).toHaveBeenCalledWith(REPORT_ID3, TENANT, 'parent');
        expect(reportSvc.markParentReadInDb).toHaveBeenCalledTimes(1);
      });

      it('parent 他人孩子的 reportId → 403，且不写"已读"', async () => {
        reportSvc.findInDb.mockResolvedValueOnce({ id: REPORT_ID3, studentId: STUDENT_OTHER });
        bindMine();
        await expect(
          controller.markParentReadReportInDb(REPORT_ID3, body, parentReq()),
        ).rejects.toThrow(ForbiddenException);
        expect(reportSvc.markParentReadInDb).not.toHaveBeenCalled();
      });

      it('B 端 admin（无 req.parent）→ 不校验绑定、不 pre-fetch，直接写', async () => {
        reportSvc.markParentReadInDb.mockResolvedValueOnce({ id: REPORT_ID3, studentId: STUDENT_OTHER });
        await controller.markParentReadReportInDb(REPORT_ID3, body, adminReq());
        expect(reportSvc.findInDb).not.toHaveBeenCalled();
        expect(parentRepo.findChildrenByParent).not.toHaveBeenCalled();
        expect(reportSvc.markParentReadInDb).toHaveBeenCalledTimes(1);
      });
    });
  });
});
