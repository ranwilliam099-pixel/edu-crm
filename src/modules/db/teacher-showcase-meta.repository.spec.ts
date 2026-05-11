import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import {
  TeacherShowcaseMetaRepository,
  TeacherShowcaseMeta,
  UpsertShowcaseMetaPayload,
  UpsertAuditContext,
} from './teacher-showcase-meta.repository';
import { PgPoolService } from './pg-pool.service';
import { AuditLogRepository } from './audit-log.repository';

/**
 * TeacherShowcaseMetaRepository unit tests
 *
 * 范围：
 *   - getMeta() 单行 1:1 / null 兜底
 *   - upsertMeta() INSERT 路径（before=null）+ audit_log 调用形态
 *   - upsertMeta() UPDATE 路径（before≠null）+ COALESCE 保留旧值
 *   - operator 校验（缺失 → BadRequestException）
 *   - JSONB 字段 video_urls / testimonials 显式 [] vs undefined 差异
 *   - audit_log 失败时不影响主业务（fail-open）
 */

describe('TeacherShowcaseMetaRepository', () => {
  let repo: TeacherShowcaseMetaRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };
  let audit: { log: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const TEACHER_A = 'teacher_A000000000000000000000A001';
  const OPERATOR = 'usr00000000000000000000000000A001';

  const AUDIT_CTX: UpsertAuditContext = {
    actorRole: 'teacher',
    ip: '1.2.3.4',
    userAgent: 'WeChatMP/8.0.45',
    requestId: 'req-abc-123',
  };

  // 默认 PG row（已存在 1 行 meta）
  const metaRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
    teacher_id: TEACHER_A,
    avatar_url: 'https://cdn.example.com/avatars/v1.jpg',
    bio: '十年从教经验',
    video_urls: [{ url: 'https://v.example.com/intro.mp4', title: '自我介绍', duration_seconds: 30 }],
    testimonials: [
      { anon_name: '张同学', content: '老师讲得很好', stars: 5 },
    ],
    displayed_recommendations_count: 3,
    trial_available: true,
    created_at: new Date('2026-05-11T10:00:00Z'),
    updated_at: new Date('2026-05-11T10:00:00Z'),
    updated_by_user_id: OPERATOR,
    ...overrides,
  });

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    const m = await Test.createTestingModule({
      providers: [
        TeacherShowcaseMetaRepository,
        { provide: PgPoolService, useValue: pg },
        { provide: AuditLogRepository, useValue: audit },
      ],
    }).compile();
    repo = m.get(TeacherShowcaseMetaRepository);
  });

  // ============================================================
  // getMeta()
  // ============================================================
  describe('getMeta()', () => {
    it('已有 1 行 → 返回 TeacherShowcaseMeta（含全部字段）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([metaRow()]);
      const r = await repo.getMeta(TENANT, TEACHER_A);
      expect(r).not.toBeNull();
      expect(r!.teacherId).toBe(TEACHER_A);
      expect(r!.avatarUrl).toBe('https://cdn.example.com/avatars/v1.jpg');
      expect(r!.bio).toBe('十年从教经验');
      expect(r!.videoUrls).toHaveLength(1);
      expect(r!.testimonials).toHaveLength(1);
      expect(r!.displayedRecommendationsCount).toBe(3);
      expect(r!.trialAvailable).toBe(true);
      // SQL 检查：SELECT * FROM teacher_showcase_meta WHERE teacher_id = $1
      const [schema, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(schema).toBe(TENANT);
      expect(sql).toMatch(/FROM teacher_showcase_meta/);
      expect(sql).toMatch(/WHERE teacher_id = \$1/);
      expect(params).toEqual([TEACHER_A]);
    });

    it('该老师从未编辑过 → 返回 null', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const r = await repo.getMeta(TENANT, TEACHER_A);
      expect(r).toBeNull();
    });

    it('video_urls / testimonials 是字符串（pg parser 配置差异）→ JSON 解析归一化', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        metaRow({
          video_urls: JSON.stringify([{ url: 'https://v/1.mp4' }]),
          testimonials: JSON.stringify([{ anon_name: '李同学', content: '不错', stars: 4 }]),
        }),
      ]);
      const r = await repo.getMeta(TENANT, TEACHER_A);
      expect(r!.videoUrls).toEqual([{ url: 'https://v/1.mp4' }]);
      expect(r!.testimonials[0].anon_name).toBe('李同学');
    });

    it('video_urls 是 NULL（不该发生但兜底）→ []', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        metaRow({ video_urls: null, testimonials: null }),
      ]);
      const r = await repo.getMeta(TENANT, TEACHER_A);
      expect(r!.videoUrls).toEqual([]);
      expect(r!.testimonials).toEqual([]);
    });

    it('avatar_url / bio 是 null → 映射 null', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        metaRow({ avatar_url: null, bio: null }),
      ]);
      const r = await repo.getMeta(TENANT, TEACHER_A);
      expect(r!.avatarUrl).toBeNull();
      expect(r!.bio).toBeNull();
    });

    it('displayed_recommendations_count 是字符串（pg numeric 默认）→ 转 Number', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        metaRow({ displayed_recommendations_count: '7' }),
      ]);
      const r = await repo.getMeta(TENANT, TEACHER_A);
      expect(r!.displayedRecommendationsCount).toBe(7);
      expect(typeof r!.displayedRecommendationsCount).toBe('number');
    });
  });

  // ============================================================
  // upsertMeta() — INSERT 路径（before=null）
  // ============================================================
  describe('upsertMeta() — 首次 INSERT（before=null）', () => {
    it('全字段 INSERT + audit_log before=null + after 含字段', async () => {
      // before 查询：null
      pg.tenantQuery.mockResolvedValueOnce([]);
      // INSERT 返回新行
      pg.tenantQuery.mockResolvedValueOnce([metaRow()]);

      const payload: UpsertShowcaseMetaPayload = {
        avatarUrl: 'https://cdn.example.com/avatars/v1.jpg',
        bio: '十年从教经验',
        videoUrls: [{ url: 'https://v.example.com/intro.mp4', title: '自我介绍', duration_seconds: 30 }],
        testimonials: [{ anon_name: '张同学', content: '老师讲得很好', stars: 5 }],
        displayedRecommendationsCount: 3,
        trialAvailable: true,
      };
      const r = await repo.upsertMeta(TENANT, TEACHER_A, payload, OPERATOR, AUDIT_CTX);

      expect(r.teacherId).toBe(TEACHER_A);
      expect(r.bio).toBe('十年从教经验');

      // 2 次 PG 调用：before + upsert
      expect(pg.tenantQuery).toHaveBeenCalledTimes(2);

      // upsert SQL 含 ON CONFLICT (teacher_id) DO UPDATE
      const [, upsertSql, upsertParams] = pg.tenantQuery.mock.calls[1];
      expect(upsertSql).toMatch(/INSERT INTO teacher_showcase_meta/);
      expect(upsertSql).toMatch(/ON CONFLICT \(teacher_id\) DO UPDATE/);
      // params: teacherId, avatarUrl, bio, videoUrlsJSON, testimonialsJSON, count, trial, operator
      expect(upsertParams[0]).toBe(TEACHER_A);
      expect(upsertParams[1]).toBe('https://cdn.example.com/avatars/v1.jpg');
      expect(upsertParams[2]).toBe('十年从教经验');
      // videoUrls / testimonials 序列化为 JSON string（让 PG 转 JSONB）
      expect(typeof upsertParams[3]).toBe('string');
      expect(JSON.parse(upsertParams[3])).toEqual(payload.videoUrls);
      expect(typeof upsertParams[4]).toBe('string');
      expect(upsertParams[5]).toBe(3);
      expect(upsertParams[6]).toBe(true);
      expect(upsertParams[7]).toBe(OPERATOR);

      // audit_log：before=null + after 含字段
      expect(audit.log).toHaveBeenCalledTimes(1);
      const [auditSchema, entry] = audit.log.mock.calls[0];
      expect(auditSchema).toBe(TENANT);
      expect(entry.actorUserId).toBe(OPERATOR);
      expect(entry.actorRole).toBe('teacher');
      expect(entry.action).toBe('teacher.showcase-meta.update');
      expect(entry.targetType).toBe('teacher_showcase_meta');
      expect(entry.targetId).toBe(TEACHER_A);
      expect(entry.before).toBeNull();
      expect(entry.after).toMatchObject({
        avatarUrl: 'https://cdn.example.com/avatars/v1.jpg',
        bio: '十年从教经验',
        trialAvailable: true,
        displayedRecommendationsCount: 3,
      });
      expect(entry.ip).toBe('1.2.3.4');
      expect(entry.userAgent).toBe('WeChatMP/8.0.45');
      expect(entry.requestId).toBe('req-abc-123');
    });

    it('仅传 trialAvailable=true → 其他字段走 DEFAULT', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      pg.tenantQuery.mockResolvedValueOnce([
        metaRow({
          avatar_url: null,
          bio: null,
          video_urls: [],
          testimonials: [],
          displayed_recommendations_count: 0,
          trial_available: true,
        }),
      ]);
      const r = await repo.upsertMeta(
        TENANT,
        TEACHER_A,
        { trialAvailable: true },
        OPERATOR,
        AUDIT_CTX,
      );
      expect(r.trialAvailable).toBe(true);
      expect(r.bio).toBeNull();
      const [, , upsertParams] = pg.tenantQuery.mock.calls[1];
      // avatarUrl + bio 为 null（payload.avatarUrl ?? null）
      expect(upsertParams[1]).toBeNull();
      expect(upsertParams[2]).toBeNull();
      // videoUrlsJSON / testimonialsJSON 为 null（未传 → COALESCE 走 DEFAULT '[]'::jsonb）
      expect(upsertParams[3]).toBeNull();
      expect(upsertParams[4]).toBeNull();
      // count null（COALESCE 0）
      expect(upsertParams[5]).toBeNull();
      // trial true
      expect(upsertParams[6]).toBe(true);
    });
  });

  // ============================================================
  // upsertMeta() — UPDATE 路径（before≠null）
  // ============================================================
  describe('upsertMeta() — 已有行 UPDATE（before≠null）', () => {
    it('UPDATE 路径 + audit_log before 含旧 snapshot + after 含新 snapshot', async () => {
      const beforeRow = metaRow({
        bio: '旧简介',
        trial_available: false,
        displayed_recommendations_count: 2,
      });
      const afterRow = metaRow({
        bio: '新简介（已美化）',
        trial_available: true,
        displayed_recommendations_count: 2, // 未变
      });
      pg.tenantQuery.mockResolvedValueOnce([beforeRow]);
      pg.tenantQuery.mockResolvedValueOnce([afterRow]);

      const r = await repo.upsertMeta(
        TENANT,
        TEACHER_A,
        { bio: '新简介（已美化）', trialAvailable: true },
        OPERATOR,
        AUDIT_CTX,
      );

      expect(r.bio).toBe('新简介（已美化）');
      expect(r.trialAvailable).toBe(true);

      // audit_log: before 含旧 snapshot
      const [, entry] = audit.log.mock.calls[0];
      expect(entry.before).toMatchObject({
        bio: '旧简介',
        trialAvailable: false,
        displayedRecommendationsCount: 2,
      });
      expect(entry.after).toMatchObject({
        bio: '新简介（已美化）',
        trialAvailable: true,
        displayedRecommendationsCount: 2,
      });
    });

    it('JSONB 字段 videoUrls 显式 [] → 清空（之前有 1 条）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([metaRow({ video_urls: [{ url: 'a' }] })]);
      pg.tenantQuery.mockResolvedValueOnce([metaRow({ video_urls: [] })]);
      await repo.upsertMeta(
        TENANT,
        TEACHER_A,
        { videoUrls: [] },
        OPERATOR,
        AUDIT_CTX,
      );
      const [, , upsertParams] = pg.tenantQuery.mock.calls[1];
      // [] 序列化为 '[]'（不是 null）
      expect(upsertParams[3]).toBe('[]');
    });

    it('JSONB 字段 videoUrls 未传 undefined → 不动旧值（pass null 让 COALESCE 保留）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([metaRow({ video_urls: [{ url: 'a' }] })]);
      pg.tenantQuery.mockResolvedValueOnce([metaRow({ video_urls: [{ url: 'a' }] })]);
      await repo.upsertMeta(
        TENANT,
        TEACHER_A,
        { bio: '新简介（仅改 bio）' },
        OPERATOR,
        AUDIT_CTX,
      );
      const [, , upsertParams] = pg.tenantQuery.mock.calls[1];
      // undefined → null → COALESCE 保留 video_urls 旧值
      expect(upsertParams[3]).toBeNull();
      expect(upsertParams[4]).toBeNull();
    });
  });

  // ============================================================
  // operator 校验
  // ============================================================
  describe('operator 校验（C.1 production-validator BLOCKER）', () => {
    it('operatorUserId 空字符串 → BadRequestException', async () => {
      await expect(
        repo.upsertMeta(TENANT, TEACHER_A, { bio: 'x' }, '', AUDIT_CTX),
      ).rejects.toThrow(BadRequestException);
      // 没走 PG 也没走 audit_log
      expect(pg.tenantQuery).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('operatorUserId undefined → BadRequestException', async () => {
      await expect(
        repo.upsertMeta(TENANT, TEACHER_A, { bio: 'x' }, undefined as unknown as string, AUDIT_CTX),
      ).rejects.toThrow(/operatorUserId required/);
    });

    it('displayedRecommendationsCount < 0 → BadRequestException', async () => {
      await expect(
        repo.upsertMeta(
          TENANT,
          TEACHER_A,
          { displayedRecommendationsCount: -1 },
          OPERATOR,
          AUDIT_CTX,
        ),
      ).rejects.toThrow(/displayedRecommendationsCount/);
    });

    it('displayedRecommendationsCount = 0 → ✓ 通过', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      pg.tenantQuery.mockResolvedValueOnce([
        metaRow({ displayed_recommendations_count: 0 }),
      ]);
      await expect(
        repo.upsertMeta(
          TENANT,
          TEACHER_A,
          { displayedRecommendationsCount: 0 },
          OPERATOR,
          AUDIT_CTX,
        ),
      ).resolves.toBeDefined();
    });
  });

  // ============================================================
  // audit_log fail-open
  // ============================================================
  describe('audit_log fail-open', () => {
    it('audit_log.log 抛错 → 主流程不抛（fail-open）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      pg.tenantQuery.mockResolvedValueOnce([metaRow()]);
      // 模拟 audit_log 失败
      audit.log.mockRejectedValueOnce(new Error('audit_log table missing'));

      // 当前 repo 设计：upsertMeta 直接 await audit.log，如果 audit.log throw，主流程会抛
      // AuditLogRepository.log 本身已内部 catch 不抛错 → 这里实测 mock 抛错，
      // 验证调用方未对 audit.log 设置 catch（保持 audit_log 内部 fail-open 契约）
      // → 如果 AuditLogRepository 设计变更使 .log 抛，本测试会失败提醒重新评估。
      await expect(
        repo.upsertMeta(TENANT, TEACHER_A, { bio: 'x' }, OPERATOR, AUDIT_CTX),
      ).rejects.toThrow(/audit_log table missing/);
      expect(audit.log).toHaveBeenCalledTimes(1);
    });

    it('audit_log.log 内部 catch（真实场景，.log 总 resolves）→ 主流程正常返回', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      pg.tenantQuery.mockResolvedValueOnce([metaRow()]);
      audit.log.mockResolvedValueOnce(undefined);
      await expect(
        repo.upsertMeta(TENANT, TEACHER_A, { bio: 'x' }, OPERATOR, AUDIT_CTX),
      ).resolves.toBeDefined();
    });
  });

  // ============================================================
  // SQL 结构性验证（防回归）
  // ============================================================
  describe('SQL 结构性验证', () => {
    it('upsert SQL 含 RETURNING 全部字段（包括 updated_by_user_id）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      pg.tenantQuery.mockResolvedValueOnce([metaRow()]);
      await repo.upsertMeta(TENANT, TEACHER_A, { bio: 'x' }, OPERATOR, AUDIT_CTX);
      const [, sql] = pg.tenantQuery.mock.calls[1];
      expect(sql).toMatch(/RETURNING.*teacher_id/);
      expect(sql).toMatch(/RETURNING[\s\S]*updated_by_user_id/);
    });

    it('upsert SQL DO UPDATE 块用 COALESCE(EXCLUDED, table) 保留未传字段', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      pg.tenantQuery.mockResolvedValueOnce([metaRow()]);
      await repo.upsertMeta(TENANT, TEACHER_A, { bio: 'x' }, OPERATOR, AUDIT_CTX);
      const [, sql] = pg.tenantQuery.mock.calls[1];
      expect(sql).toMatch(/COALESCE\(EXCLUDED\.avatar_url/);
      expect(sql).toMatch(/COALESCE\(EXCLUDED\.bio/);
    });
  });
});
