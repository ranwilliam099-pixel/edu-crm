import { Injectable } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';

/**
 * StudentImportRepository — V18 学员批量导入持久化层（tenant schema）
 *
 * 来源：用户 2026-05-04 endpoint #3（pages/b/student-import/import）
 *
 * 不新建表 — 复用 V2 students + customers + parents（public）
 *
 * 流程：
 *   1. 输入：N 行 row（最多 500）{ name, parentName, parentPhone, grade?, school?, primaryCampus?, subjects?, note? }
 *   2. 校验：每行手机号 11 位 / name / parentName / parentPhone 必填
 *   3. 事务批量插入：customer (parent) → student
 *      - 同一手机号已有 customer 则复用 customer.id
 *   4. 单行错误不阻塞其他行（catch + push errorRows）
 */

export interface StudentImportRow {
  name: string;
  parentName: string;
  parentPhone: string;
  grade?: string;
  school?: string;
  primaryCampus?: string;
  subjects?: string;
  note?: string;
}

export interface StudentImportError {
  row: number;
  error: string;
}

export interface StudentImportResult {
  successCount: number;
  errorRows: StudentImportError[];
}

@Injectable()
export class StudentImportRepository {
  constructor(private readonly pg: PgPoolService) {}

  /**
   * 校验单行（用纯函数便于单测）
   */
  validateRow(row: StudentImportRow): string | null {
    if (!row.name || row.name.trim().length === 0) {
      return 'name 必填';
    }
    if (!row.parentName || row.parentName.trim().length === 0) {
      return 'parentName 必填';
    }
    if (!row.parentPhone || row.parentPhone.trim().length === 0) {
      return 'parentPhone 必填';
    }
    if (!/^1[3-9]\d{9}$/.test(row.parentPhone.trim())) {
      return 'parentPhone 必须是 11 位手机号';
    }
    return null;
  }

  /**
   * 批量导入（事务批量，单行错误不阻塞）
   */
  async importStudents(
    tenantSchema: string,
    rows: ReadonlyArray<StudentImportRow>,
    options: {
      operatorUserId: string;
      campusId: string; // 默认 campus_id（students/customers 都需要）
    },
  ): Promise<StudentImportResult> {
    if (rows.length === 0) {
      return { successCount: 0, errorRows: [] };
    }
    if (rows.length > 500) {
      return {
        successCount: 0,
        errorRows: [{ row: 0, error: '一次最多导入 500 行' }],
      };
    }

    const errorRows: StudentImportError[] = [];
    let successCount = 0;

    return this.pg.withClient(async (client) => {
      try {
        await client.query(`SET search_path TO ${tenantSchema}, public`);

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const validationError = this.validateRow(row);
          if (validationError) {
            errorRows.push({ row: i + 1, error: validationError });
            continue;
          }

          try {
            // 1. 找/创建 customer（按 primary_mobile 匹配）
            const existing = await client.query(
              `SELECT id FROM customers WHERE primary_mobile = $1 LIMIT 1`,
              [row.parentPhone.trim()],
            );

            let customerId: string;
            if (existing.rowCount && existing.rowCount > 0) {
              customerId = existing.rows[0].id;
            } else {
              customerId = this.generateUlid();
              await client.query(
                `INSERT INTO customers (
                   id, parent_name, primary_mobile, campus_id, created_by, updated_by
                 ) VALUES ($1, $2, $3, $4, $5, $5)`,
                [
                  customerId,
                  row.parentName.trim(),
                  row.parentPhone.trim(),
                  options.campusId,
                  options.operatorUserId,
                ],
              );
            }

            // 2. 创建 student
            const studentId = this.generateUlid();
            await client.query(
              `INSERT INTO students (
                 id, student_name, grade_or_age, school_name, intended_subject,
                 customer_id, created_by, updated_by
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
              [
                studentId,
                row.name.trim(),
                row.grade || null,
                row.school || null,
                row.subjects || null,
                customerId,
                options.operatorUserId,
              ],
            );

            successCount++;
          } catch (e) {
            errorRows.push({
              row: i + 1,
              error: (e as Error).message || 'unknown error',
            });
          }
        }

        await client.query(`SET search_path TO public`);
        return { successCount, errorRows };
      } catch (e) {
        try {
          await client.query(`SET search_path TO public`);
        } catch {
          /* ignore */
        }
        throw e;
      }
    });
  }

  /**
   * 简单 ULID 生成器（32-char）— 用于内部 id
   * 测试性可被 mock 替换
   */
  private generateUlid(): string {
    const ts = Date.now().toString(16).padStart(8, '0');
    const rand = Array.from({ length: 24 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('');
    return (ts + rand).slice(0, 32);
  }
}
