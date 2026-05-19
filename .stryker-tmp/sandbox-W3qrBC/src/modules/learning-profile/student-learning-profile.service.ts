import { Injectable, BadRequestException, Logger, Optional, NotFoundException } from '@nestjs/common';
import { LessonFeedback, ClassroomPerformance } from '../feedback/lesson-feedback.service';
import { HomeworkSubmission, Grade } from '../homework/homework.service';
import { StudentAssessmentResult } from '../assessment/assessment.service';
import { LearningProfileRepository } from '../db/learning-profile.repository';
import { LessonFeedbackRepository } from '../db/lesson-feedback.repository';
import { HomeworkRepository } from '../db/homework.repository';
import { AssessmentRepository } from '../db/assessment.repository';

/**
 * StudentLearningProfileService — V15 学员学情累计档案 BE-V15-1
 *
 * 来源：《教学链路完整设计-V1-2026-05-02.md》§4
 *
 * 聚合层：把零散的 feedbacks / homeworks / assessments 聚成累计学情画像
 * cron 每天 0:00 增量 / 每月 1 号全量重算
 */
export interface KnowledgeMastery {
  name: string;
  mastery: ClassroomPerformance;
  lessonCount: number;
  lastSeenAt: Date;
}

export interface StudentLearningProfile {
  studentId: string;
  totalLessons: number;
  totalHomeworks: number;
  totalAssessments: number;
  attendanceRate: number; // 0-100
  avgHomeworkGrade?: Grade;
  avgAssessmentScore?: number;
  knowledgeMastery: ReadonlyArray<KnowledgeMastery>;
  weaknessPoints: ReadonlyArray<KnowledgeMastery>;
  strengthPoints: ReadonlyArray<KnowledgeMastery>;
  lastUpdatedAt: Date;
}

const GRADE_TO_NUM: Record<Grade, number> = {
  'A+': 6,
  A: 5,
  B: 4,
  C: 3,
  D: 2,
  '须重做': 1,
};

const NUM_TO_GRADE: ReadonlyArray<{ min: number; grade: Grade }> = [
  { min: 5.5, grade: 'A+' },
  { min: 4.5, grade: 'A' },
  { min: 3.5, grade: 'B' },
  { min: 2.5, grade: 'C' },
  { min: 1.5, grade: 'D' },
  { min: 0, grade: '须重做' },
];

@Injectable()
export class StudentLearningProfileService {
  private readonly logger = new Logger(StudentLearningProfileService.name);

  constructor(
    @Optional() private readonly repo?: LearningProfileRepository,
    @Optional() private readonly feedbackRepo?: LessonFeedbackRepository,
    @Optional() private readonly homeworkRepo?: HomeworkRepository,
    @Optional() private readonly assessmentRepo?: AssessmentRepository,
  ) {}

