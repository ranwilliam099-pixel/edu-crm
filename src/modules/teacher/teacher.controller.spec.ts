/**
 * TeacherController — Sprint B.5 audit_log 业务写
 *
 * 范围：
 *   - createTeacherInDb：audit teacher.create（phone 脱敏入 audit）
 *   - archive：audit teacher.archive（高敏感 — 注销 + 学生转移）
 *
 * 红线（拍板约束 #4）：
 *   - phone 必须 mask 入 audit（避免 PII 明文落 audit_log）
 *   - audit_log.log 抛错 不阻塞主业务（fail-open）
 */

import { TeacherController } from './teacher.controller';
import { TeacherService, Teacher } from './teacher.service';
import { TeacherRepository, TeacherArchiveResult } from '../db/teacher.repository';
import { AuditLogRepository } from '../db/audit-log.repository';
import { CreateTeacherDto } from './dto/create-teacher.dto';
import { AuthenticatedRequest, JwtPayload, TenantRole } from '../auth/jwt-payload.interface';

describe('TeacherController (Sprint B.5 audit_log)', () => {
  let controller: TeacherController;
  let service: { createTeacherInDb: jest.Mock; createTeacher: jest.Mock };
  let repo: { archive: jest.Mock };
  let auditLog: { log: jest.Mock };

  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A0000000000000000000000A01';
  const TEACHER_ID = 'teacherID000000000000000000000A1';
  const TEACHER_ID_2 = 'teacherID000000000000000000000B1';
  const ADMIN_SUB = 'adminUid00000000000000000000000A';
  const OPERATOR_ID = 'operator00000000000000000000000A';

  function jwt(role: TenantRole, sub = ADMIN_SUB): JwtPayload {
    return { sub, tenantId: TENANT_A, role, campusId: CAMPUS_A };
  }

  function req(user?: JwtPayload): AuthenticatedRequest {
    return {
      user,
      headers: { 'user-agent': 'WeChatMP/8.x', 'x-request-id': 'req-test-001' },
      body: {},
      query: {},
      params: {},
      ip: '127.0.0.1',
    };
  }

  function teacherFixture(overrides: Partial<Teacher> = {}): Teacher {
    // Day 2 Phase C X1 (2026-05-19 D1.4 拍板): hourlyPriceYuan 字段物理删除（V50 DROP COLUMN）
    return {
      id: TEACHER_ID,
      campusId: CAMPUS_A,
      name: '王老师',
      phone: '13800001111',
      userId: undefined,
      subjects: ['数学', '物理'],
      status: '在职',
      ...overrides,
    };
  }

  beforeEach(() => {
    service = {
      createTeacherInDb: jest.fn(),
      createTeacher: jest.fn(),
    } as any;
    repo = { archive: jest.fn() } as any;
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new TeacherController(
      service as unknown as TeacherService,
      repo as unknown as TeacherRepository,
      auditLog as unknown as AuditLogRepository,
    );
  });

  // ============================================================
  // createTeacherInDb() → audit_log 'teacher.create' (phone masked)
  // ============================================================
  describe('createTeacherInDb() — audit teacher.create', () => {
    it('admin 建老师档案 → audit_log 调 1 次, phone 脱敏入 audit', async () => {
      service.createTeacherInDb.mockResolvedValueOnce(teacherFixture());
      // Day 2 Phase C X1 (2026-05-19 D1.4 拍板): hourlyPriceYuan 字段物理删除
      const dto: CreateTeacherDto = {
        id: TEACHER_ID,
        campusId: CAMPUS_A,
        name: '王老师',
        phone: '13800001111',
        subjects: ['数学', '物理'],
        operator: OPERATOR_ID,
      };
      await controller.createTeacherInDb(
        { ...dto, tenantSchema: TENANT_SCHEMA },
        req(jwt('admin', ADMIN_SUB)),
      );

      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const [schema, entry] = auditLog.log.mock.calls[0];
      expect(schema).toBe(TENANT_SCHEMA);
      expect(entry.action).toBe('teacher.create');
      expect(entry.targetType).toBe('teacher');
      expect(entry.targetId).toBe(TEACHER_ID);
      expect(entry.before).toBeNull();
      expect(entry.actorUserId).toBe(ADMIN_SUB);
      expect(entry.actorRole).toBe('admin');
      // PII mask check
      expect(entry.after.phoneMask).toBe('138****1111');
      expect(entry.after.phone).toBeUndefined(); // 明文不入
      expect(entry.after.name).toBe('王老师');
      expect(entry.after.campusId).toBe(CAMPUS_A);
      expect(entry.after.status).toBe('在职');
      expect(entry.after.subjects).toEqual(['数学', '物理']);
      // X1 拍板：audit after 不含 hourlyPriceYuan（防回归）
      expect(entry.after.hourlyPriceYuan).toBeUndefined();
    });

    it('phone 缺失 → phoneMask=null（无 PII，不抛错）', async () => {
      service.createTeacherInDb.mockResolvedValueOnce(
        teacherFixture({ phone: undefined }),
      );
      const dto: CreateTeacherDto = {
        id: TEACHER_ID,
        campusId: CAMPUS_A,
        name: '李老师（兼职）',
        operator: OPERATOR_ID,
      };
      await controller.createTeacherInDb(
        { ...dto, tenantSchema: TENANT_SCHEMA },
        req(jwt('admin', ADMIN_SUB)),
      );
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.after.phoneMask).toBeNull();
    });

    it('audit_log.log 抛错 → 不阻塞主业务（fail-open）', async () => {
      service.createTeacherInDb.mockResolvedValueOnce(teacherFixture());
      auditLog.log.mockRejectedValueOnce(new Error('audit fail'));
      const dto: CreateTeacherDto = {
        id: TEACHER_ID,
        campusId: CAMPUS_A,
        name: '王老师',
        operator: OPERATOR_ID,
      };
      const r = await controller.createTeacherInDb(
        { ...dto, tenantSchema: TENANT_SCHEMA },
        req(jwt('admin', ADMIN_SUB)),
      );
      expect(r.id).toBe(TEACHER_ID);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // archive() → audit_log 'teacher.archive'
  // ============================================================
  describe('archive() — audit teacher.archive', () => {
    it('admin 注销老师 → audit_log 调 1 次, 含转移人 + 学生数', async () => {
      const result: TeacherArchiveResult = {
        teacher: teacherFixture({ status: '归档' }),
        transferToTeacherId: TEACHER_ID_2,
        transferToTeacherName: '李老师',
        studentsReassigned: 5,
      };
      repo.archive.mockResolvedValueOnce(result);

      await controller.archive(
        TEACHER_ID,
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA },
        req(jwt('admin', ADMIN_SUB)),
      );

      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('teacher.archive');
      expect(entry.targetType).toBe('teacher');
      expect(entry.targetId).toBe(TEACHER_ID);
      expect(entry.before).toEqual({ status: 'active' });
      expect(entry.after.status).toBe('归档');
      expect(entry.after.transferToTeacherId).toBe(TEACHER_ID_2);
      expect(entry.after.transferToTeacherName).toBe('李老师');
      expect(entry.after.studentsReassigned).toBe(5);
      expect(entry.actorRole).toBe('admin');
    });

    // Day 2 BLOCKER 4 (2026-05-19): SSOT §1「❌ hr 5/14 Wave 1 删」
    //   原 spec 验证 hr 可注销老师；hr 角色删除后该路径在 controller 层 @Roles 拦截
    //   audit_log normalizeActorRole 仍兜底（'hr' → 'hr' 写入但 RBAC 拦截）
    //   改用 boss 角色覆盖「无接棒人 + studentsReassigned=0」场景对称性
    it('boss 注销老师 + 无接棒人 → studentsReassigned 仍写入', async () => {
      const result: TeacherArchiveResult = {
        teacher: teacherFixture({ status: '归档' }),
        transferToTeacherId: null,
        transferToTeacherName: '无接棒人（待校长再分配）',
        studentsReassigned: 0,
      };
      repo.archive.mockResolvedValueOnce(result);

      await controller.archive(
        TEACHER_ID,
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA },
        req(jwt('boss', ADMIN_SUB)),
      );

      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.actorRole).toBe('boss');
      expect(entry.after.transferToTeacherId).toBeNull();
      expect(entry.after.studentsReassigned).toBe(0);
    });
  });
});
