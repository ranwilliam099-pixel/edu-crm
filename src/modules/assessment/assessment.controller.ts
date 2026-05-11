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
  constructor(private readonly service: AssessmentService) {}

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
      tenantSchema: string;
    },
  ): Promise<Assessment> {
    const { tenantSchema, scheduledAtMs, ...rest } = body;
    return this.service.createAssessmentInDb(
      { ...rest, scheduledAt: scheduledAtMs ? new Date(scheduledAtMs) : undefined },
      tenantSchema,
    );
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
   * Sprint B RBAC (2026-05-11 复审补): 8 role 读
   *   - teacher / academic / academic_admin / admin / boss / sales / sales_manager / sales_director
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
    'sales_director',
  )
  @HttpCode(HttpStatus.OK)
  async listResultsByAssessmentInDb(
    @Param('id') assessmentId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<StudentAssessmentResult[]> {
    return this.service.listResultsByAssessmentInDb(assessmentId, body.tenantSchema);
  }

  /**
   * Sprint B RBAC (2026-05-11 复审补): 8 role 读
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
    'sales_director',
  )
  @HttpCode(HttpStatus.OK)
  async listByTeacherInDb(
    @Param('teacherId') teacherId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<Assessment[]> {
    return this.service.listAssessmentsByTeacherInDb(teacherId, body.tenantSchema);
  }

  /**
   * Sprint B RBAC (2026-05-11 复审补): 8 role 读
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
    'sales_director',
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
