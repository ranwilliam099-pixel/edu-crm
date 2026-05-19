import { Module } from '@nestjs/common';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';
import { InvoiceRepository } from './invoice.repository';

/**
 * InvoiceModule — Wave 4A B 端 finance 域开票
 *
 * 来源：用户 2026-05-14 Wave 4 P0-2 拍板
 *
 * 路径：/api/db/invoices/*
 *
 * 依赖（通过 @Global() 自动解析）：
 *   - PgPoolService            DbModule（@Global）
 *   - FieldEncryptor           DbModule（@Global，A02-2/A02-3 共享）
 *   - HmacHasher               DbModule（@Global，A02-3）
 *   - AuditLogRepository       DbModule（@Global，V33）
 *   - SecurityService          SecurityModule（@Global，Sprint E.2）
 *
 * 与 checkout 模块完全独立：
 *   - checkout/invoice.service.ts 是 C 端自助开票（user → checkout → 申请发票）
 *   - 本 module 是 B 端 finance 手动开票（finance 主动给已签合同开票）
 *
 * 路由前缀：
 *   src/main.ts 全局 setGlobalPrefix('api')
 *   InvoiceController 路径 'db/invoices' → /api/db/invoices/*
 */
@Module({
  controllers: [InvoiceController],
  providers: [InvoiceService, InvoiceRepository],
  exports: [InvoiceService, InvoiceRepository],
})
export class InvoiceModule {}
