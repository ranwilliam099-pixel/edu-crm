import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import { ulid } from 'ulid';
import { HmacHasher } from '../../common/crypto/hmac-hasher';
import { AuditLogRepository, normalizeActorRole } from '../db/audit-log.repository';
import {
  InsertRefreshTokenInput,
  RefreshTokenRepository,
  RefreshTokenRow,
  RefreshTokenSubjectType,
} from './refresh-token.repository';

/**
 * RefreshTokenService — T11 refresh token 业务逻辑层
 *
 * 来源：2026-05-16 T11 architect spec §2 / §3 / §6
 *
 * 职责：
 *   1. issue() — login / wechat-login 后签发新 refresh token raw + 落库（hash）
 *   2. rotate() — POST /auth/refresh 调用：校验旧 token + 重放检测 + 撤销旧 + 签新
 *   3. revokeByRaw() — logout 调用：按 raw token 反查 hash + revoke
 *   4. @Cron cleanupExpired — 每日 03:00 清理 30 天前已过期 row
 *
 * Token 格式：
 *   - raw token = 32 bytes random（crypto.randomBytes(32)）→ base64url ≈ 43 chars
 *   - 数据库存 HMAC-SHA256(raw, HASH_KEY) 32 bytes BYTEA（不存明文，与 V40 parent.phone_hash 同模式）
 *
 * 失败语义（spec §2.3）：
 *   - INVALID（行不存在） → UnauthorizedException + audit auth.refresh.unknown-token
 *   - REVOKED（行已 revoked，被再次用）→ 触发重放检测：撤销 subject 全部 active token
 *                                          + UnauthorizedException + audit auth.refresh.replay-detected
 *   - EXPIRED（行已过期）→ UnauthorizedException + 不写 audit（spec §2.3 表格）
 */

/** 输入：签发新 refresh token（login / wechat-login 调用） */
export interface IssueRefreshInput {
  subjectType: RefreshTokenSubjectType;
  subjectId: string;
  tenantId: string | null;
  userAgent: string | null;
  ip: string | null;
}

/** 输出：raw token（仅返客户端一次）+ 元数据 */
export interface IssueRefreshOutput {
  refreshToken: string;
  refreshExpiresIn: number; // seconds
  jti: string;
}

/** rotate() 返回 — 不签新 access token（由 controller 调 jwtService 完成，因 audience 差异） */
export interface RotateResult {
  oldRow: RefreshTokenRow;
  newToken: IssueRefreshOutput;
}

