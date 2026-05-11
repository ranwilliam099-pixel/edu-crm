import { BadRequestException } from '@nestjs/common';
import { TeacherShowcaseController } from './teacher-showcase.controller';
import { TeacherShowcaseRepository } from './teacher-showcase.repository';
import { TeacherRepository } from './teacher.repository';
import { TeacherShowcaseMetaRepository } from './teacher-showcase-meta.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * TeacherShowcaseController unit tests (C.2 Sprint)
 *
 * 范围：
 *   - GET /showcase 三层结构：{ teacher, summary, meta }
 *   - GET /showcase bio/avatar 双源 fallback (meta 优先 → teacher legacy → null)
 *   - PUT /showcase-meta 写入 + audit ctx 透传
 *   - PUT 校验：operatorUserId 缺失 / tenantSchema 缺失 / teacher 不存在
 *   - PUT 字段校验：avatarUrl/bio 上限 / videoUrls 上限 / testimonials stars 范围
 *   - 双轨硬红线：summary 字段不被 meta 覆写
 */

describe('TeacherShowcaseController (C.2)', () => {
  let controller: TeacherShowcaseController;
  let showcaseRepo: { getSummary: jest.Mock };
  let teacherRepo: { findById: jest.Mock };
  let metaRepo: { getMeta: jest.Mock; upsertMeta: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const TEACHER_A = 'teacher_A000000000000000000000A001';
  const ADMIN = 'usr00000000000000000000000000A001';

  const baseSummary = {
    totalLessons: 200,
    totalStudents: 35,
    activeStudents: 18,
    monthlyLessons: 24,
    avgStars: 4.6,
    ratingCount: 18,
    recommendRate: 92,
    topTags: ['耐心', '专业'],
    renewalRate: 75,
    monthlyAReportRate: 65,
    cases: [{ anonName: '张同学', grade: 'A', story: '提分明显' }],
    isColdStart: false,
  };

  const baseTeacher = {
    id: TEACHER_A,
    campusId: 'campus_A_00000000000000000000A001',
    name: '王老师',
    phone: '13800000000',
    subjects: ['数学'],
    hourlyPriceYuan: 200,
    status: '在职',
  };

  const baseMeta = {
    teacherId: TEACHER_A,
    avatarUrl: 'https://cdn.example.com/avatar.jpg',
    bio: '美化后的简介',
    videoUrls: [{ url: 'https://v.example.com/intro.mp4', title: '自我介绍', duration_seconds: 30 }],
    testimonials: [{ anon_name: '李同学', content: '老师讲得好', stars: 5 }],
    displayedRecommendationsCount: 3,
    trialAvailable: true,
    createdAt: new Date('2026-05-11T10:00:00Z'),
    updatedAt: new Date('2026-05-11T10:00:00Z'),
    updatedByUserId: ADMIN,
  };

  beforeEach(() => {
    showcaseRepo = { getSummary: jest.fn() };
    teacherRepo = { findById: jest.fn() };
    metaRepo = { getMeta: jest.fn(), upsertMeta: jest.fn() };
    // 直接 new — 跳过 NestJS DI（避免 @UseInterceptors(IdempotencyInterceptor) 拉起 RedisService）
    // 单元测试范围：controller 方法的业务逻辑，不验证 guard/interceptor 装配
    // （TenantScopeGuard / RbacGuard / IdempotencyInterceptor 已有独立 spec 覆盖）
    controller = new TeacherShowcaseController(
      showcaseRepo as unknown as TeacherShowcaseRepository,
      teacherRepo as unknown as TeacherRepository,
      metaRepo as unknown as TeacherShowcaseMetaRepository,
    );
  });

  // ============================================================
  // GET /showcase 三层结构
  // ============================================================
  describe('getShowcase() — 三层结构', () => {
    it('返回 { teacher, summary, meta } 三层', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      showcaseRepo.getSummary.mockResolvedValueOnce(baseSummary);
      metaRepo.getMeta.mockResolvedValueOnce(baseMeta);

      const r = await controller.getShowcase(TEACHER_A, TENANT);

      expect(r).toHaveProperty('teacher');
      expect(r).toHaveProperty('summary');
      expect(r).toHaveProperty('meta');

      expect(r.teacher.id).toBe(TEACHER_A);
      expect(r.teacher.name).toBe('王老师');
      expect(r.teacher.subjects).toEqual(['数学']);

      // summary 字段不被 meta 覆写（双轨硬红线）
      expect(r.summary.totalLessons).toBe(200);
      expect(r.summary.avgStars).toBe(4.6);

      // meta 字段独立
      expect(r.meta.avatarUrl).toBe('https://cdn.example.com/avatar.jpg');
      expect(r.meta.trialAvailable).toBe(true);
      expect(r.meta.videoUrls).toHaveLength(1);
      expect(r.meta.testimonials).toHaveLength(1);
      expect(r.meta.updatedAt).toBe('2026-05-11T10:00:00.000Z');
    });

    it('双源 fallback：meta.bio 存在 → teacher.bio resolved=meta.bio', async () => {
      teacherRepo.findById.mockResolvedValueOnce({ ...baseTeacher, bio: 'legacy bio' });
      showcaseRepo.getSummary.mockResolvedValueOnce(baseSummary);
      metaRepo.getMeta.mockResolvedValueOnce({ ...baseMeta, bio: 'meta bio (canonical)' });

      const r = await controller.getShowcase(TEACHER_A, TENANT);
      expect(r.teacher.bio).toBe('meta bio (canonical)');
    });

    it('双源 fallback：meta=null + teacher.bio 存在 → resolved=teacher.bio', async () => {
      teacherRepo.findById.mockResolvedValueOnce({ ...baseTeacher, bio: 'legacy bio' });
      showcaseRepo.getSummary.mockResolvedValueOnce(baseSummary);
      metaRepo.getMeta.mockResolvedValueOnce(null);

      const r = await controller.getShowcase(TEACHER_A, TENANT);
      expect(r.teacher.bio).toBe('legacy bio');
      // avatar 也走 fallback 链路：meta=null → teacher.avatar 不存在 → null
      expect(r.teacher.avatar).toBeNull();
      // meta view 默认值
      expect(r.meta.bio).toBeNull();
      expect(r.meta.avatarUrl).toBeNull();
      expect(r.meta.videoUrls).toEqual([]);
      expect(r.meta.testimonials).toEqual([]);
      expect(r.meta.trialAvailable).toBe(false);
      expect(r.meta.displayedRecommendationsCount).toBe(0);
      expect(r.meta.updatedAt).toBeNull();
    });

    it('双源 fallback：meta.bio null + teacher 无 bio → resolved=null', async () => {
      teacherRepo.findById.mockResolvedValueOnce({ ...baseTeacher });
      showcaseRepo.getSummary.mockResolvedValueOnce(baseSummary);
      metaRepo.getMeta.mockResolvedValueOnce({ ...baseMeta, bio: null, avatarUrl: null });

      const r = await controller.getShowcase(TEACHER_A, TENANT);
      expect(r.teacher.bio).toBeNull();
      expect(r.teacher.avatar).toBeNull();
    });

    it('tenant schema 缺失 → BadRequestException', async () => {
      await expect(controller.getShowcase(TEACHER_A, '')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('teacher 不存在 → BadRequestException', async () => {
      teacherRepo.findById.mockResolvedValueOnce(null);
      await expect(controller.getShowcase(TEACHER_A, TENANT)).rejects.toThrow(
        /teacher.*not found/,
      );
    });
  });

  // ============================================================
  // PUT /showcase-meta — 写入 + audit ctx
  // ============================================================
  describe('updateShowcaseMeta() — PUT 写入', () => {
    const mkReq = (overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest =>
      ({
        user: { sub: ADMIN, role: 'admin', tenantId: 'TENANTA00000', campusId: null },
        ip: '1.2.3.4',
        headers: { 'user-agent': 'WeChatMP/8.0.45', 'x-request-id': 'req-abc' },
        ...overrides,
      }) as AuthenticatedRequest;

    it('admin 改 bio + trialAvailable → 透传 + audit ctx 含 ip/ua/reqId', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      metaRepo.upsertMeta.mockResolvedValueOnce(baseMeta);
      const r = await controller.updateShowcaseMeta(
        TEACHER_A,
        TENANT,
        { bio: '新简介', trialAvailable: false },
        mkReq(),
      );
      expect(r.ok).toBe(true);
      expect(r.meta.avatarUrl).toBe('https://cdn.example.com/avatar.jpg');

      // upsertMeta 调用形态
      expect(metaRepo.upsertMeta).toHaveBeenCalledTimes(1);
      const [
        passedSchema,
        passedTeacherId,
        passedPayload,
        passedOperator,
        passedAuditCtx,
      ] = metaRepo.upsertMeta.mock.calls[0];
      expect(passedSchema).toBe(TENANT);
      expect(passedTeacherId).toBe(TEACHER_A);
      expect(passedPayload).toEqual({ bio: '新简介', trialAvailable: false });
      expect(passedOperator).toBe(ADMIN);
      expect(passedAuditCtx.actorRole).toBe('admin');
      expect(passedAuditCtx.ip).toBe('1.2.3.4');
      expect(passedAuditCtx.userAgent).toBe('WeChatMP/8.0.45');
      expect(passedAuditCtx.requestId).toBe('req-abc');
    });

    it('tenantSchema 缺失 → BadRequest', async () => {
      await expect(
        controller.updateShowcaseMeta(TEACHER_A, '', { bio: 'x' }, mkReq()),
      ).rejects.toThrow(/x-tenant-schema/);
    });

    it('user.sub 缺失（auth middleware 没注入）→ BadRequest', async () => {
      await expect(
        controller.updateShowcaseMeta(
          TEACHER_A,
          TENANT,
          { bio: 'x' },
          { user: undefined, headers: {} } as unknown as AuthenticatedRequest,
        ),
      ).rejects.toThrow(/user sub/);
    });

    it('teacher 不存在（防外键挂账写孤儿行）→ BadRequest', async () => {
      teacherRepo.findById.mockResolvedValueOnce(null);
      await expect(
        controller.updateShowcaseMeta(TEACHER_A, TENANT, { bio: 'x' }, mkReq()),
      ).rejects.toThrow(/teacher.*not found/);
      expect(metaRepo.upsertMeta).not.toHaveBeenCalled();
    });

    it('avatarUrl 超 1024 → BadRequest', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      await expect(
        controller.updateShowcaseMeta(
          TEACHER_A,
          TENANT,
          { avatarUrl: 'a'.repeat(1025) },
          mkReq(),
        ),
      ).rejects.toThrow(/avatarUrl/);
      expect(metaRepo.upsertMeta).not.toHaveBeenCalled();
    });

    it('bio 超 4096 → BadRequest', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      await expect(
        controller.updateShowcaseMeta(
          TEACHER_A,
          TENANT,
          { bio: 'x'.repeat(4097) },
          mkReq(),
        ),
      ).rejects.toThrow(/bio/);
    });

    it('videoUrls 超 10 条 → BadRequest', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      const videoUrls = Array.from({ length: 11 }, (_, i) => ({ url: `https://v/${i}.mp4` }));
      await expect(
        controller.updateShowcaseMeta(TEACHER_A, TENANT, { videoUrls }, mkReq()),
      ).rejects.toThrow(/videoUrls/);
    });

    it('videoUrls item 缺 url 字段 → BadRequest', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      await expect(
        controller.updateShowcaseMeta(
          TEACHER_A,
          TENANT,
          { videoUrls: [{ url: '' } as { url: string }, { url: 'x' }] as any },
          mkReq(),
        ),
      ).rejects.toThrow(/videoUrls/);
    });

    it('testimonials stars 超 5 → BadRequest', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      await expect(
        controller.updateShowcaseMeta(
          TEACHER_A,
          TENANT,
          {
            testimonials: [{ anon_name: '张', content: 'ok', stars: 6 }],
          },
          mkReq(),
        ),
      ).rejects.toThrow(/stars/);
    });

    it('testimonials anon_name 空 → BadRequest', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      await expect(
        controller.updateShowcaseMeta(
          TEACHER_A,
          TENANT,
          {
            testimonials: [{ anon_name: '', content: 'ok', stars: 5 }],
          },
          mkReq(),
        ),
      ).rejects.toThrow(/anon_name/);
    });

    it('displayedRecommendationsCount 非整数 → BadRequest', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      await expect(
        controller.updateShowcaseMeta(
          TEACHER_A,
          TENANT,
          { displayedRecommendationsCount: 1.5 },
          mkReq(),
        ),
      ).rejects.toThrow(/displayedRecommendationsCount/);
    });

    it('trialAvailable 非 boolean → BadRequest', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      await expect(
        controller.updateShowcaseMeta(
          TEACHER_A,
          TENANT,
          { trialAvailable: 'true' as unknown as boolean },
          mkReq(),
        ),
      ).rejects.toThrow(/trialAvailable/);
    });

    it('空 body {} → upsertMeta 收到空 payload（合法 no-op 触发 audit_log）', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      metaRepo.upsertMeta.mockResolvedValueOnce(baseMeta);
      const r = await controller.updateShowcaseMeta(TEACHER_A, TENANT, {}, mkReq());
      expect(r.ok).toBe(true);
      const [, , payload] = metaRepo.upsertMeta.mock.calls[0];
      expect(payload).toEqual({});
    });

    it('boss role 透传 actor_role=boss', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      metaRepo.upsertMeta.mockResolvedValueOnce(baseMeta);
      const req = mkReq({
        user: { sub: ADMIN, role: 'boss', tenantId: 'tenantA', campusId: null },
      } as Partial<AuthenticatedRequest>);
      await controller.updateShowcaseMeta(TEACHER_A, TENANT, { bio: 'x' }, req);
      const [, , , , auditCtx] = metaRepo.upsertMeta.mock.calls[0];
      expect(auditCtx.actorRole).toBe('boss');
    });

    it('meta view 中 updatedAt Date → ISO 字符串', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      metaRepo.upsertMeta.mockResolvedValueOnce({
        ...baseMeta,
        updatedAt: new Date('2026-05-12T03:00:00Z'),
      });
      const r = await controller.updateShowcaseMeta(
        TEACHER_A,
        TENANT,
        { bio: 'x' },
        mkReq(),
      );
      expect(r.meta.updatedAt).toBe('2026-05-12T03:00:00.000Z');
    });
  });

  // ============================================================
  // 双轨硬红线（C.2 红线 #7）
  // ============================================================
  describe('双轨硬红线：meta 字段绝不影响 summary 字段', () => {
    it('meta.displayedRecommendationsCount 改大 → summary.ratingCount 不变', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      showcaseRepo.getSummary.mockResolvedValueOnce({ ...baseSummary, ratingCount: 18 });
      metaRepo.getMeta.mockResolvedValueOnce({
        ...baseMeta,
        displayedRecommendationsCount: 9999, // 老师美化数据
      });
      const r = await controller.getShowcase(TEACHER_A, TENANT);
      // summary.ratingCount 走真实 KPI，不被 meta.displayedRecommendationsCount 影响
      expect(r.summary.ratingCount).toBe(18);
      expect(r.meta.displayedRecommendationsCount).toBe(9999);
    });

    it('meta.testimonials 任意写 → summary.cases 不被覆盖（cases 来自真 monthly_reports）', async () => {
      teacherRepo.findById.mockResolvedValueOnce(baseTeacher);
      showcaseRepo.getSummary.mockResolvedValueOnce({
        ...baseSummary,
        cases: [{ anonName: '王同学', grade: 'A+', story: '真实月报案例' }],
      });
      metaRepo.getMeta.mockResolvedValueOnce({
        ...baseMeta,
        testimonials: [
          { anon_name: '假同学', content: '伪造好评', stars: 5 },
        ],
      });
      const r = await controller.getShowcase(TEACHER_A, TENANT);
      // summary.cases 走 monthly_reports 真数据
      expect(r.summary.cases[0].anonName).toBe('王同学');
      // meta.testimonials 是老师自填 — 走独立通道，不被 summary 覆盖
      expect(r.meta.testimonials[0].anon_name).toBe('假同学');
    });
  });
});
