import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ReverseOrderType } from './reverse-order.service';

/**
 * RevenueAdjustmentService — W3-1 Phase 4 BE-W5-2 GMV/实收冲减/补加
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-4 BE-W5-2
 *   - AUTH-7 A12 §4.5 报表口径影响
 *
 * PM-AUTH-7(2026-04-30): A12 报表口径
 *
 * 4 类逆向单的报表影响：
 *   - refund   (退款)：GMV 冲减 / 实收冲减（按退款金额）
 *   - transfer (转班)：GMV 不变 / 实收不变（仅记录转班）
 *   - extend   (扩科)：GMV 增加 / 实收增加（补缴部分）
 *   - cancel   (退课)：GMV 冲减 / 实收冲减（全额）
 *
 * paid 锁原则（A12 §4.5）：
 *   - 不修改原 payment_orders.amount 字段
 *   - 通过 reverse_orders 表 + revenue_adjustments 派生数据计算
 */

export interface RevenueAdjustmentInput {
  /** 32-char ULID 原订单号 */
  originalOrderId: string;
  /** 32-char ULID 逆向单号 */
  reverseOrderId: string;
  /** 4 类型 */
  type: ReverseOrderType;
  /** 原订单金额（元） */
  originalAmountCnyYuan: number;
  /** 逆向单金额（元）— refund/cancel: 退款金额；extend: 补缴金额；transfer: 0 */
  reverseAmountCnyYuan: number;
}

export interface RevenueAdjustment {
  originalOrderId: string;
  reverseOrderId: string;
  type: ReverseOrderType;
  /** GMV 冲减额（正数=冲减，负数=补加，0=无影响） */
  gmvDeltaCnyYuan: number;
  /** 实收冲减额 */
  actualRevenueDeltaCnyYuan: number;
  /** 调整后 GMV */
  adjustedGmvCnyYuan: number;
  /** 调整后实收 */
  adjustedActualRevenueCnyYuan: number;
}

@Injectable()
export class RevenueAdjustmentService {
  private readonly logger = new Logger(RevenueAdjustmentService.name);

  /**
   * 计算单笔逆向单对原订单的 GMV / 实收影响
   *
   * PM-AUTH-7(2026-04-30): A12 §4.5
   *
   * @returns 调整后金额（不修改原 payment_orders）
   */
  calculate(input: RevenueAdjustmentInput): RevenueAdjustment {
    if (!input.originalOrderId || input.originalOrderId.length !== 32) {
      throw new BadRequestException('originalOrderId must be 32-char ULID');
    }
    if (!input.reverseOrderId || input.reverseOrderId.length !== 32) {
      throw new BadRequestException('reverseOrderId must be 32-char ULID');
    }
    if (input.originalAmountCnyYuan < 0) {
      throw new BadRequestException('originalAmountCnyYuan must be >= 0');
    }
    if (input.reverseAmountCnyYuan < 0) {
      throw new BadRequestException('reverseAmountCnyYuan must be >= 0');
    }

    let gmvDelta: number;
    let actualRevenueDelta: number;

    switch (input.type) {
      case 'refund':
        // 退款：GMV 冲减 + 实收冲减（按退款金额）
        if (input.reverseAmountCnyYuan > input.originalAmountCnyYuan) {
          throw new BadRequestException(
            `refund amount ${input.reverseAmountCnyYuan} exceeds original ${input.originalAmountCnyYuan}`,
          );
        }
        gmvDelta = input.reverseAmountCnyYuan;
        actualRevenueDelta = input.reverseAmountCnyYuan;
        break;
      case 'cancel':
        // 退课：GMV 冲减 + 实收冲减（全额，与 refund 等价）
        if (input.reverseAmountCnyYuan > input.originalAmountCnyYuan) {
          throw new BadRequestException(
            `cancel amount ${input.reverseAmountCnyYuan} exceeds original ${input.originalAmountCnyYuan}`,
          );
        }
        gmvDelta = input.reverseAmountCnyYuan;
        actualRevenueDelta = input.reverseAmountCnyYuan;
        break;
      case 'transfer':
        // 转班：GMV / 实收不变（仅记录）
        if (input.reverseAmountCnyYuan !== 0) {
          throw new BadRequestException(
            `transfer reverseAmountCnyYuan must be 0 (got ${input.reverseAmountCnyYuan})`,
          );
        }
        gmvDelta = 0;
        actualRevenueDelta = 0;
        break;
      case 'extend':
        // 扩科：GMV 补加 + 实收补加（负数 delta 表示补加）
        gmvDelta = -input.reverseAmountCnyYuan;
        actualRevenueDelta = -input.reverseAmountCnyYuan;
        break;
      default:
        throw new BadRequestException(`Unknown reverse order type: ${input.type}`);
    }

    const adjustedGmv = input.originalAmountCnyYuan - gmvDelta;
    const adjustedActualRevenue = input.originalAmountCnyYuan - actualRevenueDelta;

    this.logger.log(
      `[BE-W5-2] adjustment type=${input.type} original=${input.originalAmountCnyYuan} reverse=${input.reverseAmountCnyYuan} → GMV=${adjustedGmv} 实收=${adjustedActualRevenue}`,
    );

    return {
      originalOrderId: input.originalOrderId,
      reverseOrderId: input.reverseOrderId,
      type: input.type,
      gmvDeltaCnyYuan: gmvDelta,
      actualRevenueDeltaCnyYuan: actualRevenueDelta,
      adjustedGmvCnyYuan: adjustedGmv,
      adjustedActualRevenueCnyYuan: adjustedActualRevenue,
    };
  }

  /**
   * 批量计算多笔逆向单的累计影响
   */
  calculateBatch(inputs: ReadonlyArray<RevenueAdjustmentInput>): {
    totalGmvDelta: number;
    totalActualRevenueDelta: number;
    adjustments: RevenueAdjustment[];
  } {
    const adjustments = inputs.map((input) => this.calculate(input));
    return {
      totalGmvDelta: adjustments.reduce((sum, a) => sum + a.gmvDeltaCnyYuan, 0),
      totalActualRevenueDelta: adjustments.reduce(
        (sum, a) => sum + a.actualRevenueDeltaCnyYuan,
        0,
      ),
      adjustments,
    };
  }
}
