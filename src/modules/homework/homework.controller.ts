import {
  Body,
  Controller,
  Param,
  Post,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  HomeworkService,
  HomeworkAssignment,
  HomeworkSubmission,
  Difficulty,
  Grade,
} from './homework.service';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';

/**
 * HomeworkController — V13 作业管理 HTTP 暴露 BE-V13-1
 * 路由前缀：/api/homework
 *
 * Sprint B (2026-05-11) RBAC：
 *   - 写操作（publish / grade / return）: teacher / admin / boss
 *   - 读操作（list*）：teacher / academic / academic_admin / admin / boss / sales / sales_manager
 *     （5/15 A-2 删 sales_director；拍板「教务全只读老师线」+「销售看自己客户孩子作业」）
 *   - 老 mock 端点（无 tenantSchema 的 in-memory 版本）不上 RBAC（仅测试用）
 *   - 家长 c 端：走 /api/homework/db/students/* 前缀，middleware isParentDbPath 已含
 *
 * Sprint B (2026-05-11) 深度防御：
 *   - class-level @UseGuards(TenantScopeGuard) — 兜底所有 /db endpoint 跨租户校验
 *   - body.tenantSchema 校验由 TenantScopeGuard 完成（参考 guard 第 4 条规则）
 */
@UseGuards(TenantScopeGuard)
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
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
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

  /**
   * Sprint B：submissions/POST 主要是家长 c 端提交作业（parent JWT 流）
   *   - middleware isParentDbPath 已含 /api/homework/db/submissions
   *   - 但 admin / boss / teacher 也可能代提交（运营回放）
   *   - 不设 @Roles 让 parent JWT 也能调（RbacGuard 默认放行无 @Roles 路由）
   */
  @Post('db/submissions')
  @UseInterceptors(IdempotencyInterceptor)
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
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
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
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async returnForRedoInDb(
    @Param('id') id: string,
    @Body() body: { teacherComment: string; tenantSchema: string },
  ): Promise<HomeworkSubmission> {
    return this.service.returnForRedoInDb(id, body.teacherComment, body.tenantSchema);
  }

  /**
   * Sprint B RBAC (2026-05-11 复审补): 7 role 读（5/15 A-2 删 sales_director）
   *   - teacher / academic / academic_admin / admin / boss / sales / sales_manager
   *   - 销售可看自己客户孩子的作业 — service 层做字段过滤
   *   - 5/15 A-2 删 sales_director
   */
  @Post('db/teachers/:teacherId/assignments')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles(
    'teacher',
    'academic',
    'academic_admin',
    'admin',
    'boss',
    'sales',
    'sales_manager',
    // 5/15 A-2：删 'sales_director'（不在拍板角色清单）
  )
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

  /**
   * Sprint B RBAC (2026-05-11 复审补): 7 role 读（5/15 A-2 删 sales_director）
   *   - 注：家长 c 端走独立 endpoint /api/homework/db/students/:studentId/assignments?? 不再适用
   *     middleware isParentDbPath 含 /api/homework/db/students/ → parent JWT 也会走到此 controller
   *     但 RbacGuard 拦截 parent role → 路由失效
   *     → 解决：parent 应走专门的 c 端 endpoint（待 Sprint D 拆分）。当前先按 B 端 RBAC 锁
   */
  @Post('db/students/:studentId/assignments')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles(
    'teacher',
    'academic',
    'academic_admin',
    'admin',
    'boss',
    'sales',
    'sales_manager',
    // 5/15 A-2：删 'sales_director'（不在拍板角色清单）
  )
  @HttpCode(HttpStatus.OK)
  async listAssignmentsByStudentInDb(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<HomeworkAssignment[]> {
    return this.service.listAssignmentsByStudentInDb(studentId, body.tenantSchema);
  }

  /**
   * Sprint B RBAC (2026-05-11 复审补): 7 role 读（5/15 A-2 删 sales_director）
   *   - teacher 看自己待批改
   *   - 教务双层 / 销售只读 看老师待批改 KPI
   */
  @Post('db/teachers/:teacherId/pending-grading')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles(
    'teacher',
    'academic',
    'academic_admin',
    'admin',
    'boss',
    'sales',
    'sales_manager',
    // 5/15 A-2：删 'sales_director'（不在拍板角色清单）
  )
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
