/**
 * V9 Feedback 模块单测（LessonFeedback + CourseConsumption + MonthlyReport）
 *
 * USER-AUTH(2026-05-02 PD §4 + 条目 32 L*): 24h 反馈 + 月报自动 + 课消锁定
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import {
  LessonFeedbackService,
  LessonFeedback,
  AttendanceForFeedback,
  ClassroomPerformance,
} from './lesson-feedback.service';
import {
  CourseConsumptionService,
  CourseConsumption,
} from './course-consumption.service';
import { MonthlyReportService } from './monthly-report.service';

const ULID32_F1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLFB01';
const ULID32_F2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLFB02';
const ULID32_C1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLCC01';
const ULID32_C2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLCC02';
const ULID32_M1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMM01';
const ULID32_SCH1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLSCH1';
const ULID32_SCH2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLSCH2';
const ULID32_S1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST1';
const ULID32_T1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTC1';

describe('LessonFeedbackService - V9 BE-V9-1', () => {
  let service: LessonFeedbackService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LessonFeedbackService],
    }).compile();
    service = module.get<LessonFeedbackService>(LessonFeedbackService);
  });

  describe('submit', () => {
    it('合法提交 → 返回 feedback', () => {
      const f = service.submit({
        id: ULID32_F1,
        scheduleId: ULID32_SCH1,
        studentId: ULID32_S1,
        teacherId: ULID32_T1,
        attendanceStatus: '出勤',
        classroomPerformance: '良好',
        knowledgePoints: [{ name: '二次方程', mastery: '良好' }],
        homework: '完成 5 道题',
        teacherNote: '今天表现不错',
      });
      expect(f.id).toBe(ULID32_F1);
      expect(f.attendanceStatus).toBe('出勤');
      expect(f.knowledgePoints).toHaveLength(1);
    });

    it('未知 attendanceStatus → BadRequestException', () => {
      expect(() =>
        service.submit({
          id: ULID32_F1,
          scheduleId: ULID32_SCH1,
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          attendanceStatus: 'unknown' as AttendanceForFeedback,
          classroomPerformance: '良好',
        }),
      ).toThrow(BadRequestException);
    });

    it('未知 classroomPerformance → BadRequestException', () => {
      expect(() =>
        service.submit({
          id: ULID32_F1,
          scheduleId: ULID32_SCH1,
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          attendanceStatus: '出勤',
          classroomPerformance: 'unknown' as ClassroomPerformance,
        }),
      ).toThrow(BadRequestException);
    });
  });

  // ============================================================
  // V68 (SSOT §3.-2 2026-06-03) 反馈级图片附件清洗（家长可见；非法静默丢弃 / 上限 9 / 缺省 []）
  // ============================================================
  describe('submit - V68 feedbackAttachments 清洗', () => {
    const base = {
      id: ULID32_F1,
      scheduleId: ULID32_SCH1,
      studentId: ULID32_S1,
      teacherId: ULID32_T1,
      attendanceStatus: '出勤' as AttendanceForFeedback,
      classroomPerformance: '良好' as ClassroomPerformance,
    };

    it('缺省（不传）→ feedbackAttachments = []', () => {
      const f = service.submit({ ...base });
      expect(f.feedbackAttachments).toEqual([]);
    });

    it('非数组（{} / string）→ []（不抛错）', () => {
      const f1 = service.submit({ ...base, feedbackAttachments: {} as any });
      expect(f1.feedbackAttachments).toEqual([]);
      const f2 = service.submit({ ...base, feedbackAttachments: 'oops' as any });
      expect(f2.feedbackAttachments).toEqual([]);
    });

    it('合法 https 项保留；type 强制 image；filename 选填', () => {
      const f = service.submit({
        ...base,
        feedbackAttachments: [
          { url: 'https://minxin.top/uploads/t/202606/a.jpg', type: 'image', filename: 'chat.jpg' },
          { url: 'https://cdn.example.com/b.png', type: 'image' }, // 无 filename
        ],
      });
      expect(f.feedbackAttachments).toEqual([
        { url: 'https://minxin.top/uploads/t/202606/a.jpg', type: 'image', filename: 'chat.jpg' },
        { url: 'https://cdn.example.com/b.png', type: 'image' },
      ]);
    });

    it('本机 OSS http host（备案前）放行；其它 http host 丢弃', () => {
      const f = service.submit({
        ...base,
        feedbackAttachments: [
          { url: 'http://1.14.127.67/uploads/t/202606/ok.jpg', type: 'image' }, // 本机 OSS → 保留
          { url: 'http://evil.com/x.jpg', type: 'image' }, // 非本机 http → 丢弃
        ] as any,
      });
      expect(f.feedbackAttachments).toEqual([
        { url: 'http://1.14.127.67/uploads/t/202606/ok.jpg', type: 'image' },
      ]);
    });

    it('非法 url（伪协议 / 相对 / 空 / 非 string）整项静默丢弃，合法项保留', () => {
      const f = service.submit({
        ...base,
        feedbackAttachments: [
          { url: 'javascript:alert(1)', type: 'image' }, // 伪协议 → 丢
          { url: '/relative/path.jpg', type: 'image' }, // 相对 → 丢
          { url: '', type: 'image' }, // 空 → 丢
          { url: 12345, type: 'image' }, // 非 string → 丢
          { url: 'data:image/png;base64,AAAA', type: 'image' }, // data: → 丢
          { type: 'image' }, // 缺 url → 丢
          null, // 非对象 → 丢
          { url: 'https://minxin.top/good.jpg', type: 'image' }, // 合法 → 留
        ] as any,
      });
      expect(f.feedbackAttachments).toEqual([
        { url: 'https://minxin.top/good.jpg', type: 'image' },
      ]);
    });

    it('超过 9 张 → 截断取前 9（不抛错）', () => {
      const many = Array.from({ length: 12 }, (_, i) => ({
        url: `https://minxin.top/uploads/${i}.jpg`,
        type: 'image' as const,
      }));
      const f = service.submit({ ...base, feedbackAttachments: many });
      expect(f.feedbackAttachments).toHaveLength(9);
      expect(f.feedbackAttachments![0].url).toBe('https://minxin.top/uploads/0.jpg');
      expect(f.feedbackAttachments![8].url).toBe('https://minxin.top/uploads/8.jpg');
    });
  });

  describe('update - 24h 修改窗口', () => {
    const baseFeedback: LessonFeedback = {
      id: ULID32_F1,
      scheduleId: ULID32_SCH1,
      studentId: ULID32_S1,
      teacherId: ULID32_T1,
      attendanceStatus: '出勤',
      classroomPerformance: '良好',
      submittedAt: new Date('2026-05-02T10:00:00Z'),
      updatedAt: new Date('2026-05-02T10:00:00Z'),
    };

    it('提交后 12h 内修改 → 通过', () => {
      const now = new Date('2026-05-02T22:00:00Z'); // 12h
      const result = service.update(
        baseFeedback,
        { teacherNote: '更新后的话' },
        now,
      );
      expect(result.teacherNote).toBe('更新后的话');
    });

    it('提交后 25h 修改 → BadRequestException', () => {
      const now = new Date('2026-05-03T11:01:00Z'); // 25h+
      expect(() =>
        service.update(baseFeedback, { teacherNote: '迟了' }, now),
      ).toThrow(BadRequestException);
    });
  });

  describe('markParentRead - 家长已读', () => {
    const baseFeedback: LessonFeedback = {
      id: ULID32_F1,
      scheduleId: ULID32_SCH1,
      studentId: ULID32_S1,
      teacherId: ULID32_T1,
      attendanceStatus: '出勤',
      classroomPerformance: '良好',
      submittedAt: new Date(),
      updatedAt: new Date(),
    };

    it('首次打勾 → 设 parentReadAt', () => {
      const now = new Date();
      const result = service.markParentRead(baseFeedback, now);
      expect(result.parentReadAt).toBe(now);
    });

    it('重复打勾 → 幂等不变', () => {
      const initialRead = new Date('2026-05-02T08:00:00Z');
      const result = service.markParentRead(
        { ...baseFeedback, parentReadAt: initialRead },
        new Date(),
      );
      expect(result.parentReadAt).toBe(initialRead);
    });
  });
});

describe('CourseConsumptionService - V9 BE-V9-2', () => {
  let service: CourseConsumptionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CourseConsumptionService],
    }).compile();
    service = module.get<CourseConsumptionService>(CourseConsumptionService);
  });

  describe('createConsumption', () => {
    it('schedule.complete 时创建 → status=pending_feedback + due=end_at+24h', () => {
      const endAt = new Date('2026-05-02T11:00:00Z');
      const c = service.createConsumption({
        id: ULID32_C1,
        scheduleId: ULID32_SCH1,
        studentId: ULID32_S1,
        teacherId: ULID32_T1,
        scheduleEndAt: endAt,
        amountYuan: 200,
      });
      expect(c.status).toBe('pending_feedback');
      expect(c.feedbackDueAt.getTime()).toBe(endAt.getTime() + 24 * 60 * 60 * 1000);
      expect(c.amountYuan).toBe(200);
    });
  });

  describe('confirmByFeedback', () => {
    const base: CourseConsumption = {
      id: ULID32_C1,
      scheduleId: ULID32_SCH1,
      studentId: ULID32_S1,
      teacherId: ULID32_T1,
      status: 'pending_feedback',
      feedbackDueAt: new Date('2026-05-03T11:00:00Z'),
      createdAt: new Date(),
    };

    it('提交反馈 → confirmed', () => {
      const result = service.confirmByFeedback(base, ULID32_F1);
      expect(result.status).toBe('confirmed');
      expect(result.feedbackId).toBe(ULID32_F1);
      expect(result.confirmedAt).toBeDefined();
    });

    it('cancelled 状态不能 confirm → BadRequestException', () => {
      expect(() =>
        service.confirmByFeedback({ ...base, status: 'cancelled' }, ULID32_F1),
      ).toThrow(BadRequestException);
    });
  });

  describe('scanAndLock - cron 24h 锁定', () => {
    const now = new Date('2026-05-02T12:00:00Z');

    it('超期 pending_feedback → locked', () => {
      const consumptions: CourseConsumption[] = [
        {
          id: ULID32_C1,
          scheduleId: ULID32_SCH1,
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          status: 'pending_feedback',
          feedbackDueAt: new Date('2026-05-02T10:00:00Z'), // 已过期
          createdAt: new Date(),
        },
        {
          id: ULID32_C2,
          scheduleId: ULID32_SCH2,
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          status: 'pending_feedback',
          feedbackDueAt: new Date('2026-05-02T15:00:00Z'), // 未过期
          createdAt: new Date(),
        },
      ];
      const locked = service.scanAndLock(consumptions, now);
      expect(locked).toHaveLength(1);
      expect(locked[0].id).toBe(ULID32_C1);
      expect(locked[0].status).toBe('locked');
    });

    it('confirmed 状态不被锁', () => {
      const c: CourseConsumption = {
        id: ULID32_C1,
        scheduleId: ULID32_SCH1,
        studentId: ULID32_S1,
        teacherId: ULID32_T1,
        status: 'confirmed',
        feedbackDueAt: new Date('2026-05-02T10:00:00Z'),
        createdAt: new Date(),
      };
      expect(service.scanAndLock([c], now)).toHaveLength(0);
    });
  });

  describe('unlockByLateFeedback - 老师超期补填恢复', () => {
    const locked: CourseConsumption = {
      id: ULID32_C1,
      scheduleId: ULID32_SCH1,
      studentId: ULID32_S1,
      teacherId: ULID32_T1,
      status: 'locked',
      lockedAt: new Date('2026-05-02T11:00:00Z'),
      feedbackDueAt: new Date('2026-05-02T10:00:00Z'),
      createdAt: new Date(),
    };

    it('locked → confirmed', () => {
      const result = service.unlockByLateFeedback(locked, ULID32_F1);
      expect(result.status).toBe('confirmed');
      expect(result.lockedAt).toBeUndefined();
      expect(result.feedbackId).toBe(ULID32_F1);
    });

    it('非 locked 状态 → BadRequestException', () => {
      expect(() =>
        service.unlockByLateFeedback(
          { ...locked, status: 'pending_feedback' },
          ULID32_F1,
        ),
      ).toThrow(BadRequestException);
    });
  });

  // V38: 删 sumPayrollForTeacher 单测（薪资下线，方法已删）
});

describe('MonthlyReportService - V9 BE-V9-3', () => {
  let service: MonthlyReportService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MonthlyReportService],
    }).compile();
    service = module.get<MonthlyReportService>(MonthlyReportService);
  });

  describe('generate - cron 自动生成', () => {
    it('聚合反馈 → 出勤汇总 + 表现趋势 + 知识点', () => {
      const feedbacks: LessonFeedback[] = [
        {
          id: ULID32_F1,
          scheduleId: ULID32_SCH1,
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          attendanceStatus: '出勤',
          classroomPerformance: '良好',
          knowledgePoints: [{ name: '二次方程', mastery: '良好' }],
          submittedAt: new Date('2026-04-05T10:00:00Z'),
          updatedAt: new Date(),
        },
        {
          id: ULID32_F2,
          scheduleId: ULID32_SCH2,
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          attendanceStatus: '迟到',
          classroomPerformance: '合格',
          knowledgePoints: [
            { name: '二次方程', mastery: '良好' },
            { name: '因式分解', mastery: '优秀' },
          ],
          submittedAt: new Date('2026-04-12T10:00:00Z'),
          updatedAt: new Date(),
        },
      ];
      const report = service.generate({
        id: ULID32_M1,
        studentId: ULID32_S1,
        teacherId: ULID32_T1,
        month: new Date('2026-04-01T00:00:00Z'),
        feedbacksInMonth: feedbacks,
      });
      expect(report.attendanceSummary.total).toBe(2);
      expect(report.attendanceSummary['出勤']).toBe(1);
      expect(report.attendanceSummary['迟到']).toBe(1);
      expect(report.performanceTrend).toHaveLength(2);
      expect(report.knowledgeSummary).toHaveLength(2);
      expect(report.status).toBe('auto_generated');
    });
  });

  describe('finalize - 老师补寄语 + 续报建议', () => {
    it('auto_generated → teacher_finalized', () => {
      const report = service.generate({
        id: ULID32_M1,
        studentId: ULID32_S1,
        teacherId: ULID32_T1,
        month: new Date('2026-04-01T00:00:00Z'),
        feedbacksInMonth: [],
      });
      const finalized = service.finalize(report, {
        teacherBlessing: '继续努力',
        renewalSuggestion: '建议续报一年',
      });
      expect(finalized.status).toBe('teacher_finalized');
      expect(finalized.teacherBlessing).toBe('继续努力');
    });

    it('已 finalized 再 finalize → BadRequestException', () => {
      const report = {
        id: ULID32_M1,
        studentId: ULID32_S1,
        teacherId: ULID32_T1,
        month: new Date('2026-04-01T00:00:00Z'),
        attendanceSummary: { total: 0, '出勤': 0, '迟到': 0, '缺席': 0, '请假': 0 },
        performanceTrend: [],
        knowledgeSummary: [],
        status: 'teacher_finalized' as const,
        generatedAt: new Date(),
        finalizedAt: new Date(),
      };
      expect(() =>
        service.finalize(report, {
          teacherBlessing: 'x',
          renewalSuggestion: 'y',
        }),
      ).toThrow(BadRequestException);
    });

    it('blessing 为空 → BadRequestException', () => {
      const report = service.generate({
        id: ULID32_M1,
        studentId: ULID32_S1,
        teacherId: ULID32_T1,
        month: new Date('2026-04-01T00:00:00Z'),
        feedbacksInMonth: [],
      });
      expect(() =>
        service.finalize(report, {
          teacherBlessing: '',
          renewalSuggestion: '续报',
        }),
      ).toThrow(BadRequestException);
    });
  });
});
