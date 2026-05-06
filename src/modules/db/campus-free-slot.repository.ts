import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * CampusFreeSlotRepository — V23 C 端校区赠送 slot（FCFS）
 *
 * 业务规则（V10 策略）：
 *   - 每校区 10 slot，新校区自动 init（trigger）
 *   - FCFS 抢占：第一个调用 claim 的家长拿到第一个空槽
 *   - 3 个月免费 → expires_at = granted_at + 3 months
 *   - 过期后家长需自付 ¥9.9/月 或加入集采
 *   - 校区可主动 release（释放给排队家长）
 */

export type FreeSlotStatus = 'empty' | 'occupied' | 'expired';

export interface CampusFreeSlot {
  id: number;
  campusId: string;
  slotIndex: number;
  parentId: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  status: FreeSlotStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class CampusFreeSlotRepository {
  constructor(private readonly pg: PgPoolService) {}

  static mapRow(r: PgRow): CampusFreeSlot {
    return {
      id: Number(r.id),
      campusId: r.campus_id,
      slotIndex: Number(r.slot_index),
      parentId: r.parent_id,
      grantedAt: r.granted_at ? new Date(r.granted_at).toISOString() : null,
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      status: r.status as FreeSlotStatus,
      version: Number(r.version),
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  /**
   * 列出校区所有 slot（运营查看占用情况）
   */
  async listByCampus(campusId: string): Promise<CampusFreeSlot[]> {
    const rows = await this.pg.query<any>(
      `SELECT * FROM public.campus_free_slots
        WHERE campus_id = $1
        ORDER BY slot_index ASC`,
      [campusId],
    );
    return rows.map((r) => CampusFreeSlotRepository.mapRow(r));
  }

  /**
   * 校区 slot 占用统计
   */
  async getCampusStats(campusId: string): Promise<{
    total: number;
    occupied: number;
    empty: number;
    expired: number;
  }> {
    const rows = await this.pg.query<{ status: FreeSlotStatus; count: string }>(
      `SELECT status, COUNT(*) AS count
         FROM public.campus_free_slots
        WHERE campus_id = $1
        GROUP BY status`,
      [campusId],
    );
    const out = { total: 0, occupied: 0, empty: 0, expired: 0 };
    for (const r of rows) {
      const c = parseInt(r.count, 10);
      out.total += c;
      if (r.status === 'occupied') out.occupied = c;
      else if (r.status === 'empty') out.empty = c;
      else if (r.status === 'expired') out.expired = c;
    }
    return out;
  }

  /**
   * FCFS 抢占：原子查最小 slot_index 的 empty 槽 + UPDATE
   *
   * @returns 抢到的 slot；若校区已满 throw ConflictException
   */
  async claim(
    campusId: string,
    parentId: string,
    durationMonths = 3,
  ): Promise<CampusFreeSlot> {
    return this.pg.transaction(async (client) => {
      // 检查家长是否已有 slot（防一家长占多槽）
      const existing = await client.query(
        `SELECT id FROM public.campus_free_slots
           WHERE parent_id = $1 AND status = 'occupied'`,
        [parentId],
      );
      if (existing.rows.length > 0) {
        throw new ConflictException('PARENT_ALREADY_HAS_SLOT');
      }

      // 抢最小 slot_index 的 empty/expired 槽
      const findRows = await client.query(
        `SELECT * FROM public.campus_free_slots
           WHERE campus_id = $1 AND status IN ('empty', 'expired')
           ORDER BY slot_index ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
        [campusId],
      );
      if (findRows.rows.length === 0) {
        throw new ConflictException('CAMPUS_SLOT_EXHAUSTED');
      }
      const slot = findRows.rows[0];

      const grantedAt = new Date();
      const expiresAt = new Date(grantedAt);
      expiresAt.setUTCMonth(expiresAt.getUTCMonth() + durationMonths);

      const updRows = await client.query(
        `UPDATE public.campus_free_slots
            SET parent_id = $1,
                status = 'occupied',
                granted_at = $2,
                expires_at = $3,
                version = version + 1,
                updated_at = NOW()
          WHERE id = $4 AND status IN ('empty', 'expired')
        RETURNING *`,
        [parentId, grantedAt, expiresAt, slot.id],
      );
      if (updRows.rows.length === 0) {
        // race lost
        throw new ConflictException('SLOT_RACE_LOST');
      }
      return CampusFreeSlotRepository.mapRow(updRows.rows[0]);
    });
  }

  /**
   * 校区运营 release：释放 occupied 槽（家长不再激活/校区主动取消）
   */
  async release(slotId: number): Promise<CampusFreeSlot> {
    const rows = await this.pg.query<any>(
      `UPDATE public.campus_free_slots
          SET parent_id = NULL,
              status = 'empty',
              granted_at = NULL,
              expires_at = NULL,
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1 AND status = 'occupied'
      RETURNING *`,
      [slotId],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`slot ${slotId} not occupied`);
    }
    return CampusFreeSlotRepository.mapRow(rows[0]);
  }

  /**
   * cron 巡检：occupied + expires_at < NOW → expired
   */
  async expirePending(): Promise<number> {
    const rows = await this.pg.query<{ id: string }>(
      `UPDATE public.campus_free_slots
          SET status = 'expired',
              version = version + 1,
              updated_at = NOW()
        WHERE status = 'occupied' AND expires_at < NOW()
      RETURNING id`,
    );
    return rows.length;
  }

  /**
   * 家长查自己的 slot（不存在返回 null）
   */
  async findByParent(parentId: string): Promise<CampusFreeSlot | null> {
    const rows = await this.pg.query<any>(
      `SELECT * FROM public.campus_free_slots
         WHERE parent_id = $1 AND status IN ('occupied', 'expired')
         ORDER BY granted_at DESC LIMIT 1`,
      [parentId],
    );
    return rows.length === 0 ? null : CampusFreeSlotRepository.mapRow(rows[0]);
  }
}
