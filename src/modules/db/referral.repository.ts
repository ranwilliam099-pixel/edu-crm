import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * ReferralRepository — V22 家长推荐家长（V10 策略 #17-22）
 *
 * 业务约束：
 *   - A 必须是该老师当前学员家长（create 时校验：teacher 与 referrer_student 有 active binding）
 *   - B 唯一（一个家长 parent_id 只能被一个 referral 引用）
 *   - 状态机：created → trialed → rated；30 天未 trialed → expired
 *   - 计数 = 老师维度 status='rated' 的总数
 */

export type ReferralStatus = 'created' | 'trialed' | 'rated' | 'expired';
export type RatingSource = 'lesson_feedback' | 'parent_recommendation';

export interface ParentReferral {
  id: string;
  teacherId: string;
  referrerParentId: string;
  referrerStudentId: string;
  refereeParentId: string | null;
  refereeStudentId: string | null;
  referralCode: string;
  status: ReferralStatus;
  trialScheduleId: string | null;
  ratingId: string | null;
  ratingIdSource: RatingSource | null;
  createdAt: string;
  trialedAt: string | null;
  ratedAt: string | null;
  expiresAt: string;
  note: string | null;
}

@Injectable()
export class ReferralRepository {
  constructor(private readonly pg: PgPoolService) {}

  static mapRow(r: PgRow): ParentReferral {
    return {
      id: r.id,
      teacherId: r.teacher_id,
      referrerParentId: r.referrer_parent_id,
      referrerStudentId: r.referrer_student_id,
      refereeParentId: r.referee_parent_id,
      refereeStudentId: r.referee_student_id,
      referralCode: r.referral_code,
      status: r.status as ReferralStatus,
      trialScheduleId: r.trial_schedule_id,
      ratingId: r.rating_id,
      ratingIdSource: r.rating_id_source as RatingSource | null,
      createdAt: new Date(r.created_at).toISOString(),
      trialedAt: r.trialed_at ? new Date(r.trialed_at).toISOString() : null,
      ratedAt: r.rated_at ? new Date(r.rated_at).toISOString() : null,
      expiresAt: new Date(r.expires_at).toISOString(),
      note: r.note,
    };
  }