/** raw token 形态校验范围（spec §2.2 step 1：length 20-200） */
const RAW_TOKEN_MIN = 20;
const RAW_TOKEN_MAX = 200;

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly hasher: HmacHasher,
    private readonly repo: RefreshTokenRepository,
    private readonly auditLog: AuditLogRepository,
  ) {}

  /**
   * 生成 raw refresh token（32 bytes random → base64url）
   * spec §2 + Token 格式
   */
  private generateRawToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * raw token → HMAC-SHA256 buffer
   * 不接受 null/undefined（service 内部使用）
   */
  private hashToken(raw: string): Buffer {
    const buf = this.hasher.hash(raw);
    if (!buf) {
      // 防御性：HmacHasher.hash(null/undefined) 才返 null，service 内部不会传
      throw new Error('RefreshTokenService: hasher returned null for non-null raw token');
    }
    return buf;
  }

  /**
   * 取 TTL 配置（B/C 端差异化）
   * spec §3.2
   */
  private getTtlSeconds(subjectType: RefreshTokenSubjectType): number {
    if (subjectType === 'b-user') {
      return this.config.get<number>('JWT_REFRESH_TTL_B_SEC', 604800); // 7d
    }
    return this.config.get<number>('JWT_REFRESH_TTL_PARENT_SEC', 2592000); // 30d
  }

  /**
   * 签发新 refresh token + 落库
   * 用于 login / wechat-login 后 + rotation 后
   */
  async issue(input: IssueRefreshInput): Promise<IssueRefreshOutput> {
    const raw = this.generateRawToken();
    const tokenHash = this.hashToken(raw);
    const jti = ulid();
    const ttlSec = this.getTtlSeconds(input.subjectType);
    const expiresAt = new Date(Date.now() + ttlSec * 1000);

    const dbInput: InsertRefreshTokenInput = {
      id: ulid(),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      tenantId: input.tenantId,
      tokenHash,
      jti,
      expiresAt,
      userAgent: input.userAgent,
      ip: input.ip,
    };

    await this.repo.insert(dbInput);

    return {
      refreshToken: raw,
      refreshExpiresIn: ttlSec,
      jti,
    };
  }

  /**
   * Rotation：POST /auth/refresh 主入口
   * spec §2.2 完整流程 + §3.3 重放检测
   *
   * 返回旧 row（含 subjectType/subjectId/tenantId）+ 新 token，
   * controller 用旧 row 信息签新 access token（audience 切分 + role/campusId 续期）
   */
  async rotate(
    rawToken: string,
    ctx: { userAgent: string | null; ip: string | null; requestId: string | null },
  ): Promise<RotateResult> {
    const tokenHash = this.hashToken(rawToken);
    const row = await this.repo.findByHash(tokenHash);

    // 行不存在 → 401 + audit unknown
    if (!row) {
      await this.tryAuditUnknown(ctx);
      throw new UnauthorizedException('INVALID_REFRESH_TOKEN');
    }

    // 已 revoked → 重放检测（spec §3.3）
    if (row.revokedAt !== null) {
      await this.handleReplay(row, ctx);
      throw new UnauthorizedException('REVOKED');
    }

    // 已过期 → 401（不写 audit，spec §2.3 表格）
    if (row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('EXPIRED');
    }

    // rotation：撤销旧 row + 签新 row
    // 注：spec §9.2 race condition 缓解通过 token_hash UNIQUE + revoked_at 检测，
    // 不引入 SELECT FOR UPDATE（避免与 spec §10 不实施 grace window 一致的最小变更原则）
    await this.repo.revoke(row.id);

    const newToken = await this.issue({
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      tenantId: row.tenantId,
      userAgent: ctx.userAgent,
      ip: ctx.ip,
    });

    await this.tryAuditSuccess(row, ctx);

    return { oldRow: row, newToken };
  }

  /**
   * logout 时按 raw token 撤销（spec §4.3）
   * 不抛错：raw 不匹配 / 行已 revoked 都安静返回（logout 幂等）
   */
  async revokeByRaw(rawToken: string): Promise<void> {
    const tokenHash = this.hashToken(rawToken);
    const row = await this.repo.findByHash(tokenHash);
    if (row && row.revokedAt === null) {
      await this.repo.revoke(row.id);
    }
  }

  /**
   * 重放检测处理（spec §3.3）
   * 旧 token 已 revoked 但被再次使用 → 撤销该 subject 全部 active refresh_tokens
   * + audit_log auth.refresh.replay-detected (severity high)
   */
  private async handleReplay(
    row: RefreshTokenRow,
    ctx: { userAgent: string | null; ip: string | null; requestId: string | null },
  ): Promise<void> {
    const revokedCount = await this.repo.revokeAllBySubject(
      row.subjectType,
      row.subjectId,
    );
    if (row.subjectType === 'b-user' && row.tenantId) {
      const schema = `tenant_${row.tenantId}`;
      // 与 tenant.middleware/audit-log.repository 同模式（fail-open，不阻塞 401）
      await this.auditLog.log(schema, {
        actorUserId: row.subjectId,
        actorRole: normalizeActorRole(null), // 'system' — refresh 路径无 JWT role
        action: 'auth.refresh.replay-detected',
        targetType: 'refresh_token',
        targetId: row.id,
        before: { revokedAt: row.revokedAt?.toISOString() },
        after: { revokedAllCount: revokedCount },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    } else {
      // C 端 parent — 走 pino（无 tenant audit_log），spec §10 排除「平台级 audit_log 表」
      this.logger.warn(
        `[refresh.replay-detected] subjectType=parent subjectId=${row.subjectId} revokedCount=${revokedCount}`,
      );
    }
  }

  /** rotation 成功 audit（B 端写 tenant audit_log；C 端不写表，spec §10） */
  private async tryAuditSuccess(
    row: RefreshTokenRow,
    ctx: { userAgent: string | null; ip: string | null; requestId: string | null },
  ): Promise<void> {
    if (row.subjectType !== 'b-user' || !row.tenantId) return;
    const schema = `tenant_${row.tenantId}`;
    await this.auditLog.log(schema, {
      actorUserId: row.subjectId,
      actorRole: normalizeActorRole(null), // 'system' — refresh 路径无 JWT role
      action: 'auth.refresh.success',
      targetType: 'refresh_token',
      targetId: row.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
  }

  /** unknown token audit — 平台级走 pino（无 tenant schema 可写） */
  private async tryAuditUnknown(ctx: {
    userAgent: string | null;
    ip: string | null;
    requestId: string | null;
  }): Promise<void> {
    // spec §2.3 表格 audit=是；但未知 token 无 subjectType / tenantId 可定位
    // → 走 pino（与 C 端 parent replay-detected 一致），不写 audit_log 表
    this.logger.warn(
      `[refresh.unknown-token] ip=${ctx.ip ?? 'unknown'} ua=${ctx.userAgent ?? 'unknown'} requestId=${ctx.requestId ?? 'unknown'}`,
    );
  }

  /**
   * raw token 形态校验（controller 入口用，但 service 本层也兜底以便单测覆盖）
   * spec §2.2 step 1
   */
  static isWellFormedRawToken(raw: unknown): raw is string {
    return (
      typeof raw === 'string' &&
      raw.length >= RAW_TOKEN_MIN &&
      raw.length <= RAW_TOKEN_MAX
    );
  }

  /**
   * cleanupExpired — 每日 03:00 清理 30 天前已过期 row
   * spec §7 + Runtime Wiring 验证（grep "@Cron" src/modules/auth/ = 1）
   */
  @Cron('0 3 * * *')
  async cleanupExpired(): Promise<void> {
    try {
      const deleted = await this.repo.cleanupExpired(30);
      this.logger.log(`[refresh.cleanup] deleted ${deleted} expired row(s)`);
    } catch (err) {
      // fail-open：cron 失败不应导致进程重启（与 audit_log 一致）
      this.logger.error(
        `[refresh.cleanup] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
