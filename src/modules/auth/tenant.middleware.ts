import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
  ForbiddenException,
  Optional,
  Logger,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { JwtStrategy } from './jwt.strategy';
import { ParentJwtStrategy } from './parent-jwt.strategy';
import {
  JwtPayload,
  isPlatformRole,
  AUDIENCE_B_APP,
} from './jwt-payload.interface';
import { ParentRepository } from '../db/parent.repository';
import { AuditLogRepository } from '../db/audit-log.repository';

/**
 * 租户中间件（A01 schema-per-tenant + 接口清单 V1 §6.2 网关层）
 *
 * 职责：
 *   1. 解析 Authorization: Bearer <token>
 *   2. 把 JwtPayload 挂到 req.user
 *   3. 路由分发规则（接口清单 V1 §6.2）：
 *        - /api/admin/*       强制 tenantId === null && isPlatformRole(role)
 *        - /api/checkout/*    允许游客或已支付用户（不在本中间件做校验）
 *        - /api/onboarding/*  强制已支付用户（应用层用 PaidUserGuard）
 *        - 其他 /api/*         强制 tenantId !== null，自动注入 tenant_<id> schema
 *   4. ORM session SET search_path = tenant_<tenantId>, public（在 ORM 拦截器层落地，本中间件仅设置 req 上下文）
 *
 * §0 不猜测：实际 ORM session 切换由 W1 BE-W1-4/T-W2-... 落地，当前仅做 req 注入
 *
 * 项目隔离（追加 #8）：本中间件不引用企业管理系统主项目任何 auth 实现
 *
 * SECURITY-FIX 2026-05-11 (A01-CRIT P0 Parent JWT 跨租户循环验证漏洞):
 *   - 旧 requireParentDbUser 仅信任客户端 body.tenantSchema 派生 tenantId
 *   - TenantScopeGuard 比对 body.tenantId === user.tenantId, 同源 → 循环验证失效
 *   - 修复：从 public.parent_student_bindings 查 parent 真实绑定的 tenant_id 集合
 *     客户端传入的 tenantSchema 必须落在此集合内, 否则 403 + 写 audit_log
 *   - 注：ParentRepository / AuditLogRepository 来自 @Global() DbModule，
 *     用 @Optional() 注入容错——TenantMiddleware unit test 不 import DbModule 仍可跑通
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantMiddleware.name);

  constructor(
    private readonly jwt: JwtStrategy,
    private readonly parentJwt: ParentJwtStrategy,
    @Optional() private readonly parentRepo?: ParentRepository,
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    // 用 originalUrl 而非 req.path：NestJS setGlobalPrefix('api') 后，全局 middleware
    // 在路由解析前执行；req.path 在某些 Express 内部路由层可能去掉 prefix。
    // originalUrl 保留 ?query，需先去 query 段再做前缀匹配。
    // 实测发现：req.path 在 setGlobalPrefix + middleware('*') 组合下不可靠。
    const fullUrl = req.originalUrl || req.url || req.path || '';
    const path = fullUrl.split('?')[0];

    // 公开成交链路：游客可访问，仅在已登录时挂用户
    if (path.startsWith('/api/public/') || path.startsWith('/api/checkout/')) {
      await this.tryAttachUser(req);
      return next();
    }

    // BUGFIX 2026-05-10: parents/register 是公开端点（家长首次注册无 token）
    // 之前被错误划入"必须有 token"分支，导致小程序 c/auth/login 永远 401
    if (
      path === '/api/parents/register' ||
      path === '/api/parents/db/register'
    ) {
      await this.tryAttachUser(req);
      return next();
    }

    // C 端家长路径：接受 ParentJwt 或 TenantJwt（联调期间双轨容错）
    // /api/parents/* 和 /api/parent-subscriptions/*
    // 真实 production 应严格按 ParentJwt（条目 34 Q-FE-2）
    if (
      path.startsWith('/api/parents/') ||
      path.startsWith('/api/parent-subscriptions/')
    ) {
      await this.requireParentOrTenantUser(req);
      return next();
    }

    if (this.isParentDbPath(path)) {
      // SECURITY-FIX 2026-05-11: 改为 async — 必须查 DB 校验 parent x tenant 真实绑定关系
      await this.requireParentDbUser(req);
      return next();
    }

    // 平台超管路径：必须无租户 + 平台角色
    if (path.startsWith('/api/admin/')) {
      const user = await this.requireUser(req);
      if (user.tenantId !== null) {
        throw new UnauthorizedException('admin path requires tenantId=null');
      }
      if (!isPlatformRole(user.role)) {
        throw new UnauthorizedException('admin path requires platform role');
      }
      return next();
    }

    // 开通向导：必须已登录（已支付用户在应用层 PaidUserGuard 校验）
    if (path.startsWith('/api/onboarding/')) {
      await this.requireUser(req);
      return next();
    }

    // 其他业务接口：必须已登录 + 有租户
    const user = await this.requireUser(req);
    if (!user.tenantId) {
      throw new UnauthorizedException('tenant context required');
    }

    // ORM session search_path 切换由 ORM 拦截器层落地（BE-W1-4），此处仅记录上下文
    // 2026-05-23 P1-T7 修：tenant_id 是 UPPERCASE（public.tenants.id），但 schema 名是 lowercase
    //   之前 backfill bug 漏 toLowerCase → PgPoolService.tenantQuery regex 拒 + 全 endpoint 500
    const tenantSchema = `tenant_${user.tenantId.toLowerCase()}`;
    (req as RequestWithTenant).tenantSchema = tenantSchema;
    // P1-T7 (2026-05-23) header-only 兼容：把解析的 tenantSchema backfill 到 query + body
    //   让现有 controller `@Query('tenantSchema')` + `@Body() body.tenantSchema` 透明兼容 header-only
    //   bGet/bPost 注入 header x-tenant-schema → middleware 解析后回填 query/body → controller 0 改
    //   规范：docs/API-接口参数规范-2026-05-23.md §2.1 唯一允许位置 header
    //   兼容期：controller 渐进迁移到 @Req req.tenantSchema 后可删本逻辑（推 Sprint Y）
    this.backfillTenantSchemaToReq(req, tenantSchema);
    next();
  }

  private backfillTenantSchemaToReq(req: Request, schema: string): void {
    if (req.query && typeof req.query === 'object' && !(req.query as any).tenantSchema) {
      (req.query as any).tenantSchema = schema;
    }
    if (req.body && typeof req.body === 'object' && !(req.body as any).tenantSchema) {
      (req.body as any).tenantSchema = schema;
    }
  }

  // SPRINT-E.1(2026-05-13): tryAttachUser / requireUser / requireParentOrTenantUser
  // 改为 async（jwt.parse 由 sync → async：支持 jti 黑名单 Redis 查询）
  private async tryAttachUser(req: Request): Promise<void> {
    const token = this.extractToken(req);
    if (!token) return;
    try {
      (req as RequestWithUser).user = await this.jwt.parse(token);
    } catch {
      // 公开路径忽略 token 错误
    }
  }

  private async requireUser(req: Request): Promise<JwtPayload> {
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException('Missing Authorization header');
    const user = await this.jwt.parse(token);
    (req as RequestWithUser).user = user;
    return user;
  }

  /**
   * Q-FE-2: 接受 ParentJwt 或 TenantJwt（双轨容错）
   * 优先尝试 ParentJwt（type='parent'）；失败 → 退回 TenantJwt
   *
   * T6b (2026-05-16) SECURITY-FIX：fallback 收紧
   *   原 catch 块吞所有错误 → B 端 admin/boss JWT (aud='b-app') 走 /api/parents/** 时
   *   parentJwt.parse 抛 'audience mismatch' / 'Token type mismatch' 被 catch 吞 →
   *   fallback 到 jwt.parse 把 B 端 token 当合法用户挂上 → 越权进入 C 端 endpoint.
   *
   *   修复（覆盖 parent-jwt.strategy 当前校验顺序：type 先于 aud）：
   *     1. 'audience mismatch' rethrow（少数情况：未来 strategy 调整顺序）
   *     2. peek 无签名解码 aud === 'b-app' → 显式 401（覆盖 strategy 当前 type 先抛）
   *     3. 其他（旧 token 无 aud / 无 type）保留 fallback 兼容
   */
  private async requireParentOrTenantUser(req: Request): Promise<void> {
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException('Missing Authorization header');
    try {
      const parent = this.parentJwt.parse(token);
      (req as RequestWithUser & { parent?: any }).parent = parent;
      return;
    } catch (e) {
      // T6b ①: audience mismatch 表示 B 端 token 强行走 parent 路径 → 拒绝 fallback
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes('audience mismatch')) {
        throw e instanceof UnauthorizedException
          ? e
          : new UnauthorizedException(msg);
      }
      // T6b ②: parent-jwt.strategy 当前 type 校验早于 aud 校验, B 端 token
      // 因 type!='parent' 先抛 → audience mismatch 没机会运行.
      // 用无签名解码 peek aud='b-app' 显式拒绝, 防 B 端 admin/boss JWT 走 parent 路径.
      if (this.peekTokenAud(token) === AUDIENCE_B_APP) {
        throw new UnauthorizedException(
          `B-app token cannot be used on parent path (aud=${AUDIENCE_B_APP})`,
        );
      }
      // T6b ③: 其他错误（旧 token 无 type / 无 aud）保留 fallback 兼容
    }
    const user = await this.jwt.parse(token);
    (req as RequestWithUser).user = user;
  }

  /**
   * T6b: 无签名解码 JWT payload, 仅读 aud 用于路由决策.
   * 无签名验证 → 不可用于鉴权; 仅"看起来像 B 端 token 就不走 parent 分支"的预判.
   * 真正鉴权由 jwt.parse / parentJwt.parse 兜底.
   */
  private peekTokenAud(token: string): string | undefined {
    try {
      const parts = token.split('.');
      if (parts.length < 2) return undefined;
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8'),
      );
      return typeof payload.aud === 'string' ? payload.aud : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * C 端页面复用部分 tenant DB 查询：家长 token 本身不带 tenantId，
   * 因此通过绑定二维码/孩子档案保存的 tenantSchema 限定 schema。
   *
   * SECURITY-FIX 2026-05-11 (A01-CRIT P0):
   *   旧实现仅信任客户端 body.tenantSchema 派生 tenantId 挂到 req.user.tenantId,
   *   导致 TenantScopeGuard 比对 body.tenantId === user.tenantId 循环验证失效.
   *
   *   攻击场景:
   *     家长 P 持合法 ParentJwt, 但 P 仅订阅 tenant A;
   *     P 可调用 POST /api/db/students/STU_OF_B/monthly-reports
   *     { tenantSchema: 'tenant_b' }, 旧逻辑放行 → 越权读 tenant B 数据.
   *
   *   修复:
   *     1. 从 ParentJwt 拿 parentId (token 签名验证保证真实身份)
   *     2. 从客户端拿 body.tenantSchema (允许传, 因 c 端要切租户)
   *     3. 查 public.parent_student_bindings WHERE parent_id=? AND binding_status='active'
   *        拿到该 parent 真实绑定的 tenant_id 集合 (跨机构家长共享支持多个)
   *     4. 派生的 tenantId 必须落在此集合内, 否则 403 + audit_log
   *
   *   方案 (选项 C 通过孩子关系反查):
   *     - 选项 A (parent_bindings 表) — 不存在, 命名是 parent_student_bindings
   *     - 选项 B (parent_subscriptions) — 跨机构家长共享 1 笔订阅, 但订阅本身不含 tenant_id
   *       (V10 §5.1 拍板: parent_subscriptions 表 unique by parent_id, 无 tenant_id 列),
   *       所以订阅状态无法直接给"该家长能访问哪些 tenant"的答案
   *     - 选项 C (parent_student_bindings) — ✅ 选定:
   *       该表 (id, parent_id, student_id, tenant_id, binding_status) 明确告知
   *       "parent X 在 tenant Y 内绑了哪个 student". 这是数据级 ground truth.
   *
   *   边界:
   *     - parent role 但客户端没传 tenantSchema → 401 (旧行为保留)
   *     - parent role + 无任何 active binding → 403 (没绑过任何孩子, 无 tenant 权限)
   *     - ParentRepository 未注入 (test 模式) → fallback 旧行为 + WARN log
   *       (生产环境 DbModule @Global 必定注入, 此路径不会走到)
   */
  private async requireParentDbUser(req: Request): Promise<void> {
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException('Missing Authorization header');

    // 1. 解析 ParentJwt (token 签名是真实身份证明)
    let parent: { parentId: string };
    try {
      parent = this.parentJwt.parse(token);
    } catch (e) {
      if (e instanceof UnauthorizedException) {
        // 不是 parent token, 尝试 B 端 TenantJwt 兜底 (legacy 兼容)
        const user = await this.jwt.parse(token);
        (req as RequestWithUser).user = user;
        return;
      }
      throw e;
    }

    // 2026-05-23 P0 C 端 tenant context 桥梁:
    //   /api/c/tenant-contexts 是「选 tenant 之前」的 endpoint
    //   — parent 登录后还没选 tenant，没法传 x-tenant-schema header
    //   → 走白名单豁免: 仅校验 parent JWT, 不要求 tenantSchema, 不查 binding
    //   端点本身在 c-side.controller.getTenantContexts 内查 parent_student_bindings
    //   严格用 req.parent.parentId 反查并返结果, 不暴露任何跨 parent 数据.
    //
    //   安全性: 必须 startsWith 精确匹配该路径; 不允许前缀通配 (防止
    //   /api/c/tenant-contexts-xxx 之类的衍生路径意外豁免).
    //   path 来源是 originalUrl 已去 query 段 (中间件主流程 L59-62 已处理).
    const fullUrl = req.originalUrl || req.url || '';
    const reqPath = fullUrl.split('?')[0];
    if (
      reqPath === '/api/c/tenant-contexts' ||
      reqPath === '/c/tenant-contexts' /* test 环境无 setGlobalPrefix('api') 时 */
    ) {
      // 仅挂 parent context, 不挂 tenantId / tenantSchema (端点自己聚合多 tenant 视图)
      this.attachParentUser(req, parent.parentId, null, null);
      return;
    }

    // 2. 客户端必须传 tenantSchema (c 端切租户标识)
    const schema = this.extractTenantSchema(req);
    if (!schema) {
      throw new UnauthorizedException(
        'x-tenant-schema or body.tenantSchema required for parent c-side',
      );
    }
    const requestedTenantId = schema.replace(/^tenant_/, '');

    // 3. 查 DB 校验 parent x tenant 真实绑定关系
    //    若 ParentRepository 未注入 (test 模式) 走 fail-open 路径并 WARN
    if (!this.parentRepo) {
      this.logger.warn(
        `[A01-FALLBACK] ParentRepository not injected, skipping cross-tenant check ` +
          `(parent=${parent.parentId} requestedTenant=${requestedTenantId}). ` +
          `生产环境此路径不应触发 — DbModule @Global 必定注入.`,
      );
      this.attachParentUser(req, parent.parentId, requestedTenantId, schema);
      return;
    }

    let bindings: Array<{ tenantId: string; bindingStatus: string }>;
    try {
      bindings = await this.parentRepo.findChildrenByParent(parent.parentId);
    } catch (e) {
      // DB 异常 → 不放行 (fail-close on critical security path).
      // 注: 这与生产架构其他模块"fail-open"哲学不同, 此处是跨租户隔离硬红线
      this.logger.error(
        `[A01-DB-ERROR] parent_student_bindings 查询失败, 拒绝放行: ` +
          `parent=${parent.parentId} tenant=${requestedTenantId} err=${
            e instanceof Error ? e.message : String(e)
          }`,
      );
      throw new ForbiddenException(
        'parent x tenant 绑定关系校验失败 (db error), 请重试',
      );
    }

    const allowedTenantIds = new Set(
      bindings
        .filter((b) => b.bindingStatus === 'active')
        .map((b) => b.tenantId.toLowerCase()),
    );

    if (!allowedTenantIds.has(requestedTenantId.toLowerCase())) {
      // 越权: parent 没绑过该 tenant 的任何 student
      // 写 audit_log 留证据 (fail-open: audit_log 写失败不阻塞 403)
      // 注: audit_log 写到 parent 已绑定的第一个 tenant schema (parent 至少绑过 1 个);
      // 若 parent 一个 tenant 都没绑 → 不写 audit_log (没有任何合法 schema 可写)
      if (this.auditLog && allowedTenantIds.size > 0) {
        const auditSchema = `tenant_${Array.from(allowedTenantIds)[0]}`;
        try {
          await this.auditLog.log(auditSchema, {
            actorUserId: parent.parentId,
            actorRole: 'parent',
            action: 'parent.cross-tenant-denied',
            targetType: 'tenant',
            targetId: requestedTenantId,
            before: null,
            after: {
              requestedTenant: requestedTenantId,
              allowedTenants: Array.from(allowedTenantIds),
              path: req.originalUrl || req.url,
            },
            ip: req.ip ?? null,
            userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
            requestId:
              (req.headers?.['x-request-id'] as string | undefined) ?? null,
          });
        } catch {
          // audit_log 失败不阻塞主拒绝路径
        }
      }
      this.logger.warn(
        `[A01-CROSS-TENANT-DENIED] parent=${parent.parentId} tried tenant=${requestedTenantId} ` +
          `but only bound to [${Array.from(allowedTenantIds).join(',')}] ` +
          `on ${req.method} ${req.originalUrl || req.url}`,
      );
      // P1-1 (2026-05-23): HTTP 403 body 不暴露内部 ULID 标识符 (OWASP A05)
      //   完整 parentId / tenantId / allowedTenants 已在上方 pino warn + audit_log 落盘 (server-side only)
      throw new ForbiddenException('PARENT_NOT_BOUND_TO_TENANT');
    }

    // 4. 校验通过 → 挂上下文
    this.attachParentUser(req, parent.parentId, requestedTenantId, schema);
  }

  /**
   * 把 parent 信息挂到 req (供 controller / guard 后续用)
   * 与旧行为兼容: req.user 含 sub=parentId / tenantId / role='parent' / campusId=null
   *
   * 2026-05-23 P0 C 端 tenant context 桥梁:
   *   tenantId / schema 允许 null — 用于 /api/c/tenant-contexts 白名单分支
   *   (parent 已认证但还没选 tenant). controller 自己用 req.parent.parentId
   *   反查 binding 列表, 不依赖 req.tenantSchema.
   */
  private attachParentUser(
    req: Request,
    parentId: string,
    tenantId: string | null,
    schema: string | null,
  ): void {
    (req as RequestWithUser).user = {
      sub: parentId,
      tenantId: tenantId as any, // JwtPayload.tenantId 是 string | null 形态
      role: 'parent' as any,
      campusId: null,
    };
    // V36 双轨 audience 守护: 让 controller 通过 req.parent 识别 c 端 JWT 流
    (req as RequestWithUser & { parent?: any }).parent = {
      sub: parentId,
      parentId,
      role: 'parent',
    };
    if (schema) {
      (req as RequestWithTenant).tenantSchema = schema;
      // P1-T7 (2026-05-23) header-only 兼容：c-side parent 路径同步 backfill query + body
      this.backfillTenantSchemaToReq(req, schema);
    }
  }

  /**
   * 判定路径是否走"C 端家长 / 双轨容错"分发分支
   *
   * 设计意图：
   *   - 家长 c 端要看孩子反馈、月报、请假、推荐等，但家长 JWT 不带 tenantId
   *   - 这类路径走 requireParentDbUser → 从 body.tenantSchema 派生 tenantId
   *     + 用 parent_student_bindings 真实绑定关系校验（A01-CRIT 修复）
   *
   * Sprint B (2026-05-11) 复审修复：
   *   - 旧实现 `/api/db/lesson-feedbacks/` 全前缀匹配会误覆盖未来新增的 cron/admin endpoint
   *   - `/api/db/monthly-reports/` 旧实现已用精确正则白名单
   *   - 本次（2026-05-11 二轮复审）把所有 parent 路径都改为精确正则白名单：
   *       - lesson-feedbacks/:id/find       — parent 读反馈
   *       - lesson-feedbacks/:id/parent-read — parent 打"已读"
   *     而 lesson-feedbacks/POST（提交反馈）/ :id/update 等走 B 端 TenantJwt
   *   - leaves / recommendations / referrals / course-balance / homework 同步收窄
   *
   * 注：generate / pending-finalize / :id/finalize（老师视角）仍走 B 端常规分发
   */
  private isParentDbPath(path: string): boolean {
    const parentStudentPath =
      /^\/api\/db\/students\/[^/]+\/(feedbacks|monthly-reports)$/.test(path) ||
      /^\/api\/db\/students\/[^/]+\/leaves\/list$/.test(path);

    // monthly-reports 路径白名单（仅 parent 实际访问的 endpoint）
    //   - /:id/find        — c 端家长读月报（parent JWT 主路径，audience='parent' 自动遮蔽）
    //   - /:id/parent-read — c 端家长打"已读"标记
    // 不含：generate / pending-finalize / :id/finalize / :id/finalize-parent — 走 B 端
    const parentMonthlyReportPath =
      /^\/api\/db\/monthly-reports\/[^/]+\/(find|parent-read)$/.test(path);

    // Sprint B 复审：lesson-feedbacks 精确正则（仅 parent 实际访问的 endpoint）
    //   - /:id/find        — c 端家长读反馈
    //   - /:id/parent-read — c 端家长打"已读"标记
    // 不含：POST / :id/update — 老师写反馈（走 B 端 TenantJwt）
    const parentLessonFeedbackPath =
      /^\/api\/db\/lesson-feedbacks\/[^/]+\/(find|parent-read)$/.test(path);

    // Sprint B 复审：leaves 精确正则
    //   - POST /api/db/leaves                 — 家长提交请假（c 端主入口）
    //   - POST /api/db/leaves/:id/approve     — admin / boss 走 B 端，不走 parent 分支
    //   - POST /api/db/leaves/:id/reject      — 同上
    //   - POST /api/db/students/:sid/leaves/list — 已在 parentStudentPath 覆盖
    // 仅 POST /api/db/leaves（家长提交）走 parent 分支：
    const parentLeavesPath = path === '/api/db/leaves';

    // Sprint B 复审：recommendations / referrals 精确收窄（家长是主调用方）
    //   - recommendations: 家长看老师推荐列表 / 申请推荐
    //   - referrals: 家长推介好友（c 端主入口）
    //   仍允许前缀但语义已收窄（无其他 admin/boss 路径用此前缀）
    const parentRecommendationsPath = /^\/api\/db\/recommendations(\/|$)/.test(path);
    const parentReferralsPath = /^\/api\/db\/referrals(\/|$)/.test(path);

    // Sprint B 复审：course-balance 仅 students 子路径走 parent
    //   - /api/course-balance/db/students/:sid/* — 家长看孩子余额（c 端主入口）
    //   - /api/course-balance/db/admin/* — admin 走 B 端，不走 parent 分支
    const parentCourseBalancePath =
      /^\/api\/course-balance\/db\/students\/[^/]+(\/|$)/.test(path);

    // Sprint B 复审：homework
    //   - /api/homework/db/submissions       — 家长代提交作业（c 端入口）
    //   - /api/homework/db/students/:sid/*   — 家长看孩子作业列表
    const parentHomeworkSubmissionsPath = path === '/api/homework/db/submissions';
    const parentHomeworkStudentsPath = /^\/api\/homework\/db\/students\/[^/]+(\/|$)/.test(path);

    // P4-Y (2026-05-20): C 端 4 新 endpoint
    //   - POST /api/db/teacher-ratings — 家长评老师
    //   - GET  /api/c/home — 家长 home 聚合
    //   - GET  /api/c/students/:studentId/profile — C 端学员档案
    //   - GET  /api/c/messages — C 端消息中心
    //   - PATCH /api/c/messages/:id/mark-read — 标记已读
    const parentTeacherRatingPath = path === '/api/db/teacher-ratings';
    // /api/c/* 路径全量走 parent 分支（c-side controller 都是家长视角）
    const parentCSidePath = /^\/api\/c\//.test(path);

    return (
      parentStudentPath ||
      parentMonthlyReportPath ||
      parentLessonFeedbackPath ||
      parentLeavesPath ||
      parentRecommendationsPath ||
      parentReferralsPath ||
      parentCourseBalancePath ||
      parentHomeworkSubmissionsPath ||
      parentHomeworkStudentsPath ||
      parentTeacherRatingPath ||
      parentCSidePath
    );
  }

  private extractTenantSchema(req: Request): string {
    // P0 真生产 bug 修 (5/20)：c-side 4 page (c/home, c/messages, c/student-profile,
    //   c/rate-teacher) 用 query string `?tenantSchema=` 传，middleware 之前只看 header/body
    //   → 全 401 'invalid tenant schema'。补查 query string 让 c-side 用 GET + query 也能通。
    // 三处来源（优先级 header > body > query），任一命中即通过。
    const queryFromUrl = ((): string => {
      const url = req.originalUrl || req.url || '';
      const m = url.match(/[?&]tenantSchema=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    })();
    const raw = String(
      req.headers['x-tenant-schema'] || req.body?.tenantSchema || queryFromUrl || '',
    );
    if (!/^tenant_[a-z0-9]+$/.test(raw)) {
      throw new UnauthorizedException('invalid tenant schema');
    }
    return raw;
  }

  private extractToken(req: Request): string | null {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return null;
    return auth.substring('Bearer '.length).trim() || null;
  }
}

interface RequestWithUser extends Request {
  user?: JwtPayload;
}

interface RequestWithTenant extends RequestWithUser {
  tenantSchema?: string;
}
