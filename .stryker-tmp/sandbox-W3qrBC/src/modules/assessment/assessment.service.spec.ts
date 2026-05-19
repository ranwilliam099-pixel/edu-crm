/**
 * AssessmentService 单元测试 — V14 BE-V14-1
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  AssessmentService,
  Assessment,
  StudentAssessmentResult,
  AssessmentType,
} from './assessment.service';

const ULID32_A1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLAS01';
const ULID32_R1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLAR01';
const ULID32_R2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLAR02';
const ULID32_R3 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLAR03';
const ULID32_S1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST1';
const ULID32_S2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST2';
const ULID32_S3 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST3';
const ULID32_T1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTC1';
const ULID32_USER = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMUS1';

describe('AssessmentService - V14 BE-V14-1', () => {
  let service: AssessmentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AssessmentService],
    }).compile();
    service = module.get<AssessmentService>(AssessmentService);
  });

  describe('createAssessment', () => {
    it('合法创建 → status=draft + 默认 月考/100 分', () => {
      const a = service.createAssessment({
        id: ULID32_A1,
        teacherId: ULID32_T1,
        title: '5月月考',
        subject: '数学',
      });
      expect(a.status).toBe('draft');
      expect(a.assessmentType).toBe('月考');
      expect(a.totalScore).toBe(100);
    });

    it('自定义 totalScore + assessmentType', () => {
      const a = service.createAssessment({
        id: ULID32_A1,
        teacherId: ULID32_T1,
        title: '期末',
        subject: '英语',
        assessmentType: '期末',
        totalScore: 150,
      });
      expect(a.totalScore).toBe(150);
      expect(a.assessmentType).toBe('期末');
    });

    it('未知 assessmentType → BadRequestException', () => {
      expect(() =>
        service.createAssessment({
          id: ULID32_A1,
          teacherId: ULID32_T1,
          title: 'X',
          subject: 'Y',
          assessmentType: 'invalid' as AssessmentType,
        }),
      ).toThrow(BadRequestException);
    });

    it('totalScore <= 0 → BadRequestException', () => {
      expect(() =>
        service.createAssessment({
          id: ULID32_A1,
          teacherId: ULID32_T1,
          title: 'X',
          subject: 'Y',
          totalScore: 0,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('recordResult', () => {
    const assessment: Assessment = {
      id: ULID32_A1,
      teacherId: ULID32_T1,
      title: 'X',
      subject: 'Y',
      assessmentType: '月考',
      totalScore: 100,
      status: 'draft',
      createdAt: new Date(),
    };

    it('合法录入 → 返回 result', () => {
      const r = service.recordResult(
        {
          id: ULID32_R1,
          assessmentId: ULID32_A1,
          studentId: ULID32_S1,
          score: 85,
          knowledgeBreakdown: [{ name: '二次方程', score: 25, total: 30 }],
          recordedByUserId: ULID32_USER,
        },
        assessment,
        [],
      );
      expect(r.score).toBe(85);
      expect(r.recordedAt).toBeDefined();
    });

    it('score 超界 → BadRequestException', () => {
      expect(() =>
        service.recordResult(
          {
            id: ULID32_R1,
            assessmentId: ULID32_A1,
            studentId: ULID32_S1,
            score: 110,
            recordedByUserId: ULID32_USER,
          },
          assessment,
          [],
        ),
      ).toThrow(BadRequestException);
    });

    it('已录入再录 → ConflictException(RESULT_ALREADY_RECORDED)', () => {
      const existing: StudentAssessmentResult[] = [
        {
          id: ULID32_R1,
          assessmentId: ULID32_A1,
          studentId: ULID32_S1,
          score: 85,
          recordedAt: new Date(),
        },
      ];
      expect(() =>
        service.recordResult(
          {
            id: ULID32_R2,
            assessmentId: ULID32_A1,
            studentId: ULID32_S1,
            score: 90,
            recordedByUserId: ULID32_USER,
          },
          assessment,
          existing,
        ),
      ).toThrow(ConflictException);
    });

    it('closed assessment 不能录入', () => {
      expect(() =>
        service.recordResult(
          {
            id: ULID32_R1,
            assessmentId: ULID32_A1,
            studentId: ULID32_S1,
            score: 85,
            recordedByUserId: ULID32_USER,
          },
          { ...assessment, status: 'closed' },
          [],
        ),
      ).toThrow(ConflictException);
    });

    it('知识点细分超界 → BadRequestException', () => {
      expect(() =>
        service.recordResult(
          {
            id: ULID32_R1,
            assessmentId: ULID32_A1,
            studentId: ULID32_S1,
            score: 85,
            knowledgeBreakdown: [{ name: 'X', score: 50, total: 30 }], // score > total
            recordedByUserId: ULID32_USER,
          },
          assessment,
          [],
        ),
      ).toThrow(BadRequestException);
    });
  });

  describe('publishAssessment / closeAssessment', () => {
    const draft: Assessment = {
      id: ULID32_A1,
      teacherId: ULID32_T1,
      title: 'X',
      subject: 'Y',
      assessmentType: '月考',
      totalScore: 100,
      status: 'draft',
      createdAt: new Date(),
    };

    it('draft → published', () => {
      expect(service.publishAssessment(draft).status).toBe('published');
    });

    it('published → published 重复发布 → BadRequestException', () => {
      expect(() =>
        service.publishAssessment({ ...draft, status: 'published' }),
      ).toThrow(BadRequestException);
    });

    it('published → closed', () => {
      expect(service.closeAssessment({ ...draft, status: 'published' }).status).toBe(
        'closed',
      );
    });

    it('closed → closed 重复 → BadRequestException', () => {
      expect(() => service.closeAssessment({ ...draft, status: 'closed' })).toThrow(
        BadRequestException,
      );
    });
  });

  describe('computeRanking', () => {
    it('按 score 降序排名', () => {
      const results: StudentAssessmentResult[] = [
        { id: ULID32_R1, assessmentId: ULID32_A1, studentId: ULID32_S1, score: 80 },
        { id: ULID32_R2, assessmentId: ULID32_A1, studentId: ULID32_S2, score: 95 },
        { id: ULID32_R3, assessmentId: ULID32_A1, studentId: ULID32_S3, score: 70 },
      ];
      const ranked = service.computeRanking(results);
      expect(ranked[0].studentId).toBe(ULID32_S2);
      expect(ranked[0].rankInClass).toBe(1);
      expect(ranked[1].studentId).toBe(ULID32_S1);
      expect(ranked[1].rankInClass).toBe(2);
      expect(ranked[2].studentId).toBe(ULID32_S3);
      expect(ranked[2].rankInClass).toBe(3);
    });

    it('同分并列排名', () => {
      const results: StudentAssessmentResult[] = [
        { id: ULID32_R1, assessmentId: ULID32_A1, studentId: ULID32_S1, score: 80 },
        { id: ULID32_R2, assessmentId: ULID32_A1, studentId: ULID32_S2, score: 80 }, // 并列
        { id: ULID32_R3, assessmentId: ULID32_A1, studentId: ULID32_S3, score: 70 },
      ];
      const ranked = service.computeRanking(results);
      expect(ranked[0].rankInClass).toBe(1);
      expect(ranked[1].rankInClass).toBe(1); // 并列第 1
      expect(ranked[2].rankInClass).toBe(3); // 跳到 3
    });
  });

  describe('listByStudent', () => {
    it('返回该学员的 published 测评 + result，按时间倒序', () => {
      const assessments: Assessment[] = [
        {
          id: ULID32_A1,
          teacherId: ULID32_T1,
          title: 'X',
          subject: 'Y',
          assessmentType: '月考',
          totalScore: 100,
          status: 'published',
          createdAt: new Date(),
        },
      ];
      const results: StudentAssessmentResult[] = [
        {
          id: ULID32_R1,
          assessmentId: ULID32_A1,
          studentId: ULID32_S1,
          score: 80,
          recordedAt: new Date('2026-04-01'),
        },
      ];
      const list = service.listByStudent(ULID32_S1, results, assessments);
      expect(list).toHaveLength(1);
      expect(list[0].result.score).toBe(80);
    });

    it('未 published 不返回', () => {
      const assessments: Assessment[] = [
        {
          id: ULID32_A1,
          teacherId: ULID32_T1,
          title: 'X',
          subject: 'Y',
          assessmentType: '月考',
          totalScore: 100,
          status: 'draft', // 未发布
          createdAt: new Date(),
        },
      ];
      const results: StudentAssessmentResult[] = [
        {
          id: ULID32_R1,
          assessmentId: ULID32_A1,
          studentId: ULID32_S1,
          score: 80,
          recordedAt: new Date(),
        },
      ];
      expect(service.listByStudent(ULID32_S1, results, assessments)).toHaveLength(0);
    });
  });
});
