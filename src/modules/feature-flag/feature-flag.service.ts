import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * FeatureFlagService — W3-1 Phase 5.5 灰度开关
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-5 灰度开关
 *
 * PM-AUTH(2026-04-30): 灰度开关
 *
 * 全局 feature flags：通过 ENV 变量控制
 *   - 命名规范：FEATURE_<NAME>=true|false
 *   - 默认值：未设置时按代码内 defaults
 *
 * 使用：
 *   - 业务模块注入 FeatureFlagService
 *   - 调用 isEnabled(name) 决定是否走新路径
 *   - 灰度回滚通过修改 ENV 即可，无需重新部署代码
 */

/**
 * 当前已注册的 feature flags 列表
 * 新 flag 必须先在此处声明（含默认值），才能在代码中使用
 */
export const FEATURE_FLAGS = {
  /** 启用 lifecycle scheduler（A10 自动续费/冻结/清理） */
  lifecycle_scheduler_enabled: false,
  /** 启用 reverse_orders 业务路径（A12 4 类逆向单） */
  reverse_orders_enabled: false,
  /** 启用 admin API（A11 §3.4 平台超管） */
  admin_api_enabled: false,
  /** 启用 wxpay real client（EXT-01 解除后切真商户号） */
  wxpay_real_client: false,
  /** 启用 i18n（默认 false，仅中文） */
  i18n_enabled: false,
  /** 启用平台超管手工审批退款（A11） */
  manual_refund_review: true,
} as const;

export type FeatureFlagName = keyof typeof FEATURE_FLAGS;

@Injectable()
export class FeatureFlagService {
  private readonly logger = new Logger(FeatureFlagService.name);
  private readonly cache = new Map<FeatureFlagName, boolean>();

  constructor(private readonly config: ConfigService) {}

  /**
   * 查询 flag 是否开启
   *
   * 优先级：ENV (FEATURE_<NAME>) > 代码默认值
   *
   * @throws BadRequestException 未声明的 flag
   */
  isEnabled(name: FeatureFlagName): boolean {
    if (!(name in FEATURE_FLAGS)) {
      throw new BadRequestException(
        `Unknown feature flag: ${name} (declare in FEATURE_FLAGS first)`,
      );
    }
    if (this.cache.has(name)) {
      return this.cache.get(name)!;
    }
    const envKey = `FEATURE_${name.toUpperCase()}`;
    const envValue = this.config.get<string>(envKey);
    let result: boolean;
    if (envValue === undefined || envValue === null || envValue === '') {
      result = FEATURE_FLAGS[name];
    } else {
      result = envValue.toLowerCase() === 'true';
    }
    this.cache.set(name, result);
    this.logger.log(`[Phase 5.5] feature flag ${name} = ${result} (env=${envValue ?? 'unset'})`);
    return result;
  }

  /**
   * 强制要求 flag 开启（守护代码路径）
   *
   * @throws BadRequestException flag 未启用
   */
  requireEnabled(name: FeatureFlagName): void {
    if (!this.isEnabled(name)) {
      throw new BadRequestException(`Feature flag ${name} is not enabled`);
    }
  }

  /**
   * 测试用：清缓存（业务代码不应调用）
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 列出所有已注册 flag 的当前状态
   */
  listAll(): Record<FeatureFlagName, boolean> {
    const result: Partial<Record<FeatureFlagName, boolean>> = {};
    for (const name of Object.keys(FEATURE_FLAGS) as FeatureFlagName[]) {
      result[name] = this.isEnabled(name);
    }
    return result as Record<FeatureFlagName, boolean>;
  }
}
