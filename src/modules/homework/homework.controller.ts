import { Body, Controller, Param, Post, HttpCode, HttpStatus } from '@nestjs/common';
import {
  HomeworkService,
  HomeworkAssignment,
  HomeworkSubmission,
  Difficulty,
  Grade,
} from './homework.service';

/**
 * HomeworkController — V13 作业管理 HTTP 暴露 BE-V13-1
 * 路由前缀：/api/homework
 */
@Controller('homework')
export class HomeworkController {
  constructor(private readonly service: HomeworkService) {}

  @Post('assignments')
  @HttpCode(HttpStatus.CREATED)
  publish(
    @Body()
    body: {
      id: string;
      teacherId: string;
      title: string;
      content?: string;
      attachments?: Array<{ url: string; type: string; filename: string }>;
      dueAtMs?: number;
      difficulty?: Difficulty;
      scheduleId?: string;
      recipientStudentIds: string[];
    },
  ): HomeworkAssignment {
    return this.service.publish({
      ...body,
      dueAt: body.dueAtMs ? new Date(body.dueAtMs) : undefined,
    });
  }

  @Post('submissions')
  @HttpCode(HttpStatus.CREATED)
  submitForStudent(
    @Body()
    body: {
      id: string;
      assignmentId: string;
      studentId: string;
      submittedByParentId?: string;
      content?: string;
      attachments?: Array<{ url: string; type: string; filename: string }>;
      assignment: HomeworkAssignment;
      existingSubmissions: HomeworkSubmission[];
    },
  ): HomeworkSubmission {
    return this.service.submitForStudent(
      {
        id: body.id,
        assignmentId: body.assignmentId,
        studentId: body.studentId,
        submittedByParentId: body.submittedByParentId,
        content: body.content,
        attachments: body.attachments,
      },
      this.deserializeAssignment(body.assignment),
      body.existingSubmissions.map((s) => this.deserializeSubmission(s)),
    );
  }

