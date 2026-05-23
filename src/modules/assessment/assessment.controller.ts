import {
  Body,
  Controller,
  ForbiddenException,
  Param,
  Post,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  AssessmentService,
  Assessment,
  StudentAssessmentResult,
  AssessmentType,
  KnowledgePointScore,
} from './assessment.service';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { TeacherRepository } from '../db/teacher.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * AssessmentController — V14 测评/考试 HTTP 暴露 BE-V14-1
 * 路由前缀：/api/assessments
 *
 * Sprint B (2026-05-11) RBAC：
 *   - 写操作（create / record / publish / close）: teacher / admin / boss
 *   - 读操作（list*）: teacher / academic / academic_admin / admin / boss
 *   - 老 mock 端点（无 tenantSchema 的 in-memory 版本）不上 RBAC（仅测试用）
 *
 * Sprint B (2026-05-11) 深度防御：
 *   - class-level @UseGuards(TenantScopeGuard) — 兜底所有 /db endpoint 跨租户校验
 */
@UseGuards(TenantScopeGuard)
@Controller('assessments')
export class AssessmentController {
  // 2026-05-22 加 TeacherRepository — db/my-list JWT 反查 (同 homework my-assignments)
  constructor(
    private readonly service: AssessmentService,
    private readonly teacherRepo: TeacherRepository,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  createAssessment(
    @Body()
    body: {
      id: string;
      teacherId: string;
      title: string;
      subject: string;
      assessmentType?: AssessmentType;
      totalScore?: number;
      scheduledAtMs?: number;
    },
  ): Assessment {
    return this.service.createAssessment({
      ...body,
      scheduledAt: body.scheduledAtMs ? new Date(body.scheduledAtMs) : undefined,
    });
  }

  @Post(':id/results')
  @HttpCode(HttpStatus.CREATED)
  recordResult(
    @Param('id') _id: string,
    @Body()
    body: {
      input: {
        id: string;
        assessmentId: string;
        studentId: string;
        score: number;
        knowledgeBreakdown?: KnowledgePointScore[];
        teacherComment?: string;
        recordedByUserId: string;
      };
      assessment: Assessment;
      existingResults: StudentAssessmentResult[];
    },
  ): StudentAssessmentResult {
    return this.service.recordResult(
      body.input,
      this.deserializeAssessment(body.assessment),
      body.existingResults.map((r) => this.deserializeResult(r)),
    );
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  publish(
    @Param('id') _id: string,
    @Body() body: { assessment: Assessment },
  ): Assessment {
    return this.service.publishAssessment(this.deserializeAssessment(body.assessment));
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  close(
    @Param('id') _id: string,
    @Body() body: { assessment: Assessment },
  ): Assessment {
    return this.service.closeAssessment(this.deserializeAssessment(body.assessment));
  }

  @Post(':id/ranking')
  @HttpCode(HttpStatus.OK)
  computeRanking(
    @Param('id') _id: string,
    @Body() body: { results: StudentAssessmentResult[] },
  ): StudentAssessmentResult[] {
    return this.service.computeRanking(
      body.results.map((r) => this.deserializeResult(r)),
    );
  }

  @Post('students/:studentId/list')
  @HttpCode(HttpStatus.OK)
  listByStudent(
    @Param('studentId') studentId: string,
    @Body()
    body: { results: StudentAssessmentResult[]; assessments: Assessment[] },
  ): Array<{ assessment: Assessment; result: StudentAssessmentResult }> {
    return this.service.listByStudent(
      studentId,
      body.results.map((r) => this.deserializeResult(r)),
      body.assessments.map((a) => this.deserializeAssessment(a)),
    );
  }

  // ================ /db 真存盘版 ================

  @Post('db')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.CREATED)
  async createInDb(
    @Body()
    body: {
      id: string;
      teacherId: string;
      title: string;
      subject: string;
      assessmentType?: AssessmentType;
      totalScore?: number;
      scheduledAtMs?: number;
      // 2026-05-23 task #33: 测评接收方学员清单 (可选, 未传则默认 = 老师主带学员)
      recipientStudentIds?: string[];
      tenantSchema: string;
    },
  ): Promise<Assessment | (Assessment & { recipientStudentIds: string[] })> {
    const { tenantSchema, scheduledAtMs, recipientStudentIds, ...rest } = body;
    const input = { ...rest, scheduledAt: scheduledAtMs ? new Date(scheduledAtMs) : undefined };
    // 2026-05-23 task #33: 新走 fan-out (recipients 默认从 student_teacher_bindings)
    //   旧 createAssessmentInDb 不带 recipients, 兼容保留 (无 student-binding tenant 走不下来)
    return this.service.createAssessmentWithRecipientsInDb(input, recipientStudentIds, tenantSchema);
  }

  @Post('db/:id/results')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.CREATED)
  async recordResultInDb(
    @Param('id') assessmentId: string,
    @Body()
    body: {
      id: string;
      studentId: string;
      score: number;
      knowledgeBreakdown?: KnowledgePointScore[];
      teacherComment?: string;
      recordedByUserId: string;
      tenantSchema: string;
    },
  ): Promise<StudentAssessmentResult> {
    const { tenantSchema, ...rest } = body;
    return this.service.recordResultInDb({ ...rest, assessmentId }, tenantSchema);
  }

  @Post('db/:id/publish')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async publishInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<Assessment> {
    return this.service.publishAssessmentInDb(id, body.tenantSchema);
  }

  @Post('db/:id/close')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async closeInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<Assessment> {
    return this.service.closeAssessmentInDb(id, body.tenantSchema);
  }

  /**
   * Sprint B RBAC (2026-05-11 复审补): 7 role 读（5/15 A-2 删 sales_director）
   *   - teacher / academic / academic_admin / admin / boss / sales / sales_manager
   */
  @Post('db/:id/results/list')
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
  async listResultsByAssessmentInDb(
    @Param('id') assessmentId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<StudentAssessmentResult[]> {
    return this.service.listResultsByAssessmentInDb(assessmentId, body.tenantSchema);
  }

  /**
   * 2026-05-22 老师视角测评列表 — JWT 反查 teacher.id
   *   POST /api/assessments/db/my-list { tenantSchema }
   *   RBAC: teacher only (本人测评); 其他角色用 db/teachers/:teacherId/list
   *   同 schedule.controller my-calendar + homework.controller my-assignments 模式
   */
  @Post('db/my-list')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher')
  @HttpCode(HttpStatus.OK)
  async listMyAssessmentsInDb(
    @Body() body: { tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Assessment[]> {
    const userId = req.user?.sub;
    if (!userId) throw new ForbiddenException('user.sub missing');
    const teacher = await this.teacherRepo.findByUserId(body.tenantSchema, userId);
    if (!teacher) {
      throw new ForbiddenException(
        `no teachers row bound to user ${userId} — 老师未建档案不能查测评`,
      );
    }
    return this.service.listAssessmentsByTeacherInDb(teacher.id, body.tenantSchema);
  }

  /**
   * 2026-05-22 老师测评录分 page 一站式 — 拉 assessment + recipients + results
   *   POST /api/assessments/db/:id/detail { tenantSchema }
   *
   *   2026-05-23 task #33 升级返 shape:
   *     { assessment, recipients[], results[] }
   *     - recipients: V60 assessment_recipients (含全员 含未录)
   *     - results: V14 student_assessment_results (已录)
   *     - 前端 merge: 每 recipient 找对应 result → 已录/未录
   */
  @Post('db/:id/detail')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'academic', 'academic_admin', 'admin', 'boss', 'sales', 'sales_manager')
  @HttpCode(HttpStatus.OK)
  async getAssessmentDetailInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<{
    assessment: Assessment;
    recipients: Array<{ studentId: string; studentName: string | null }>;
    results: StudentAssessmentResult[];
  }> {
    return this.service.getAssessmentDetailInDb(id, body.tenantSchema);
  }

  /**
   * Sprint B RBAC (2026-05-11 复审补): 7 role 读（5/15 A-2 删 sales_director）
   */
  @Post('db/teachers/:teacherId/list')
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
  async listByTeacherInDb(
    @Param('teacherId') teacherId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<Assessment[]> {
    return this.service.listAssessmentsByTeacherInDb(teacherId, body.tenantSchema);
  }

  /**
   * Sprint B RBAC (2026-05-11 复审补): 7 role 读（5/15 A-2 删 sales_director）
   *   - 注：家长 c 端不走此 endpoint，走专门 c 端 path（待 Sprint D 拆分）
   */
  @Post('db/students/:studentId/results')
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
  async listResultsByStudentInDb(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<StudentAssessmentResult[]> {
    return this.service.listResultsByStudentInDb(studentId, body.tenantSchema);
  }

  // ===== helpers =====

  private deserializeAssessment(a: Assessment): Assessment {
    return {
      ...a,
      scheduledAt: a.scheduledAt ? new Date(a.scheduledAt as unknown as string) : undefined,
      createdAt: new Date(a.createdAt as unknown as string),
    };
  }

  private deserializeResult(r: StudentAssessmentResult): StudentAssessmentResult {
    return {
      ...r,
      recordedAt: r.recordedAt ? new Date(r.recordedAt as unknown as string) : undefined,
    };
  }
}
