import { ParentCommunicationRepository } from './parent-communication.repository';
import { PgPoolService } from './pg-pool.service';

/**
 * ParentCommunicationRepository 单测 (V67 SSOT §5.4 教务家长沟通记录)
 *   - create：INSERT parent_communications（id/student/campus/type/content/createdBy 落库）
 *   - listByStudent：LEFT JOIN users 取 createdByName + ORDER BY communication_date DESC
 *   - mapRow：DATE 列 → YYYY-MM-DD（无时区漂移）；createdByName 映射
 */
describe('ParentCommunicationRepository (V67 §5.4 教务家长沟通记录)', () => {
  let repo: ParentCommunicationRepository;
  let pg: { tenantQuery: jest.Mock };

  const TENANT = 'tenant_073e69d6aa5ac5b7e38496d3f57e7cdb';
  const COMM = 'comm0000000000000000000000000C01';
  const STUDENT = 'student00000000000000000000000S1';
  const CAMPUS = 'campus0000000000000000000000C001';
  const ACADEMIC = 'academicA0000000000000000000A001';

  const row = (overrides: Record<string, any> = {}) => ({
    id: COMM,
    student_id: STUDENT,
    campus_id: CAMPUS,
    communication_date: '2026-06-02',
    type: 'wechat',
    content: '家长反馈孩子最近作业拖拉',
    follow_up: null,
    created_by: ACADEMIC,
    created_at: '2026-06-02T00:00:00.000Z',
    updated_at: '2026-06-02T00:00:00.000Z',
    ...overrides,
  });

  beforeEach(() => {
    pg = { tenantQuery: jest.fn() };
    repo = new ParentCommunicationRepository(pg as unknown as PgPoolService);
  });

  describe('create', () => {
    it('INSERT parent_communications，回填字段', async () => {
      pg.tenantQuery.mockResolvedValue([row()]);
      const c = await repo.create(TENANT, {
        id: COMM,
        studentId: STUDENT,
        campusId: CAMPUS,
        communicationDate: '2026-06-02',
        type: 'wechat',
        content: '家长反馈孩子最近作业拖拉',
        followUp: null,
        createdBy: ACADEMIC,
      });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2] as unknown[];
      expect(sql).toContain('INSERT INTO parent_communications');
      // 落库参数顺序：id, student_id, campus_id, communication_date, type, content, follow_up, created_by
      expect(params[0]).toBe(COMM);
      expect(params[1]).toBe(STUDENT);
      expect(params[2]).toBe(CAMPUS);
      expect(params[4]).toBe('wechat');
      expect(params[7]).toBe(ACADEMIC);
      expect(c.studentId).toBe(STUDENT);
      expect(c.type).toBe('wechat');
      expect(c.campusId).toBe(CAMPUS);
    });

    it('mapRow：DATE 列归一为 YYYY-MM-DD（Date 对象不漂移）', async () => {
      pg.tenantQuery.mockResolvedValue([
        row({ communication_date: new Date('2026-06-02T00:00:00.000Z') }),
      ]);
      const c = await repo.create(TENANT, {
        id: COMM,
        studentId: STUDENT,
        campusId: CAMPUS,
        communicationDate: '2026-06-02',
        type: 'phone',
        content: 'x',
        followUp: null,
        createdBy: ACADEMIC,
      });
      expect(c.communicationDate).toBe('2026-06-02');
    });
  });

  describe('listByStudent — LEFT JOIN users + ORDER BY date DESC', () => {
    it('WHERE student_id 参数化 + LEFT JOIN users 取 created_by_name + ORDER BY communication_date DESC', async () => {
      pg.tenantQuery.mockResolvedValue([row({ created_by_name: '赵丽' })]);
      const list = await repo.listByStudent(TENANT, STUDENT, {});
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2] as unknown[];
      expect(sql).toContain('FROM parent_communications pc');
      expect(sql).toContain('LEFT JOIN users u ON u.id = pc.created_by');
      expect(sql).toContain('u.name AS created_by_name');
      expect(sql).toContain('pc.student_id = $1');
      expect(sql).toContain('ORDER BY pc.communication_date DESC');
      expect(params[0]).toBe(STUDENT);
      expect(list[0].createdByName).toBe('赵丽');
    });

    it('limit 上限 200（防滥用）', async () => {
      pg.tenantQuery.mockResolvedValue([]);
      await repo.listByStudent(TENANT, STUDENT, { limit: 9999 });
      const params = pg.tenantQuery.mock.calls[0][2] as unknown[];
      // 参数顺序：student_id, limit, offset
      expect(params[1]).toBe(200);
      expect(params[2]).toBe(0);
    });

    it('默认 limit 100 / offset 0', async () => {
      pg.tenantQuery.mockResolvedValue([]);
      await repo.listByStudent(TENANT, STUDENT);
      const params = pg.tenantQuery.mock.calls[0][2] as unknown[];
      expect(params[1]).toBe(100);
      expect(params[2]).toBe(0);
    });
  });
});
