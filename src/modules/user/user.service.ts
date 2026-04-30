import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';

/**
 * UserService — W3-1 sales `campus_scope` 应用层填充骨架
 *
 * 来源：
 *   - PM 临时授权《全部人员-审核往来总台账.md》条目 11（2026-04-30）
 *   - 开发总监查收条目 12（2026-04-30 07:08）
 *   - V5__pd_signed_corrections.sql §2 已删 sales DB 触发器，应用层接管填充
 *
 * PM-TEMP-AUTH(2026-04-30): 主校区单值，等产品最终签字回归。
 *   产品最终签字若选「全部校区 ID」或「部门归属计算」，本服务的 `defaultCampusScope` 必须按
 *   产品口径重写；本注释 + 本文件 + spec fixture 中 `PM-TEMP-AUTH` tag 为回归锚点。
 *
 * 严守边界：
 *   1. 仅生成内存中的 user 对象；不真实 INSERT DB（INT-01 仍挂账）
 *   2. 不延伸 BE-W3-2 / BE-W3-3 / 其他 W3 子项
 *   3. 不引入企业管理系统主项目任何依赖
 */
@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  /**
   * 创建用户（应用层填充逻辑骨架，不真实持久化）。
   *
   * PM-TEMP-AUTH(2026-04-30): 主校区单值
   *   - role === 'sales' 且 campusScope 未传：默认填充 [campusId]（主校区单值）
   *   - role === 'sales' 且 campusScope 已传：按显式值（运营批量导入场景）
   *   - 其他角色：campusScope 直接采信传入值或默认 []
   *
   * @returns 含 campusScope 的 user 对象（不持久化）
   * @throws BadRequestException 若 role=sales 且 campusId 缺失
   */
  createUser(dto: CreateUserDto): {
    id: string;
    tenantId: string;
    role: string;
    campusId: string;
    campusScope: ReadonlyArray<string>;
  } {
    if (!dto.id || dto.id.length !== 32) {
      throw new BadRequestException(`user id must be 32-char ULID`);
    }
    if (!dto.tenantId || dto.tenantId.length !== 32) {
      throw new BadRequestException(`tenantId must be 32-char ULID`);
    }
    if (!['admin', 'manager', 'sales', 'teacher'].includes(dto.role)) {
      throw new BadRequestException(`role must be one of admin/manager/sales/teacher`);
    }
    if (!dto.campusId || dto.campusId.length !== 32) {
      throw new BadRequestException(`campusId must be 32-char ULID`);
    }

    const campusScope = this.resolveCampusScope(dto);

    this.logger.log(
      `createUser id=${dto.id} role=${dto.role} campusScope.size=${campusScope.length} ` +
        `(PM-TEMP-AUTH=${dto.role === 'sales' && !dto.campusScope})`,
    );

    return {
      id: dto.id,
      tenantId: dto.tenantId,
      role: dto.role,
      campusId: dto.campusId,
      campusScope,
    };
  }

  /**
   * 解析 campus_scope（按角色分支默认填充）。
   *
   * PM-AUTH-5(2026-04-30): 条目 14 代码冲刺总授权 — sales 主校区单值已转**正式签字**
   * BE-W3-1（条目 14 §B Track CODE-1）扩展范围：admin 全校区 / 普通员工部门归属
   *
   * 默认填充策略：
   *   - sales → [campusId]（主校区单值，AUTH-5 正式签字）
   *   - admin → []（业务语义：admin 不受 campus_scope 限制，业务层权限校验直接跳过此字段）
   *   - teacher / manager → [campusId]（部门归属待 DepartmentService 落地，临时按主校区单值；
   *     DepartmentService 落地后由 V6 ALTER 路径补充部门归属计算）
   *
   * 显式传入 campusScope 时优先按显式值（运营批量导入场景）。
   */
  private resolveCampusScope(dto: CreateUserDto): ReadonlyArray<string> {
    if (dto.campusScope !== undefined) {
      return [...dto.campusScope];
    }
    switch (dto.role) {
      case 'sales':
        // PM-AUTH-5: 主校区单值（条目 14 AUTH-5 正式签字）
        return [dto.campusId];
      case 'admin':
        // PM-AUTH-5: admin 全校区语义 — 应用层默认空数组，业务层权限校验对 admin 跳过 scope check
        // 不查 CampusService（待 BE-W4-1 落地后由权限层处理）
        return [];
      case 'teacher':
      case 'manager':
        // PM-AUTH-5: 普通员工部门归属临时按主校区单值
        // DepartmentService 落地后（BE-W4+）补 V6 ALTER 路径
        return [dto.campusId];
      default:
        return [];
    }
  }
}
