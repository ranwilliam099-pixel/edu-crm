import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Optional,
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
import { ActorRole, AuditLogRepository } from './audit-log.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
// Sprint B.3 (2026-05-11): showcase 双轨硬红线
//   - summary（系统真实 KPI）→ 仅 admin/boss/academic/teacher 自己可看
//   - meta（美化展示）→ 全角色可看（包括 sales / parent，因为是宣传卡）
//   - sales/parent/sales_manager 调 → summary 自动遮蔽（returnEmptySummary）— 5/15 A-2 删 sales_director
// 注：Sprint B.3 复审 — 不再用 actorGroupOf（sales_manager 归 admin group，但 KPI 拍板要求遮蔽）
//     改用 raw role 显式判定，保持 actorGroupOf 在 customer/contract 模块的收口语义

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
    // Sprint B (2026-05-11 复审): self-check 失败时写 audit_log
    //   - @Optional：unit spec 直接 new 时可传 undefined（不破坏现有 spec test）
    //   - fail-open：audit_log 写失败不阻塞主 ForbiddenException
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  // ================================================================
  // GET /api/db/teachers/:id/showcase — 三层聚合
  // ================================================================
  /**
   * Sprint B RBAC (2026-05-11 复审补 — 选项 C):
   *   - 单 endpoint + RbacGuard + 8 role (B 端全角色)
   *   - parent 走独立 c 端 endpoint (parent JWT 流), 不访问此 B 端 path
   *   - 老师线 / 销售线 / 管理类都可看老师业务展示卡
   *   - 双轨硬红线：summary 字段是真实 KPI（仅 admin/boss/academic/校长/老师自己有意义）
   *     但 service 层暂未做字段级过滤 — sales 可看到完整 summary（待 Sprint D RoleFieldFilter 收尾）
   */
  @Get(':teacherId/showcase')
  @UseGuards(RbacGuard)
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
  async getShowcase(
    @Param('teacherId') teacherId: string,
    @Headers('x-tenant-schema') tenantSchema: string,
    @Req() req?: AuthenticatedRequest,
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

    // Sprint B.3 双轨硬红线 (2026-05-11)：
    //   - 真实 KPI summary 仅 admin/boss/academic/teacher 自己（拍板「相关角色可见」）
    //   - 销售/家长 → summary 自动遮蔽（return empty summary，不抛 403）
    //   - 教师自己 (teacher.userId === req.user.sub) → summary 可见（自己看自己 KPI）
    //   - 其他 teacher 看别人的 summary → 走 teacher 互看 path（仅 admin path 全可看）
    //   - meta 字段不限制（业务展示卡本来就是宣传）
    //
    // Sprint B.3 复审 (2026-05-11) 修 5：拍板边界 — KPI summary ≠ customer/contract
    //   - actorGroupOf 把 sales_manager 归 admin（customer/contract 收口拍板 ✅）
    //   - 但 teacher KPI summary 拍板「销售看 showcase = 美化数据」
    //     → sales_manager 也走 emptySummary（5/15 A-2 删 sales_director）
    //   - 实现：显式检测 raw role 而非 group（保持 actorGroupOf 在其他模块的语义）
    const role = req?.user?.role;
    const isRealAdmin = role === 'admin' || role === 'boss';
    const isAcademic = role === 'academic' || role === 'academic_admin';
    const isSelf =
      role === 'teacher' &&
      teacher.userId &&
      teacher.userId === req?.user?.sub;
    // sales / sales_manager / marketing / hr / finance / parent / teacher(看别人)
    //   → 全部走 emptySummary（销售线不看真实 KPI；拍板「美化数据 only」）
    //   5/15 A-2 删 sales_director（落入 unknown group → 也不可见）
    const canSeeSummary = isRealAdmin || isAcademic || isSelf;
    const finalSummary: TeacherShowcaseSummary = canSeeSummary
      ? summary
      : this.emptySummary(summary);

    return {
      teacher: {
        id: teacher.id,
        name: teacher.name,
        subjects: [...(teacher.subjects || [])],
        avatar: resolvedAvatar,
        bio: resolvedBio,
      },
      summary: finalSummary,
      meta: this.viewMeta(meta),
    };
  }

  /**
   * Sprint B.3：销售/家长视角的 summary 遮蔽
   *
   * 真实 KPI（totalLessons / avgStars / renewalRate 等）对销售/家长不可见，
   * 防止销售对客户夸大宣传"老师 5 星好评 92%" 等真实数据。
   *
   * 返回值字段保持（不删 key，前端类型不破），但数值清零：
   *   - 数值字段 → 0
   *   - 数组字段 → []
   *   - 布尔 → 默认值（isColdStart=true 表示"冷启动无数据"，UI 友好显示）
   */
  private emptySummary(original: TeacherShowcaseSummary): TeacherShowcaseSummary {
    return {
      ...original,
      totalLessons: 0,
      totalStudents: 0,
      activeStudents: 0,
      monthlyLessons: 0,
      avgStars: null,
      ratingCount: 0,
      recommendRate: null,
      topTags: [],
      renewalRate: null,
      monthlyAReportRate: null,
      cases: [],
      isColdStart: true,
    };
  }

  // ================================================================
  // PUT /api/db/teachers/:id/showcase-meta — 老师美化数据更新
  // ================================================================
  /**
   * 老师 / admin / boss 更新 showcase 美化数据
   *
   * 来源：用户 2026-05-10 全局规则 #3（双轨数据）+ C.2 Sprint + Sprint B 2026-05-11
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
   * RBAC (Sprint B 2026-05-11 落地)：
   *   - admin / boss：可改任意老师的 showcase meta（拍板「老板校长 ✅ 全权」）
   *   - teacher: 只能改自己 — req.user.sub === teachers.user_id WHERE teachers.id = :id
   *     （即 self-check：req.user.sub 反查 teacher.userId，比对 :id）
   *   - 其他 role: RbacGuard 拒绝
   *   - audit_log actor_role: 透传 JWT 实际 role（admin / boss / teacher）
   */
  @Put(':teacherId/showcase-meta')
  @UseGuards(RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async updateShowcaseMeta(
    @Param('teacherId') teacherId: string,
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
    // Sprint B: actor_role 取 JWT 实际 role（admin/boss/teacher）— V33 已枚举三者
    const actorRole = (req.user?.role ?? 'admin') as ActorRole;

    // 验证 :id 是已存在的老师（避免对不存在 teacher 写入 meta 行触发外键报错）
    const teacher = await this.teacherRepo.findById(tenantSchema, teacherId);
    if (!teacher) {
      throw new BadRequestException(`teacher ${teacherId} not found`);
    }

    // Sprint B self-check: teacher role 只能改自己
    //   - admin / boss: 跳过 self-check
    //   - teacher: teacher.userId 必须 === req.user.sub
    //     （teacher.userId 缺失 → 视为未绑定用户账号 → 拒绝；不能让"无人认领"的档案被任意人改）
    //
    // Sprint B 复审 (2026-05-11): self-check 失败前写 audit_log（fail-open）
    if (req.user?.role === 'teacher') {
      if (!teacher.userId || teacher.userId !== operatorUserId) {
        // audit_log 失败不阻塞 ForbiddenException
        try {
          await this.auditLog?.log(tenantSchema, {
            actorUserId: operatorUserId,
            actorRole: 'teacher',
            action: 'teacher.self-check-failed',
            targetType: 'teacher_showcase_meta',
            targetId: teacherId,
            before: null,
            after: {
              attempted_teacher_id: teacherId,
              bound_user_id: teacher.userId ?? null,
              own_user_id: operatorUserId,
            },
            ip: req.ip ?? null,
            userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
            requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
          });
        } catch {
          // audit fail-open
        }
        throw new ForbiddenException(
          `teacher self-check: teacher ${teacherId} bound to user=${teacher.userId ?? '(null)'} ` +
            `but req.user.sub=${operatorUserId} — 拒绝改他人 showcase`,
        );
      }
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
