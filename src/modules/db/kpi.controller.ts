import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import {
  KpiService,
  SignedKpiResult,
  RenewalKpiResult,
  ConsumptionKpiResult,
  StudentActivityKpiResult,
  SalesHomeKpiResult,
} from './kpi.service';

/**
 * KpiController — 4 KPI dashboard endpoint（2026-05-20 P4-X 拍板）
 *
 * 来源：
 *   - SSOT §3.1/§3.2 老板/校长 home 4 KPI 组 Level 2 下钻
 *   - SSOT §6 操作权限矩阵 2026-05-20 新增 kpi.*.read = [admin, boss]
 *
 * Endpoints（全部 admin/boss 角色）：
 *   GET /db/kpi/signed             本月新签聚合（sales + academic）
 *   GET /db/kpi/renewal            本月续约聚合（academic + sales）
 *   GET /db/kpi/consumption        本月消课聚合（仅 academic）
 *   GET /db/kpi/student-activity   学员活跃度聚合（按校区分桶）
 *
 * 守门 5 层：
 *   1. TenantScopeGuard class-level（body/query/header 三重 schema 校验）
 *   2. RbacGuard class-level + @Roles('admin', 'boss')
 *   3. tenantSchema query 必填（缺 → BadRequest）
 *   4. boss 强制 callerCampusId = jwt.campusId（即便 query.campusId 传他校 → 403）
 *   5. admin 可选 campusId csv 多选 / 不传 = 跨校全部
 *
 * 不写 audit_log：KPI 是高频读路径（home Level 2 进入即触发），写 audit_log 会污染。
 * 越权由 RbacGuard 自动 403（A09 已在 RbacGuard 层覆盖；本 endpoint 不再单独写）。
 */
@Controller('db/kpi')
@UseGuards(TenantScopeGuard, RbacGuard)
export class KpiController {
  constructor(private readonly kpi: KpiService) {}

  /**
   * 解析 campusIds query：
   *   - admin 角色：解析 csv 为字符串数组（空 / 未传 → null = 全部）
   *   - boss 角色：强制 = [jwt.campusId]；如 query 含 campusId 但不含 jwt.campusId → 403
   *
   * 设计：A04 防 client-controlled scope 关键 — boss 永远不能查他校 KPI。
   */
  private resolveCampusScope(
    role: string | undefined,
    jwtCampusId: string | null | undefined,
    queryCampusIdsCsv: string | undefined,
  ): string[] | null {
    const parsedQuery = (queryCampusIdsCsv ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (role === 'boss') {
      if (!jwtCampusId) {
        throw new ForbiddenException(
          'BOSS_MISSING_CAMPUS_ID: boss role 必须 jwt.campusId 非空',
        );
      }
      if (parsedQuery.length > 0) {
        // boss 传了 campusIds：只允许全部 = jwt.campusId（容忍同值传递，不容忍他校）
        const hasOtherCampus = parsedQuery.some((cid) => cid !== jwtCampusId);
        if (hasOtherCampus) {
          throw new ForbiddenException(
            'FORBIDDEN_CAMPUS_MISMATCH: boss 不能查询其他校区 KPI',
          );
        }
      }
      return [jwtCampusId];
    }

    if (role === 'admin') {
      // admin 没传 → 跨校全部（null）；传了 → 按 csv 过滤
      return parsedQuery.length === 0 ? null : parsedQuery;
    }

    // 其他 role 理论被 @Roles 挡住，但兜底防御：返 [] 让 SQL where false 命中无数据
    return [];
  }

  /**
   * 2026-05-21 销售自视角 home KPI
   *   GET /db/kpi/sales-home?tenantSchema=
   *   Auth: JWT.sub → salesUserId（不接受 client 传 userId 防伪造）
   *   RBAC: sales / sales_manager 可读自己 home 数据
   */
  @Get('sales-home')
  @Roles('sales', 'sales_manager')
  @HttpCode(HttpStatus.OK)
  async salesHomeKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<SalesHomeKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const salesUserId = req.user?.sub;
    if (!salesUserId) throw new BadRequestException('user sub required');
    return this.kpi.getSalesHomeKpi(tenantSchema, salesUserId);
  }

  /**
   * GET /db/kpi/signed — 本月新签聚合
   * Query: tenantSchema (必填) + campusId (csv, admin 可选 / boss 仅本校)
   */
  @Get('signed')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async signedKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusIdCsv?: string,
  ): Promise<SignedKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = this.resolveCampusScope(
      req.user?.role,
      req.user?.campusId,
      campusIdCsv,
    );
    return this.kpi.getSignedKpi(tenantSchema, { campusIds });
  }

  /**
   * GET /db/kpi/renewal — 本月续约聚合
   * Query: tenantSchema (必填) + campusId (csv)
   */
  @Get('renewal')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async renewalKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusIdCsv?: string,
  ): Promise<RenewalKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = this.resolveCampusScope(
      req.user?.role,
      req.user?.campusId,
      campusIdCsv,
    );
    return this.kpi.getRenewalKpi(tenantSchema, { campusIds });
  }

  /**
   * GET /db/kpi/consumption — 本月消课聚合（仅 academic 维度）
   * Query: tenantSchema (必填) + campusId (csv)
   */
  @Get('consumption')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async consumptionKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusIdCsv?: string,
  ): Promise<ConsumptionKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = this.resolveCampusScope(
      req.user?.role,
      req.user?.campusId,
      campusIdCsv,
    );
    return this.kpi.getConsumptionKpi(tenantSchema, { campusIds });
  }

  /**
   * GET /db/kpi/student-activity — 学员活跃度（按校区分桶）
   * Query: tenantSchema (必填) + campusId (csv)
   */
  @Get('student-activity')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async studentActivityKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusIdCsv?: string,
  ): Promise<StudentActivityKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = this.resolveCampusScope(
      req.user?.role,
      req.user?.campusId,
      campusIdCsv,
    );
    return this.kpi.getStudentActivityKpi(tenantSchema, { campusIds });
  }
}
