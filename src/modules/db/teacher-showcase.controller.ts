import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { TeacherShowcaseRepository, TeacherShowcaseSummary } from './teacher-showcase.repository';
import { TeacherRepository } from './teacher.repository';
import {
  TeacherShowcaseMetaRepository,
  TeacherShowcaseMeta,
  UpsertShowcaseMetaPayload,
  VideoUrlEntry,
  TestimonialEntry,
} from './teacher-showcase-meta.repository';
import { Teacher } from '../teacher/teacher.service';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { ActorRole } from './audit-log.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';

/**
 * TeacherShowcaseController — V35 老师业务展示卡数据接入（C.2 双轨数据落地）
 *
 * 来源：
 *   - 用户 2026-05-04 Phase 2 后端聚合（11 项 KPI 数据源）
 *   - V35__teacher_showcase_meta.sql 美化展示数据双轨基础设施
 *   - C.2 Sprint：showcase endpoint 响应分层 { teacher, summary, meta }
 *   - server-business-rules-validator 红线：「showcase 路由不能直接暴露真实 KPI 给家长/销售」
 *
 * 路由：
 *   GET /api/db/teachers/:id/showcase          — 三层聚合：teacher / summary / meta
 *   PUT /api/db/teachers/:id/showcase-meta     — 老师 / admin / boss 美化展示数据
 *
 * 双轨硬红线（C.2 红线 #7）：
 *   - summary 字段 = 系统真实数据（teachers + teacher_ratings + monthly_reports）
 *     → 内部 KPI / leaderboard / 工资计算专用
 *   - meta 字段 = 老师自填美化数据（teacher_showcase_meta）
 *     → 销售卡 / 家长选老师 / 老师业务卡 UI 展示专用
 *   - **绝不**把 meta 字段用于 KPI / leaderboard / 工资统计
 *
 * 字段双源 fallback（C.2 红线 #5，V35 方案 B 决策）：
 *   - meta.bio        优先 → teacher.bio (legacy) → null
 *   - meta.avatarUrl  优先 → teacher.avatar（V7 老字段，可能缺）→ null
 *
 * 鉴权：
 *   - GET：TenantScopeGuard 跨租户隔离（A01 红线）
 *   - PUT：TenantScopeGuard + RbacGuard + Roles(teacher/admin/boss)
 *     + IdempotencyInterceptor（PROD-ARCH P0 第 5 项；APP_INTERCEPTOR 已全局注册，显式标注语义）
 *
 * 注：
 *   - TODO（C.2 后续）：teacher 角色 self-check（不能改其他老师）
 *     — 当前 RbacGuard 仅检 role，未交叉验证 req.user.sub vs :id
 *     — 临时方案：admin/boss 可改任何老师；teacher 角色暂随 RbacGuard 放行（监控 audit_log）
 *     — 待 user→teacher 映射表/字段就绪后补 self-check（teachers.user_id）
 */
@UseGuards(TenantScopeGuard)
@Controller('db/teachers')
export class TeacherShowcaseController {
  constructor(
    private readonly showcaseRepo: TeacherShowcaseRepository,
    private readonly teacherRepo: TeacherRepository,
    private readonly metaRepo: TeacherShowcaseMetaRepository,
  ) {}

