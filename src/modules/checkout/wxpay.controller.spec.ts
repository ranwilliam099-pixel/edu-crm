import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { WxPayController } from './wxpay.controller';
import type { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * WxPayController 单元测试 — W2-T1
 *
 * 模式：直接 new WxPayController（避免 NestJS DI 拉起 IdempotencyInterceptor → RedisService 链）
 * RbacGuard / TenantScopeGuard / IdempotencyInterceptor / Throttler 已有独立 spec 覆盖
 *
 * 覆盖：
 *   - unified-order subscription 路径 + parent-extra 路径 + RBAC + 入参校验
 *   - callbacks/wxpay payment + refund + 验签失败 audit
 *   - close-order RBAC + mock 模式拒绝（friendly error）
 *   - refund 入参校验 + outRefundNo 服务端生成 + RBAC
 *   - audit_log 必写 + fail-open
 */

const ULID_A = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP00';
const ULID_B = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP01';

const VALID_OPENID = 'oTestXXXXXXXXXXXXXXXX';

function makeReq(opts: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    headers: {},
    ip: '1.2.3.4',
    ...opts,
  } as AuthenticatedRequest;
}

describe('WxPayController', () => {
  let controller: WxPayController;
  let wxpay: {
    createPrepay: jest.Mock;
    verifyCallbackSignature: jest.Mock;
    requestRefund: jest.Mock;
    closeOrder?: jest.Mock;
  };
  let callback: {
    handlePaymentNotify: jest.Mock;
    handleRefundNotify: jest.Mock;
  };
  let auditLog: { log: jest.Mock };
  let config: { get: jest.Mock };

  function buildController(opts: { withAudit?: boolean } = {}): WxPayController {
    const withAudit = opts.withAudit ?? true;
    return new WxPayController(
      wxpay as never,
      callback as never,
      withAudit ? (auditLog as never) : undefined,
      config as never,
    );
  }

  beforeEach(() => {
    wxpay = {
      createPrepay: jest.fn(),
      verifyCallbackSignature: jest.fn(),
      requestRefund: jest.fn(),
      closeOrder: jest.fn(),
    };
    callback = {
      handlePaymentNotify: jest.fn(),
      handleRefundNotify: jest.fn(),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    config = {
      get: jest.fn((k: string) => {
        if (k === 'WXPAY_NOTIFY_URL') {
          return 'https://api.minxin.top/api/checkout/callbacks/wxpay';
        }
        return undefined;
      }),
    };

    controller = buildController();
  });

  // ============================================================
  // POST /api/checkout/wxpay/unified-order
  // ============================================================
  describe('unifiedOrder', () => {
    const validSubBody = {
      tenantId: 'tnnt0000000000000000000000000001',
      tenantSchema: 'tenant_tnnt0000000000000000000000000001',
      outTradeNo: ULID_A,
      openid: VALID_OPENID,
      amountCents: 199900,
      description: '教育培训行业销售 CRM 标准版年费',
      type: 'subscription' as const,
    };

    it('subscription happy path（admin）→ 返 prepayId + jsApiParams + audit_log 写入', async () => {
      wxpay.createPrepay.mockResolvedValueOnce({
        prepayId: 'wx_prepay_001',
        jsApiParams: {
          timeStamp: '1700000000',
          nonceStr: 'n',
          package: 'prepay_id=wx_prepay_001',
          signType: 'RSA',
          paySign: 'sig',
        },
      });
      const req = makeReq({
        user: {
          sub: 'usr00000000000000000000000000000a',
          role: 'admin',
          tenantId: 'tnnt0000000000000000000000000001',
          campusId: null,
        },
        body: validSubBody,
      });
      const r = await controller.unifiedOrder(validSubBody, req);
      expect(r.prepayId).toBe('wx_prepay_001');
      expect(auditLog.log).toHaveBeenCalledWith(
        'tenant_tnnt0000000000000000000000000001',
        expect.objectContaining({
          action: 'wxpay.unified-order.created',
          targetType: 'payment_order',
          targetId: ULID_A,
        }),
      );
      // openid 全文不应入 audit（仅 last8）
      const auditCall = auditLog.log.mock.calls[0][1];
      expect(JSON.stringify(auditCall.after)).not.toContain(VALID_OPENID);
      expect(auditCall.after.openidLast8).toBe(VALID_OPENID.slice(-8));
    });

    it('subscription 无 JWT → 401', async () => {
      await expect(
        controller.unifiedOrder(validSubBody, makeReq()),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('subscription 非 admin/boss/platform → 403', async () => {
      const req = makeReq({
        user: {
          sub: 'usr1',
          role: 'sales',
          tenantId: 't1',
          campusId: null,
        },
      });
      await expect(controller.unifiedOrder(validSubBody, req)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('subscription body.tenantId 不匹配 JWT user.tenantId → 403 (T9-EPIC round 2 跨 tenant 支付攻击防御)', async () => {
      // T9-EPIC round 2 (2026-05-16 security audit P0)：admin from tenant A 不能构造
      // body.tenantId=TENANT_B 跨 tenant 创建付款单。前端 URL 参数不可信，后端唯一守门。
      const req = makeReq({
        user: {
          sub: 'usr00000000000000000000000000000a',
          role: 'admin',
          tenantId: 'tnnt0000000000000000000000000001', // tenant A
          campusId: null,
        },
      });
      await expect(
        controller.unifiedOrder(
          { ...validSubBody, tenantId: 'tnnt0000000000000000000000000099' }, // tenant B
          req,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('parent-extra 有 ParentJwt → 通过', async () => {
      wxpay.createPrepay.mockResolvedValueOnce({
        prepayId: 'wx_prepay_002',
        jsApiParams: {
          timeStamp: '1700000000',
          nonceStr: 'n',
          package: 'prepay_id=wx_prepay_002',
          signType: 'RSA',
          paySign: 'sig',
        },
      });
      const body = { ...validSubBody, type: 'parent-extra' as const };
      const req = makeReq({
        body,
      });
      (req as { parent?: object }).parent = {
        sub: 'par1',
        parentId: 'par1',
        role: 'parent',
      };
      const r = await controller.unifiedOrder(body, req);
      expect(r.prepayId).toBe('wx_prepay_002');
    });

    it('parent-extra 无 ParentJwt → 401', async () => {
      const body = { ...validSubBody, type: 'parent-extra' as const };
      await expect(controller.unifiedOrder(body, makeReq())).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('outTradeNo 非 32 字符 → 400', async () => {
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'admin',
          tenantId: 't',
          campusId: null,
        },
      });
      await expect(
        controller.unifiedOrder({ ...validSubBody, outTradeNo: 'short' }, req),
      ).rejects.toThrow(BadRequestException);
    });

    it('amountCents 非正整数 → 400', async () => {
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'admin',
          tenantId: 't',
          campusId: null,
        },
      });
      await expect(
        controller.unifiedOrder({ ...validSubBody, amountCents: -1 }, req),
      ).rejects.toThrow(BadRequestException);
    });

    it('WXPAY_NOTIFY_URL 未配置 → 400', async () => {
      config.get.mockImplementation(() => undefined);
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'admin',
          tenantId: 'tnnt0000000000000000000000000001', // T9-EPIC round 2: 匹配 validSubBody.tenantId 防 owner check 先抛
          campusId: null,
        },
      });
      await expect(
        controller.unifiedOrder(validSubBody, req),
      ).rejects.toThrow(/notifyUrl|NOTIFY_URL|https/i);
    });

    it('type 非法 → 400', async () => {
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'admin',
          tenantId: 't',
          campusId: null,
        },
      });
      await expect(
        controller.unifiedOrder(
          { ...validSubBody, type: 'invalid' as 'subscription' },
          req,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('wxpay.createPrepay 抛错 → audit failed + 透传 error', async () => {
      wxpay.createPrepay.mockRejectedValueOnce(new Error('wxpay down'));
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'admin',
          tenantId: 'tnnt0000000000000000000000000001',
          campusId: null,
        },
        body: validSubBody,
      });
      await expect(controller.unifiedOrder(validSubBody, req)).rejects.toThrow();
      expect(auditLog.log).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          action: 'wxpay.unified-order.failed',
        }),
      );
    });

    it('description 超 127 字 → 400（V3 限制）', async () => {
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'admin',
          tenantId: 't',
          campusId: null,
        },
      });
      await expect(
        controller.unifiedOrder(
          { ...validSubBody, description: 'a'.repeat(128) },
          req,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // POST /api/checkout/callbacks/wxpay
  // ============================================================
  describe('wxpayCallback', () => {
    const headers = {
      'wechatpay-timestamp': '1700000000',
      'wechatpay-nonce': 'abc',
      'wechatpay-serial': 'SERIAL_001',
      'wechatpay-signature': 'sig',
    };

    function reqWithHeaders(
      kind: 'payment' | 'refund' = 'payment',
      notifyBody?: object,
    ): AuthenticatedRequest {
      return makeReq({
        headers,
        body: { kind, notifyBody, expectedAmountCents: 199900 },
      });
    }

    it('payment SUCCESS → 返 SUCCESS', async () => {
      callback.handlePaymentNotify.mockResolvedValueOnce({
        outTradeNo: ULID_A,
        shouldTransitTo: '已支付',
        amountCents: 199900,
      });
      const body = {
        kind: 'payment' as const,
        notifyBody: { out_trade_no: ULID_A, trade_state: 'SUCCESS' as const },
        expectedAmountCents: 199900,
      };
      const r = await controller.wxpayCallback(
        body,
        reqWithHeaders('payment', body.notifyBody),
      );
      expect(r.code).toBe('SUCCESS');
      // callback 路径无 tenant 上下文 → tryAudit 直接跳过（fail-open），audit log 0 次
    });

    it('refund SUCCESS → 调 handleRefundNotify', async () => {
      callback.handleRefundNotify.mockResolvedValueOnce({
        outTradeNo: ULID_A,
        outRefundNo: ULID_B,
        shouldTransitTo: '已退款',
        refundAmountCents: 50000,
      });
      const body = {
        kind: 'refund' as const,
        notifyBody: { out_trade_no: ULID_A, refund_status: 'SUCCESS' as const },
      };
      const r = await controller.wxpayCallback(
        body,
        reqWithHeaders('refund', body.notifyBody),
      );
      expect(r.code).toBe('SUCCESS');
      expect(callback.handleRefundNotify).toHaveBeenCalled();
    });

    it('payment 验签失败 → 抛 UnauthorizedException', async () => {
      callback.handlePaymentNotify.mockRejectedValueOnce(
        new UnauthorizedException('Invalid wxpay callback signature'),
      );
      const body = {
        kind: 'payment' as const,
        notifyBody: { out_trade_no: ULID_A },
        expectedAmountCents: 199900,
      };
      await expect(
        controller.wxpayCallback(body, reqWithHeaders('payment', body.notifyBody)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('payment 缺 notifyBody → 400', async () => {
      await expect(
        controller.wxpayCallback({} as never, makeReq({ headers })),
      ).rejects.toThrow(BadRequestException);
    });

    it('payment 缺 expectedAmountCents → 400', async () => {
      await expect(
        controller.wxpayCallback(
          {
            kind: 'payment',
            notifyBody: { out_trade_no: ULID_A } as never,
          } as never,
          makeReq({ headers }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('refund 缺 notifyBody → 400', async () => {
      await expect(
        controller.wxpayCallback({ kind: 'refund' } as never, makeReq({ headers })),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // POST /api/checkout/wxpay/close-order
  // ============================================================
  describe('closeOrder', () => {
    it('mock 模式（wxpay.closeOrder undefined）→ 400 friendly error', async () => {
      // mock client 没有 closeOrder
      delete wxpay.closeOrder;
      controller = buildController(); // rebuild with mock missing
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'admin',
          tenantId: 'tnnt0000000000000000000000000001',
          campusId: null,
        },
      });
      await expect(
        controller.closeOrder(
          {
            tenantId: 'tnnt0000000000000000000000000001',
            tenantSchema: 'tenant_tnnt0000000000000000000000000001',
            outTradeNo: ULID_A,
          },
          req,
        ),
      ).rejects.toThrow(/mock/);
    });

    it('real 模式 + admin → ok=true', async () => {
      wxpay.closeOrder = jest.fn().mockResolvedValueOnce(true);
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'admin',
          tenantId: 'tnnt0000000000000000000000000001',
          campusId: null,
        },
        body: { outTradeNo: ULID_A },
      });
      const r = await controller.closeOrder(
        {
          tenantId: 'tnnt0000000000000000000000000001',
          tenantSchema: 'tenant_tnnt0000000000000000000000000001',
          outTradeNo: ULID_A,
        },
        req,
      );
      expect(r).toEqual({ ok: true });
      expect(auditLog.log).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          action: 'wxpay.close-order.requested',
          targetId: ULID_A,
        }),
      );
    });

    it('non-admin → 403', async () => {
      wxpay.closeOrder = jest.fn();
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'sales',
          tenantId: 't',
          campusId: null,
        },
      });
      await expect(
        controller.closeOrder({ outTradeNo: ULID_A }, req),
      ).rejects.toThrow(ForbiddenException);
    });

    it('outTradeNo 非 32 字符 → 400', async () => {
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'admin',
          tenantId: 't',
          campusId: null,
        },
      });
      await expect(
        controller.closeOrder({ outTradeNo: 'short' }, req),
      ).rejects.toThrow(BadRequestException);
    });

    it('无 JWT → 401', async () => {
      await expect(
        controller.closeOrder({ outTradeNo: ULID_A }, makeReq()),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ============================================================
  // POST /api/checkout/wxpay/refund
  // ============================================================
  describe('refund', () => {
    const validRefundBody = {
      tenantId: 'tnnt0000000000000000000000000001',
      tenantSchema: 'tenant_tnnt0000000000000000000000000001',
      outTradeNo: ULID_A,
      outRefundNo: ULID_B,
      refundAmountCents: 50000,
      totalAmountCents: 199900,
      reason: '客户申请部分退款（A04 §3）',
    };

    it('finance happy path → 返 refundId + audit', async () => {
      wxpay.requestRefund.mockResolvedValueOnce({
        refundId: 'wx_refund_001',
        status: 'PROCESSING',
      });
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'finance',
          tenantId: 'tnnt0000000000000000000000000001',
          campusId: 'campus0001',
        },
        body: validRefundBody,
      });
      const r = await controller.refund(validRefundBody, req);
      expect(r.refundId).toBe('wx_refund_001');
      expect(r.status).toBe('PROCESSING');
      expect(r.outRefundNo).toBe(ULID_B);
      expect(auditLog.log).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          action: 'wxpay.refund.requested',
          targetType: 'payment_refund',
          targetId: ULID_B,
        }),
      );
    });

    it('outRefundNo 客户端不传 → 服务端生成 ULID', async () => {
      wxpay.requestRefund.mockResolvedValueOnce({
        refundId: 'wx_refund_001',
        status: 'PROCESSING',
      });
      const body = { ...validRefundBody };
      delete (body as { outRefundNo?: string }).outRefundNo;
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'finance',
          tenantId: 'tnnt0000000000000000000000000001',
          campusId: 'campus0001',
        },
        body,
      });
      const r = await controller.refund(body, req);
      expect(r.outRefundNo).toHaveLength(26); // ulid() 26 字符
    });

    it('refundAmount > totalAmount → 400', async () => {
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'finance',
          tenantId: 't',
          campusId: 'c',
        },
      });
      await expect(
        controller.refund(
          { ...validRefundBody, refundAmountCents: 200000 },
          req,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('reason 缺失 → 400', async () => {
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'finance',
          tenantId: 't',
          campusId: 'c',
        },
      });
      await expect(
        controller.refund({ ...validRefundBody, reason: '' }, req),
      ).rejects.toThrow(BadRequestException);
    });

    it('amount 非整数 → 400', async () => {
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'finance',
          tenantId: 't',
          campusId: 'c',
        },
      });
      await expect(
        controller.refund(
          { ...validRefundBody, refundAmountCents: 1.5 },
          req,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('wxpay.requestRefund 抛错 → audit failed + 透传', async () => {
      wxpay.requestRefund.mockRejectedValueOnce(new Error('wxpay refund net'));
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'finance',
          tenantId: 'tnnt0000000000000000000000000001',
          campusId: 'c',
        },
        body: validRefundBody,
      });
      await expect(controller.refund(validRefundBody, req)).rejects.toThrow();
      expect(auditLog.log).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          action: 'wxpay.refund.failed',
        }),
      );
    });

    it('无 JWT → 401（class-level RbacGuard 未介入时本 handler 显式校验）', async () => {
      await expect(
        controller.refund(validRefundBody, makeReq()),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ============================================================
  // audit_log fail-open
  // ============================================================
  describe('audit_log fail-open', () => {
    it('AuditLogRepository.log 抛错 → 不阻塞主业务（仍返 prepayId）', async () => {
      auditLog.log.mockRejectedValueOnce(new Error('PG down'));
      wxpay.createPrepay.mockResolvedValueOnce({
        prepayId: 'wx_prepay_001',
        jsApiParams: {
          timeStamp: '1',
          nonceStr: 'n',
          package: 'p',
          signType: 'RSA',
          paySign: 's',
        },
      });
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'admin',
          tenantId: 'tnnt0000000000000000000000000001',
          campusId: null,
        },
        body: {
          tenantSchema: 'tenant_tnnt0000000000000000000000000001',
          outTradeNo: ULID_A,
          openid: VALID_OPENID,
          amountCents: 199900,
          description: 'd',
          type: 'subscription' as const,
        },
      });
      const r = await controller.unifiedOrder(
        {
          tenantId: 'tnnt0000000000000000000000000001',
          tenantSchema: 'tenant_tnnt0000000000000000000000000001',
          outTradeNo: ULID_A,
          openid: VALID_OPENID,
          amountCents: 199900,
          description: 'd',
          type: 'subscription' as const,
        },
        req,
      );
      expect(r.prepayId).toBe('wx_prepay_001');
    });

    it('AuditLogRepository 未注入 → 不阻塞（@Optional）', async () => {
      controller = buildController({ withAudit: false });

      wxpay.createPrepay.mockResolvedValueOnce({
        prepayId: 'wx_prepay_001',
        jsApiParams: {
          timeStamp: '1',
          nonceStr: 'n',
          package: 'p',
          signType: 'RSA',
          paySign: 's',
        },
      });
      const req = makeReq({
        user: {
          sub: 'u',
          role: 'admin',
          tenantId: 'tnnt0000000000000000000000000001',
          campusId: null,
        },
      });
      const r = await controller.unifiedOrder(
        {
          tenantSchema: 'tenant_tnnt0000000000000000000000000001',
          outTradeNo: ULID_A,
          openid: VALID_OPENID,
          amountCents: 199900,
          description: 'd',
          type: 'subscription',
        },
        req,
      );
      expect(r.prepayId).toBe('wx_prepay_001');
    });
  });
});
