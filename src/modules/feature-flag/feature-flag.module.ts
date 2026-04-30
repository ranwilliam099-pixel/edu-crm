import { Global, Module } from '@nestjs/common';
import { FeatureFlagService } from './feature-flag.service';

/**
 * FeatureFlag 模块（W3-1 Phase 5.5 灰度开关）
 *
 * @Global() — 全局可注入，无需在每个模块的 imports 中重复声明
 *
 * PM-AUTH(2026-04-30): 灰度开关
 */
@Global()
@Module({
  providers: [FeatureFlagService],
  exports: [FeatureFlagService],
})
export class FeatureFlagModule {}
