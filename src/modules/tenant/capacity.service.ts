import { Injectable, ForbiddenException, Logger } from '@nestjs/common';

/**
 * 容量守护服务（W1 BE-W1-5 骨架，A07 + A08）
 *
 * 职责（执行结论清单 V0.1 §1 第 10/11 项 + 字段清单 V1.1 §2.1）：
 *   - A07：标准版账号上限 = 50；超限提示升级并阻止新增
 *   - A08：标准版校区上限 = 3；创建第 4 个校区时提示升级并阻止新增
 *   - 校区版 / 增长版 上限由 D11 第二批（2026-05-05）产品经理交付，本服务为 §0 不猜测留出可扩展枚举
 *
 * 放弃猜测：
 *   - 校区版 / 增长版具体上限不擅自填值，DEFAULT_LIMITS 仅含已拍板的"标准版"档
 *   - 升级提示文案待 A05/A06 详细规约（D11 第一批 2026-05-04）
 *
 * 项目隔离（追加 #8）：本服务不引用企业管理系统主项目任何容量逻辑
 */
@Injectable()
export class CapacityService {
  private readonly logger = new Logger(CapacityService.name);

  /**
   * A07/A08 标准版上限（已拍板 = 50 账号 + 3 校区）
   * 校区版 / 增长版 = undefined → 由 W2 D11 第二批拍板后填入
   */
  static readonly DEFAULT_LIMITS: Record<TenantVersion, VersionLimits> = {
    标准版: { accountLimit: 50, campusLimit: 3 },
    校区版: { accountLimit: undefined, campusLimit: undefined },
    增长版: { accountLimit: undefined, campusLimit: undefined },
  };

  /**
   * 校验账号数是否超过版本上限（A07）
   * @throws ForbiddenException 超量时（错误码 4007，与接口清单 V1 §错误码对齐）
   */
  guardAccountLimit(version: TenantVersion, currentCount: number, accountLimit: number): void {
    if (accountLimit === undefined) {
      throw new ForbiddenException(
        `[A07] account limit for version=${version} not yet defined (waiting D11 batch 2 ETA 2026-05-05)`,
      );
    }
    if (currentCount >= accountLimit) {
      throw new ForbiddenException({
        code: 4007,
        version,
        currentCount,
        accountLimit,
        message: `账号数已达 ${version}上限 ${accountLimit}，请升级版本`,
      });
    }
  }

  /**
   * 校验校区数是否超过版本上限（A08）
   * @throws ForbiddenException 超量时（错误码 4008）
   */
  guardCampusLimit(version: TenantVersion, currentCount: number, campusLimit: number): void {
    if (campusLimit === undefined) {
      throw new ForbiddenException(
        `[A08] campus limit for version=${version} not yet defined (waiting D11 batch 2 ETA 2026-05-05)`,
      );
    }
    if (currentCount >= campusLimit) {
      throw new ForbiddenException({
        code: 4008,
        version,
        currentCount,
        campusLimit,
        message: `校区数已达 ${version}上限 ${campusLimit}，请升级版本`,
      });
    }
  }

  /**
   * 解析版本上限（占位：W1 BE-W1-1 接 TypeORM 后从 public.tenants 读真实值）
   * 当前仅返回 DEFAULT_LIMITS 静态值
   */
  resolveLimits(version: TenantVersion): VersionLimits {
    return CapacityService.DEFAULT_LIMITS[version];
  }
}

export type TenantVersion = '标准版' | '校区版' | '增长版';

export interface VersionLimits {
  /** A07 账号上限；undefined 表示该版本待 D11 第二批拍板 */
  accountLimit: number | undefined;
  /** A08 校区上限；同上 */
  campusLimit: number | undefined;
}
