/**
 * StudentLearningProfileService 单元测试 — V15 BE-V15-1
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { StudentLearningProfileService } from './student-learning-profile.service';
import { LessonFeedback } from '../feedback/lesson-feedback.service';
import { HomeworkSubmission } from '../homework/homework.service';
import { StudentAssessmentResult } from '../assessment/assessment.service';

const ULID32_S1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST1';
const ULID32_F1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLFB01';
const ULID32_F2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLFB02';
const ULID32_T1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTC1';

describe('StudentLearningProfileService - V15 BE-V15-1', () => {
  let service: StudentLearningProfileService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StudentLearningProfileService],
    }).compile();
    service = module.get<StudentLearningProfileService>(StudentLearningProfileService);
  });

  describe('recompute', () => {
    it('空数据 → 全 0 + 空数组', () => {
      const profile = service.recompute({
        studentId: ULID32_S1,
        feedbacks: [],
        homeworkSubmissions: [],
        assessmentResults: [],
      });
      expect(profile.totalLessons).toBe(0);
      expect(profile.attendanceRate).toBe(0);
      expect(profile.knowledgeMastery).toHaveLength(0);
      expect(profile.weaknessPoints).toHaveLength(0);
      expect(profile.avgHomeworkGrade).toBeUndefined();
      expect(profile.avgAssessmentScore).toBeUndefined();
    });

    it('出勤率计算正确（出勤+迟到 / 总数）', () => {
      const feedbacks: LessonFeedback[] = [
        {
          id: ULID32_F1,
          scheduleId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSCH1',
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          attendanceStatus: '出勤',
          classroomPerformance: '良好',
          submittedAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: ULID32_F2,
          scheduleId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSCH2',
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          attendanceStatus: '缺席',
          classroomPerformance: '合格',
          submittedAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      const profile = service.recompute({
        studentId: ULID32_S1,
        feedbacks,
        homeworkSubmissions: [],
        assessmentResults: [],
      });
      expect(profile.attendanceRate).toBe(50); // 1/2 = 50%
    });

    it('知识点累计去重 — 同名取最近 mastery + lessonCount 累加', () => {
      const feedbacks: LessonFeedback[] = [
        {
          id: ULID32_F1,
          scheduleId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSCH1',
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          attendanceStatus: '出勤',
          classroomPerformance: '良好',
          knowledgePoints: [{ name: '二次方程', mastery: '需努力' }],
          submittedAt: new Date('2026-04-01'),
          updatedAt: new Date(),
        },
        {
          id: ULID32_F2,
          scheduleId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSCH2',
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          attendanceStatus: '出勤',
          classroomPerformance: '良好',
          knowledgePoints: [{ name: '二次方程', mastery: '良好' }], // 进步
          submittedAt: new Date('2026-04-15'),
          updatedAt: new Date(),
        },
      ];
      const profile = service.recompute({
        studentId: ULID32_S1,
        feedbacks,
        homeworkSubmissions: [],
        assessmentResults: [],
      });
      const km = profile.knowledgeMastery.find((k) => k.name === '二次方程');
      expect(km).toBeDefined();
      expect(km?.lessonCount).toBe(2);
      expect(km?.mastery).toBe('良好'); // 最近一次的 mastery
    });

    it('薄弱 / 强项识别', () => {
      const feedbacks: LessonFeedback[] = [
        {
          id: ULID32_F1,
          scheduleId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSCH1',
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          attendanceStatus: '出勤',
          classroomPerformance: '良好',
          knowledgePoints: [
            { name: '二次方程', mastery: '需努力' }, // 薄弱
            { name: '因式分解', mastery: '优秀' }, // 强项
            { name: '平面几何', mastery: '合格' }, // 既不薄弱也不强项
          ],
          submittedAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      const profile = service.recompute({
        studentId: ULID32_S1,
        feedbacks,
        homeworkSubmissions: [],
        assessmentResults: [],
      });
      expect(profile.weaknessPoints.map((k) => k.name)).toEqual(['二次方程']);
      expect(profile.strengthPoints.map((k) => k.name)).toEqual(['因式分解']);
    });

    it('作业平均等级（A+B → A）', () => {
      const subs: HomeworkSubmission[] = [
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSUB1',
          assignmentId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLAS01',
          studentId: ULID32_S1,
          status: 'graded',
          grade: 'A', // 5
          submittedAt: new Date(),
        },
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSUB2',
          assignmentId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLAS02',
          studentId: ULID32_S1,
          status: 'graded',
          grade: 'B', // 4
          submittedAt: new Date(),
        },
      ];
      const profile = service.recompute({
        studentId: ULID32_S1,
        feedbacks: [],
        homeworkSubmissions: subs,
        assessmentResults: [],
      });
      // 平均 = (5+4)/2 = 4.5 → A
      expect(profile.avgHomeworkGrade).toBe('A');
      expect(profile.totalHomeworks).toBe(2);
    });

    it('测评平均分', () => {
      const results: StudentAssessmentResult[] = [
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLAR01',
          assessmentId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLAS01',
          studentId: ULID32_S1,
          score: 80,
          recordedAt: new Date(),
        },
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLAR02',
          assessmentId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLAS02',
          studentId: ULID32_S1,
          score: 90,
          recordedAt: new Date(),
        },
      ];
      const profile = service.recompute({
        studentId: ULID32_S1,
        feedbacks: [],
        homeworkSubmissions: [],
        assessmentResults: results,
      });
      expect(profile.avgAssessmentScore).toBe(85);
      expect(profile.totalAssessments).toBe(2);
    });

    it('未批改的作业不入平均（仅 graded 状态）', () => {
      const subs: HomeworkSubmission[] = [
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSUB1',
          assignmentId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLAS01',
          studentId: ULID32_S1,
          status: 'submitted', // 未批
          submittedAt: new Date(),
        },
      ];
      const profile = service.recompute({
        studentId: ULID32_S1,
        feedbacks: [],
        homeworkSubmissions: subs,
        assessmentResults: [],
      });
      expect(profile.totalHomeworks).toBe(0);
      expect(profile.avgHomeworkGrade).toBeUndefined();
    });

    it('studentId 长度非 32 → BadRequestException', () => {
      expect(() =>
        service.recompute({
          studentId: 'short',
          feedbacks: [],
          homeworkSubmissions: [],
          assessmentResults: [],
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('identifyWeaknesses / identifyStrengths', () => {
    it('返回 profile 中的对应字段', () => {
      const profile = service.recompute({
        studentId: ULID32_S1,
        feedbacks: [
          {
            id: ULID32_F1,
            scheduleId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSCH1',
            studentId: ULID32_S1,
            teacherId: ULID32_T1,
            attendanceStatus: '出勤',
            classroomPerformance: '良好',
            knowledgePoints: [
              { name: 'A', mastery: '需努力' },
              { name: 'B', mastery: '优秀' },
            ],
            submittedAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        homeworkSubmissions: [],
        assessmentResults: [],
      });
      const w = service.identifyWeaknesses(profile);
      const s = service.identifyStrengths(profile);
      expect(w.map((k) => k.name)).toEqual(['A']);
      expect(s.map((k) => k.name)).toEqual(['B']);
    });
  });
});
