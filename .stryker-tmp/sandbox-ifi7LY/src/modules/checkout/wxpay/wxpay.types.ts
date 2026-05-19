/**
 * 微信支付 V3 接口契约（W2-T1）— A02 拍板
 *
 * 接口契约源自微信支付 V3 官方文档 + A04 退款与发票责任链规约 V1.0
 * 不引用企业管理系统主项目任何支付实现（追加 #8 项目隔离）
 */

/** WxPayClient 接口 — Mock 与真实实现共用 */
export interface WxPayClient {
  /**
   * 创建预支付订单（JSAPI 下单）
   * 对应微信 V3 API: POST /v3/pay/transactions/jsapi
   */
  createPrepay(params: CreatePrepayParams): Promise<CreatePrepayResult>;

  /**
   * 校验回调签名（V3 SHA256-WITH-RSA + Timestamp/Nonce）
   * 对应微信 V3 文档: 通用规则 / 验签
   */
  verifyCallbackSignature(headers: CallbackHeaders, rawBody: string): Promise<boolean>;

  /**
   * 申请退款
   * 对应微信 V3 API: POST /v3/refund/domestic/refunds
   */
  requestRefund(params: RefundParams): Promise<RefundResult>;
}

/** 注入 token：DI 解耦 mock vs real（A02 通道枚举） */
export const WX_PAY_CLIENT = Symbol('WX_PAY_CLIENT');

export interface CreatePrepayParams {
  /** 公司主体 SaaS 订单号（payment_orders.id，ULID 32-char）*/
  outTradeNo: string;
  /** 用户 openid（前端 wx.login → code → openid 流程）*/
  openid: string;
  /** 金额（人民币分；1999 元 = 199900 分）*/
  amountCents: number;
  /** 商品描述（如 "教育培训行业销售 CRM 标准版年费"）*/
  description: string;
  /** 回调通知 URL（A04 §3 回调签名校验前置）*/
  notifyUrl: string;
  /**
   * 业务侧 tenantId（32-ULID）— 透传到 V3 attach 字段
   *
   * T9-FU-1（2026-05-16）：subscription 路径下 controller 传 req.user.tenantId,
   * 微信回调时 decrypted.attach 反查到 tenantId 推 subscription 解锁
   * （详见 wxpay.controller.ts:344-373 callback UPDATE 分支）
   *
   * parent-extra 路径不传（家长跨 tenant 加购，attach 不适用）
   */
  tenantId?: string;
}

export interface CreatePrepayResult {
  /** 微信返回的预支付 id（前端 JSAPI 调起支付用）*/
  prepayId: string;
  /** 调起 JSAPI 支付所需的 5 个参数（前端按这些组装 wx.requestPayment）*/
  jsApiParams: {
    timeStamp: string;
    nonceStr: string;
    package: string;       // "prepay_id=<id>"
    signType: 'RSA';
    paySign: string;
  };
}

export interface CallbackHeaders {
  'wechatpay-timestamp': string;
  'wechatpay-nonce': string;
  'wechatpay-serial': string;
  'wechatpay-signature': string;
}

export interface RefundParams {
  /** 原 SaaS 订单号 */
  outTradeNo: string;
  /** 退款单号（payment_refunds.id, ULID 32-char）*/
  outRefundNo: string;
  /** 退款金额（分）*/
  refundAmountCents: number;
  /** 原订单总金额（分）*/
  totalAmountCents: number;
  /** 退款原因（A04 §3 必填）*/
  reason: string;
}

export interface RefundResult {
  /** 微信退款单号 */
  refundId: string;
  /** A04 §5.2 状态映射：处理中=PROCESSING / 退款成功=SUCCESS / 退款关闭=CLOSED / 退款异常=ABNORMAL */
  status: 'PROCESSING' | 'SUCCESS' | 'CLOSED' | 'ABNORMAL';
}
