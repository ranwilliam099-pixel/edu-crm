/**
 * V20 Promotion 共享类型 — 由 promotion.repository / promotion-quota.service /
 * promotion-audit.repository / controller / eligibility-service 共用
 */
import type { PlanTier } from './subscription.repository';

export type PromotionSourceType = 'self_service' | 'kol' | 'campaign';
export type PromotionStatus = 'reserved' | 'committed' | 'released' | 'expired';

export interface ActivationRules {
  teachers?: number;
  students?: number;
  parents?: number;
  schedules?: number;
}

export interface PromotionTier {
  id: number;
  code: string;
  name: string;
  discountPct: number;
  quotaTotal: number | null;
  quotaUsed: number;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  activationRules: ActivationRules | null;
  appliesToPlans: PlanTier[];
  appliesYears: number;
  sourceType: PromotionSourceType;
  inviteCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PromotionDryRun {
  affectedTenantsLocked: number;
  remainingQuota: number | null;
  estimatedNewActivations: number;
  estimatedGmvDeltaYuan: number;
  warnings: string[];
}

export interface AuditCtx {
  operatorId?: string;
  operatorRole?: string;
  operatorIp?: string;
  note?: string;
}

export type PromotionAuditAction =
  | 'create'
  | 'update'
  | 'toggle'
  | 'delete'
  | 'quota_reserve'
  | 'quota_commit'
  | 'quota_release'
  | 'quota_expire';
