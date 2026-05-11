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
  StudentLearningProfileService,
  StudentLearningProfile,
  KnowledgeMastery,
} from './student-learning-profile.service';
import { LessonFeedback } from '../feedback/lesson-feedback.service';
import { HomeworkSubmission } from '../homework/homework.service';
import { StudentAssessmentResult } from '../assessment/assessment.service';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';

/**
 * LearningProfileController — V15 学情累计档案 HTTP 暴露 BE-V15-1
 * 路由前缀：/api/learning-profile
 *
 * Sprint B (2026-05-11) RBAC：
 *   - recompute / recompute-all：admin / boss / teacher（cron 走 service 不走 controller）
 *   - 读 endpoint：teacher / academic / academic_admin / admin / boss
 *   - 老 mock 端点（无 tenantSchema 的 in-memory 版本）不上 RBAC
 *
 * Sprint B (2026-05-11) 深度防御：
 *   - class-level @UseGuards(TenantScopeGuard) — 兜底所有 /db endpoint 跨租户校验
 */
@UseGuards(TenantScopeGuard)
@Controller('learning-profile')
export class LearningProfileController {
  constructor(private readonly service: StudentLearningProfileService) {}

  /**
   * POST /api/learning-profile/recompute
   * cron 每天 0:00 增量 + 每月 1 号全量
   */
  @Post('recompute')
  @HttpCode(HttpStatus.OK)
  recompute(
    @Body()
    body: {
      studentId: string;
      feedbacks: LessonFeedback[];
      homeworkSubmissions: HomeworkSubmission[];
      assessmentResults: StudentAssessmentResult[];
      nowMs?: number;
    },
  ): StudentLearningProfile {
    return this.service.recompute({
      studentId: body.studentId,
      feedbacks: body.feedbacks.map((f) => this.deserializeFeedback(f)),
      homeworkSubmissions: body.homeworkSubmissions.map((s) =>
        this.deserializeSubmission(s),
      ),
      assessmentResults: body.assessmentResults.map((r) => this.deserializeResult(r)),
      now: body.nowMs ? new Date(body.nowMs) : new Date(),
    });
  }

  @Post('students/:studentId/weaknesses')
  @HttpCode(HttpStatus.OK)
  identifyWeaknesses(
    @Param('studentId') _studentId: string,
    @Body() body: { profile: StudentLearningProfile },
  ): ReadonlyArray<KnowledgeMastery> {
    return this.service.identifyWeaknesses(this.deserializeProfile(body.profile));
  }

  @Post('students/:studentId/strengths')
  @HttpCode(HttpStatus.OK)
  identifyStrengths(
    @Param('studentId') _studentId: string,
    @Body() body: { profile: StudentLearningProfile },
  ): ReadonlyArray<KnowledgeMastery> {
    return this.service.identifyStrengths(this.deserializeProfile(body.profile));
  }

  // ================ /db 真存盘版 ================

  @Post('db/students/:studentId/recompute')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async recomputeInDb(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string; nowMs?: number },
  ): Promise<StudentLearningProfile> {
    return this.service.recomputeInDb(
      studentId,
      body.tenantSchema,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * Sprint B RBAC (2026-05-11 复审补): 8 role 读
   *   - teacher / academic / academic_admin / admin / boss / sales / sales_manager / sales_director
   */
  @Post('db/students/:studentId/profile')
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
  async findInDb(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<StudentLearningProfile> {
    return this.service.findInDb(studentId, body.tenantSchema);
  }

  /**
   * Sprint B RBAC (2026-05-11 复审补): 8 role 读
   *   - 通常 cron 调，HTTP endpoint 仅给运营/admin 列陈旧档案（recompute 触发用）
   */
  @Post('db/stale')
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
  async listStaleInDb(
    @Body() body: { tenantSchema: string; thresholdMs: number },
  ): Promise<StudentLearningProfile[]> {
    return this.service.listStaleInDb(body.tenantSchema, new Date(body.thresholdMs));
  }

  @Post('db/recompute-all')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async recomputeAllInDb(
    @Body() body: { tenantSchema: string; nowMs?: number },
  ): Promise<{ recomputed: number; failed: number }> {
    return this.service.recomputeAllInDb(
      body.tenantSchema,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  // -- helpers --

  private deserializeFeedback(f: LessonFeedback): LessonFeedback {
    return {
      ...f,
      submittedAt: new Date(f.submittedAt as unknown as string),
      updatedAt: new Date(f.updatedAt as unknown as string),
      parentReadAt: f.parentReadAt
        ? new Date(f.parentReadAt as unknown as string)
        : undefined,
    };
  }

  private deserializeSubmission(s: HomeworkSubmission): HomeworkSubmission {
    return {
      ...s,
      submittedAt: new Date(s.submittedAt as unknown as string),
      gradedAt: s.gradedAt ? new Date(s.gradedAt as unknown as string) : undefined,
    };
  }

  private deserializeResult(r: StudentAssessmentResult): StudentAssessmentResult {
    return {
      ...r,
      recordedAt: r.recordedAt ? new Date(r.recordedAt as unknown as string) : undefined,
    };
  }

  private deserializeProfile(p: StudentLearningProfile): StudentLearningProfile {
    return {
      ...p,
      lastUpdatedAt: new Date(p.lastUpdatedAt as unknown as string),
      knowledgeMastery: p.knowledgeMastery.map((k) => ({
        ...k,
        lastSeenAt: new Date(k.lastSeenAt as unknown as string),
      })),
      weaknessPoints: p.weaknessPoints.map((k) => ({
        ...k,
        lastSeenAt: new Date(k.lastSeenAt as unknown as string),
      })),
      strengthPoints: p.strengthPoints.map((k) => ({
        ...k,
        lastSeenAt: new Date(k.lastSeenAt as unknown as string),
      })),
    };
  }
}
