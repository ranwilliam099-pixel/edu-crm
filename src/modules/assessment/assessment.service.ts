import { Injectable, BadRequestException, ConflictException, Logger, Optional, NotFoundException } from '@nestjs/common';
import { AssessmentRepository } from '../db/assessment.repository';

/**
 * AssessmentService — V14 测评/考试 BE-V14-1
 *
 * 来源：《教学链路完整设计-V1-2026-05-02.md》§3
 *
 * V1 简化：仅录纸笔成绩；V2 可扩展在线答题（需题库设计）
 */
export type AssessmentType = '月考' | '期中' | '期末' | '单元测' | '其他';
export type AssessmentStatus = 'draft' | 'published' | 'closed';

export interface KnowledgePointScore {
  name: string;
  score: number;
  total: number;
}

export interface Assessment {
  id: string;
  teacherId: string;
  title: string;
  subject: string;
  assessmentType: AssessmentType;
  totalScore: number;
  scheduledAt?: Date;
  status: AssessmentStatus;
  createdAt: Date;
}

export interface StudentAssessmentResult {
  id: string;
  assessmentId: string;
  studentId: string;
  score?: number;
  rankInClass?: number;
  knowledgeBreakdown?: ReadonlyArray<KnowledgePointScore>;
  teacherComment?: string;
  recordedAt?: Date;
  recordedByUserId?: string;
}

@Injectable()
export class AssessmentService {
  private readonly logger = new Logger(AssessmentService.name);

  constructor(@Optional() private readonly repo?: AssessmentRepository) {}