  @Post('submissions/:id/grade')
  @HttpCode(HttpStatus.OK)
  grade(
    @Param('id') _id: string,
    @Body()
    body: {
      submission: HomeworkSubmission;
      grade: Grade;
      teacherComment?: string;
      gradedByUserId: string;
      nowMs?: number;
    },
  ): HomeworkSubmission {
    return this.service.grade(
      this.deserializeSubmission(body.submission),
      {
        grade: body.grade,
        teacherComment: body.teacherComment,
        gradedByUserId: body.gradedByUserId,
      },
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  @Post('submissions/:id/return')
  @HttpCode(HttpStatus.OK)
  returnForRedo(
    @Param('id') _id: string,
    @Body() body: { submission: HomeworkSubmission; teacherComment: string; nowMs?: number },
  ): HomeworkSubmission {
    return this.service.returnForRedo(
      this.deserializeSubmission(body.submission),
      body.teacherComment,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  @Post('teachers/:teacherId/pending-grading')
  @HttpCode(HttpStatus.OK)
  listPendingByTeacher(
    @Param('teacherId') teacherId: string,
    @Body()
    body: { submissions: HomeworkSubmission[]; assignments: HomeworkAssignment[] },
  ): HomeworkSubmission[] {
    return this.service.listPendingByTeacher(
      teacherId,
      body.submissions.map((s) => this.deserializeSubmission(s)),
      body.assignments.map((a) => this.deserializeAssignment(a)),
    );
  }

  @Post('students/:studentId/list')
  @HttpCode(HttpStatus.OK)
  listByStudent(
    @Param('studentId') studentId: string,
    @Body()
    body: { assignments: HomeworkAssignment[]; submissions: HomeworkSubmission[] },
  ): Array<{ assignment: HomeworkAssignment; submission?: HomeworkSubmission }> {
    return this.service.listByStudent(
      studentId,
      body.assignments.map((a) => this.deserializeAssignment(a)),
      body.submissions.map((s) => this.deserializeSubmission(s)),
    );
  }

  // ================ /db 真存盘版 ================

  @Post('db/assignments')
  @HttpCode(HttpStatus.CREATED)
  async publishInDb(
    @Body()
    body: {
      id: string;
      teacherId: string;
      title: string;
      content?: string;
      attachments?: Array<{ url: string; type: string; filename: string }>;
      dueAtMs?: number;
      difficulty?: Difficulty;
      scheduleId?: string;
      recipientStudentIds: string[];
      tenantSchema: string;
    },
  ): Promise<HomeworkAssignment> {
    const { tenantSchema, dueAtMs, ...rest } = body;
    return this.service.publishInDb(
      { ...rest, dueAt: dueAtMs ? new Date(dueAtMs) : undefined },
      tenantSchema,
    );
  }

  @Post('db/submissions')
  @HttpCode(HttpStatus.CREATED)
  async submitInDb(
    @Body()
    body: {
      id: string;
      assignmentId: string;
      studentId: string;
      submittedByParentId?: string;
      content?: string;
      attachments?: Array<{ url: string; type: string; filename: string }>;
      tenantSchema: string;
    },
  ): Promise<HomeworkSubmission> {
    const { tenantSchema, ...rest } = body;
    return this.service.submitForStudentInDb(rest, tenantSchema);
  }

  @Post('db/submissions/:id/grade')
  @HttpCode(HttpStatus.OK)
  async gradeInDb(
    @Param('id') id: string,
    @Body()
    body: {
      grade: Grade;
      teacherComment?: string;
      gradedByUserId: string;
      tenantSchema: string;
    },
  ): Promise<HomeworkSubmission> {
    return this.service.gradeInDb(
      id,
      {
        grade: body.grade,
        teacherComment: body.teacherComment,
        gradedByUserId: body.gradedByUserId,
      },
      body.tenantSchema,
    );
  }

  @Post('db/submissions/:id/return')
  @HttpCode(HttpStatus.OK)
  async returnForRedoInDb(
    @Param('id') id: string,
    @Body() body: { teacherComment: string; tenantSchema: string },
  ): Promise<HomeworkSubmission> {
    return this.service.returnForRedoInDb(id, body.teacherComment, body.tenantSchema);
  }

  @Post('db/teachers/:teacherId/assignments')
  @HttpCode(HttpStatus.OK)
  async listAssignmentsByTeacherInDb(
    @Param('teacherId') teacherId: string,
    @Body() body: { tenantSchema: string; limit?: number; offset?: number },
  ): Promise<HomeworkAssignment[]> {
    return this.service.listAssignmentsByTeacherInDb(teacherId, body.tenantSchema, {
      limit: body.limit,
      offset: body.offset,
    });
  }

  @Post('db/students/:studentId/assignments')
  @HttpCode(HttpStatus.OK)
  async listAssignmentsByStudentInDb(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<HomeworkAssignment[]> {
    return this.service.listAssignmentsByStudentInDb(studentId, body.tenantSchema);
  }

  @Post('db/teachers/:teacherId/pending-grading')
  @HttpCode(HttpStatus.OK)
  async listPendingByTeacherInDb(
    @Param('teacherId') teacherId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<HomeworkSubmission[]> {
    return this.service.listPendingByTeacherInDb(teacherId, body.tenantSchema);
  }

  // ===== helpers =====

  private deserializeAssignment(a: HomeworkAssignment): HomeworkAssignment {
    return {
      ...a,
      dueAt: a.dueAt ? new Date(a.dueAt as unknown as string) : undefined,
      createdAt: new Date(a.createdAt as unknown as string),
    };
  }

  private deserializeSubmission(s: HomeworkSubmission): HomeworkSubmission {
    return {
      ...s,
      submittedAt: new Date(s.submittedAt as unknown as string),
      gradedAt: s.gradedAt ? new Date(s.gradedAt as unknown as string) : undefined,
    };
  }
}
