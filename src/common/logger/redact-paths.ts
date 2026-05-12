/**
 * REDACT_PATHS — pino 日志 PII 脱敏路径
 *
 * 来源：用户 2026-05-10 「可上架生产架构」P0 第 3 项
 *       拍板「隐私分级一级（手机/身份证）」+ 安全审计要求
 *
 * 用法：pino redact 配置 → 命中路径的字段输出为 '[REDACTED]'
 *
 * 路径语法（fast-redact）：
 *   - 'req.headers.authorization' — 精确路径
 *   - '*.phone'                   — 通配任意层
 *   - 'res.headers["set-cookie"]' — 含特殊字符用 []
 */
export const REDACT_PATHS: string[] = [
  // ===== 请求头（鉴权类）=====
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-tenant-schema"]', // 含租户 schema 名（半敏感）

  // ===== 响应头（鉴权类）=====
  'res.headers["set-cookie"]',

  // ===== 请求体（凭证类）=====
  'req.body.password',
  'req.body.passwordConfirm',
  'req.body.oldPassword',
  'req.body.newPassword',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.accessToken',
  'req.body.access_token',
  'req.body.refresh_token',
  'req.body.code',
  'req.body.smsCode',
  'req.body.sms_code',
  'req.body.verificationCode',

  // ===== 通配（业务敏感字段，任意层级）=====
  '*.phone',
  '*.mobile',
  '*.id_number',
  '*.id_card',
  '*.idCard',
  '*.idNumber',
  '*.bank_card',
  '*.bankCard',
  '*.wechat',
  '*.we_chat',
  '*.password',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  '*.accessToken',
  '*.refreshToken',
  '*.session',
  '*.api_key',
  '*.apiKey',
  '*.secret',

  // ===== 微信小程序专用 =====
  '*.openid',
  '*.unionid',
  '*.session_key',
  '*.sessionKey',

  // ===== 加密字段（双重保险，已是密文但还是不打）=====
  '*.phone_encrypted',
  '*.phoneEncrypted',
  '*.wechat_encrypted',
  '*.wechatEncrypted',

  // ===== A02-3 round 2 (security WARNING #2 修复): PII 衍生物 =====
  // phone_hash 是 HMAC-SHA256(phone, HASH_KEY) 输出，等同身份标识
  // 持有 HASH_KEY 的人可暴力枚举 10^11 手机号空间反查 → 不能进日志
  '*.phone_hash',
  '*.phoneHash',
];