  /**
   * 创建测评（默认 status=draft，老师录完所有成绩后 publish）
   */
  createAssessment(input: {
    id: string;
    teacherId: string;
    title: string;
    subject: string;
    assessmentType?: AssessmentType;
    totalScore?: number;
    scheduledAt?: Date;
  }): Assessment {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('id must be 32-char ULID');
    }
    if (!input.teacherId || input.teacherId.length !== 32) {
      throw new BadRequestException('teacherId must be 32-char ULID');
    }
    if (!input.title || input.title.trim().length === 0) {
      throw new BadRequestException('title required');
    }
    if (!input.subject || input.subject.trim().length === 0) {
      throw new BadRequestException('subject required');
    }
    const assessmentType = input.assessmentType ?? '月考';
    if (!['月考', '期中', '期末', '单元测', '其他'].includes(assessmentType)) {
      throw new BadRequestException(`assessmentType invalid: ${assessmentType}`);
    }
    const totalScore = input.totalScore ?? 100;
    if (totalScore <= 0) {
      throw new BadRequestException('totalScore must be > 0');
    }
    return {
      id: input.id,
      teacherId: input.teacherId,
      title: input.title,
      subject: input.subject,
      assessmentType,
      totalScore,
      scheduledAt: input.scheduledAt,
      status: 'draft',
      createdAt: new Date(),
    };
  }

  /**
   * 录入学员成绩
   */
  recordResult(
    input: {
      id: string;
      assessmentId: string;
      studentId: string;
      score: number;
      knowledgeBreakdown?: ReadonlyArray<KnowledgePointScore>;
      teacherComment?: string;
      recordedByUserId: string;
    },
    assessment: Assessment,
    existingResults: ReadonlyArray<StudentAssessmentResult>,
  ): StudentAssessmentResult {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('id must be 32-char ULID');
    }
    if (assessment.status === 'closed') {
      throw new ConflictException('assessment closed, cannot record');
    }
    if (input.score < 0 || input.score > assessment.totalScore) {
      throw new BadRequestException(
        `score out of range [0, ${assessment.totalScore}]: ${input.score}`,
      );
    }
    if (!input.recordedByUserId || input.recordedByUserId.length !== 32) {
      throw new BadRequestException('recordedByUserId must be 32-char ULID');
    }
    const existing = existingResults.find(
      (r) => r.assessmentId === input.assessmentId && r.studentId === input.studentId,
    );
    if (existing) {
      throw new ConflictException(
        `RESULT_ALREADY_RECORDED: student=${input.studentId} assessment=${input.assessmentId}`,
      );
    }
    if (input.knowledgeBreakdown) {
      for (const kp of input.knowledgeBreakdown) {
        if (kp.score < 0 || kp.score > kp.total) {
          throw new BadRequestException(
            `knowledge_breakdown ${kp.name}: score out of range`,
          );
        }
      }
    }
    return {
      id: input.id,
      assessmentId: input.assessmentId,
      studentId: input.studentId,
      score: input.score,
      knowledgeBreakdown: input.knowledgeBreakdown,
      teacherComment: input.teacherComment,
      recordedAt: new Date(),
      recordedByUserId: input.recordedByUserId,
    };
  }

  /**
   * 录入完全部成绩后 publish（家长可见）
   */
  publishAssessment(assessment: Assessment): Assessment {
    if (assessment.status === 'published') {
      throw new BadRequestException('already published');
    }
    if (assessment.status === 'closed') {
      throw new BadRequestException('cannot publish closed assessment');
    }
    return { ...assessment, status: 'published' };
  }

  /**
   * 关闭测评（不再允许录入）
   */
  closeAssessment(assessment: Assessment): Assessment {
    if (assessment.status === 'closed') {
      throw new BadRequestException('already closed');
    }
    return { ...assessment, status: 'closed' };
  }

  /**
   * 计算班内排名（按 score 降序）
   */
  computeRanking(
    results: ReadonlyArray<StudentAssessmentResult>,
  ): StudentAssessmentResult[] {
    const sorted = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    let lastScore: number | undefined = undefined;
    let lastRank = 0;
    return sorted.map((r, idx) => {
      const currentRank = r.score === lastScore ? lastRank : idx + 1;
      lastScore = r.score;
      lastRank = currentRank;
      return { ...r, rankInClass: currentRank };
    });
  }

  /**
   * 学员视角的测评列表（按时间倒序）
   */
  listByStudent(
    studentId: string,
    results: ReadonlyArray<StudentAssessmentResult>,
    assessments: ReadonlyArray<Assessment>,
  ): Array<{ assessment: Assessment; result: StudentAssessmentResult }> {
    const studentResults = results.filter(
      (r) => r.studentId === studentId && r.recordedAt !== undefined,
    );
    return studentResults
      .map((r) => ({
        result: r,
        assessment: assessments.find((a) => a.id === r.assessmentId),
      }))
      .filter((entry): entry is { assessment: Assessment; result: StudentAssessmentResult } =>
        entry.assessment !== undefined && entry.assessment.status === 'published',
      )
      .sort(
        (a, b) =>
          (b.result.recordedAt?.getTime() ?? 0) - (a.result.recordedAt?.getTime() ?? 0),
      );
  }

  // ============= 真存盘版 =============

  async createAssessmentInDb(
    input: Parameters<AssessmentService['createAssessment']>[0],
    tenantSchema: string,
  ): Promise<Assessment> {
    if (!this.repo) throw new BadRequestException('AssessmentRepository not available');
    const memA = this.createAssessment(input);
    return this.repo.insertAssessment(tenantSchema, memA);
  }

  async recordResultInDb(
    input: {
      id: string;
      assessmentId: string;
      studentId: string;
      score: number;
      knowledgeBreakdown?: ReadonlyArray<KnowledgePointScore>;
      teacherComment?: string;
      recordedByUserId: string;
    },
    tenantSchema: string,
  ): Promise<StudentAssessmentResult> {
    if (!this.repo) throw new BadRequestException('AssessmentRepository not available');
    const assessment = await this.repo.findAssessmentById(tenantSchema, input.assessmentId);
    if (!assessment) throw new NotFoundException(`assessment ${input.assessmentId} not found`);
    const existingResults = await this.repo.listResultsByAssessment(tenantSchema, input.assessmentId);
    const memR = this.recordResult(input, assessment, existingResults);
    return this.repo.insertResult(tenantSchema, memR);
  }

  async publishAssessmentInDb(
    id: string,
    tenantSchema: string,
  ): Promise<Assessment> {
    if (!this.repo) throw new BadRequestException('AssessmentRepository not available');
    const existing = await this.repo.findAssessmentById(tenantSchema, id);
    if (!existing) throw new NotFoundException(`assessment ${id} not found`);
    // 沿用纯逻辑校验
    this.publishAssessment(existing);
    // 发布前自动算排名
    const results = await this.repo.listResultsByAssessment(tenantSchema, id);
    const ranked = this.computeRanking(results);
    await this.repo.updateRankings(
      tenantSchema,
      ranked
        .filter((r): r is StudentAssessmentResult & { rankInClass: number } => r.rankInClass !== undefined)
        .map((r) => ({ id: r.id, rankInClass: r.rankInClass })),
    );
    return this.repo.setAssessmentStatus(tenantSchema, id, 'published');
  }

  async closeAssessmentInDb(
    id: string,
    tenantSchema: string,
  ): Promise<Assessment> {
    if (!this.repo) throw new BadRequestException('AssessmentRepository not available');
    const existing = await this.repo.findAssessmentById(tenantSchema, id);
    if (!existing) throw new NotFoundException(`assessment ${id} not found`);
    this.closeAssessment(existing);
    return this.repo.setAssessmentStatus(tenantSchema, id, 'closed');
  }

  async findAssessmentInDb(id: string, tenantSchema: string): Promise<Assessment> {
    if (!this.repo) throw new BadRequestException('AssessmentRepository not available');
    const r = await this.repo.findAssessmentById(tenantSchema, id);
    if (!r) throw new NotFoundException(`assessment ${id} not found`);
    return r;
  }

  async listAssessmentsByTeacherInDb(
    teacherId: string,
    tenantSchema: string,
  ): Promise<Assessment[]> {
    if (!this.repo) throw new BadRequestException('AssessmentRepository not available');
    return this.repo.listAssessmentsByTeacher(tenantSchema, teacherId);
  }

  async listResultsByAssessmentInDb(
    assessmentId: string,
    tenantSchema: string,
  ): Promise<StudentAssessmentResult[]> {
    if (!this.repo) throw new BadRequestException('AssessmentRepository not available');
    return this.repo.listResultsByAssessment(tenantSchema, assessmentId);
  }

  async listResultsByStudentInDb(
    studentId: string,
    tenantSchema: string,
  ): Promise<StudentAssessmentResult[]> {
    if (!this.repo) throw new BadRequestException('AssessmentRepository not available');
    return this.repo.listResultsByStudent(tenantSchema, studentId);
  }

  /**
   * 2026-05-22 老师测评录分 page 一站式: { assessment, results[] }
   *   按用户「禁止幻想」原则: 无 assessment_recipients 表 → 不假造未录学员清单
   *   results 来自已录 student_assessment_results, 0 → 显示空状态
   */
  async getAssessmentDetailInDb(
    assessmentId: string,
    tenantSchema: string,
  ): Promise<{ assessment: Assessment; results: StudentAssessmentResult[] }> {
    if (!this.repo) throw new BadRequestException('AssessmentRepository not available');
    const assessment = await this.repo.findAssessmentById(tenantSchema, assessmentId);
    if (!assessment) throw new NotFoundException(`assessment ${assessmentId} not found`);
    const results = await this.repo.listResultsByAssessment(tenantSchema, assessmentId);
    return { assessment, results };
  }
}
