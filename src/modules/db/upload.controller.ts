import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * UploadController — 通用文件上传 endpoint（V25 自建 nginx 方案）
 *
 * 路径：POST /api/db/upload  multipart/form-data 字段名 `file`
 *
 * 流程：
 *   1. multer 接收文件流（最大 10 MB；扩展名白名单）
 *   2. 落盘 /home/ubuntu/uploads/<tenantId>/<yyyymm>/<random>.<ext>
 *   3. 返回 { url: 'https://minxin.top/uploads/<tenantId>/...' }（备案前用 http://1.14.127.67/uploads/）
 *
 * 配置（.env）：
 *   UPLOAD_DIR=/home/ubuntu/uploads
 *   UPLOAD_PUBLIC_BASE=http://1.14.127.67/uploads
 *   UPLOAD_MAX_BYTES=20971520  （20 MB；覆盖 30s 压缩视频）
 *
 * 安全：
 *   - TenantScopeGuard 强制 JWT 携带 tenantId（防匿名滥用磁盘）
 *   - 图片 + 视频白名单（jpg/jpeg/png/webp/gif/mp4/mov/webm）
 *   - 文件名 random ULID + 扩展名（防 path traversal）
 *   - 大小硬上限 20 MB
 */
@Controller('db')
@UseGuards(TenantScopeGuard)
export class UploadController {
  private readonly logger = new Logger(UploadController.name);

  static readonly ALLOWED_EXT = new Set([
    '.jpg', '.jpeg', '.png', '.webp', '.gif',
    '.mp4', '.mov', '.webm',
  ]);
  static readonly DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

  constructor(private readonly config: ConfigService) {}

  static getUploadDir(config?: ConfigService): string {
    return (
      config?.get<string>('UPLOAD_DIR') ||
      process.env.UPLOAD_DIR ||
      '/home/ubuntu/uploads'
    );
  }

  static getPublicBase(config?: ConfigService): string {
    return (
      config?.get<string>('UPLOAD_PUBLIC_BASE') ||
      process.env.UPLOAD_PUBLIC_BASE ||
      'http://1.14.127.67/uploads'
    );
  }

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (req: any, _file, cb) => {
          const tenantId =
            (req as AuthenticatedRequest).user?.tenantId || 'unknown';
          const ym = new Date().toISOString().slice(0, 7).replace('-', '');
          const dir = path.join(
            UploadController.getUploadDir(),
            tenantId,
            ym,
          );
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname).toLowerCase();
          const id = crypto.randomBytes(16).toString('hex');
          cb(null, `${id}${ext}`);
        },
      }),
      limits: { fileSize: UploadController.DEFAULT_MAX_BYTES },
      fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!UploadController.ALLOWED_EXT.has(ext)) {
          cb(new BadRequestException(`扩展名不支持：${ext}`), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ ok: true; url: string; size: number; mimeType: string }> {
    if (!file) {
      throw new BadRequestException('file 字段必填（multipart/form-data）');
    }
    const tenantId = req.user?.tenantId || 'unknown';
    const ym = new Date().toISOString().slice(0, 7).replace('-', '');
    const url = `${UploadController.getPublicBase(this.config)}/${tenantId}/${ym}/${file.filename}`;
    this.logger.log(
      `[UPLOAD] tenant=${tenantId} size=${file.size}B file=${file.filename}`,
    );
    return {
      ok: true,
      url,
      size: file.size,
      mimeType: file.mimetype,
    };
  }
}