  /**
   * 创建推荐 — A 给老师生成新推荐码
   * 必须先校验 A 是该老师学员家长（在 service 层用 parent_student_bindings + teacher_id 校验）
   */
  async create(
    tenantSchema: string,
    payload: {
      id: string;
      teacherId: string;
      referrerParentId: string;
      referrerStudentId: string;
      referralCode: string;
      note?: string;
    },
  ): Promise<ParentReferral> {
    if (!payload.id || payload.id.length !== 32) {
      throw new BadRequestException('referral id must be 32-char ULID');
    }
    if (!payload.referralCode || payload.referralCode.length < 6) {
      throw new BadRequestException('referralCode must be ≥6 chars');
    }
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO parent_referrals
         (id, teacher_id, referrer_parent_id, referrer_student_id, referral_code, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        payload.id,
        payload.teacherId,
        payload.referrerParentId,
        payload.referrerStudentId,
        payload.referralCode,
        payload.note || null,
      ],
    );
    return ReferralRepository.mapRow(rows[0]);
  }

  async findByCode(tenantSchema: string, code: string): Promise<ParentReferral | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT * FROM parent_referrals WHERE referral_code = $1 LIMIT 1`,
      [code],
    );
    return rows.length === 0 ? null : ReferralRepository.mapRow(rows[0]);
  }

  async findById(tenantSchema: string, id: string): Promise<ParentReferral | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT * FROM parent_referrals WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : ReferralRepository.mapRow(rows[0]);
  }

  async listByReferrer(
    tenantSchema: string,
    referrerParentId: string,
    limit = 50,
  ): Promise<ParentReferral[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT * FROM parent_referrals
         WHERE referrer_parent_id = $1
         ORDER BY created_at DESC LIMIT $2`,
      [referrerParentId, limit],
    );
    return rows.map((r) => ReferralRepository.mapRow(r));
  }

  async listByTeacher(
    tenantSchema: string,
    teacherId: string,
    options: { status?: ReferralStatus; limit?: number } = {},
  ): Promise<ParentReferral[]> {
    const limit = options.limit ?? 100;
    if (options.status) {
      const rows = await this.pg.tenantQuery<any>(
        tenantSchema,
        `SELECT * FROM parent_referrals
           WHERE teacher_id = $1 AND status = $2
           ORDER BY created_at DESC LIMIT $3`,
        [teacherId, options.status, limit],
      );
      return rows.map((r) => ReferralRepository.mapRow(r));
    }
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT * FROM parent_referrals
         WHERE teacher_id = $1
         ORDER BY created_at DESC LIMIT $2`,
      [teacherId, limit],
    );
    return rows.map((r) => ReferralRepository.mapRow(r));
  }

  /**
   * markTrialed — B 通过 code 完成首次试听
   * 状态机：created → trialed
   * 校验：B 唯一（UNIQUE INDEX 自动校验）+ status 必须 created
   */
  async markTrialed(
    tenantSchema: string,
    code: string,
    args: {
      refereeParentId: string;
      refereeStudentId: string;
      trialScheduleId: string;
    },
  ): Promise<ParentReferral> {
    return this.pg.transaction(
      async (client) => {
        const findRows = await client.query(
          `SELECT * FROM parent_referrals
             WHERE referral_code = $1 FOR UPDATE`,
          [code],
        );
        if (findRows.rows.length === 0) {
          throw new NotFoundException(`REFERRAL_NOT_FOUND: ${code}`);
        }
        const cur = findRows.rows[0];
        if (cur.status !== 'created') {
          throw new ConflictException(`REFERRAL_INVALID_STATE: ${cur.status}`);
        }
        if (new Date(cur.expires_at) < new Date()) {
          throw new ConflictException('REFERRAL_EXPIRED');
        }
        if (cur.referrer_parent_id === args.refereeParentId) {
          throw new BadRequestException('REFEREE_CANNOT_BE_REFERRER');
        }
        try {
          const updRows = await client.query(
            `UPDATE parent_referrals
                SET status = 'trialed',
                    referee_parent_id = $1,
                    referee_student_id = $2,
                    trial_schedule_id = $3,
                    trialed_at = NOW()
              WHERE referral_code = $4 AND status = 'created'
            RETURNING *`,
            [
              args.refereeParentId,
              args.refereeStudentId,
              args.trialScheduleId,
              code,
            ],
          );
          if (updRows.rows.length === 0) {
            throw new ConflictException('REFERRAL_RACE');
          }
          return ReferralRepository.mapRow(updRows.rows[0]);
        } catch (e: any) {
          if (e?.code === '23505' || /uq_pr_referee_parent/.test(e.message || '')) {
            throw new ConflictException('REFEREE_ALREADY_REFERRED');
          }
          throw e;
        }
      },
      { tenantSchema },
    );
  }

  /**
   * markRated — B 评价老师 → 计数 +1
   * 状态机：trialed → rated
   */
  async markRated(
    tenantSchema: string,
    refereeParentId: string,
    teacherId: string,
    rating: { id: string; source: RatingSource },
  ): Promise<ParentReferral | null> {
    return this.pg.transaction(
      async (client) => {
        const findRows = await client.query(
          `SELECT * FROM parent_referrals
             WHERE referee_parent_id = $1
               AND teacher_id = $2
               AND status = 'trialed'
             FOR UPDATE`,
          [refereeParentId, teacherId],
        );
        if (findRows.rows.length === 0) return null;

        const updRows = await client.query(
          `UPDATE parent_referrals
              SET status = 'rated',
                  rating_id = $1,
                  rating_id_source = $2,
                  rated_at = NOW()
            WHERE id = $3
          RETURNING *`,
          [rating.id, rating.source, findRows.rows[0].id],
        );
        return ReferralRepository.mapRow(updRows.rows[0]);
      },
      { tenantSchema },
    );
  }

  /**
   * 老师维度推荐计数（业务卡 stats 用）
   * @returns rated（已计数）+ trialed（已试听待评价）+ pending（等 B 试听）
   */
  async getTeacherStats(
    tenantSchema: string,
    teacherId: string,
  ): Promise<{ rated: number; trialed: number; pending: number; expired: number }> {
    const rows = await this.pg.tenantQuery<{ status: ReferralStatus; count: string }>(
      tenantSchema,
      `SELECT status, COUNT(*) AS count
         FROM parent_referrals
        WHERE teacher_id = $1
        GROUP BY status`,
      [teacherId],
    );
    const out = { rated: 0, trialed: 0, pending: 0, expired: 0 };
    for (const r of rows) {
      const c = parseInt(r.count, 10);
      if (r.status === 'rated') out.rated = c;
      else if (r.status === 'trialed') out.trialed = c;
      else if (r.status === 'created') out.pending = c;
      else if (r.status === 'expired') out.expired = c;
    }
    return out;
  }

  /**
   * 校验 A 是否该老师学员家长（service 层 create 前调用）
   */
  async assertReferrerIsTeacherStudentParent(
    tenantSchema: string,
    teacherId: string,
    referrerParentId: string,
    referrerStudentId: string,
  ): Promise<void> {
    // 1) 校验 student 是该老师学员（schedule_students 有 active 排课，或 student_teacher_bindings active）
    // 简化：用 student_teacher_bindings.active
    const bindingRows = await this.pg.tenantQuery<{ count: string }>(
      tenantSchema,
      `SELECT COUNT(*) AS count FROM student_teacher_bindings
         WHERE teacher_id = $1 AND student_id = $2 AND status = 'active'`,
      [teacherId, referrerStudentId],
    );
    if (parseInt(bindingRows[0]?.count || '0', 10) === 0) {
      throw new BadRequestException(
        'REFERRER_NOT_TEACHER_STUDENT_PARENT: student not bound to teacher',
      );
    }
    // 2) 校验 parent 是该 student 的家长（public.parent_student_bindings）
    const psbRows = await this.pg.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM public.parent_student_bindings
         WHERE parent_id = $1 AND student_id = $2`,
      [referrerParentId, referrerStudentId],
    );
    if (parseInt(psbRows[0]?.count || '0', 10) === 0) {
      throw new BadRequestException(
        'REFERRER_NOT_TEACHER_STUDENT_PARENT: parent not bound to student',
      );
    }
  }

  /**
   * cron 巡检：created + 已过期 → expired
   */
  async expirePending(tenantSchema: string): Promise<number> {
    const rows = await this.pg.tenantQuery<{ id: string }>(
      tenantSchema,
      `UPDATE parent_referrals
          SET status = 'expired'
        WHERE status = 'created' AND expires_at < NOW()
      RETURNING id`,
    );
    return rows.length;
  }
}
