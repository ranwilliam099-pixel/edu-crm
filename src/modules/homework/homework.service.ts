import { Injectable, BadRequestException, ConflictException, Logger, Optional, NotFoundException } from '@nestjs/common';
import { HomeworkRepository } from '../db/homework.repository';

/**
 * HomeworkService — V13 作业管理 BE-V13-1
 *
 * 来源：《教学链路完整设计-V1-2026-05-02.md》§2
 *
 * 流程：
 *   1. 老师 publish() 布置作业，附件 + 截止时间 + 难度
 *   2. 系统按 schedule_students 或 student_teacher_bindings 写入 assignment_recipients
 *   3. 学员/家长 submitForStudent() 提交
 *   4. 老师 grade() 批改
 */
export type Difficulty = '易' | '中' | '难';
export type AssignmentStatus = 'published' | 'archived';
export type SubmissionStatus = 'submitted' | 'graded' | 'returned';
export type Grade = 'A+' | 'A' | 'B' | 'C' | 'D' | '须重做';

export interface HomeworkAssignment {
  id: string;
  scheduleId?: string;
  teacherId: string;
  title: string;
  content?: string;
  attachments?: ReadonlyArray<{ url: string; type: string; filename: string }>;
  dueAt?: Date;
  difficulty?: Difficulty;
  status: AssignmentStatus;
  recipientStudentIds: ReadonlyArray<string>;
  createdAt: Date;
}

export interface HomeworkSubmission {
  id: string;
  assignmentId: string;
  studentId: string;
  submittedByParentId?: string;
  content?: string;
  attachments?: ReadonlyArray<{ url: string; type: string; filename: string }>;
  status: SubmissionStatus;
  grade?: Grade;
  teacherComment?: string;
  gradedAt?: Date;
  gradedByUserId?: string;
  submittedAt: Date;
}

@Injectable()
export class HomeworkService {
  private readonly logger = new Logger(HomeworkService.name);

  constructor(@Optional() private readonly repo?: HomeworkRepository) {}

