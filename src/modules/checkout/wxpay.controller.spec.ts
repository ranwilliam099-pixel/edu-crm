import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
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
  let config: { get: jest.Mock; getOrThrow: jest.Mock };
  let pg: { query: jest.Mock };

  // T9-FU-1 round 2 (2026-05-16 production-validator SPEC GAP)：
  //   buildController 加 pg 可选参数，使 V3 callback subscription UPDATE
  //   分支 (wxpay.controller.ts:355-384) 在单测可被覆盖
  function buildController(opts: { withAudit?: boolean; withPg?: boolean } = {}): WxPayController {
    const withAudit = opts.withAudit ?? true;
    const withPg = opts.withPg ?? false;
    return new WxPayController(
      wxpay as never,
      callback as never,
      withAudit ? (auditLog as never) : undefined,
      config as never,
      withPg ? (pg as never) : undefined,
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
    pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    config = {
      get: jest.fn((k: string) => {
        if (k === 'WXPAY_NOTIFY_URL') {
          return 'https://api.minxin.top/api/checkout/callbacks/wxpay';
        }
        return undefined;
      }),
      // T9-FU-1 round 2：decryptV3Resource 用 getOrThrow 拉 WXPAY_API_V3_KEY
      getOrThrow: jest.fn((k: string) => {
        if (k === 'WXPAY_API_V3_KEY') {
          return '01234567890123456789012345678901'; // 32-char 测试密钥
        }
        throw new Error(`config.getOrThrow miss key=${k}`);
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
      // T9-FU-1 (2026-05-16)：subscription 路径 createPrepay input 必须含
      // tenantId（用 req.user.tenantId 来源；body.tenantId 仅做 owner-check 不直接信任）
      expect(wxpay.createPrepay).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tnnt0000000000000000000000000001',
        }),
      );
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
      // T9-FU-1 round 2 (business+security 共识 finding)：audit after 必含 tenantId
      // 来源 JWT (req.user.tenantId)，不需要 JOIN auditor->users 表对账
      expect(auditCall.after.tenantId).toBe('tnnt0000000000000000000000000001');
    });

    it('T9-FU-1: parent-extra 路径 → createPrepay input 不含 tenantId（家长跨 tenant 加购，attach 不适用）', async () => {
      wxpay.createPrepay.mockResolvedValueOnce({
        prepayId: 'wx_prepay_parent',
        jsApiParams: {
          timeStamp: '1700000000',
          nonceStr: 'n',
          package: 'prepay_id=wx_prepay_parent',
          signType: 'RSA',
          paySign: 'sig',
        },
      });
      const body = { ...validSubBody, type: 'parent-extra' as const };
      const req = makeReq({ body });
      (req as { parent?: object }).parent = {
        sub: 'par1',
        parentId: 'par1',
        role: 'parent',
      };
      await controller.unifiedOrder(body, req);
      expect(wxpay.createPrepay).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: undefined,
        }),
      );
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

    // ============================================================
    // V3 原生协议分支 — T9-FU-1 round 2 (production-validator SPEC GAP)
    //
    // 业务闭环验证：attach=tenantId 透传 → callback 解密 → UPDATE public.tenants
    //   wxpay.controller.ts:355-384 subscription UPDATE 路径之前 0 spec 覆盖
    //   T9-FU-1 业务价值（subscription_status='trial' → 'active'）必须有测试断言
    // ============================================================
    describe('V3 原生协议分支（T9-FU-1 业务闭环）', () => {
      const APIV3_KEY = '01234567890123456789012345678901'; // 与 config.getOrThrow 一致
      const TENANT_ID = 'tnnt0000000000000000000000000001';

      /**
       * 用真实 AES-256-GCM 加密构造 V3 resource，避免 spec 与 controller 解密
       * 实现走两套（mock 私有 method 会 false-positive）
       */
      function encryptV3Resource(
        payload: Record<string, unknown>,
        associatedData = 'transaction',
      ) {
        const nonce = '012345678901'; // 12-byte for GCM
        const cipher = crypto.createCipheriv(
          'aes-256-gcm',
          Buffer.from(APIV3_KEY, 'utf8'),
          Buffer.from(nonce, 'utf8'),
        );
        cipher.setAAD(Buffer.from(associatedData, 'utf8'));
        const encrypted = Buffer.concat([
          cipher.update(JSON.stringify(payload), 'utf8'),
          cipher.final(),
        ]);
        const authTag = cipher.getAuthTag();
        const ciphertext = Buffer.concat([encrypted, authTag]).toString('base64');
        return {
          algorithm: 'AEAD_AES_256_GCM',
          ciphertext,
          associated_data: associatedData,
          nonce,
        };
      }

      it('attach=tenantId + trade_state=SUCCESS → pg.query UPDATE subscription_status=active', async () => {
        controller = buildController({ withPg: true });
        wxpay.verifyCallbackSignature.mockResolvedValueOnce(true);
        const resource = encryptV3Resource({
          out_trade_no: ULID_A,
          trade_state: 'SUCCESS',
          attach: TENANT_ID,
          transaction_id: '4200001234202605160001',
          amount: { total: 199900 },
        });
        const r = await controller.wxpayCallback(
          { id: 'evt_001', event_type: 'TRANSACTION.SUCCESS', resource } as never,
          makeReq({ headers }),
        );
        expect(r.code).toBe('SUCCESS');
        // T9-FU-1 业务闭环：attach → callback 解密 → pg UPDATE active
        expect(pg.query).toHaveBeenCalledTimes(1);
        const [sql, params] = pg.query.mock.calls[0];
        expect(sql).toContain("subscription_status='active'");
        expect(sql).toContain("INTERVAL '365 days'");
        expect(params).toEqual([TENANT_ID]);
      });

      it('attach 缺失 + trade_state=SUCCESS → 跳过 UPDATE（log warn 不抛）', async () => {
        controller = buildController({ withPg: true });
        wxpay.verifyCallbackSignature.mockResolvedValueOnce(true);
        const resource = encryptV3Resource({
          out_trade_no: ULID_A,
          trade_state: 'SUCCESS',
          transaction_id: '4200001234202605160002',
          amount: { total: 199900 },
          // attach 字段刻意不传（platform_admin / 旧订单回滚场景）
        });
        const r = await controller.wxpayCallback(
          { id: 'evt_002', event_type: 'TRANSACTION.SUCCESS', resource } as never,
          makeReq({ headers }),
        );
        expect(r.code).toBe('SUCCESS');
        expect(pg.query).not.toHaveBeenCalled(); // attach 缺失 → 跳过 UPDATE
      });

      it('attach 非 32-ULID（长度不对）+ trade_state=SUCCESS → 跳过 UPDATE', async () => {
        controller = buildController({ withPg: true });
        wxpay.verifyCallbackSignature.mockResolvedValueOnce(true);
        const resource = encryptV3Resource({
          out_trade_no: ULID_A,
          trade_state: 'SUCCESS',
          attach: 'not-a-valid-ulid', // 长度不对，attach 校验 length===32 失败
          transaction_id: '4200001234202605160003',
          amount: { total: 199900 },
        });
        const r = await controller.wxpayCallback(
          { id: 'evt_003', event_type: 'TRANSACTION.SUCCESS', resource } as never,
          makeReq({ headers }),
        );
        expect(r.code).toBe('SUCCESS');
        expect(pg.query).not.toHaveBeenCalled();
      });

      it('pg 未注入（this.pg=undefined）+ trade_state=SUCCESS → 跳过 UPDATE（fail-open）', async () => {
        controller = buildController({ withPg: false }); // pg 不注入
        wxpay.verifyCallbackSignature.mockResolvedValueOnce(true);
        const resource = encryptV3Resource({
          out_trade_no: ULID_A,
          trade_state: 'SUCCESS',
          attach: TENANT_ID,
          transaction_id: '4200001234202605160004',
          amount: { total: 199900 },
        });
        const r = await controller.wxpayCallback(
          { id: 'evt_004', event_type: 'TRANSACTION.SUCCESS', resource } as never,
          makeReq({ headers }),
        );
        // pg.query 不应被调（this.pg=undefined 时 L355 if 短路）
        expect(r.code).toBe('SUCCESS');
        expect(pg.query).not.toHaveBeenCalled();
      });

      it('pg UPDATE 抛错 → fail-open（仍返 SUCCESS，避免微信重试）', async () => {
        controller = buildController({ withPg: true });
        pg.query.mockRejectedValueOnce(new Error('pg connection failed'));
        wxpay.verifyCallbackSignature.mockResolvedValueOnce(true);
        const resource = encryptV3Resource({
          out_trade_no: ULID_A,
          trade_state: 'SUCCESS',
          attach: TENANT_ID,
          transaction_id: '4200001234202605160005',
          amount: { total: 199900 },
        });
        const r = await controller.wxpayCallback(
          { id: 'evt_005', event_type: 'TRANSACTION.SUCCESS', resource } as never,
          makeReq({ headers }),
        );
        // fail-open：UPDATE 失败不阻塞 callback 返 SUCCESS（微信侧不重试）
        expect(r.code).toBe('SUCCESS');
        expect(pg.query).toHaveBeenCalledTimes(1);
      });

      it('验签失败 → callback 返 FAIL，不解密不 UPDATE', async () => {
        controller = buildController({ withPg: true });
        wxpay.verifyCallbackSignature.mockResolvedValueOnce(false);
        const resource = encryptV3Resource({
          out_trade_no: ULID_A,
          trade_state: 'SUCCESS',
          attach: TENANT_ID,
          transaction_id: '4200001234202605160006',
          amount: { total: 199900 },
        });
        const r = await controller.wxpayCallback(
          { id: 'evt_006', event_type: 'TRANSACTION.SUCCESS', resource } as never,
          makeReq({ headers }),
        );
        expect(r.code).toBe('FAIL');
        expect(pg.query).not.toHaveBeenCalled();
      });
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
