import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * CourseProductRepository — 课程产品管理（V2 course_products）
 *
 * 来源：用户 2026-05-07 Phase 5「全做」— 校长/老板可补课程产品库
 *
 * 注：V29 销售签约可自填 courseProductName 不强制选既有产品；本表仍作为
 * 「机构标准产品库」给校长/老板预设常用产品（销售可选择性使用）。
 */

export interface CourseProduct {
  id: string;
  productName: string;
  courseLine: string;
  classType: string;
  lessonPackage: string | null;
  standardPrice: number;
  campusScope: string | null;
  status: '上架' | '下架';
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class CourseProductRepository {
  constructor(private readonly pg: PgPoolService) {}

  static mapRow(r: PgRow): CourseProduct {
    return {
      id: r.id,
      productName: r.product_name,
      courseLine: r.course_line,
      classType: r.class_type,
      lessonPackage: r.lesson_package,
      standardPrice: Number(r.standard_price),
      campusScope: r.campus_scope,
      status: r.status as '上架' | '下架',
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  /**
   * 列产品 — 默认仅上架（销售签约时下拉用）；admin 管理时可看下架
   */
  async list(
    tenantSchema: string,
    options: { includeOffShelf?: boolean; limit?: number; offset?: number } = {},
  ): Promise<CourseProduct[]> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const where = options.includeOffShelf ? '' : `WHERE status = '上架'`;
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM course_products
         ${where}
         ORDER BY status DESC, created_at DESC
         LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map((r) => CourseProductRepository.mapRow(r));
  }

  async findById(tenantSchema: string, id: string): Promise<CourseProduct | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM course_products WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : CourseProductRepository.mapRow(rows[0]);
  }

  /**
   * 创建产品（校长/老板预设）
   *
   * 唯一性：product_name + status='上架'（已有 V2 unique index）— 重复 → 409
   */
  async create(
    tenantSchema: string,
    payload: {
      id: string;
      productName: string;
      courseLine: string;
      classType: string;
      lessonPackage?: string | null;
      standardPrice: number;
      campusScope?: string | null;
      operatorUserId: string;
    },
  ): Promise<CourseProduct> {
    if (!payload.id || payload.id.length !== 32) {
      throw new BadRequestException('id must be 32-char ULID');
    }
    if (!payload.productName) throw new BadRequestException('productName required');
    if (!payload.courseLine) throw new BadRequestException('courseLine required');
    if (!payload.classType) throw new BadRequestException('classType required');
    if (payload.standardPrice < 0) throw new BadRequestException('standardPrice must be ≥ 0');

    try {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `INSERT INTO course_products
           (id, product_name, course_line, class_type, lesson_package,
            standard_price, campus_scope, status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'上架',$8,$8)
         RETURNING *`,
        [
          payload.id,
          payload.productName,
          payload.courseLine,
          payload.classType,
          payload.lessonPackage || null,
          payload.standardPrice,
          payload.campusScope || null,
          payload.operatorUserId,
        ],
      );
      return CourseProductRepository.mapRow(rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictException(`产品名「${payload.productName}」上架重复`);
      }
      throw e;
    }
  }

  /**
   * 切换上架/下架
   */
  async setStatus(
    tenantSchema: string,
    id: string,
    status: '上架' | '下架',
    operatorUserId: string,
  ): Promise<CourseProduct> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `UPDATE course_products
          SET status = $1, updated_at = NOW(), updated_by = $2
        WHERE id = $3
      RETURNING *`,
      [status, operatorUserId, id],
    );
    if (rows.length === 0) throw new NotFoundException(`course_product ${id} not found`);
    return CourseProductRepository.mapRow(rows[0]);
  }
}