  /**
   * 老师布置作业（关联 schedule 或独立）
   */
  publish(input: {
    id: string;
    teacherId: string;
    title: string;
    content?: string;
    attachments?: ReadonlyArray<{ url: string; type: string; filename: string }>;
    dueAt?: Date;
    difficulty?: Difficulty;
    scheduleId?: string;
    recipientStudentIds: ReadonlyArray<string>;
  }): HomeworkAssignment {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('assignment id must be 32-char ULID');
    }
    if (!input.teacherId || input.teacherId.length !== 32) {
      throw new BadRequestException('teacherId must be 32-char ULID');
    }
    if (!input.title || input.title.trim().length === 0) {
      throw new BadRequestException('title required');
    }
    if (!input.recipientStudentIds || input.recipientStudentIds.length === 0) {
      throw new BadRequestException('recipientStudentIds required (>=1)');
    }
    for (const sid of input.recipientStudentIds) {
      if (sid.length !== 32) {
        throw new BadRequestException(`recipient ${sid} must be 32-char ULID`);
      }
    }
    if (input.difficulty && !['易', '中', '难'].includes(input.difficulty)) {
      throw new BadRequestException(`difficulty must be 易/中/难`);
    }
    this.logger.log(
      `[BE-V13-1] publishHomework id=${input.id} teacher=${input.teacherId} ` +
        `recipients=${input.recipientStudentIds.length} due=${input.dueAt?.toISOString() ?? 'none'}`,
    );
    return {
      id: input.id,
      scheduleId: input.scheduleId,
      teacherId: input.teacherId,
      title: input.title,
      content: input.content,
      attachments: input.attachments,
      dueAt: input.dueAt,
      difficulty: input.difficulty,
      status: 'published',
      recipientStudentIds: input.recipientStudentIds,
      createdAt: new Date(),
    };
  }

  /**
   * 学员/家长提交作业
   *
   * @throws ConflictException 已有提交（重复提交）
   * @throws BadRequestException 学员不在 recipients 列表
   */
  submitForStudent(
    input: {
      id: string;
      assignmentId: string;
      studentId: string;
      submittedByParentId?: string;
      content?: string;
      attachments?: ReadonlyArray<{ url: string; type: string; filename: string }>;
    },
    assignment: HomeworkAssignment,
    existingSubmissions: ReadonlyArray<HomeworkSubmission>,
  ): HomeworkSubmission {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('submission id must be 32-char ULID');
    }
    if (assignment.status === 'archived') {
      throw new ConflictException('assignment archived, cannot submit');
    }
    if (!assignment.recipientStudentIds.includes(input.studentId)) {
      throw new BadRequestException('STUDENT_NOT_IN_RECIPIENTS');
    }
    const existing = existingSubmissions.find(
      (s) => s.assignmentId === input.assignmentId && s.studentId === input.studentId,
    );
    if (existing && existing.status !== 'returned') {
      throw new ConflictException('ALREADY_SUBMITTED');
    }
    return {
      id: input.id,
      assignmentId: input.assignmentId,
      studentId: input.studentId,
      submittedByParentId: input.submittedByParentId,
      content: input.content,
      attachments: input.attachments,
      status: 'submitted',
      submittedAt: new Date(),
    };
  }

  /**
   * 老师批改
   */
  grade(
    submission: HomeworkSubmission,
    input: { grade: Grade; teacherComment?: string; gradedByUserId: string },
    now: Date = new Date(),
  ): HomeworkSubmission {
    if (submission.status === 'graded') {
      throw new ConflictException('already graded');
    }
    if (submission.status === 'returned') {
      throw new BadRequestException('cannot grade returned submission');
    }
    if (!['A+', 'A', 'B', 'C', 'D', '须重做'].includes(input.grade)) {
      throw new BadRequestException(`invalid grade: ${input.grade}`);
    }
    if (!input.gradedByUserId || input.gradedByUserId.length !== 32) {
      throw new BadRequestException('gradedByUserId must be 32-char ULID');
    }
    return {
      ...submission,
      status: 'graded',
      grade: input.grade,
      teacherComment: input.teacherComment,
      gradedAt: now,
      gradedByUserId: input.gradedByUserId,
    };
  }

  /**
   * 退回（须重做）— 学员需重新提交
   */
  returnForRedo(
    submission: HomeworkSubmission,
    teacherComment: string,
    now: Date = new Date(),
  ): HomeworkSubmission {
    if (submission.status === 'returned') {
      throw new BadRequestException('already returned');
    }
    if (!teacherComment || teacherComment.trim().length === 0) {
      throw new BadRequestException('teacherComment required for return');
    }
    return {
      ...submission,
      status: 'returned',
      teacherComment,
      gradedAt: now,
    };
  }

  /**
   * 老师"待批改"列表
   */
  listPendingByTeacher(
    teacherId: string,
    submissions: ReadonlyArray<HomeworkSubmission>,
    assignments: ReadonlyArray<HomeworkAssignment>,
  ): HomeworkSubmission[] {
    const teacherAssignmentIds = assignments
      .filter((a) => a.teacherId === teacherId)
      .map((a) => a.id);
    return submissions.filter(
      (s) => teacherAssignmentIds.includes(s.assignmentId) && s.status === 'submitted',
    );
  }

  /**
   * 学员视角的作业列表（含完成状态）
   */
  listByStudent(
    studentId: string,
    assignments: ReadonlyArray<HomeworkAssignment>,
    submissions: ReadonlyArray<HomeworkSubmission>,
  ): Array<{ assignment: HomeworkAssignment; submission?: HomeworkSubmission }> {
    return assignments
      .filter((a) => a.recipientStudentIds.includes(studentId) && a.status === 'published')
      .map((a) => ({
        assignment: a,
        submission: submissions.find(
          (s) => s.assignmentId === a.id && s.studentId === studentId,
        ),
      }));
  }

  // ============= 真存盘版 =============

  async publishInDb(
    input: Parameters<HomeworkService['publish']>[0],
    tenantSchema: string,
  ): Promise<HomeworkAssignment> {
    if (!this.repo) throw new BadRequestException('HomeworkRepository not available');
    const memAsg = this.publish(input);
    return this.repo.insertAssignmentWithRecipients(tenantSchema, memAsg);
  }

  async submitForStudentInDb(
    input: {
      id: string;
      assignmentId: string;
      studentId: string;
      submittedByParentId?: string;
      content?: string;
      attachments?: ReadonlyArray<{ url: string; type: string; filename: string }>;
    },
    tenantSchema: string,
  ): Promise<HomeworkSubmission> {
    if (!this.repo) throw new BadRequestException('HomeworkRepository not available');
    const assignment = await this.repo.findAssignmentById(tenantSchema, input.assignmentId);
    if (!assignment) throw new NotFoundException(`assignment ${input.assignmentId} not found`);
    const existing = await this.repo.findSubmissionByAssignmentStudent(
      tenantSchema,
      input.assignmentId,
      input.studentId,
    );
    const memSub = this.submitForStudent(input, assignment, existing ? [existing] : []);
    return this.repo.insertSubmission(tenantSchema, memSub);
  }

  async gradeInDb(
    submissionId: string,
    input: { grade: Grade; teacherComment?: string; gradedByUserId: string },
    tenantSchema: string,
  ): Promise<HomeworkSubmission> {
    if (!this.repo) throw new BadRequestException('HomeworkRepository not available');
    const existing = await this.repo.findSubmissionById(tenantSchema, submissionId);
    if (!existing) throw new NotFoundException(`submission ${submissionId} not found`);
    // 沿用纯逻辑校验
    this.grade(existing, input);
    return this.repo.grade(
      tenantSchema,
      submissionId,
      input.grade,
      input.teacherComment,
      input.gradedByUserId,
    );
  }

  async returnForRedoInDb(
    submissionId: string,
    teacherComment: string,
    tenantSchema: string,
  ): Promise<HomeworkSubmission> {
    if (!this.repo) throw new BadRequestException('HomeworkRepository not available');
    return this.repo.returnForRedo(tenantSchema, submissionId, teacherComment);
  }

  async listAssignmentsByTeacherInDb(
    teacherId: string,
    tenantSchema: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<HomeworkAssignment[]> {
    if (!this.repo) throw new BadRequestException('HomeworkRepository not available');
    return this.repo.listAssignmentsByTeacher(tenantSchema, teacherId, options);
  }

  async listAssignmentsByStudentInDb(
    studentId: string,
    tenantSchema: string,
  ): Promise<HomeworkAssignment[]> {
    if (!this.repo) throw new BadRequestException('HomeworkRepository not available');
    return this.repo.listAssignmentsByStudent(tenantSchema, studentId);
  }

  async listPendingByTeacherInDb(
    teacherId: string,
    tenantSchema: string,
  ): Promise<HomeworkSubmission[]> {
    if (!this.repo) throw new BadRequestException('HomeworkRepository not available');
    return this.repo.listPendingByTeacher(tenantSchema, teacherId);
  }

  /**
   * 2026-05-23 (task #31): submission count batch (单 SQL 减 N+1)
   *   homework/list 老师视角列表场景: 每个 assignment 显示 submitted/graded 数
   *   原前端 0 占位 → 现一次性拉所有 assignment 的统计
   */
  async listAssignmentSubmissionCountsInDb(
    assignmentIds: ReadonlyArray<string>,
    tenantSchema: string,
  ): Promise<Array<{ assignmentId: string; totalRecipients: number; submitted: number; graded: number }>> {
    if (!this.repo) throw new BadRequestException('HomeworkRepository not available');
    return this.repo.listAssignmentSubmissionCounts(tenantSchema, assignmentIds);
  }

  /**
   * 2026-05-22 老师批改 page 一站式数据源:
   *   { assignment, recipients[], submissions[] }
   *   前端 merge: 每个 recipient 找对应 submission → submitted/graded/未交
   */
  async getAssignmentDetailInDb(
    assignmentId: string,
    tenantSchema: string,
  ): Promise<{
    assignment: HomeworkAssignment;
    recipients: Array<{ studentId: string; studentName: string | null }>;
    submissions: Array<HomeworkSubmission & { studentName: string | null }>;
  }> {
    if (!this.repo) throw new BadRequestException('HomeworkRepository not available');
    const assignment = await this.repo.findAssignmentById(tenantSchema, assignmentId);
    if (!assignment) throw new NotFoundException(`assignment ${assignmentId} not found`);
    const [recipients, submissions] = await Promise.all([
      this.repo.listRecipientsWithStudentName(tenantSchema, assignmentId),
      this.repo.listSubmissionsByAssignmentWithStudentName(tenantSchema, assignmentId),
    ]);
    return { assignment, recipients, submissions };
  }
}
