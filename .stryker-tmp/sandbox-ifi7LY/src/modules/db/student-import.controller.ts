import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  StudentImportRepository,
  StudentImportRow,
  StudentImportResult,
} from './student-import.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';

/**
 * StudentImportController — 学员批量导入
 *
 * 路由：
 *   POST /api/db/students/import  - 批量导入学员（事务批量，单行错误不阻塞）
 *
 * 鉴权：x-tenant-schema header
 *
 * Body：
 *   { rows: StudentImportRow[] (≤500), operatorUserId, campusId }
 */
@UseGuards(TenantScopeGuard)
@Controller('db/students')
export class StudentImportController {
  constructor(private readonly importRepo: StudentImportRepository) {}

  @Post('import')
  @HttpCode(HttpStatus.OK)
  async importStudents(
    @Headers('x-tenant-schema') tenantSchema: string,
    @Body()
    body: {
      rows: StudentImportRow[];
      operatorUserId: string;
      campusId: string;
    },
  ): Promise<StudentImportResult> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    if (!Array.isArray(body.rows)) {
      throw new BadRequestException('rows must be an array');
    }
    if (!body.operatorUserId) {
      throw new BadRequestException('operatorUserId required');
    }
    if (!body.campusId) {
      throw new BadRequestException('campusId required');
    }
    return this.importRepo.importStudents(tenantSchema, body.rows, {
      operatorUserId: body.operatorUserId,
      campusId: body.campusId,
    });
  }
}
