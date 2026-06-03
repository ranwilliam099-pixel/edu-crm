import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { LessonFeedbackRepository } from './lesson-feedback.repository';
import { PgPoolService } from './pg-pool.service';
import { LessonFeedback } from '../feedback/lesson-feedback.service';

describe('LessonFeedbackRepository', () => {
  let repo: LessonFeedbackRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT = 'tenant_test123456789012345678901234567';
  const SAMPLE: LessonFeedback = {
    id: 'feedback00000000000000000000000A',
    scheduleId: 'sched00000000000000000000000000A',
    studentId: 'stu00000000000000000000000000A001',
    teacherId: 'teach000000000000000000000000A001',
    attendanceStatus: '出勤',
    classroomPerformance: '良好',
    knowledgePoints: [{ name: '函数', mastery: '良好' }],
    homework: '完成 P10-P12',
    submittedAt: new Date('2026-05-02T10:00:00Z'),
    updatedAt: new Date('2026-05-02T10:00:00Z'),
  };
  const ROW = {
    id: SAMPLE.id,
    schedule_id: SAMPLE.scheduleId,
    student_id: SAMPLE.studentId,
    teacher_id: SAMPLE.teacherId,
    attendance_status: SAMPLE.attendanceStatus,
    classroom_performance: SAMPLE.classroomPerformance,
    knowledge_points: JSON.stringify(SAMPLE.knowledgePoints),
    homework: SAMPLE.homework,
    homework_attachments: null,
    teacher_note: null,
    teacher_internal_note: null,
    feedback_attachments: null,
    parent_read_at: null,
    submitted_at: SAMPLE.submittedAt,
    updated_at: SAMPLE.updatedAt,
  };

  beforeEach(async () => {
    pg = {
      tenantQuery: jest.fn(),
      query: jest.fn(),
      withClient: jest.fn(),
    };
    const m = await Test.createTestingModule({
      providers: [
        LessonFeedbackRepository,
        { provide: PgPoolService, useValue: pg },
      ],
    }).compile();
    repo = m.get(LessonFeedbackRepository);
  });

  describe('insert', () => {
    it('serializes JSONB fields and maps row back', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      const result = await repo.insert(TENANT, SAMPLE);
      expect(result.id).toBe(SAMPLE.id);
      expect(result.knowledgePoints).toEqual([{ name: '函数', mastery: '良好' }]);
      const [tenant, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(tenant).toBe(TENANT);
      expect(sql).toContain('INSERT INTO lesson_feedbacks');
      expect(params[0]).toBe(SAMPLE.id);
      expect(params[6]).toBe(JSON.stringify(SAMPLE.knowledgePoints)); // JSONB stringify
    });

    // V18 5 fields
    it('serializes V18 knowledge_matrix / dim_ratings / homework_deadline / homework_difficulty / next_preview', async () => {
      const sampleWithV18: LessonFeedback = {
        ...SAMPLE,
        knowledgeMatrix: [{ name: '因式分解', mastery: 'mastered' }],
        dimRatings: { focus: 4, engage: 5, think: 4, homework: 4 },
        homeworkDeadline: new Date('2026-05-04T22:00:00Z'),
        homeworkDifficulty: 'medium',
        nextPreview: '下次预习平方差',
      };
      pg.tenantQuery.mockResolvedValueOnce([
        {
          ...ROW,
          knowledge_matrix: JSON.stringify(sampleWithV18.knowledgeMatrix),
          dim_ratings: JSON.stringify(sampleWithV18.dimRatings),
          homework_deadline: sampleWithV18.homeworkDeadline,
          homework_difficulty: 'medium',
          next_preview: '下次预习平方差',
        },
      ]);
      const result = await repo.insert(TENANT, sampleWithV18);
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(params[11]).toBe(JSON.stringify(sampleWithV18.knowledgeMatrix));
      expect(params[12]).toBe(JSON.stringify(sampleWithV18.dimRatings));
      expect(params[13]).toEqual(sampleWithV18.homeworkDeadline);
      expect(params[14]).toBe('medium');
      expect(params[15]).toBe('下次预习平方差');
      expect(result.knowledgeMatrix).toEqual([{ name: '因式分解', mastery: 'mastered' }]);
      expect(result.dimRatings).toEqual({ focus: 4, engage: 5, think: 4, homework: 4 });
      expect(result.homeworkDifficulty).toBe('medium');
      expect(result.nextPreview).toBe('下次预习平方差');
    });

    // V68 (SSOT §3.-2 2026-06-03) 反馈级图片附件（家长可见）
    it('serializes V68 feedback_attachments (param[16] = JSON.stringify) and maps back', async () => {
      const atts = [
        { url: 'https://minxin.top/uploads/t/202606/a.jpg', type: 'image', filename: 'chat1.jpg' },
        { url: 'https://minxin.top/uploads/t/202606/b.jpg', type: 'image' },
      ];
      const sampleWithAtts: LessonFeedback = {
        ...SAMPLE,
        feedbackAttachments: atts as any,
      };
      pg.tenantQuery.mockResolvedValueOnce([
        { ...ROW, feedback_attachments: JSON.stringify(atts) },
      ]);
      const result = await repo.insert(TENANT, sampleWithAtts);
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      // 列名 + 占位 $19 在 SQL 中
      expect(sql).toContain('feedback_attachments');
      expect(sql).toContain('$19');
      // param[16] = feedback_attachments（id..nextPreview 共 16 个 → 索引 16）
      expect(params[16]).toBe(JSON.stringify(atts));
      expect(result.feedbackAttachments).toEqual(atts);
    });

    it('feedback_attachments 缺省（undefined）→ INSERT 传 null', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      await repo.insert(TENANT, SAMPLE); // SAMPLE 无 feedbackAttachments
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(params[16]).toBeNull();
    });
  });

  describe('update with V18 fields', () => {
    it('updates V18 5 fields when provided', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          ...ROW,
          knowledge_matrix: JSON.stringify([{ name: '函数', mastery: 'mastered' }]),
          dim_ratings: JSON.stringify({ focus: 5 }),
          homework_difficulty: 'hard',
          next_preview: '复习',
        },
      ]);
      await repo.update(TENANT, SAMPLE.id, {
        knowledgeMatrix: [{ name: '函数', mastery: 'mastered' }],
        dimRatings: { focus: 5 },
        homeworkDifficulty: 'hard',
        nextPreview: '复习',
      });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('knowledge_matrix =');
      expect(sql).toContain('dim_ratings =');
      expect(sql).toContain('homework_difficulty =');
      expect(sql).toContain('next_preview =');
    });
  });

  describe('findById', () => {
    it('returns null when not found', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      expect(await repo.findById(TENANT, 'nope')).toBeNull();
    });
    it('parses knowledge_points JSON string correctly', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      const r = await repo.findById(TENANT, SAMPLE.id);
      expect(r?.knowledgePoints).toEqual([{ name: '函数', mastery: '良好' }]);
    });
    it('handles knowledge_points already parsed (pg jsonb)', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        { ...ROW, knowledge_points: SAMPLE.knowledgePoints },
      ]);
      const r = await repo.findById(TENANT, SAMPLE.id);
      expect(r?.knowledgePoints).toEqual(SAMPLE.knowledgePoints);
    });

    // V68 (SSOT §3.-2) 出参默认 [] + 解析（string / 已 parse 两路）
    it('SELECT includes feedback_attachments; null → maps to [] (default)', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]); // feedback_attachments: null
      const r = await repo.findById(TENANT, SAMPLE.id);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('feedback_attachments');
      expect(r?.feedbackAttachments).toEqual([]);
    });

    it('parses feedback_attachments JSON string into array', async () => {
      const atts = [{ url: 'https://minxin.top/uploads/x.jpg', type: 'image', filename: 'x.jpg' }];
      pg.tenantQuery.mockResolvedValueOnce([
        { ...ROW, feedback_attachments: JSON.stringify(atts) },
      ]);
      const r = await repo.findById(TENANT, SAMPLE.id);
      expect(r?.feedbackAttachments).toEqual(atts);
    });

    it('handles feedback_attachments already parsed (pg jsonb)', async () => {
      const atts = [{ url: 'https://minxin.top/uploads/y.jpg', type: 'image' }];
      pg.tenantQuery.mockResolvedValueOnce([
        { ...ROW, feedback_attachments: atts },
      ]);
      const r = await repo.findById(TENANT, SAMPLE.id);
      expect(r?.feedbackAttachments).toEqual(atts);
    });
  });

  describe('findByScheduleStudent', () => {
    it('queries by schedule + student', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      await repo.findByScheduleStudent(TENANT, SAMPLE.scheduleId, SAMPLE.studentId);
      expect(pg.tenantQuery.mock.calls[0][2]).toEqual([
        SAMPLE.scheduleId,
        SAMPLE.studentId,
      ]);
    });
  });

  describe('listByStudent', () => {
    it('uses default limit 50 offset 0', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listByStudent(TENANT, SAMPLE.studentId);
      expect(pg.tenantQuery.mock.calls[0][2]).toEqual([SAMPLE.studentId, 50, 0]);
    });
  });

  describe('listByStudentTeacherInRange', () => {
    it('passes range bounds correctly', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      const start = new Date('2026-05-01');
      const end = new Date('2026-06-01');
      const result = await repo.listByStudentTeacherInRange(
        TENANT,
        SAMPLE.studentId,
        SAMPLE.teacherId,
        start,
        end,
      );
      expect(result).toHaveLength(1);
      expect(pg.tenantQuery.mock.calls[0][2]).toEqual([
        SAMPLE.studentId,
        SAMPLE.teacherId,
        start,
        end,
      ]);
    });
  });

  describe('update', () => {
    it('only updates provided fields', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      await repo.update(TENANT, SAMPLE.id, { teacherNote: '改了' });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('teacher_note = $1');
      expect(sql).not.toContain('attendance_status =');
    });
    it('throws NotFoundException when 0 rows updated', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(repo.update(TENANT, 'nope', { homework: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('markParentRead', () => {
    it('uses COALESCE for idempotency', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        { ...ROW, parent_read_at: new Date('2026-05-02T11:00:00Z') },
      ]);
      const r = await repo.markParentRead(TENANT, SAMPLE.id);
      expect(r.parentReadAt).toBeInstanceOf(Date);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('COALESCE(parent_read_at, NOW())');
    });
  });

  describe('countUnreadByParent', () => {
    it('returns 0 when student list is empty', async () => {
      const c = await repo.countUnreadByParent(TENANT, []);
      expect(c).toBe(0);
      expect(pg.tenantQuery).not.toHaveBeenCalled();
    });
    it('parses count from string', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ count: '7' }]);
      const c = await repo.countUnreadByParent(TENANT, [SAMPLE.studentId]);
      expect(c).toBe(7);
    });
  });
});
