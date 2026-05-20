/**
 * TeacherRatingRepository 单测 — P4-Y (2026-05-20)
 *
 * 验证：
 *   - upsert: ON CONFLICT 路径 isInsert 标志（xmax = 0）
 *   - findByTriple: 三元组查询
 *   - isTeacherForStudent: 三 OR 关系（assigned_teacher / schedule / binding）
 *   - mapRow: tags JSONB 解析（数组 / 字符串 / null）
 */
import { TeacherRatingRepository } from './teacher-rating.repository';
import { PgPoolService } from './pg-pool.service';

const TENANT_SCHEMA = 'tenant_abc';

describe('TeacherRatingRepository', () => {
  let pg: { tenantQuery: jest.Mock };
  let repo: TeacherRatingRepository;

  beforeEach(() => {
    pg = { tenantQuery: jest.fn() };
    repo = new TeacherRatingRepository(pg as unknown as PgPoolService);
  });

  describe('upsert', () => {
    it('isInsert=true 当 xmax=0', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'r1',
          parent_id: 'p1',
          teacher_id: 't1',
          student_id: 's1',
          stars: 5,
          content: 'good',
          tags: '["#nice"]',
          created_at: new Date('2026-05-20T10:00:00Z'),
          updated_at: new Date('2026-05-20T10:00:00Z'),
          created_by: 'p1',
          is_insert: true,
        },
      ]);
      const res = await repo.upsert(TENANT_SCHEMA, {
        id: 'r1',
        parentId: 'p1',
        teacherId: 't1',
        studentId: 's1',
        stars: 5,
        content: 'good',
        tags: ['#nice'],
      });
      expect(res.isInsert).toBe(true);
      expect(res.entry.id).toBe('r1');
      expect(res.entry.tags).toEqual(['#nice']);
      expect(pg.tenantQuery).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.stringContaining('ON CONFLICT (parent_id, teacher_id, student_id)'),
        expect.any(Array),
      );
    });

    it('isInsert=false 当 xmax != 0（PATCH 路径）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'r1',
          parent_id: 'p1',
          teacher_id: 't1',
          student_id: 's1',
          stars: 3,
          content: null,
          tags: null,
          created_at: new Date('2026-05-19T10:00:00Z'),
          updated_at: new Date('2026-05-20T10:00:00Z'),
          created_by: 'p1',
          is_insert: false,
        },
      ]);
      const res = await repo.upsert(TENANT_SCHEMA, {
        id: 'r1',
        parentId: 'p1',
        teacherId: 't1',
        studentId: 's1',
        stars: 3,
      });
      expect(res.isInsert).toBe(false);
      expect(res.entry.stars).toBe(3);
      expect(res.entry.tags).toBeNull();
    });

    it('tags=undefined → 传 null jsonb', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'r1',
          parent_id: 'p1',
          teacher_id: 't1',
          student_id: 's1',
          stars: 5,
          content: null,
          tags: null,
          created_at: new Date(),
          updated_at: new Date(),
          created_by: 'p1',
          is_insert: true,
        },
      ]);
      await repo.upsert(TENANT_SCHEMA, {
        id: 'r1',
        parentId: 'p1',
        teacherId: 't1',
        studentId: 's1',
        stars: 5,
      });
      const args = pg.tenantQuery.mock.calls[0][2];
      // args[6] 是 tags 参数（JSON.stringify(null) 或 null）
      expect(args[6]).toBeNull();
    });
  });

  describe('findByTriple', () => {
    it('未找到 → null', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const res = await repo.findByTriple(TENANT_SCHEMA, 'p1', 't1', 's1');
      expect(res).toBeNull();
    });

    it('找到 → 返回明细', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'r1',
          parent_id: 'p1',
          teacher_id: 't1',
          student_id: 's1',
          stars: 4,
          content: 'ok',
          tags: ['#tag1'],
          created_at: '2026-05-20T10:00:00Z',
          updated_at: '2026-05-20T10:00:00Z',
          created_by: 'p1',
        },
      ]);
      const res = await repo.findByTriple(TENANT_SCHEMA, 'p1', 't1', 's1');
      expect(res?.stars).toBe(4);
      expect(res?.tags).toEqual(['#tag1']);
    });
  });

  describe('isTeacherForStudent', () => {
    it('有命中 → true', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ hit: 1 }]);
      const res = await repo.isTeacherForStudent(TENANT_SCHEMA, 't1', 's1');
      expect(res).toBe(true);
    });

    it('无命中 → false', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const res = await repo.isTeacherForStudent(TENANT_SCHEMA, 't1', 's1');
      expect(res).toBe(false);
    });

    it('SQL 含三 OR 分支（assigned_teacher_id / schedules / student_teacher_bindings）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.isTeacherForStudent(TENANT_SCHEMA, 't1', 's1');
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('s.assigned_teacher_id = $1');
      expect(sql).toContain('schedules sc');
      expect(sql).toContain('schedule_students ss');
      expect(sql).toContain('student_teacher_bindings stb');
    });
  });

  describe('mapRow tags 解析', () => {
    it('数组直接返回', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'r1',
          parent_id: 'p1',
          teacher_id: 't1',
          student_id: 's1',
          stars: 5,
          content: null,
          tags: ['#a', '#b'],
          created_at: new Date(),
          updated_at: new Date(),
          created_by: 'p1',
          is_insert: true,
        },
      ]);
      const res = await repo.upsert(TENANT_SCHEMA, {
        id: 'r1', parentId: 'p1', teacherId: 't1', studentId: 's1', stars: 5,
      });
      expect(res.entry.tags).toEqual(['#a', '#b']);
    });

    it('JSON 字符串解析', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'r1',
          parent_id: 'p1',
          teacher_id: 't1',
          student_id: 's1',
          stars: 5,
          content: null,
          tags: '["#c"]',
          created_at: new Date(),
          updated_at: new Date(),
          created_by: 'p1',
          is_insert: true,
        },
      ]);
      const res = await repo.upsert(TENANT_SCHEMA, {
        id: 'r1', parentId: 'p1', teacherId: 't1', studentId: 's1', stars: 5,
      });
      expect(res.entry.tags).toEqual(['#c']);
    });

    it('null → null', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'r1',
          parent_id: 'p1',
          teacher_id: 't1',
          student_id: 's1',
          stars: 5,
          content: null,
          tags: null,
          created_at: new Date(),
          updated_at: new Date(),
          created_by: 'p1',
          is_insert: true,
        },
      ]);
      const res = await repo.upsert(TENANT_SCHEMA, {
        id: 'r1', parentId: 'p1', teacherId: 't1', studentId: 's1', stars: 5,
      });
      expect(res.entry.tags).toBeNull();
    });

    it('无效 JSON 字符串 → null（fail-open）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'r1',
          parent_id: 'p1',
          teacher_id: 't1',
          student_id: 's1',
          stars: 5,
          content: null,
          tags: 'not-valid-json{',
          created_at: new Date(),
          updated_at: new Date(),
          created_by: 'p1',
          is_insert: true,
        },
      ]);
      const res = await repo.upsert(TENANT_SCHEMA, {
        id: 'r1', parentId: 'p1', teacherId: 't1', studentId: 's1', stars: 5,
      });
      expect(res.entry.tags).toBeNull();
    });
  });
});
