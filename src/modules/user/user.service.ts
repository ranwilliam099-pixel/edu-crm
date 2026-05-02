import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';

/**
 * UserService — W3-1 sales `campus_scope` 应用层填充
 *
 * 来源：
 *   - PM 临时授权《全部人员-审核往来总台账.md》条目 11（2026-04-30）
 *   - 开发总监查收条目 12（2026-04-30 07:08）
 *   - V5__pd_signed_corrections.sql §2 已删 sales DB 触发器，应用层接管填充
 *   - **用户最终拍板（2026-05-02 台账条目 28）：sales 三选一锁方案 2 主校区单值**
 *
 * USER-AUTH(2026-05-02): sales = `[campusId]` 主校区单值，最终拍板锁定。
 *   原 PM-TEMP-AUTH(2026-04-30) 临时授权升级为 USER-AUTH 正式拍板，无需再回归。
 *   admin / teacher / manager 三角色填充语义仍等 PD 二次明示（条目 19）。
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
   * 创建用户（应用层填充逻辑，不真实持久化）。
   *
   * USER-AUTH(2026-05-02): sales 主校区单值（用户最终拍板，台账条目 28）
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
    const validRoles = [
      'sales',
      'sales_manager',
      'sales_director',
      'marketing',
      'finance',
      'boss',
      'admin',
      'hr',
    ];
    if (!validRoles.includes(dto.role)) {
      throw new BadRequestException(
        `role must be one of ${validRoles.join('/')} (V2 schema CHECK 8 枚举)`,
      );
    }
    if (!dto.campusId || dto.campusId.length !== 32) {
      throw new BadRequestException(`campusId must be 32-char ULID`);
    }

    const campusScope = this.resolveCampusScope(dto);

    this.logger.log(
      `createUser id=${dto.id} role=${dto.role} campusScope.size=${campusScope.length} ` +
        `(USER-AUTH-2=${dto.role === 'sales' && !dto.campusScope})`,
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
   * USER-AUTH(2026-05-02): sales 三选一最终拍板锁方案 2 主校区单值（台账条目 28）
   * PM-AUTH-5(2026-04-30): 条目 14 代码冲刺总授权 — admin/teacher/manager 三角色填充由 cron 临时编写
   * BE-W3-1（条目 14 §B Track CODE-1）扩展范围：admin 全校区 / 普通员工部门归属
   *
   * USER-AUTH(2026-05-02 台账条目 30 + 31): 用户拍板 8 枚举 campus_scope 默认填充策略
   *
   * 单校区组 → [campusId]（数据权限边界 = 本人所属校区，前端可显式覆盖为多校）：
   *   - sales（销售，条目 28 已锁）
   *   - sales_manager（销售经理 / "man"）
   *   - boss（校长，条目 31 修订：默认单校但前端 UX 可选多校 — 连锁总校长场景）
   *   - marketing（市场，条目 31 拍板默认单校保守）
   *   - finance（财务，条目 31 拍板默认单校保守）
   *
   * 跨校区组 → []（业务层权限校验对此组跳过 campus_scope 过滤，可见全租户）：
   *   - sales_director（大区销售总监 / 跨校区管理）
   *   - admin（系统管理员 / 跨校区管理）
   *   - hr（人事 / 跨校区管理，2026-05-02 修订）
   *
   * teacher 已移出本 service：
   *   条目 29 用户拍板老师走方向 B，独立 `teachers` 表 + V7 ALTER 待开；
   *   条目 31 进一步拍板 teachers.user_id NULLABLE（部分老师纯档案不登录）
   *
   * 显式传入 campusScope 时优先按显式值（运营批量导入场景 + 多校区授权）。
   */
  private resolveCampusScope(dto: CreateUserDto): ReadonlyArray<string> {
    if (dto.campusScope !== undefined) {
      return [...dto.campusScope];
    }
    switch (dto.role) {
      // 单校区组 — 数据权限 = 本人所属校区（前端 UX 可显式覆盖为多校）
      case 'sales':
      case 'sales_manager':
      case 'boss':
      case 'marketing':
      case 'finance':
        return [dto.campusId];

      // 跨校区组 — 空数组 + 业务层豁免（admin/sales_director/hr 跨校区管理）
      case 'sales_director':
      case 'admin':
      case 'hr':
        return [];

      default:
        // 不应到达（validRoles 已过滤），保险分支
        return [];
    }
  }
}
