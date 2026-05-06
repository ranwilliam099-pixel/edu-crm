/**
 * src/shared/types — 跨模块共享的非业务类型
 *
 * 用途：
 *   - 减少业务模块之间的反向依赖
 *   - 集中暴露 controller / guard / repository 都可能用到的类型
 *
 * 不放业务领域类型（Teacher / Schedule / Parent 等）— 那些归属于各自模块
 *
 * 引用方式：
 *   import { AuthenticatedRequest } from 'src/shared/types';
 *   或
 *   import { AuthenticatedRequest } from '../../shared/types';
 */

// JWT / 认证（来自 auth 模块）
export type {
  JwtPayload,
  TenantRole,
  PlatformRole,
  AuthenticatedRequest,
} from '../../modules/auth/jwt-payload.interface';
export {
  PLATFORM_ROLES,
  isPlatformRole,
} from '../../modules/auth/jwt-payload.interface';

// V20 Promotion（来自 db 模块）
export type {
  PromotionTier,
  PromotionDryRun,
  PromotionStatus,
  PromotionSourceType,
  PromotionAuditAction,
  ActivationRules,
  AuditCtx,
} from '../../modules/db/promotion.types';
