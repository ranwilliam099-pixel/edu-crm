import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ParentRepository } from '../db/parent.repository';
import { Parent } from '../parent/parent.service';
import { ParentSelfGuard } from '../auth/parent-self.guard';
import { AuditLogRepository, normalizeActorRole } from '../db/audit-log.repository';
import {
  CSideRepository,
  ChildBrief,
  MessageItem,
  MessageType,
  TodayLesson,
  UnreadCount,
} from './c-side.repository';
// 2026-05-22 波 C: 家长 C 端「待我决定老师变更」endpoint (SSOT §6.5 闭环)
import { TeacherChangeRequestService } from '../db/teacher-change-request.service';
// 2026-05-23 P0 T1: tenant-contexts endpoint 反查 public.tenants 拿 tenant.name
import { PgPoolService } from '../db/pg-pool.service';
// 2026-05-25 #4 闭环: C 端家长「我的请假」多孩聚合 endpoint
import { LeaveRepository, Leave } from '../db/leave.repository';

/**
 * CSideController — P4-Y 2026-05-20 C 端家长聚合 endpoint
 *
 * 路由前缀：/api/c
 *
 * 路径分发：
 *   GET   /api/c/home                                 家长 home 一站式聚合
 *   GET   /api/c/students/:studentId/profile          C 端学员档案（家长视角脱敏）
 *   GET   /api/c/messages                             消息中心（feedback + monthly-report）
 *   PATCH /api/c/messages/:id/mark-read               标记单条消息已读（需 ?type=feedback|monthly-report）
 *
 * RBAC 双层守护：
 *   1. tenant.middleware.requireParentDbUser（parent_student_bindings 实绑校验）已挂 req.parent + req.tenantSchema
 *      → 跨 tenant 攻击早被中间件拦截
 *   2. 本 controller 用 req.parent.sub 反查 binding 列表 → 仅返绑定 student 的数据（family-owner scope）
 *      profile endpoint 额外校验 studentId 必须在当前 tenant 的 active binding 内
 *
 * 不挂 TenantScopeGuard：
 *   - parent JWT 不带 tenantId（跨机构身份），TenantScopeGuard 比对 user.tenantId 不适用
 *   - tenant.middleware 已校验 binding × tenant 真实关系 → 已挂 req.tenantSchema
 *
 * ParentSelfGuard class-level：
 *   - 仅守 :parentId path param，本 controller 无此参数 → guard 跳过
 *   - 留作未来如有 /api/c/parents/:parentId/... 时自动生效
 *
 * 限流：60 req/min（覆盖全局 default 60/min，与默认对齐）
 */

interface ParentRequest {
  parent?: { sub?: string; parentId?: string; role?: string };
  tenantSchema?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  originalUrl?: string;
  url?: string;
  method?: string;
}

// P0 真生产 bug 修 (5/20): c-side read 严格 Crockford32 (排除 I/L/O/U) 与
// student.controller create 校验 (仅 length=32) 不一致 → 历史含 I/L/O/U 的 ID 被拒
// 修复: 放宽到 alphanumeric (与 create 一致)，PG 参数化查询防 SQL injection
const ULID_PATTERN = /^[0-9A-Z]{32}$/i;

@Controller('c')
@UseGuards(ParentSelfGuard)
export class CSideController {
  private readonly logger = new Logger(CSideController.name);

  constructor(
    private readonly cside: CSideRepository,
    private readonly parentRepo: ParentRepository,
    @Optional() private readonly auditLog?: AuditLogRepository,
    // 2026-05-22 波 C: 家长「待我决定老师变更」endpoint (SSOT §6.5 闭环)
    @Optional() private readonly tcrService?: TeacherChangeRequestService,
    // 2026-05-23 P0 T1: tenant-contexts endpoint 反查 public.tenants 拿 tenant.name
    //   PgPoolService 是 @Global DbModule 提供, c-side module 不显式 import 也可注入.
    //   Optional 容错: spec 没 mock PG 时跳过 tenant 名查询走 fallback string.
    @Optional() private readonly pg?: PgPoolService,
    // 2026-05-25 #4: C 端「我的请假」多孩聚合 endpoint (GET /api/c/leaves)
    //   Optional 容错: 现有 spec 没 mock leaveRepo 时 endpoint 注入 undefined → 调用时报错
    //   生产 module 必须 providers 注册 LeaveRepository
    @Optional() private readonly leaveRepo?: LeaveRepository,
  ) {}

