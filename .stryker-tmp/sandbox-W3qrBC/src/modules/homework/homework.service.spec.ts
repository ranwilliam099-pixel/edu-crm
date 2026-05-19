/**
 * HomeworkService 单元测试 — V13 BE-V13-1
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  HomeworkService,
  HomeworkAssignment,
  HomeworkSubmission,
  Grade,
} from './homework.service';

const ULID32_A1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLAS01';
const ULID32_A2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLAS02';
const ULID32_S1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST1';
const ULID32_S2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST2';
const ULID32_S3 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST3';
const ULID32_T1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTC1';
const ULID32_T2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTC2';
const ULID32_SUB1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLSUB1';
const ULID32_SUB2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLSUB2';
const ULID32_USER = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMUS1';

describe('HomeworkService - V13 BE-V13-1', () => {
  let service: HomeworkService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HomeworkService],
    }).compile();
    service = module.get<HomeworkService>(HomeworkService);
  });

  describe('publish - 老师布置作业', () => {
    it('合法布置 → status=published', () => {
      const a = service.publish({
        id: ULID32_A1,
        teacherId: ULID32_T1,
        title: '完成 P12 第一题至第五题',
        difficulty: '中',
        recipientStudentIds: [ULID32_S1, ULID32_S2],
      });
      expect(a.status).toBe('published');
      expect(a.recipientStudentIds).toHaveLength(2);
    });

    it('title 空 → BadRequestException', () => {
      expect(() =>
        service.publish({
          id: ULID32_A1,
          teacherId: ULID32_T1,
          title: '',
          recipientStudentIds: [ULID32_S1],
        }),
      ).toThrow(BadRequestException);
    });

    it('recipientStudentIds 空 → BadRequestException', () => {
      expect(() =>
        service.publish({
          id: ULID32_A1,
          teacherId: ULID32_T1,
          title: 'X',
          recipientStudentIds: [],
        }),
      ).toThrow(BadRequestException);
    });

    it('未知 difficulty → BadRequestException', () => {
      expect(() =>
        service.publish({
          id: ULID32_A1,
          teacherId: ULID32_T1,
          title: 'X',
          difficulty: 'invalid' as any,
          recipientStudentIds: [ULID32_S1],
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('submitForStudent - 学员上交', () => {
    const assignment: HomeworkAssignment = {
      id: ULID32_A1,
      teacherId: ULID32_T1,
      title: 'X',
      status: 'published',
      recipientStudentIds: [ULID32_S1, ULID32_S2],
      createdAt: new Date(),
    };

    it('首次提交 → status=submitted', () => {
      const sub = service.submitForStudent(
        {
          id: ULID32_SUB1,
          assignmentId: ULID32_A1,
          studentId: ULID32_S1,
          content: '我做完了',
        },
        assignment,
        [],
      );
      expect(sub.status).toBe('submitted');
    });

    it('学员不在 recipients → BadRequestException(STUDENT_NOT_IN_RECIPIENTS)', () => {
      expect(() =>
        service.submitForStudent(
          {
            id: ULID32_SUB1,
            assignmentId: ULID32_A1,
            studentId: ULID32_S3, // 不在 recipients
          },
          assignment,
          [],
        ),
      ).toThrow(BadRequestException);
    });

    it('已提交（submitted） → ConflictException(ALREADY_SUBMITTED)', () => {
      const existing: HomeworkSubmission[] = [
        {
          id: ULID32_SUB1,
          assignmentId: ULID32_A1,
          studentId: ULID32_S1,
          status: 'submitted',
          submittedAt: new Date(),
        },
      ];
      expect(() =>
        service.submitForStudent(
          { id: ULID32_SUB2, assignmentId: ULID32_A1, studentId: ULID32_S1 },
          assignment,
          existing,
        ),
      ).toThrow(ConflictException);
    });

    it('returned 状态可重新提交（学员重做）', () => {
      const existing: HomeworkSubmission[] = [
        {
          id: ULID32_SUB1,
          assignmentId: ULID32_A1,
          studentId: ULID32_S1,
          status: 'returned',
          teacherComment: '请重做',
          submittedAt: new Date(),
          gradedAt: new Date(),
        },
      ];
      const sub = service.submitForStudent(
        { id: ULID32_SUB2, assignmentId: ULID32_A1, studentId: ULID32_S1 },
        assignment,
        existing,
      );
      expect(sub.status).toBe('submitted');
    });

    it('archived assignment → ConflictException', () => {
      expect(() =>
        service.submitForStudent(
          { id: ULID32_SUB1, assignmentId: ULID32_A1, studentId: ULID32_S1 },
          { ...assignment, status: 'archived' },
          [],
        ),
      ).toThrow(ConflictException);
    });
  });

  describe('grade - 老师批改', () => {
    const submitted: HomeworkSubmission = {
      id: ULID32_SUB1,
      assignmentId: ULID32_A1,
      studentId: ULID32_S1,
      status: 'submitted',
      submittedAt: new Date(),
    };

    it('合法批改 → status=graded', () => {
      const result = service.grade(submitted, {
        grade: 'A',
        teacherComment: '不错',
        gradedByUserId: ULID32_USER,
      });
      expect(result.status).toBe('graded');
      expect(result.grade).toBe('A');
    });

    it('未知 grade → BadRequestException', () => {
      expect(() =>
        service.grade(submitted, {
          grade: 'F' as Grade,
          gradedByUserId: ULID32_USER,
        }),
      ).toThrow(BadRequestException);
    });

    it('已 graded 再批 → ConflictException', () => {
      expect(() =>
        service.grade(
          { ...submitted, status: 'graded' },
          { grade: 'A', gradedByUserId: ULID32_USER },
        ),
      ).toThrow(ConflictException);
    });

    it('returned 状态不能批 → BadRequestException', () => {
      expect(() =>
        service.grade(
          { ...submitted, status: 'returned' },
          { grade: 'A', gradedByUserId: ULID32_USER },
        ),
      ).toThrow(BadRequestException);
    });

    it('gradedByUserId 长度非 32 → BadRequestException', () => {
      expect(() =>
        service.grade(submitted, { grade: 'A', gradedByUserId: 'short' }),
      ).toThrow(BadRequestException);
    });
  });

  describe('returnForRedo - 退回重做', () => {
    const submitted: HomeworkSubmission = {
      id: ULID32_SUB1,
      assignmentId: ULID32_A1,
      studentId: ULID32_S1,
      status: 'submitted',
      submittedAt: new Date(),
    };

    it('退回 → status=returned + 必填 comment', () => {
      const result = service.returnForRedo(submitted, '请按要求重做');
      expect(result.status).toBe('returned');
      expect(result.teacherComment).toBe('请按要求重做');
    });

    it('comment 空 → BadRequestException', () => {
      expect(() => service.returnForRedo(submitted, '')).toThrow(BadRequestException);
    });
  });

  describe('listPendingByTeacher - 老师待批改', () => {
    it('返回该老师作业的 submitted 状态submission', () => {
      const assignments: HomeworkAssignment[] = [
        {
          id: ULID32_A1,
          teacherId: ULID32_T1,
          title: 'X',
          status: 'published',
          recipientStudentIds: [ULID32_S1],
          createdAt: new Date(),
        },
        {
          id: ULID32_A2,
          teacherId: ULID32_T2, // 别的老师
          title: 'Y',
          status: 'published',
          recipientStudentIds: [ULID32_S2],
          createdAt: new Date(),
        },
      ];
      const submissions: HomeworkSubmission[] = [
        {
          id: ULID32_SUB1,
          assignmentId: ULID32_A1,
          studentId: ULID32_S1,
          status: 'submitted',
          submittedAt: new Date(),
        },
        {
          id: ULID32_SUB2,
          assignmentId: ULID32_A2,
          studentId: ULID32_S2,
          status: 'submitted',
          submittedAt: new Date(),
        },
      ];
      const pending = service.listPendingByTeacher(ULID32_T1, submissions, assignments);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(ULID32_SUB1);
    });

    it('已 graded 不在 pending 列表', () => {
      const assignments: HomeworkAssignment[] = [
        {
          id: ULID32_A1,
          teacherId: ULID32_T1,
          title: 'X',
          status: 'published',
          recipientStudentIds: [ULID32_S1],
          createdAt: new Date(),
        },
      ];
      const submissions: HomeworkSubmission[] = [
        {
          id: ULID32_SUB1,
          assignmentId: ULID32_A1,
          studentId: ULID32_S1,
          status: 'graded',
          submittedAt: new Date(),
        },
      ];
      const pending = service.listPendingByTeacher(ULID32_T1, submissions, assignments);
      expect(pending).toHaveLength(0);
    });
  });

  describe('listByStudent - 学员视角', () => {
    it('返回 published 给本学员的作业 + 状态', () => {
      const assignments: HomeworkAssignment[] = [
        {
          id: ULID32_A1,
          teacherId: ULID32_T1,
          title: 'X',
          status: 'published',
          recipientStudentIds: [ULID32_S1],
          createdAt: new Date(),
        },
        {
          id: ULID32_A2,
          teacherId: ULID32_T1,
          title: 'Y',
          status: 'published',
          recipientStudentIds: [ULID32_S2], // 别的学员
          createdAt: new Date(),
        },
      ];
      const submissions: HomeworkSubmission[] = [];
      const result = service.listByStudent(ULID32_S1, assignments, submissions);
      expect(result).toHaveLength(1);
      expect(result[0].assignment.id).toBe(ULID32_A1);
      expect(result[0].submission).toBeUndefined();
    });

    it('已提交 → submission 字段填充', () => {
      const assignments: HomeworkAssignment[] = [
        {
          id: ULID32_A1,
          teacherId: ULID32_T1,
          title: 'X',
          status: 'published',
          recipientStudentIds: [ULID32_S1],
          createdAt: new Date(),
        },
      ];
      const submissions: HomeworkSubmission[] = [
        {
          id: ULID32_SUB1,
          assignmentId: ULID32_A1,
          studentId: ULID32_S1,
          status: 'graded',
          grade: 'A',
          submittedAt: new Date(),
        },
      ];
      const result = service.listByStudent(ULID32_S1, assignments, submissions);
      expect(result).toHaveLength(1);
      expect(result[0].submission?.grade).toBe('A');
    });

    it('archived 作业不返回', () => {
      const assignments: HomeworkAssignment[] = [
        {
          id: ULID32_A1,
          teacherId: ULID32_T1,
          title: 'X',
          status: 'archived',
          recipientStudentIds: [ULID32_S1],
          createdAt: new Date(),
        },
      ];
      expect(service.listByStudent(ULID32_S1, assignments, [])).toHaveLength(0);
    });
  });
});
