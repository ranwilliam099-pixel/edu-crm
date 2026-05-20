import { Test } from '@nestjs/testing';
import { KpiService } from './kpi.service';
import { PgPoolService } from './pg-pool.service';

describe('KpiService (P4-X 2026-05-20)', () => {
  let svc: KpiService;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus0000000000000000000000A001';
  const CAMPUS_B = 'campus0000000000000000000000B002';

  const SALES_1 = 'sales000000000000000000000000A01';
  const SALES_2 = 'sales000000000000000000000000A02';
  const ACADEMIC_1 = 'acad0000000000000000000000000A01';
  const ACADEMIC_2 = 'acad0000000000000000000000000A02';

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [KpiService, { provide: PgPoolService, useValue: pg }],
    }).compile();
    svc = m.get(KpiService);
  });

  // ============================================================
  // getSignedKpi
  // ============================================================
  describe('getSignedKpi', () => {
    it('SQL 包含 order_type=新签 + signed_at 30 days + status IN active/pending', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await svc.getSignedKpi(TENANT, { campusIds: null });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain(`c.order_type = '新签'`);
      expect(sql).toContain(`c.signed_at >= NOW() - INTERVAL '30 days'`);
      expect(sql).toContain(`c.status IN ('active','pending')`);
      expect(sql).toContain(`c.deleted_at IS NULL`);
      expect(sql).toContain(`c.owner_user_id IS NOT NULL`);
      expect(sql).toContain(`JOIN users u ON u.id = c.owner_user_id`);
    });

    it('campusIds=null → SQL 无 campus filter + params 空', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await svc.getSignedKpi(TENANT, { campusIds: null });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(sql).not.toContain(`c.campus_id IN`);
      expect(params).toEqual([]);
    });

    it('campusIds=[A] → SQL 加 AND c.campus_id IN ($1) + params=[A]', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await svc.getSignedKpi(TENANT, { campusIds: [CAMPUS_A] });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(sql).toContain(`AND c.campus_id IN ($1)`);
      expect(params).toEqual([CAMPUS_A]);
    });

    it('campusIds=[A,B] → SQL 加 AND c.campus_id IN ($1,$2) + params=[A,B]', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await svc.getSignedKpi(TENANT, { campusIds: [CAMPUS_A, CAMPUS_B] });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(sql).toContain(`AND c.campus_id IN ($1,$2)`);
      expect(params).toEqual([CAMPUS_A, CAMPUS_B]);
    });

    it('happy path: 2 sales + 1 academic → 正确分桶 + 排名 + 金额格式化', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          owner_user_id: SALES_1,
          owner_name: '张三',
          owner_role: 'sales',
          total_amount: '48200',
          count: '3',
        },
        {
          owner_user_id: SALES_2,
          owner_name: '李四',
          owner_role: 'sales',
          total_amount: '30000',
          count: '2',
        },
        {
          owner_user_id: ACADEMIC_1,
          owner_name: '王教务',
          owner_role: 'academic',
          total_amount: '50360',
          count: '4',
        },
      ]);
      const r = await svc.getSignedKpi(TENANT, { campusIds: null });
      expect(r.total.count).toBe(9); // 3+2+4
      expect(r.total.amount).toBe('128,560'); // 48200+30000+50360
      expect(r.sales).toHaveLength(2);
      expect(r.sales[0].userId).toBe(SALES_1);
      expect(r.sales[0].rankText).toBe('第 1');
      expect(r.sales[0].amountText).toBe('¥48,200');
      expect(r.sales[0].count).toBe(3);
      expect(r.sales[1].rankText).toBe('第 2');
      expect(r.academic).toHaveLength(1);
      expect(r.academic[0].userId).toBe(ACADEMIC_1);
      expect(r.academic[0].amountText).toBe('¥50,360');
      expect(r.academic[0].rankText).toBe('第 1');
    });

    it('sales_manager + academic_admin 也分别归入 sales / academic 桶', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          owner_user_id: SALES_1,
          owner_name: '销主',
          owner_role: 'sales_manager',
          total_amount: '20000',
          count: '1',
        },
        {
          owner_user_id: ACADEMIC_1,
          owner_name: '教主',
          owner_role: 'academic_admin',
          total_amount: '15000',
          count: '1',
        },
      ]);
      const r = await svc.getSignedKpi(TENANT, { campusIds: null });
      expect(r.sales).toHaveLength(1);
      expect(r.sales[0].userId).toBe(SALES_1);
      expect(r.academic).toHaveLength(1);
      expect(r.academic[0].userId).toBe(ACADEMIC_1);
    });

    it('admin/boss 自签合同 → 算入 total 但不进 sales/academic 排行', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          owner_user_id: 'admin000000000000000000000000A01',
          owner_name: '老板',
          owner_role: 'admin',
          total_amount: '10000',
          count: '1',
        },
        {
          owner_user_id: SALES_1,
          owner_name: '张三',
          owner_role: 'sales',
          total_amount: '5000',
          count: '1',
        },
      ]);
      const r = await svc.getSignedKpi(TENANT, { campusIds: null });
      expect(r.total.count).toBe(2);
      expect(r.total.amount).toBe('15,000');
      expect(r.sales).toHaveLength(1);
      expect(r.academic).toHaveLength(0);
    });

    it('owner_name=NULL → name 兜底为 "未知"', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          owner_user_id: SALES_1,
          owner_name: null,
          owner_role: 'sales',
          total_amount: '8000',
          count: '1',
        },
      ]);
      const r = await svc.getSignedKpi(TENANT, { campusIds: null });
      expect(r.sales[0].name).toBe('未知');
    });

    it('空数据返 total=0/0 + sales[] + academic[]', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const r = await svc.getSignedKpi(TENANT, { campusIds: null });
      expect(r.total.count).toBe(0);
      expect(r.total.amount).toBe('0');
      expect(r.sales).toEqual([]);
      expect(r.academic).toEqual([]);
    });

    it('SQL 抛错 → 返空 total/sales/academic (graceful)', async () => {
      pg.tenantQuery.mockRejectedValueOnce(new Error('contracts table missing'));
      const r = await svc.getSignedKpi(TENANT, { campusIds: null });
      expect(r.total.count).toBe(0);
      expect(r.sales).toEqual([]);
      expect(r.academic).toEqual([]);
    });

    it('大金额 ¥1,234,567 正确千分位逗号', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          owner_user_id: SALES_1,
          owner_name: '大单',
          owner_role: 'sales',
          total_amount: '1234567',
          count: '5',
        },
      ]);
      const r = await svc.getSignedKpi(TENANT, { campusIds: null });
      expect(r.sales[0].amountText).toBe('¥1,234,567');
      expect(r.total.amount).toBe('1,234,567');
    });
  });

  // ============================================================
  // getRenewalKpi
  // ============================================================
  describe('getRenewalKpi', () => {
    it('SQL 包含 order_type IN (续费/扩科/升班/转班) 4 种续约类型', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await svc.getRenewalKpi(TENANT, { campusIds: null });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain(`c.order_type IN ('续费','扩科','升班','转班')`);
      expect(sql).toContain(`c.signed_at >= NOW() - INTERVAL '30 days'`);
    });

    it('happy path: academic 续约 + sales 续约 → 双桶分类', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          owner_user_id: ACADEMIC_1,
          owner_name: '王教务',
          owner_role: 'academic',
          total_amount: '60000',
          count: '5',
        },
        {
          owner_user_id: SALES_1,
          owner_name: '张三',
          owner_role: 'sales',
          total_amount: '20000',
          count: '2',
        },
      ]);
      const r = await svc.getRenewalKpi(TENANT, { campusIds: null });
      expect(r.total.count).toBe(7);
      expect(r.total.amount).toBe('80,000');
      expect(r.academic).toHaveLength(1);
      expect(r.academic[0].amountText).toBe('¥60,000');
      expect(r.sales).toHaveLength(1);
      expect(r.sales[0].amountText).toBe('¥20,000');
    });

    it('campusIds 多选 IN clause 透传', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await svc.getRenewalKpi(TENANT, {
        campusIds: [CAMPUS_A, CAMPUS_B],
      });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(sql).toContain(`AND c.campus_id IN ($1,$2)`);
      expect(params).toEqual([CAMPUS_A, CAMPUS_B]);
    });

    it('SQL 抛错 → 返空', async () => {
      pg.tenantQuery.mockRejectedValueOnce(new Error('no contracts'));
      const r = await svc.getRenewalKpi(TENANT, { campusIds: null });
      expect(r.total.amount).toBe('0');
      expect(r.sales).toEqual([]);
      expect(r.academic).toEqual([]);
    });
  });

  // ============================================================
  // getConsumptionKpi
  // ============================================================
  describe('getConsumptionKpi', () => {
    it('SQL JOIN schedules + users + 过滤 status confirmed + role academic/academic_admin', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await svc.getConsumptionKpi(TENANT, { campusIds: null });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain(`FROM course_consumptions cc`);
      expect(sql).toContain(`JOIN schedules sc ON sc.id = cc.schedule_id`);
      expect(sql).toContain(`LEFT JOIN users u ON u.id = sc.created_by_user_id`);
      expect(sql).toContain(`cc.status = 'confirmed'`);
      expect(sql).toContain(`cc.confirmed_at >= NOW() - INTERVAL '30 days'`);
      expect(sql).toContain(`u.role IN ('academic','academic_admin')`);
    });

    it('campusIds 注入 sc.campus_id 过滤', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await svc.getConsumptionKpi(TENANT, { campusIds: [CAMPUS_A] });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(sql).toContain(`AND sc.campus_id IN ($1)`);
      expect(params).toEqual([CAMPUS_A]);
    });

    it('happy path: 2 academic 不同消课 → 排名 + total 累加', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          academic_user_id: ACADEMIC_1,
          academic_name: '王教务',
          total_hours: '40.5',
          lessons_count: '30',
        },
        {
          academic_user_id: ACADEMIC_2,
          academic_name: '李教务',
          total_hours: '25.0',
          lessons_count: '20',
        },
      ]);
      const r = await svc.getConsumptionKpi(TENANT, { campusIds: null });
      expect(r.total.hours).toBe(65.5);
      expect(r.total.lessons).toBe(50);
      expect(r.academic).toHaveLength(2);
      expect(r.academic[0].userId).toBe(ACADEMIC_1);
      expect(r.academic[0].rankText).toBe('第 1');
      expect(r.academic[0].hoursText).toBe('40.5');
      expect(r.academic[0].lessonsCount).toBe(30);
      expect(r.academic[1].rankText).toBe('第 2');
    });

    it('academic_name=NULL → "未知"', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          academic_user_id: ACADEMIC_1,
          academic_name: null,
          total_hours: '10',
          lessons_count: '5',
        },
      ]);
      const r = await svc.getConsumptionKpi(TENANT, { campusIds: null });
      expect(r.academic[0].name).toBe('未知');
    });

    it('空数据 → total=0/0 + academic[]', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const r = await svc.getConsumptionKpi(TENANT, { campusIds: null });
      expect(r.total).toEqual({ hours: 0, lessons: 0 });
      expect(r.academic).toEqual([]);
    });

    it('SQL 抛错 → 返空 (graceful)', async () => {
      pg.tenantQuery.mockRejectedValueOnce(new Error('no schedules'));
      const r = await svc.getConsumptionKpi(TENANT, { campusIds: null });
      expect(r.total.hours).toBe(0);
      expect(r.academic).toEqual([]);
    });

    it('小数 hours 保留 1 位精度', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          academic_user_id: ACADEMIC_1,
          academic_name: '王',
          total_hours: '12.3456',
          lessons_count: '8',
        },
      ]);
      const r = await svc.getConsumptionKpi(TENANT, { campusIds: null });
      expect(r.academic[0].hoursRaw).toBe(12.3);
      expect(r.academic[0].hoursText).toBe('12.3');
    });
  });

  // ============================================================
  // getStudentActivityKpi
  // ============================================================
  describe('getStudentActivityKpi', () => {
    it('SQL 用 CTE active_30d + JOIN campuses + COUNT FILTER', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await svc.getStudentActivityKpi(TENANT, { campusIds: null });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain(`WITH active_30d AS`);
      expect(sql).toContain(`cc.confirmed_at >= NOW() - INTERVAL '30 days'`);
      expect(sql).toContain(`cc.status = 'confirmed'`);
      expect(sql).toContain(`LEFT JOIN active_30d a ON a.student_id = s.id`);
      expect(sql).toContain(`LEFT JOIN campuses ca ON ca.id = s.campus_id`);
      expect(sql).toContain(`s.deleted_at IS NULL`);
      expect(sql).toContain(`COUNT(*) FILTER (WHERE a.student_id IS NOT NULL) AS active_count`);
    });

    it('campusIds 多选注入 s.campus_id', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await svc.getStudentActivityKpi(TENANT, {
        campusIds: [CAMPUS_A, CAMPUS_B],
      });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(sql).toContain(`AND s.campus_id IN ($1,$2)`);
      expect(params).toEqual([CAMPUS_A, CAMPUS_B]);
    });

    it('happy path: 2 校区分桶 + 总 activityRate 计算', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          campus_id: CAMPUS_A,
          campus_name: '总部校区',
          active_count: '40',
          total_count: '50',
        },
        {
          campus_id: CAMPUS_B,
          campus_name: '分部校区',
          active_count: '15',
          total_count: '30',
        },
      ]);
      const r = await svc.getStudentActivityKpi(TENANT, { campusIds: null });
      expect(r.total.activeStudents).toBe(55);
      expect(r.total.totalStudents).toBe(80);
      // 55/80 = 0.6875 → '68.8%'
      expect(r.total.activityRate).toBe('68.8%');
      expect(r.campusBreakdown).toHaveLength(2);
      expect(r.campusBreakdown[0].campusId).toBe(CAMPUS_A);
      expect(r.campusBreakdown[0].activeCount).toBe(40);
      expect(r.campusBreakdown[0].totalCount).toBe(50);
      expect(r.campusBreakdown[0].rate).toBe('80%');
      expect(r.campusBreakdown[1].campusId).toBe(CAMPUS_B);
      expect(r.campusBreakdown[1].rate).toBe('50%');
    });

    it('totalStudents=0 → activityRate "0%" 不除零', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const r = await svc.getStudentActivityKpi(TENANT, { campusIds: null });
      expect(r.total.activeStudents).toBe(0);
      expect(r.total.totalStudents).toBe(0);
      expect(r.total.activityRate).toBe('0%');
      expect(r.campusBreakdown).toEqual([]);
    });

    it('某校区 totalCount=0 → 单 row activityRate 0%', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          campus_id: CAMPUS_A,
          campus_name: '空校区',
          active_count: '0',
          total_count: '0',
        },
      ]);
      const r = await svc.getStudentActivityKpi(TENANT, { campusIds: null });
      expect(r.campusBreakdown[0].rate).toBe('0%');
    });

    it('campus_id=NULL + campus_name=NULL → unknown 兜底', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          campus_id: null,
          campus_name: null,
          active_count: '5',
          total_count: '10',
        },
      ]);
      const r = await svc.getStudentActivityKpi(TENANT, { campusIds: null });
      expect(r.campusBreakdown[0].campusId).toBe('unknown');
      expect(r.campusBreakdown[0].campusName).toBe('未分配');
    });

    it('SQL 抛错 → 返空 + activityRate 0%', async () => {
      pg.tenantQuery.mockRejectedValueOnce(new Error('no students'));
      const r = await svc.getStudentActivityKpi(TENANT, { campusIds: null });
      expect(r.total.activeStudents).toBe(0);
      expect(r.total.activityRate).toBe('0%');
      expect(r.campusBreakdown).toEqual([]);
    });

    it('100% 活跃: active==total → 100%', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          campus_id: CAMPUS_A,
          campus_name: 'A',
          active_count: '20',
          total_count: '20',
        },
      ]);
      const r = await svc.getStudentActivityKpi(TENANT, { campusIds: null });
      expect(r.campusBreakdown[0].rate).toBe('100%');
      expect(r.total.activityRate).toBe('100%');
    });
  });

  // ============================================================
  // Helper functions edge behavior
  // ============================================================
  describe('helper edge cases', () => {
    it('campusIds=[] 视作 null（query 解析返 null 由 controller 负责）', async () => {
      // service 接受 null = 不过滤; 但若 controller 不当传 [] 我们也兜底
      pg.tenantQuery.mockResolvedValueOnce([]);
      await svc.getSignedKpi(TENANT, { campusIds: [] });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(sql).not.toContain(`c.campus_id IN`);
      expect(params).toEqual([]);
    });
  });
});