  // ================================================================
  // GET /api/db/teachers/:id/showcase — 三层聚合
  // ================================================================
  @Get(':id/showcase')
  async getShowcase(
    @Param('id') teacherId: string,
    @Headers('x-tenant-schema') tenantSchema: string,
  ): Promise<{
    teacher: {
      id: string;
      name: string;
      subjects: string[];
      avatar: string | null;
      bio: string | null;
    };
    summary: TeacherShowcaseSummary;
    meta: ShowcaseMetaView;
  }> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }

    // 1. 系统真实老师档案（teachers 表，V7 双轨之「真实」侧）
    const teacher = await this.teacherRepo.findById(tenantSchema, teacherId);
    if (!teacher) {
      throw new BadRequestException(`teacher ${teacherId} not found`);
    }

    // 2. 真实 KPI（teachers + teacher_ratings + monthly_reports + course_packages）
    //    供老板 dashboard / 工资 / KPI 内部统计 — 严禁裸露给家长 UI
    const summary = await this.showcaseRepo.getSummary(tenantSchema, teacherId);

    // 3. 美化展示数据（teacher_showcase_meta，V35）— 给家长/销售 UI 看
    const meta = await this.metaRepo.getMeta(tenantSchema, teacherId);

    // 4. 双源 fallback（V35 方案 B 决策）
    //    - bio: meta.bio (canonical) > teacher.bio (legacy) > null
    //    - avatar: meta.avatarUrl > teacher.avatar（V7 可能缺，安全访问）> null
    const legacyAvatar = (teacher as Teacher & { avatar?: string }).avatar ?? null;
    const teacherBio = (teacher as Teacher & { bio?: string | null }).bio ?? null;
    const resolvedBio = meta?.bio ?? teacherBio;
    const resolvedAvatar = meta?.avatarUrl ?? legacyAvatar;

    return {
      teacher: {
        id: teacher.id,
        name: teacher.name,
        subjects: [...(teacher.subjects || [])],
        avatar: resolvedAvatar,
        bio: resolvedBio,
      },
      summary,
      meta: this.viewMeta(meta),
    };
  }

  // ================================================================
  // PUT /api/db/teachers/:id/showcase-meta — 老师美化数据更新
  // ================================================================
  /**
   * 老师 / admin / boss 更新 showcase 美化数据
   *
   * 来源：用户 2026-05-10 全局规则 #3（双轨数据）+ C.2 Sprint
   *
   * Body（UpsertShowcaseMetaPayload）：
   *   avatarUrl?: string | null
   *   bio?: string | null
   *   videoUrls?: VideoUrlEntry[]
   *   testimonials?: TestimonialEntry[]
   *   displayedRecommendationsCount?: number
   *   trialAvailable?: boolean
   *
   * 行为：
   *   - 缺省字段保留旧值（COALESCE）；JSONB 字段显式传 [] 才清空
   *   - 自动 audit_log 记 before/after diff
   *   - operator = req.user.sub（用于 audit + updated_by_user_id 链路）
   *
   * 注意：IdempotencyInterceptor 已 APP_INTERCEPTOR 全局注册，显式 @UseInterceptors
   *      仅用于代码可读性 / 单元测试上下文 — 实际拦截在全局注册器
   *      （多重注册 NestJS 也会按 reflect 元数据去重，不会重复执行）
   *
   * RBAC（C.2 Sprint 范围）：
   *   - admin / boss：可改任意老师的 showcase meta
   *   - TODO（C.3+ teacher JWT role 引入后）：
   *     1. 把 'teacher' 加入 JwtPayload.TenantRole（src/modules/auth/jwt-payload.interface.ts）
   *     2. 在本 @Roles 上加 'teacher'
   *     3. 在 controller 加 self-check：req.user.sub === teachers.user_id（拒绝改他人）
   *     4. 同时 audit_log actor_role 已支持 'teacher'（V33 中已枚举）
   *   - 当前阶段：teachers 表的 user_id 字段就绪但 JWT 端尚未签发 role=teacher。
   *     admin/boss 走运管代填 showcase meta（拍板：教务/admin 全只读老师线 ≠ showcase
   *     可写：showcase meta 是「老师业务卡」非 KPI，所以 admin 可写不破坏双轨红线）。
   */
  @Put(':id/showcase-meta')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async updateShowcaseMeta(
    @Param('id') teacherId: string,
    @Headers('x-tenant-schema') tenantSchema: string,
    @Body() body: UpsertShowcaseMetaBody,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ ok: true; meta: ShowcaseMetaView }> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    if (!teacherId) {
      throw new BadRequestException('teacherId path param required');
    }

    const operatorUserId = req.user?.sub;
    if (!operatorUserId) {
      throw new BadRequestException('user sub required (auth middleware)');
    }
    // C.2: actor_role 取 JWT 实际 role（admin/boss）；C.3+ 加入 teacher 时本字段会承接
    const actorRole = (req.user?.role ?? 'admin') as ActorRole;

    // 验证 :id 是已存在的老师（避免对不存在 teacher 写入 meta 行触发外键报错）
    const teacher = await this.teacherRepo.findById(tenantSchema, teacherId);
    if (!teacher) {
      throw new BadRequestException(`teacher ${teacherId} not found`);
    }

    // 字段级业务校验（class-validator 暂未引入 controller 层；走显式 BadRequest）
    const payload = this.validateAndNormalize(body);

    const meta = await this.metaRepo.upsertMeta(
      tenantSchema,
      teacherId,
      payload,
      operatorUserId,
      {
        actorRole,
        ip: req.ip ?? null,
        userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
        requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
      },
    );

    return { ok: true, meta: this.viewMeta(meta) };
  }

  // ================================================================
  // helpers
  // ================================================================

  /**
   * 校验 + 归一化 body → UpsertShowcaseMetaPayload
   *
   * 校验规则（class-validator 替代方案 — 保持 controller 层一致风格）：
   *   - avatarUrl: string | null，长度 ≤ 1024
   *   - bio: string | null，长度 ≤ 4096
   *   - videoUrls: array，每项 { url: string ≤ 1024 }，最多 10 条
   *   - testimonials: array，每项 { anon_name, content, stars 1-5 }，最多 50 条
   *   - displayedRecommendationsCount: int ≥ 0
   *   - trialAvailable: boolean
   *
   * 严守 ValidationPipe（main.ts whitelist + forbidNonWhitelisted）已挡住
   * 多余字段；本方法只校验值域与上限
   */
  private validateAndNormalize(body: UpsertShowcaseMetaBody): UpsertShowcaseMetaPayload {
    if (body === null || body === undefined || typeof body !== 'object') {
      throw new BadRequestException('body must be object');
    }

    const out: UpsertShowcaseMetaPayload = {};

    if (body.avatarUrl !== undefined) {
      if (body.avatarUrl !== null) {
        if (typeof body.avatarUrl !== 'string' || body.avatarUrl.length > 1024) {
          throw new BadRequestException('avatarUrl must be string ≤ 1024');
        }
      }
      out.avatarUrl = body.avatarUrl;
    }
    if (body.bio !== undefined) {
      if (body.bio !== null) {
        if (typeof body.bio !== 'string' || body.bio.length > 4096) {
          throw new BadRequestException('bio must be string ≤ 4096');
        }
      }
      out.bio = body.bio;
    }
    if (body.videoUrls !== undefined) {
      if (!Array.isArray(body.videoUrls) || body.videoUrls.length > 10) {
        throw new BadRequestException('videoUrls must be array ≤ 10 items');
      }
      for (const v of body.videoUrls) {
        if (
          !v ||
          typeof v !== 'object' ||
          typeof v.url !== 'string' ||
          v.url.length === 0 ||
          v.url.length > 1024
        ) {
          throw new BadRequestException('videoUrls item must have non-empty url ≤ 1024');
        }
      }
      out.videoUrls = body.videoUrls as VideoUrlEntry[];
    }
    if (body.testimonials !== undefined) {
      if (!Array.isArray(body.testimonials) || body.testimonials.length > 50) {
        throw new BadRequestException('testimonials must be array ≤ 50 items');
      }
      for (const t of body.testimonials) {
        if (!t || typeof t !== 'object') {
          throw new BadRequestException('testimonials item must be object');
        }
        if (typeof t.anon_name !== 'string' || t.anon_name.length === 0 || t.anon_name.length > 64) {
          throw new BadRequestException('testimonials.anon_name 1-64 chars');
        }
        if (typeof t.content !== 'string' || t.content.length > 2048) {
          throw new BadRequestException('testimonials.content string ≤ 2048');
        }
        if (typeof t.stars !== 'number' || !Number.isFinite(t.stars) || t.stars < 1 || t.stars > 5) {
          throw new BadRequestException('testimonials.stars must be 1-5');
        }
      }
      out.testimonials = body.testimonials as TestimonialEntry[];
    }
    if (body.displayedRecommendationsCount !== undefined) {
      const n = body.displayedRecommendationsCount;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        throw new BadRequestException('displayedRecommendationsCount must be int ≥ 0');
      }
      out.displayedRecommendationsCount = n;
    }
    if (body.trialAvailable !== undefined) {
      if (typeof body.trialAvailable !== 'boolean') {
        throw new BadRequestException('trialAvailable must be boolean');
      }
      out.trialAvailable = body.trialAvailable;
    }

    return out;
  }

  /**
   * 把 TeacherShowcaseMeta（DB 行）归一化为对外 view（meta=null 走默认空）
   *
   * 注：meta 不存在时 → 仍返回结构化默认值，前端不必判 null
   */
  private viewMeta(meta: TeacherShowcaseMeta | null): ShowcaseMetaView {
    if (!meta) {
      return {
        avatarUrl: null,
        bio: null,
        videoUrls: [],
        testimonials: [],
        displayedRecommendationsCount: 0,
        trialAvailable: false,
        updatedAt: null,
      };
    }
    return {
      avatarUrl: meta.avatarUrl,
      bio: meta.bio,
      videoUrls: meta.videoUrls,
      testimonials: meta.testimonials,
      displayedRecommendationsCount: meta.displayedRecommendationsCount,
      trialAvailable: meta.trialAvailable,
      updatedAt: meta.updatedAt instanceof Date
        ? meta.updatedAt.toISOString()
        : (meta.updatedAt ?? null),
    };
  }
}

/**
 * 对外 meta view（防 DB schema 泄漏；teacher_id 不重复 — 已在 path :id）
 */
interface ShowcaseMetaView {
  avatarUrl: string | null;
  bio: string | null;
  videoUrls: VideoUrlEntry[];
  testimonials: TestimonialEntry[];
  displayedRecommendationsCount: number;
  trialAvailable: boolean;
  updatedAt: string | null;
}

/**
 * PUT body（class-validator 暂未在 controller 层，仅类型 + 显式校验）
 */
interface UpsertShowcaseMetaBody {
  tenantId?: string;
  avatarUrl?: string | null;
  bio?: string | null;
  videoUrls?: VideoUrlEntry[];
  testimonials?: TestimonialEntry[];
  displayedRecommendationsCount?: number;
  trialAvailable?: boolean;
}