  /**
   * 重算学员学情累计档案
   *
   * @param sources 源数据（外部从各 Service 收集）
   * @returns 重算后的 profile
   */
  recompute(input: {
    studentId: string;
    feedbacks: ReadonlyArray<LessonFeedback>;
    homeworkSubmissions: ReadonlyArray<HomeworkSubmission>;
    assessmentResults: ReadonlyArray<StudentAssessmentResult>;
    now?: Date;
  }): StudentLearningProfile {
    if (!input.studentId || input.studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    const now = input.now ?? new Date();

    // 出勤率
    const totalLessons = input.feedbacks.length;
    const presentCount = input.feedbacks.filter(
      (f) => f.attendanceStatus === '出勤' || f.attendanceStatus === '迟到',
    ).length;
    const attendanceRate =
      totalLessons === 0
        ? 0
        : Math.round((presentCount / totalLessons) * 10000) / 100;

    // 知识点累计 — 聚合 lesson_feedbacks.knowledge_points
    const knowledgeMap = new Map<
      string,
      { mastery: ClassroomPerformance; lessonCount: number; lastSeenAt: Date }
    >();
    for (const f of input.feedbacks) {
      const points = f.knowledgePoints ?? [];
      for (const p of points) {
        const existing = knowledgeMap.get(p.name);
        if (!existing) {
          knowledgeMap.set(p.name, {
            mastery: p.mastery,
            lessonCount: 1,
            lastSeenAt: f.submittedAt,
          });
        } else {
          existing.lessonCount += 1;
          if (f.submittedAt.getTime() > existing.lastSeenAt.getTime()) {
            existing.mastery = p.mastery; // 取最新
            existing.lastSeenAt = f.submittedAt;
          }
        }
      }
    }
    const knowledgeMastery: KnowledgeMastery[] = Array.from(
      knowledgeMap.entries(),
    ).map(([name, v]) => ({ name, ...v }));

    // 作业平均等级
    const gradedSubs = input.homeworkSubmissions.filter(
      (s) => s.status === 'graded' && s.grade !== undefined,
    );
    const avgHomeworkNum =
      gradedSubs.length === 0
        ? undefined
        : gradedSubs.reduce((sum, s) => sum + GRADE_TO_NUM[s.grade!], 0) /
          gradedSubs.length;
    const avgHomeworkGrade =
      avgHomeworkNum === undefined
        ? undefined
        : NUM_TO_GRADE.find((entry) => avgHomeworkNum >= entry.min)?.grade;

    // 测评平均分
    const recordedResults = input.assessmentResults.filter(
      (r) => r.score !== undefined,
    );
    const avgAssessmentScore =
      recordedResults.length === 0
        ? undefined
        : Math.round(
            (recordedResults.reduce((sum, r) => sum + (r.score ?? 0), 0) /
              recordedResults.length) *
              100,
          ) / 100;

    // 薄弱 / 强项识别
    const weaknessPoints = knowledgeMastery.filter(
      (k) => k.mastery === '需努力' || k.mastery === '需关注',
    );
    const strengthPoints = knowledgeMastery.filter(
      (k) => k.mastery === '优秀' || k.mastery === '良好',
    );

    this.logger.log(
      `[BE-V15-1] recomputeProfile student=${input.studentId} ` +
        `lessons=${totalLessons} homeworks=${gradedSubs.length} ` +
        `assessments=${recordedResults.length} attendance=${attendanceRate}%`,
    );

    return {
      studentId: input.studentId,
      totalLessons,
      totalHomeworks: gradedSubs.length,
      totalAssessments: recordedResults.length,
      attendanceRate,
      avgHomeworkGrade,
      avgAssessmentScore,
      knowledgeMastery,
      weaknessPoints,
      strengthPoints,
      lastUpdatedAt: now,
    };
  }

  /**
   * 给定 profile，识别薄弱（暴露给业务层用 — 续报建议生成）
   */
  identifyWeaknesses(profile: StudentLearningProfile): ReadonlyArray<KnowledgeMastery> {
    return profile.weaknessPoints;
  }

  /**
   * 给定 profile，识别强项
   */
  identifyStrengths(profile: StudentLearningProfile): ReadonlyArray<KnowledgeMastery> {
    return profile.strengthPoints;
  }

  // ============= 真存盘版 =============

  /**
   * 重算并真存盘（cron 每天 0:00 调用）
   */
  async recomputeInDb(
    studentId: string,
    tenantSchema: string,
    now: Date = new Date(),
  ): Promise<StudentLearningProfile> {
    if (!this.repo || !this.feedbackRepo || !this.homeworkRepo || !this.assessmentRepo) {
      throw new BadRequestException('LearningProfile dependencies not all available');
    }
    if (!studentId || studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    const [feedbacks, submissions, results] = await Promise.all([
      this.feedbackRepo.listByStudent(tenantSchema, studentId, { limit: 1000 }),
      this.homeworkRepo.listSubmissionsByStudent(tenantSchema, studentId),
      this.assessmentRepo.listResultsByStudent(tenantSchema, studentId),
    ]);
    const memProfile = this.recompute({
      studentId,
      feedbacks,
      homeworkSubmissions: submissions,
      assessmentResults: results,
      now,
    });
    return this.repo.upsert(tenantSchema, memProfile);
  }

  async findInDb(
    studentId: string,
    tenantSchema: string,
  ): Promise<StudentLearningProfile> {
    if (!this.repo) throw new BadRequestException('LearningProfileRepository not available');
    const r = await this.repo.findByStudent(tenantSchema, studentId);
    if (!r) throw new NotFoundException(`learning profile for ${studentId} not found`);
    return r;
  }

  /**
   * cron：列出 N 天前未更新的档案
   */
  async listStaleInDb(
    tenantSchema: string,
    threshold: Date,
  ): Promise<StudentLearningProfile[]> {
    if (!this.repo) throw new BadRequestException('LearningProfileRepository not available');
    return this.repo.listStale(tenantSchema, threshold);
  }

  /**
   * cron 全量批量重算 — 扫所有学员，每个跑一次 recomputeInDb
   */
  async recomputeAllInDb(
    tenantSchema: string,
    now: Date = new Date(),
  ): Promise<{ recomputed: number; failed: number }> {
    if (!this.repo) throw new BadRequestException('LearningProfileRepository not available');
    const ids = await this.repo.listAllStudentIds(tenantSchema);
    let recomputed = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await this.recomputeInDb(id, tenantSchema, now);
        recomputed += 1;
      } catch (e) {
        failed += 1;
        this.logger.warn(`[BE-V15-1 recomputeAllInDb] skip ${id}: ${(e as Error).message}`);
      }
    }
    this.logger.log(
      `[BE-V15-1 recomputeAllInDb] tenant=${tenantSchema} ` +
        `recomputed=${recomputed} failed=${failed} total=${ids.length}`,
    );
    return { recomputed, failed };
  }
}
