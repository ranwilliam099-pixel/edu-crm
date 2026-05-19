import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import {
  SecurityService,
  SecurityCheckResult,
  MsgSecScene,
} from './security.service';

/**
 * SecurityController — Sprint E.2 内容安全 2 项后端代理
 *
 * 来源：用户 2026-05-13 Sprint E.2 内容安全 2 项后端代理拍板
 *
 * 路由前缀：/api/security（B 端 JWT 鉴权 — 由 auth.module TenantMiddleware.forRoutes('*') 全局兜底）
 *
 * 端点：
 *   POST /api/security/msg-check  — 文本安全检测
 *   POST /api/security/img-check  — 图片安全检测（multipart/form-data 字段名 `image`）
 *
 * 鉴权（2026-05-13 round 2 三方 validator 共识 finding 修正）：
 *   - **TenantMiddleware 全局兜底**：/api/security/* 不在 /api/public/* 或 /api/checkout/* 白名单，
 *     落入 tenant.middleware「其他业务接口」分支，**强制 user.tenantId 非空**（B 端 JWT 必填）。
 *   - **不挂 TenantScopeGuard**：本 controller 不读 body.tenantSchema / query.tenantSchema，
 *     不需 tenant 数据隔离守门（msg-check / img-check 是平台级代理，调微信单 WX_APP_ID）。
 *   - **openid 来源**：当前接受 body.openid 由前端传（微信 API 强制要求 openid 防滥用）。
 *     ⚠️ Sprint E backlog: 后续 JwtPayload 加 openid 字段后，应改用 req.user.openid 覆盖
 *     body.openid（防攻击者持合法 JWT 传他人 openid 污染微信侧用户风险画像）。
 *   - **C 端家长场景**：parents 通过 ParentJwt（独立鉴权）调本 endpoint 当前会 401
 *     （ParentJwt 不含 tenantId）。如未来需 C 端家长直接调，需扩展 tenant.middleware
 *     白名单或 ParentJwt 兜底，本次不做。
 *   - 限流：app.module ThrottlerModule 全局 60/min default，本 controller 方法级覆盖
 *
 * 限流（Sprint E.1 @nestjs/throttler 全局 APP_GUARD ThrottlerGuard）：
 *   - msg-check: 30 req/min/IP（msgSecCheck 是高频文本场景，但每次调微信 access_token 限流敏感）
 *   - img-check: 10 req/min/IP（图片上传消耗带宽 + 微信侧 imgSecCheck 单 appId QPS 限制）
 *
 * 微信文档：
 *   https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/sec-check/security.msgSecCheck.html
 *   https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/sec-check/security.imgSecCheck.html
 */

// 微信 img_sec_check 单图最大 1MB（白名单：jpeg / jpg / png / gif / bmp）
const IMG_MAX_BYTES = 1 * 1024 * 1024;
const IMG_ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/bmp',
]);

// 微信 msgSecCheck 文本最大 2500 字符
const MSG_MAX_LENGTH = 2500;

// 微信 scene 枚举范围
const VALID_SCENES = new Set([1, 2, 3, 4]);

// openid 微信合法格式（28 字符 base64-like；放宽到 20-64 防未来微信变更）
const OPENID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

@Controller('security')
export class SecurityController {
  private readonly logger = new Logger(SecurityController.name);

  constructor(private readonly security: SecurityService) {}

  /**
   * POST /api/security/msg-check — 文本安全检测
   *
   * Body: {
   *   content: string   // 待检测文本，1-2500 字
   *   openid: string    // 微信 openid，20-64 字符
   *   scene?: 1|2|3|4   // 1=资料 2=评论 3=论坛 4=社交日志（默认 1）
   * }
   *
   * 返回：SecurityCheckResult
   *   ok=true 通过；ok=false 时 suggest=risky 违规 / suggest=review 需复查
   *
   * 限流：覆盖全局 default 60/min → 30/min（文本检测高频，但每次调微信 access_token 限流敏感）
   */
  @Post('msg-check')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async msgCheck(
    @Body()
    body: {
      content?: string;
      openid?: string;
      scene?: number;
    },
  ): Promise<SecurityCheckResult> {
    const content = body?.content;
    const openid = body?.openid;
    const scene = body?.scene ?? MsgSecScene.PROFILE;

    if (!content || typeof content !== 'string') {
      throw new BadRequestException('content is required (string, 1-2500 chars)');
    }
    if (content.length === 0 || content.length > MSG_MAX_LENGTH) {
      throw new BadRequestException(
        `content length must be 1-${MSG_MAX_LENGTH} chars`,
      );
    }
    // Sprint X.2 round 25 (2026-05-19): openid 改可选, B 端员工无 openid 走 v1 server-mode
    //   原硬要 openid 让 B 端 customer/staff 创建时 msgSecCheck 永 400 → 内容安全审查失效 (合规风险)
    //   修: 无 openid 时空字符串传给 service, service 走 v1 server-side check (microsoft msgsec v1 支持无 openid)
    //   有 openid 时仍校验格式 (防 garbage 注入微信 API)
    if (openid && (typeof openid !== 'string' || !OPENID_PATTERN.test(openid))) {
      throw new BadRequestException(
        'openid format invalid (20-64 chars, A-Za-z0-9_-) — 可不传 (B 端员工)',
      );
    }
    if (typeof scene !== 'number' || !VALID_SCENES.has(scene)) {
      throw new BadRequestException('scene must be one of 1/2/3/4');
    }

    return this.security.msgSecCheck(content, openid || '', scene as MsgSecScene);
  }

  /**
   * POST /api/security/img-check — 图片安全检测
   *
   * multipart/form-data:
   *   image: File         // 待检测图片，<=1MB，jpeg/png/gif/bmp
   *   openid: string      // 微信 openid
   *
   * 返回：SecurityCheckResult
   *   ok=true 通过；ok=false 时 suggest=risky 违规 / suggest=review 需复查
   *
   * 限流：覆盖全局 default 60/min → 10/min（图片上传消耗带宽 + 微信 imgSecCheck 单 appId QPS 限制）
   */
  @Post('img-check')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: IMG_MAX_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!IMG_ALLOWED_MIME.has(file.mimetype)) {
          cb(
            new BadRequestException(
              `mime not allowed: ${file.mimetype} (allowed: jpeg/png/gif/bmp)`,
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  async imgCheck(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('openid') openid: string | undefined,
  ): Promise<SecurityCheckResult> {
    if (!file) {
      throw new BadRequestException('image field is required (multipart/form-data)');
    }
    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('image buffer is empty');
    }
    if (file.size > IMG_MAX_BYTES) {
      throw new BadRequestException(`image size > ${IMG_MAX_BYTES} bytes`);
    }
    if (!openid || typeof openid !== 'string' || !OPENID_PATTERN.test(openid)) {
      throw new BadRequestException(
        'openid is required (20-64 chars, A-Za-z0-9_-)',
      );
    }

    return this.security.imgSecCheck(file.buffer, openid, file.mimetype);
  }
}
