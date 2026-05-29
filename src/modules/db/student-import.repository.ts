import { Injectable } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';
import { FieldEncryptor } from '../../common/crypto/field-encryptor';
import { HmacHasher } from '../../common/crypto/hmac-hasher';

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
 *
 * V41 三写双读（A02-4，2026-05-13）：
 *   - customers.primary_mobile + primary_mobile_hash + primary_mobile_encrypted 三轨
 *   - 查重 SELECT：hash 列优先（生产路径）+ 明文 fallback（兼容期 backfill 未完成）
 *   - 新建 INSERT：明文 + hash + encrypted 三列同事务一并写
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
  constructor(
    private readonly pg: PgPoolService,
    private readonly encryptor: FieldEncryptor,
    private readonly hasher: HmacHasher,
  ) {}

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
    // 2026-05-29 全面检测 P0: tenantSchema 直接进 SET search_path，必须正则校验防 SQL 注入
    //   （与 pg-pool.service.ts:70 同护栏；本 repo 用 withClient 绕过了 tenantQuery 的校验 → 漏网之鱼）
    if (!tenantSchema || !/^tenant_[a-z0-9_]+$/.test(tenantSchema)) {
      throw new Error('invalid tenant schema');
    }
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
            //    V41 A02-4：优先 hash 列查询（生产路径）+ fallback 明文兼容期
            //    backfill 未完成的老行 primary_mobile_hash=NULL → hash 查不到 → 走明文 fallback
            const mobilePlain = row.parentPhone.trim();
            const mobileHash = this.hasher.hash(mobilePlain);
            let existing = await client.query(
              `SELECT id FROM customers WHERE primary_mobile_hash = $1 LIMIT 1`,
              [mobileHash],
            );
            if (!existing.rowCount || existing.rowCount === 0) {
              // backfill 未完成的老行兼容（旧明文列仍 UNIQUE，可查到）
              existing = await client.query(
                `SELECT id FROM customers WHERE primary_mobile = $1 LIMIT 1`,
                [mobilePlain],
              );
            }

            let customerId: string;
            if (existing.rowCount && existing.rowCount > 0) {
              customerId = existing.rows[0].id;
            } else {
              customerId = this.generateUlid();
              // V41 A02-4：三写 primary_mobile + primary_mobile_hash + primary_mobile_encrypted
              const mobileEncrypted = this.encryptor.encrypt(mobilePlain);
              await client.query(
                `INSERT INTO customers (
                   id, parent_name,
                   primary_mobile, primary_mobile_hash, primary_mobile_encrypted,
                   campus_id, created_by, updated_by
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
                [
                  customerId,
                  row.parentName.trim(),
                  mobilePlain,
                  mobileHash,
                  mobileEncrypted,
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