  /**
   * 2026-05-23 P0 GET /api/c/tenant-contexts — C 端「选 tenant」桥梁
   *
   * 背景：parent JWT 不带 tenantId (跨机构身份), 但 C 端业务接口要 tenantSchema
   *   → parent 登录后必须先「选 tenant」, 此 endpoint 返绑定的所有 tenant + 每 tenant 内的孩子
   *
   * 白名单豁免（tenant.middleware.requireParentDbUser）：
   *   此 path 命中精确匹配 → 仅校验 parent JWT 不要求 tenantSchema
   *   端点内严格用 req.parent.parentId 反查, 不读 client 传入的任何 tenant 信息.
   *
   * Response 形态:
   *   {
   *     contexts: [
   *       {
   *         tenantId, tenantName,
   *         children: [{
   *           studentId, studentName, campusId, campusName,
   *           bindingStatus: 'active', isPrimary
   *         }]
   *       }
   *     ]
   *   }
   *
   * 安全（fail-close on cross-tenant exposure）:
   *   - parentRepo.findChildrenByParent 已用 WHERE parent_id=$1 AND binding_status='active'
   *     PG 参数化查询防 SQL injection, 跨 parent 物理隔离
   *   - cside.findChildrenByIds 按 studentIds + tenantSchema 双重 scope, 跨 tenant 不可能命中
   *   - 任何子任务 reject → throw, 不 swallow (parent 看到 500 比看到部分数据更安全)
   */
  @Get('tenant-contexts')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async getTenantContexts(@Req() req: ParentRequest): Promise<{
    contexts: Array<{
      tenantId: string;
      tenantName: string;
      children: Array<{
        studentId: string;
        studentName: string;
        campusId: string | null;
        campusName: string | null;
        bindingStatus: 'active';
        isPrimary: boolean;
      }>;
    }>;
  }> {
    // 1. parent JWT 已挂上 (middleware 白名单豁免分支)
    const parentId = req.parent?.parentId || req.parent?.sub;
    if (!parentId) throw new ForbiddenException('parent JWT required');

    // 2. 反查 binding (仓库已过滤 binding_status='active')
    const bindings = await this.parentRepo.findChildrenByParent(parentId);
    if (bindings.length === 0) {
      // P1-4 (2026-05-23): 0 binding → 无 tenant 上下文, audit skip (fail-open)
      //   security-auditor 接受 "access read but empty result" 不写 audit (无敏感聚合)
      return { contexts: [] };
    }

    // 3. 按 tenant_id (小写化) 分组
    type Binding = (typeof bindings)[number];
    const byTenant = new Map<string, Binding[]>();
    for (const b of bindings) {
      const key = b.tenantId.toLowerCase();
      const arr = byTenant.get(key);
      if (arr) arr.push(b);
      else byTenant.set(key, [b]);
    }

    // 4. 批量拿 tenant.name (一次查询, 不 N+1)
    const tenantIds = Array.from(byTenant.keys());
    const tenantNameMap = await this.fetchTenantNames(tenantIds);

    // 5. 跨 tenant 聚合 children (每 tenant 一次 schema query, 串行 await Promise.all)
    //    fail-close: 任一 reject → throw 整体 500. 不允许返部分数据 (设计文档红线).
    const contexts = await Promise.all(
      Array.from(byTenant.entries()).map(async ([tenantIdLower, bs]) => {
        const tenantSchema = `tenant_${tenantIdLower}`;
        // tenant_id 原始大小写: bindings 里有 (raw), 用第一个 binding 的 tenantId 字段
        const tenantIdRaw = bs[0].tenantId;
        const studentIds = bs.map((b) => b.studentId);
        const children = await this.cside.findChildrenByIds(
          tenantSchema,
          studentIds,
        );
        // children 是 SQL ORDER BY created_at ASC, bindings 是 SQL 默认序
        // 用 studentId map join 而非 index map 保证正确性 (设计文档 design.md L107
        // 的 index map 是 spec, 不保证 SQL 排序一致, 改为 id-based lookup 更稳).
        const bindingByStuId = new Map<string, Binding>();
        for (const b of bs) bindingByStuId.set(b.studentId, b);
        const childrenOut = children
          .map((c) => {
            const b = bindingByStuId.get(c.id);
            if (!b) return null; // 防御性: student 已软删但 binding 还 active (理论上不应发生)
            return {
              studentId: c.id,
              studentName: c.name,
              campusId: c.campusId ?? null,
              campusName: c.campusName ?? null,
              bindingStatus: 'active' as const,
              isPrimary: Boolean(b.isPrimary),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
        return {
          tenantId: tenantIdRaw,
          tenantName: tenantNameMap.get(tenantIdLower) || '(机构名待定)',
          children: childrenOut,
        };
      }),
    );

    // P1-4 (2026-05-23 security-auditor + production-validator 共识):
    //   跨 tenant 关系聚合属敏感 access read (OWASP A09 + 拍板 P1-1) → 必须留 audit 痕迹.
    //   tenantSchema 取首个绑定 tenant (parent 跨机构身份, audit_log 单 tenant 落盘是约定).
    //   fail-open: tryAudit 内部已 try-catch + 返 void, 不阻断主流程.
    const firstTenantLower = Array.from(byTenant.keys())[0];
    await this.tryAudit(`tenant_${firstTenantLower}`, {
      actorUserId: parentId,
      action: 'c.tenant-contexts.read',
      targetType: 'parent',
      targetId: parentId,
      before: null,
      after: { contextCount: contexts.length, tenantCount: byTenant.size },
      req,
    });

    return { contexts };
  }

  /**
   * 批量拿 tenant.name → Map<tenantIdLower, name>
   *   - SELECT id, name FROM public.tenants WHERE id = ANY($1)
   *   - 用 ILIKE 等价 lowercased 比较: schema 里 tenants.id 是 32-char ULID 大小写都可能,
   *     这里用 LOWER(id) IN 比较保险, 但 ULID 在 V2 schema 实际是 lowercase 一致.
   *   - PgPoolService 未注入 (spec mock 场景) → 返空 map, controller 走 fallback name.
   *
   * fail-close 决策: 查询失败 throw, 不返空 map.
   *   原因: 设计文档红线 (任何 catch 必须 throw, 不 swallow).
   *   spec 通过 @Optional() pg 直接走 fallback 路径不触发查询.
   */
  private async fetchTenantNames(
    tenantIdsLower: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!this.pg || tenantIdsLower.length === 0) return map;
    const rows = await this.pg.query<{ id: string; name: string }>(
      `SELECT id, name FROM public.tenants WHERE LOWER(id) = ANY($1::text[])`,
      [tenantIdsLower],
    );
    for (const r of rows) {
      map.set(r.id.toLowerCase(), r.name || '');
    }
    return map;
  }

  /**
   * GET /api/c/home — 家长 home 聚合（当前 tenant scope）
   *
   * Query:
   *   tenantSchema?  可选，缺省走 req.tenantSchema（middleware 已挂）
   *
   * Response:
   *   {
   *     children: ChildBrief[],
   *     todayLessons: TodayLesson[],
   *     unreadCount: UnreadCount,
   *   }
   */
  @Get('home')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async getHome(
    @Req() req: ParentRequest,
  ): Promise<{
    children: ChildBrief[];
    todayLessons: TodayLesson[];
    unreadCount: UnreadCount;
  }> {
    const { parentId, tenantSchema, tenantId } = this.assertParent(req);

    // 1. 拿当前 tenant 内 active binding 的学员 ids
    const bindings = await this.parentRepo.findChildrenByParent(parentId);
    const studentIds = bindings
      .filter(
        (b) =>
          b.bindingStatus === 'active' &&
          b.tenantId.toLowerCase() === tenantId.toLowerCase(),
      )
      .map((b) => b.studentId);

    if (studentIds.length === 0) {
      // 该 tenant 下无 active binding（理论上 middleware 已拦截，但保险）
      return {
        children: [],
        todayLessons: [],
        unreadCount: { feedbacks: 0, monthlyReports: 0, total: 0 },
      };
    }

    // 2. children 基础档案（含主带老师 + 校区）
    const children = await this.cside.findChildrenByIds(
      tenantSchema,
      studentIds,
    );

    // 3. 今日课表（UTC 当天 [00:00, 24:00)）
    const now = new Date();
    const startUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
    const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
    const todayLessons = await this.cside.findTodayLessons(
      tenantSchema,
      studentIds,
      startUtc,
      endUtc,
    );

    // 4. 未读消息计数
    const unreadCount = await this.cside.countUnread(tenantSchema, studentIds);

    return { children, todayLessons, unreadCount };
  }

  /**
   * 2026-05-25 #2 闭环：GET /api/c/lessons — C 端家长多日课表查询
   *
   * 复用场景：
   *   - c/lessons/list 多日筛选（本周/已完成/请假）
   *   - c/leave/apply 请假选课次（status=待出勤 + from=today 拿即将到课）
   *
   * Query：
   *   - studentId?  仅查指定孩子（必须在当前 tenant 的 active binding 内，否则 403）
   *   - from?       ISO date 起（含），不传 = 不限
   *   - to?         ISO date 止（不含），不传 = 不限
   *   - status?     '待出勤'|'已完成'|'已取消'，不传 = 排除「已取消」全部
   *
   * 字段权限：复用 TodayLesson 类型（5/20 BLOCKER-1 已脱敏，不返 contract / payroll）
   *
   * RBAC：parent JWT + tenant.middleware 已守 binding × tenant 真实关系
   */
  @Get('lessons')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async getLessons(
    @Req() req: ParentRequest,
    @Query('studentId') studentId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
  ): Promise<{ items: TodayLesson[] }> {
    const { parentId, tenantSchema, tenantId } = this.assertParent(req);

    // 1. 拿当前 tenant 内 active binding 的学员 ids（防越权 baseline）
    const bindings = await this.parentRepo.findChildrenByParent(parentId);
    const studentIds = bindings
      .filter(
        (b) =>
          b.bindingStatus === 'active' &&
          b.tenantId.toLowerCase() === tenantId.toLowerCase(),
      )
      .map((b) => b.studentId);

    if (studentIds.length === 0) return { items: [] };

    // 2. 如果指定 studentId，必须在 binding 内（防越权看他人孩子）
    if (studentId) {
      if (!ULID_PATTERN.test(studentId)) {
        throw new BadRequestException('studentId must be 32-char ULID');
      }
      if (!studentIds.includes(studentId)) {
        throw new ForbiddenException('studentId not in your active bindings');
      }
    }

    // 3. 解析 from / to ISO 字符串
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    if (from && fromDate && isNaN(fromDate.getTime())) {
      throw new BadRequestException('from must be ISO date string');
    }
    if (to && toDate && isNaN(toDate.getTime())) {
      throw new BadRequestException('to must be ISO date string');
    }

    // 4. 校验 status 白名单（防 SQL 注入 / 模糊语义）
    const allowedStatus = ['待出勤', '已完成', '已取消'];
    if (status && !allowedStatus.includes(status)) {
      throw new BadRequestException(
        `status must be one of: ${allowedStatus.join(', ')}`,
      );
    }

    const items = await this.cside.findLessonsForChildren(
      tenantSchema,
      studentIds,
      { from: fromDate, to: toDate, status, studentId },
    );

    return { items };
  }

  /**
   * 2026-05-25 #4 闭环：GET /api/c/leaves — C 端家长「我的请假」多孩聚合
   *
   * 替代旧流程（前端需先调 /parents/:id/children 拿 studentIds → 循环调 POST /db/students/:id/leaves/list）
   *   - 后端一站式：parentId → bindings → studentIds → leaveRepo.findByStudents
   *   - 多孩聚合 + JOIN students/schedules/teachers/course_products 字段齐备
   *
   * RBAC: parent JWT + tenant.middleware 校验 + studentIds 仅当前 tenant active binding
   */
  @Get('leaves')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async getLeaves(
    @Req() req: ParentRequest,
  ): Promise<{ items: Leave[] }> {
    // @Optional leaveRepo: 生产 DbModule @Global 自动注入；spec 不 mock 时 undefined
    if (!this.leaveRepo) {
      this.logger.error('leaveRepo not injected — check DbModule providers');
      return { items: [] };
    }
    const { parentId, tenantSchema, tenantId } = this.assertParent(req);

    const bindings = await this.parentRepo.findChildrenByParent(parentId);
    const studentIds = bindings
      .filter(
        (b) =>
          b.bindingStatus === 'active' &&
          b.tenantId.toLowerCase() === tenantId.toLowerCase(),
      )
      .map((b) => b.studentId);

    if (studentIds.length === 0) return { items: [] };

    const items = await this.leaveRepo.findByStudents(tenantSchema, studentIds, 100);
    return { items };
  }

  /**
   * 2026-05-23 GET /api/c/me/profile — C 端家长「我的」页数据源
   *
   * 返 parent 基础信息 (name/phone/avatarUrl) — 家长本人看自己的 PII 合法
   *   - parentRepo.findParentById 已解密 phone (V40 双读)
   *   - 不返 wechat_openid / wechat_unionid (前端无需)
   *
   * 替代 c/mine MOCK_PARENT (张爸爸/13800138000 假数据)
   */
  @Get('me/profile')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async getMyProfile(
    @Req() req: ParentRequest,
  ): Promise<{ id: string; name: string | null; phone: string | null; avatarUrl: string | null; status: string }> {
    const parentId = (req.parent && req.parent.sub) || (req.parent && req.parent.parentId);
    if (!parentId) throw new ForbiddenException('parent JWT missing');
    const parent = await this.parentRepo.findParentById(parentId);
    // P1-3 (2026-05-23): HTTP 404 body 不暴露内部 ULID (OWASP A05).
    //   parentId 已在 server-side pino / audit_log 落盘, 不再透传 client.
    if (!parent) throw new NotFoundException('PARENT_NOT_FOUND');
    return {
      id: parent.id,
      name: parent.name || null,
      phone: parent.phone || null,
      avatarUrl: (parent as Parent & { avatarUrl?: string }).avatarUrl || null,
      status: parent.status,
    };
  }

  /**
   * GET /api/c/students/:studentId/profile — C 端学员档案
   *
   * 业务：
   *   - parent 必须 active 绑定该 student 在当前 tenant
   *   - 返脱敏档案（不返家长 phone / contract 金额 / family_address）
   */
  @Get('students/:studentId/profile')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async getStudentProfile(
    @Param('studentId') studentId: string,
    @Req() req: ParentRequest,
  ): Promise<ChildBrief> {
    if (!ULID_PATTERN.test(studentId)) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    const { parentId, tenantSchema, tenantId } = this.assertParent(req);

    // RBAC: parent 必须 active 绑定该 student 在当前 tenant
    const bindings = await this.parentRepo.findChildrenByParent(parentId);
    const owns = bindings.find(
      (b) =>
        b.bindingStatus === 'active' &&
        b.studentId === studentId &&
        b.tenantId.toLowerCase() === tenantId.toLowerCase(),
    );
    if (!owns) {
      await this.tryAudit(tenantSchema, {
        actorUserId: parentId,
        action: 'c.student-profile.deny-binding',
        targetType: 'student',
        targetId: studentId,
        after: { parentId, tenantId },
        req,
      });
      throw new ForbiddenException('parent not bound to this student in this tenant');
    }

    // 读 child brief（脱敏字段，无 PII）
    const profile = await this.cside.findChildById(tenantSchema, studentId);
    if (!profile) {
      throw new NotFoundException(`student ${studentId} not found`);
    }
    return profile;
  }

  /**
   * GET /api/c/messages — 消息中心
   *
   * Query:
   *   unreadOnly?    'true'/'1' → 仅未读
   *   limit?         默认 20，上限 100
   *   offset?        默认 0
   *
   * Response:
   *   { items: MessageItem[], total, unreadCount }
   */
  @Get('messages')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async listMessages(
    @Query('unreadOnly') unreadOnlyRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Query('offset') offsetRaw: string | undefined,
    @Req() req: ParentRequest,
  ): Promise<{
    items: MessageItem[];
    total: number;
    unreadCount: UnreadCount;
  }> {
    const { parentId, tenantSchema, tenantId } = this.assertParent(req);
    const unreadOnly = unreadOnlyRaw === 'true' || unreadOnlyRaw === '1';
    const limit = this.parseInt(limitRaw, 20, 1, 100);
    const offset = this.parseInt(offsetRaw, 0, 0, 100000);

    const bindings = await this.parentRepo.findChildrenByParent(parentId);
    const studentIds = bindings
      .filter(
        (b) =>
          b.bindingStatus === 'active' &&
          b.tenantId.toLowerCase() === tenantId.toLowerCase(),
      )
      .map((b) => b.studentId);

    if (studentIds.length === 0) {
      return {
        items: [],
        total: 0,
        unreadCount: { feedbacks: 0, monthlyReports: 0, total: 0 },
      };
    }

    const [list, unread] = await Promise.all([
      this.cside.listMessages(tenantSchema, studentIds, unreadOnly, limit, offset),
      this.cside.countUnread(tenantSchema, studentIds),
    ]);
    return {
      items: list.items,
      total: list.total,
      unreadCount: unread,
    };
  }

  /**
   * PATCH /api/c/messages/:messageId/mark-read?type=feedback|monthly-report
   *
   * 标记单条消息已读
   *   - type=feedback         → lesson_feedbacks.parent_read_at
   *   - type=monthly-report   → monthly_reports.parent_read_at
   *
   * RBAC：UPDATE WHERE student_id IN (家长绑定学员 ids)，跨家长 → rowCount=0 → 403
   */
  @Patch('messages/:messageId/mark-read')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async markMessageRead(
    @Param('messageId') messageId: string,
    @Query('type') typeRaw: string | undefined,
    @Req() req: ParentRequest,
  ): Promise<{ id: string; type: MessageType; markedAt: string }> {
    if (!ULID_PATTERN.test(messageId)) {
      throw new BadRequestException('messageId must be 32-char ULID');
    }
    if (typeRaw !== 'feedback' && typeRaw !== 'monthly-report') {
      throw new BadRequestException(
        `type must be 'feedback' or 'monthly-report' (got '${typeRaw ?? ''}')`,
      );
    }
    const type: MessageType = typeRaw;
    const { parentId, tenantSchema, tenantId } = this.assertParent(req);

    const bindings = await this.parentRepo.findChildrenByParent(parentId);
    const studentIds = bindings
      .filter(
        (b) =>
          b.bindingStatus === 'active' &&
          b.tenantId.toLowerCase() === tenantId.toLowerCase(),
      )
      .map((b) => b.studentId);

    if (studentIds.length === 0) {
      throw new ForbiddenException('parent has no active binding in this tenant');
    }

    const ok = await this.cside.markMessageRead(
      tenantSchema,
      type,
      messageId,
      studentIds,
    );
    if (!ok) {
      // 不存在 或 不归属家长 — 一律 403 不泄露存在性
      await this.tryAudit(tenantSchema, {
        actorUserId: parentId,
        action: 'c.message.deny-mark-read',
        targetType: type,
        targetId: messageId,
        after: { parentId, tenantId, type },
        req,
      });
      throw new ForbiddenException('message not found or not owned by this parent');
    }
    // 5/20 P5 三审 production P1-1: 写操作 audit 补全（避免 PATCH mark-read 静默无审计）
    await this.tryAudit(tenantSchema, {
      actorUserId: parentId,
      action: 'c.message.mark-read',
      targetType: type,
      targetId: messageId,
      after: { parentId, tenantId, type },
      req,
    });
    return { id: messageId, type, markedAt: new Date().toISOString() };
  }

  // ===== helpers =====

  // ============================================================
  // 2026-05-22 波 C: 家长「待我决定老师变更」 (SSOT §6.5 闭环)
  //   B 端教务发起变更 → 推送家长 → 家长在 C 端「同意 / 拒绝」
  //   approved → 同事务 update student.assigned_teacher_id + 未来 schedules
  // ============================================================

  /**
   * GET /api/c/teacher-changes/pending — 列我的 pending 老师变更请求
   *
   * 走 ParentJwtStrategy + tenant.middleware (req.parent.sub 已挂)
   * 服务端用 parent_id = req.parent.sub 过滤 — 跨家长 → 自动 0 行
   */
  @Get('teacher-changes/pending')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async listMyPendingTeacherChanges(
    @Req() req: ParentRequest,
  ): Promise<{ items: Awaited<ReturnType<TeacherChangeRequestService['listPendingByParent']>> }> {
    const { parentId, tenantSchema } = this.assertParent(req);
    if (!this.tcrService) {
      throw new BadRequestException('TeacherChangeRequestService not wired');
    }
    const items = await this.tcrService.listPendingByParent(tenantSchema, parentId);
    return { items };
  }

  /**
   * PATCH /api/c/teacher-changes/:teacherChangeRequestId/decide — 家长同意/拒绝
   *
   * Body: { decision: 'approved' | 'rejected', rejectReason?: string }
   * approved → 自动 update student.assigned_teacher_id + 未来 schedules (service 同事务)
   *
   * RBAC: tcr.parent_id === req.parent.sub (service 内 SELECT FOR UPDATE 校验)
   *   跨家长 → service 抛 PARENT_MISMATCH BadRequest
   */
  @Patch('teacher-changes/:teacherChangeRequestId/decide')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async decideTeacherChange(
    @Param('teacherChangeRequestId') teacherChangeRequestId: string,
    @Body() body: { decision: 'approved' | 'rejected'; rejectReason?: string },
    @Req() req: ParentRequest,
  ): Promise<{ id: string; decision: string; schedulesUpdated: number }> {
    if (!ULID_PATTERN.test(teacherChangeRequestId)) {
      throw new BadRequestException('teacherChangeRequestId must be 32-char ULID');
    }
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      throw new BadRequestException(`decision must be 'approved' or 'rejected'`);
    }
    const { parentId, tenantSchema } = this.assertParent(req);
    if (!this.tcrService) {
      throw new BadRequestException('TeacherChangeRequestService not wired');
    }
    const result = await this.tcrService.parentDecide(
      tenantSchema,
      teacherChangeRequestId,
      parentId,
      body.decision,
      body.rejectReason,
    );
    await this.tryAudit(tenantSchema, {
      actorUserId: parentId,
      action: body.decision === 'approved'
        ? 'teacher.change-approved-by-parent'
        : 'teacher.change-rejected-by-parent',
      targetType: 'teacher_change_request',
      targetId: teacherChangeRequestId,
      before: null,
      after: { schedulesUpdated: result.schedulesUpdated },
      req,
    });
    return { id: teacherChangeRequestId, decision: body.decision, schedulesUpdated: result.schedulesUpdated };
  }

  /**
   * 校验 req.parent 存在并提取 parentId / tenantSchema / tenantId
   * tenant.middleware 已挂上，此处仅兜底
   */
  private assertParent(req: ParentRequest): {
    parentId: string;
    tenantSchema: string;
    tenantId: string;
  } {
    const parentId = req.parent?.sub;
    if (!parentId) {
      throw new ForbiddenException('parent JWT required (middleware should have set)');
    }
    const tenantSchema = req.tenantSchema;
    if (!tenantSchema) {
      throw new BadRequestException(
        'tenant context required (set x-tenant-schema header or body.tenantSchema)',
      );
    }
    const tenantId = tenantSchema.replace(/^tenant_/, '');
    return { parentId, tenantSchema, tenantId };
  }

  private parseInt(
    raw: string | undefined,
    defaultVal: number,
    min: number,
    max: number,
  ): number {
    if (!raw) return defaultVal;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return defaultVal;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  private async tryAudit(
    tenantSchema: string,
    entry: {
      actorUserId: string;
      action: string;
      targetType: string;
      targetId: string | null;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
      req: ParentRequest;
    },
  ): Promise<void> {
    if (!this.auditLog) return;
    try {
      await this.auditLog.log(tenantSchema, {
        actorUserId: entry.actorUserId,
        actorRole: normalizeActorRole('parent'),
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        before: entry.before ?? null,
        after: entry.after ?? null,
        ip: entry.req.ip ?? null,
        userAgent:
          (entry.req.headers?.['user-agent'] as string | undefined) ?? null,
        requestId:
          (entry.req.headers?.['x-request-id'] as string | undefined) ?? null,
      });
    } catch {
      // fail-open
    }
  }
}
