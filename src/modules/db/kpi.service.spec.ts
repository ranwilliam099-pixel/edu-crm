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
      // 2026-05-29 全面检测：students 表无 campus_id（2026-05-22 修），campus 来自 customers cu
      expect(sql).toContain(`LEFT JOIN campuses ca ON ca.id = cu.campus_id`);
      expect(sql).toContain(`s.deleted_at IS NULL`);
      expect(sql).toContain(`COUNT(*) FILTER (WHERE a.student_id IS NOT NULL) AS active_count`);
    });

    it('campusIds 多选注入 cu.campus_id', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await svc.getStudentActivityKpi(TENANT, {
        campusIds: [CAMPUS_A, CAMPUS_B],
      });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2];
      // 2026-05-29 全面检测：campus filter 走 customers cu.campus_id（students 无此列）
      expect(sql).toContain(`AND cu.campus_id IN ($1,$2)`);
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

  // ============================================================
  // 2026-05-22 Sprint Y — getTeacherHomeKpi
  // ============================================================
  describe('getTeacherHomeKpi (Sprint Y)', () => {
    const USER_ID = 'teacher000000000000000000000U001';
    const TEACHER_ID = 'teacher000000000000000000000T001';

    function mockTeacherResolve(teacherId: string | null) {
      // Step 0 query: teachers WHERE user_id = $1
      if (teacherId === null) {
        pg.tenantQuery.mockResolvedValueOnce([]);
      } else {
        pg.tenantQuery.mockResolvedValueOnce([{ id: teacherId }]);
      }
    }

    function mockAllStepsEmpty() {
      // Step 1: todayLessons
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0', last_minutes: null }]);
      // Step 2a: primaryStudents count
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      // Step 2b: pendingFeedback
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      // Step 3: monthlyReferrals
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      // Step 4a: taught
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      // Step 4b: leave/swap
      pg.tenantQuery.mockResolvedValueOnce([{ leave_cnt: '0', swap_cnt: '0' }]);
      // Step 5a: today todos
      pg.tenantQuery.mockResolvedValueOnce([]);
      // Step 5b: overdue todos
      pg.tenantQuery.mockResolvedValueOnce([]);
      // Step 5c: monthly report todos
      pg.tenantQuery.mockResolvedValueOnce([]);
    }

    it('userId 为空字符串 → 直接返 emptyTeacherHome (不调 PG)', async () => {
      const r = await svc.getTeacherHomeKpi(TENANT, '');
      expect(pg.tenantQuery).not.toHaveBeenCalled();
      expect(r.todayLessons.count).toBe(0);
      expect(r.primaryStudents.count).toBe(0);
      expect(r.monthlyReferrals.count).toBe(0);
      expect(r.monthlyAttendance).toEqual({ taught: 0, leave: 0, swap: 0 });
      expect(r.todos).toEqual([]);
    });

    it('teacher 档案不存在 → 全部 0 返回（不抛错）', async () => {
      mockTeacherResolve(null);
      const r = await svc.getTeacherHomeKpi(TENANT, USER_ID);
      expect(pg.tenantQuery).toHaveBeenCalledTimes(1); // 仅 Step 0
      expect(r.todayLessons.count).toBe(0);
      expect(r.todos).toEqual([]);
    });

    it('happy path: 全部 SQL 都返数据 → 正确聚合', async () => {
      mockTeacherResolve(TEACHER_ID);
      // Step 1: 今日 3 节课 + 最近一节 60min 前
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '3', last_minutes: '60.0' }]);
      // Step 2a: 12 主带学员
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '12' }]);
      // Step 2b: 2 未填反馈
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '2' }]);
      // Step 3: 4 推荐成功
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '4' }]);
      // Step 4a: 28 已完成
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '28' }]);
      // Step 4b: 2 请假 / 1 调课
      pg.tenantQuery.mockResolvedValueOnce([{ leave_cnt: '2', swap_cnt: '1' }]);
      // Step 5a: 今日 1 节待上课
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'S0000000000000000000000000000001',
          start_at: '2026-05-22T10:00:00Z',
          notes: '数学单元复习',
        },
      ]);
      // Step 5b: 超 24h 未填反馈 1 节
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'S0000000000000000000000000000002',
          start_at: '2026-05-20T10:00:00Z',
        },
      ]);
      // Step 5c: 1 月报待 finalize
      pg.tenantQuery.mockResolvedValueOnce([
        { id: 'R0000000000000000000000000000001', month: '2026-04-01' },
      ]);

      const r = await svc.getTeacherHomeKpi(TENANT, USER_ID);

      expect(r.todayLessons).toEqual({ count: 3, lastLessonAgoMin: 60 });
      expect(r.primaryStudents).toEqual({ count: 12, pendingFeedback: 2 });
      expect(r.monthlyReferrals).toEqual({ count: 4 });
      expect(r.monthlyAttendance).toEqual({ taught: 28, leave: 2, swap: 1 });
      expect(r.todos).toHaveLength(3);
      expect(r.todos[0]).toMatchObject({
        type: 'today_lesson',
        title: '今日待上课',
        meta: '数学单元复习',
      });
      expect(r.todos[1]).toMatchObject({
        type: 'feedback_overdue',
        title: '超 24h 未填反馈',
      });
      expect(r.todos[2]).toMatchObject({
        type: 'monthly_report',
        title: '月报待 finalize',
        meta: '2026-04-01',
      });
    });

    it('部分聚合失败 (Step 1 PG 抛错) → 其他卡片仍渲染 + 该卡 = 0', async () => {
      mockTeacherResolve(TEACHER_ID);
      // Step 1: 抛错
      pg.tenantQuery.mockRejectedValueOnce(new Error('PG timeout'));
      // Step 2-5: 正常返
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '5' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '2' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '20' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ leave_cnt: '0', swap_cnt: '0' }]);
      pg.tenantQuery.mockResolvedValueOnce([]);
      pg.tenantQuery.mockResolvedValueOnce([]);
      pg.tenantQuery.mockResolvedValueOnce([]);

      const r = await svc.getTeacherHomeKpi(TENANT, USER_ID);

      // Step 1 失败 → todayLessons 全 0
      expect(r.todayLessons).toEqual({ count: 0, lastLessonAgoMin: 0 });
      // 其他卡正常
      expect(r.primaryStudents.count).toBe(5);
      expect(r.monthlyReferrals.count).toBe(2);
      expect(r.monthlyAttendance.taught).toBe(20);
    });

    it('SQL 包含正确的 teacher_id 参数 + 30 天滚动窗口', async () => {
      mockTeacherResolve(TEACHER_ID);
      mockAllStepsEmpty();

      await svc.getTeacherHomeKpi(TENANT, USER_ID);

      // Step 1 (今日课表)
      const todaySql = pg.tenantQuery.mock.calls[1][1] as string;
      expect(todaySql).toContain('start_at::date = CURRENT_DATE');
      expect(todaySql).toContain(`status != '已取消'`);
      expect(pg.tenantQuery.mock.calls[1][2]).toEqual([TEACHER_ID]);

      // Step 2a (主带学员 binding)
      const psSql = pg.tenantQuery.mock.calls[2][1] as string;
      expect(psSql).toContain(`student_teacher_bindings`);
      expect(psSql).toContain(`status = 'active'`);

      // Step 3 (推荐 30d 内)
      const refSql = pg.tenantQuery.mock.calls[4][1] as string;
      expect(refSql).toContain(`parent_referrals`);
      expect(refSql).toContain(`status = 'rated'`);
      expect(refSql).toContain(`rated_at >= NOW() - INTERVAL '30 days'`);

      // Step 4a (本月 taught)
      const taughtSql = pg.tenantQuery.mock.calls[5][1] as string;
      expect(taughtSql).toContain(`status = '已完成'`);
      expect(taughtSql).toContain(`start_at >= NOW() - INTERVAL '30 days'`);
    });

    it('lastLessonAgoMin 为 null（无今日课）→ 返 0 不抛错', async () => {
      mockTeacherResolve(TEACHER_ID);
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0', last_minutes: null }]);
      // 其他 step 略
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ leave_cnt: '0', swap_cnt: '0' }]);
      pg.tenantQuery.mockResolvedValueOnce([]);
      pg.tenantQuery.mockResolvedValueOnce([]);
      pg.tenantQuery.mockResolvedValueOnce([]);

      const r = await svc.getTeacherHomeKpi(TENANT, USER_ID);

      expect(r.todayLessons.lastLessonAgoMin).toBe(0);
      expect(r.todayLessons.count).toBe(0);
    });

    it('todos 顺序：today_lesson → feedback_overdue → monthly_report', async () => {
      mockTeacherResolve(TEACHER_ID);
      // Step 1-4 略（全 0）
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0', last_minutes: null }]);
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ leave_cnt: '0', swap_cnt: '0' }]);
      // Step 5: 每类 1 个
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'S001',
          start_at: '2026-05-22T15:00:00Z',
          notes: null,
        },
      ]);
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'S002',
          start_at: '2026-05-20T15:00:00Z',
        },
      ]);
      pg.tenantQuery.mockResolvedValueOnce([
        { id: 'R001', month: '2026-04-01' },
      ]);

      const r = await svc.getTeacherHomeKpi(TENANT, USER_ID);
      expect(r.todos.map((t) => t.type)).toEqual([
        'today_lesson',
        'feedback_overdue',
        'monthly_report',
      ]);
    });
  });
});
