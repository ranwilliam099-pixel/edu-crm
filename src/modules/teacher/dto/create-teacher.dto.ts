/**
 * CreateTeacherDto — V7 teachers 独立档案表 DTO
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§2
 *   - 用户拍板：台账条目 29 方向 B + 条目 31 #2 user_id NULLABLE
 *
 * USER-AUTH(2026-05-02 台账条目 29/31): 教师独立档案，user_id 可空
 *   - 全职老师 user_id = users.id（同时能登录系统）
 *   - 兼职 / 代课 / 试岗老师 user_id 留空（纯档案不登录，由销售/经理代排课）
 */

export type TeacherStatus = '在职' | '请假' | '归档';

export interface CreateTeacherDto {
  /** 32-char ULID Crockford Base32 */
  readonly id: string;

  /** 主校区 ID（用于显示/搜索；排课资源池查询时跨 campus 不受限）*/
  readonly campusId: string;

  /** 教师姓名 */
  readonly name: string;

  /** 电话（可选，纯档案教师可能不留）*/
  readonly phone?: string;

  /** 关联登录账号 user.id（可空，条目 31 #2：部分老师纯档案不登录）*/
  readonly userId?: string;

  /** 教学科目数组，例 ["数学","英语"] */
  readonly subjects?: ReadonlyArray<string>;

  /** 教师简介 */
  readonly bio?: string;

  /** 课时单价（机构对老师的定价，单位元）— V39 renamed from hourlyRateYuan，语义解耦自「工资」 */
  readonly hourlyPriceYuan?: number;

  /** 状态，默认 '在职' */
  readonly status?: TeacherStatus;

  /** 操作人（审计字段）*/
  readonly operator: string;
}
