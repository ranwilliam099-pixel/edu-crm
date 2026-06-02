import { Injectable } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * ParentCommunicationRepository — V67 (SSOT §5.4) 教务家长沟通记录持久化层
 *
 * 来源：SSOT §5.4 parent_communication 家长沟通记录（5/16 拍板；2026-06-02 走查 B 定 spec）。
 *
 * 表：parent_communications（tenant schema，V67）
 *   id / student_id / campus_id / communication_date(DATE) /
 *   type(wechat|phone|in_person) / content(TEXT) / follow_up(TEXT 可空) /
 *   created_by(教务 user.id) / created_at / updated_at
 *
 * ⚠️ 与 V57 parent_communication（单数，家长 C 端咨询）是两个独立对象，勿混淆。
 *
 * 职责：
 *   - create()：建一条家长沟通记录（id 由 controller genId32 传入）。
 *   - listByStudent()：按学员维度倒序（communication_date DESC）列出，LEFT JOIN users 取 createdByName。
 *
 * 安全：全部 pg.tenantQuery（自动 SET search_path tenant_xxx, public）；
 *   campusId / created_by 由 controller 从 JWT 取（禁信前端），repo 不做权限只做数据。
 *   跨校校验复用 StudentRepository.findAssignmentInfo（students 表无 campus_id 列，
 *   学员校区随家庭主档 customers.campus_id 派生），不在本 repo。
 */

export type CommunicationType = 'wechat' | 'phone' | 'in_person';

export interface ParentCommunication {
  id: string;
  studentId: string;
  campusId: string;
  /** 沟通日期（YYYY-MM-DD；DATE 列无时区） */
  communicationDate: string;
  type: CommunicationType;
  content: string;
  followUp: string | null;
  createdBy: string;
  /** 记录教务姓名（读路径 LEFT JOIN users 派生；写 RETURNING 不含 → null） */
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ParentCommunicationRepository {
  constructor(private readonly pg: PgPoolService) {}

  private static formatDateOnly(value: unknown): string {
    if (value instanceof Date) {
      // pg DATE may arrive as a UTC timestamp for local midnight; format in business timezone.
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(value);
    }
    return String(value).slice(0, 10);
  }

  private static mapRow(row: PgRow): ParentCommunication {
    return {
      id: row.id,
      studentId: row.student_id,
      campusId: row.campus_id,
      // DATE 列：pg 驱动可能返回 Date 或字符串；统一取 YYYY-MM-DD（无时区漂移）
      communicationDate: ParentCommunicationRepository.formatDateOnly(row.communication_date),
      type: row.type as CommunicationType,
      content: row.content,
      followUp: row.follow_up ?? null,
      createdBy: row.created_by,
      createdByName: row.created_by_name ?? null,
      createdAt: row.created_at
        ? new Date(row.created_at).toISOString()
        : new Date(0).toISOString(),
      updatedAt: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(0).toISOString(),
    };
  }

  /** 写 RETURNING 列（裸；INSERT…RETURNING 不 JOIN → createdByName 写回 null） */
  private static readonly COLS = `id, student_id, campus_id, communication_date::text AS communication_date,
              type, content, follow_up, created_by, created_at, updated_at`;

  /** 读路径列（pc. 前缀 + LEFT JOIN users 取 created_by_name），与 READ_FROM 配套 */
  private static readonly COLS_PC = `pc.id, pc.student_id, pc.campus_id, pc.communication_date::text AS communication_date,
              pc.type, pc.content, pc.follow_up, pc.created_by, pc.created_at, pc.updated_at,
              u.name AS created_by_name`;
  private static readonly READ_FROM = `FROM parent_communications pc
            LEFT JOIN users u ON u.id = pc.created_by AND u.deleted_at IS NULL`;

  // ============================================================
  // 写：create（教务记录一条家长沟通）
  // ============================================================
  async create(
    tenantSchema: string,
    input: {
      id: string;
      studentId: string;
      campusId: string;
      communicationDate: string;
      type: CommunicationType;
      content: string;
      followUp: string | null;
      createdBy: string;
    },
  ): Promise<ParentCommunication> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `INSERT INTO parent_communications
         (id, student_id, campus_id, communication_date,
          type, content, follow_up, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING ${ParentCommunicationRepository.COLS}`,
      [
        input.id,
        input.studentId,
        input.campusId,
        input.communicationDate,
        input.type,
        input.content,
        input.followUp,
        input.createdBy,
      ],
    );
    return ParentCommunicationRepository.mapRow(rows[0]);
  }

  // ============================================================
  // 读：按学员维度列出（communication_date DESC）
  // ============================================================
  /**
   * 列出某学员的家长沟通记录，按 communication_date 倒序（最新优先）。
   *   LEFT JOIN users 取记录教务姓名（createdByName，姓名非一级 PII）。
   *   limit 默认 100 上限 200；offset 默认 0。
   */
  async listByStudent(
    tenantSchema: string,
    studentId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<ParentCommunication[]> {
    const limit = opts.limit ? Math.min(opts.limit, 200) : 100;
    const offset = opts.offset ?? 0;
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT ${ParentCommunicationRepository.COLS_PC}
         ${ParentCommunicationRepository.READ_FROM}
        WHERE pc.student_id = $1
        ORDER BY pc.communication_date DESC, pc.created_at DESC
        LIMIT $2 OFFSET $3`,
      [studentId, limit, offset],
    );
    return rows.map((r) => ParentCommunicationRepository.mapRow(r));
  }
}
