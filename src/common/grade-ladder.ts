/**
 * grade-ladder.ts — 学员年级自动升级（computed-on-read）纯函数工具
 *
 * 来源：SSOT §4.1.1「学员年级自动升级（2026-05-31 用户拍板）」
 *
 * 设计要点：
 *   - 阶梯 12 级：小学一年级 → ... → 高三（高三封顶，不再进级）
 *   - 进级时点：每年 8/1（学年起点）。日期 D 的学年 = D.month>=8 ? D.year : D.year-1
 *   - computed-on-read：不跑 cron、不改库存值。students.grade_or_age 存录入原值，
 *     students.grade_base_year 存录入时学年；读时推算 currentGrade =
 *     advance(grade_or_age, 当前学年 − grade_base_year)，封顶高三。
 *   - 非阶梯值豁免：grade_or_age 非 12 标准值（如「5 岁」「学前」）→ 原样返回不进级。
 *
 * 纯函数 + now 可注入（参数），时区用服务器本地（prod = 北京时间）。
 */

/**
 * 阶梯（12 级，从低到高）。索引即「年级序数」，advance 沿数组前进。
 * 顺序与 SSOT §4.1.1 完全一致；末位「高三」为封顶。
 */
export const GRADE_LADDER: readonly string[] = [
  '小学一年级',
  '小学二年级',
  '小学三年级',
  '小学四年级',
  '小学五年级',
  '小学六年级',
  '初一',
  '初二',
  '初三',
  '高一',
  '高二',
  '高三',
] as const;

/**
 * 计算日期 D 所属「学年」（学年起点 8/1）。
 *   D.month >= 8（即 8~12 月）→ 学年 = D.year
 *   D.month < 8（即 1~7 月）  → 学年 = D.year - 1
 *
 * getMonth() 返回 0-11，故 8 月 = 7。
 *
 * @param date 任意 Date（默认 new Date()，服务器本地时区）
 * @returns 学年（整数年份，如 2026）
 */
export function academicYear(date: Date = new Date()): number {
  const month0 = date.getMonth(); // 0-11
  const year = date.getFullYear();
  // month0 >= 7 表示 8 月及以后（新学年起点）
  return month0 >= 7 ? year : year - 1;
}

/**
 * 沿阶梯把 grade 进 steps 步，封顶高三；非阶梯值原样返回。
 *
 *   - grade 不在 GRADE_LADDER（自定义值如「5 岁」「学前」）→ 原样返回（豁免）。
 *   - steps <= 0（同学年或时钟回拨 / 倒填学年）→ 返回原 grade（不退级）。
 *   - 进级越过末位 → 封顶「高三」。
 *
 * @param grade 录入年级原值（已 trim 由调用方保证；此处对 undefined/null/空串豁免返回原值）
 * @param steps 进级步数（当前学年 − grade_base_year）
 * @returns 推算后的年级；非阶梯/异常输入原样返回
 */
export function advance(grade: string | null | undefined, steps: number): string | null | undefined {
  if (grade === null || grade === undefined || grade === '') return grade;
  const idx = GRADE_LADDER.indexOf(grade);
  if (idx === -1) return grade; // 非阶梯值豁免
  if (!Number.isFinite(steps) || steps <= 0) return grade; // 不进级 / 不退级
  const targetIdx = Math.min(idx + Math.floor(steps), GRADE_LADDER.length - 1); // 封顶高三
  return GRADE_LADDER[targetIdx];
}

/**
 * computed-on-read 主入口：按录入原值 + 录入学年 + 当前时间推算当前年级。
 *
 *   currentGrade = advance(gradeOrAge, academicYear(now) − gradeBaseYear)
 *
 *   - gradeOrAge 为空 / null / 非阶梯值 → 原样返回（advance 已处理豁免）。
 *   - gradeBaseYear 为 null（老数据 backfill 未覆盖等兜底场景）→ 调用方应传
 *     academicYear(createdAt) 作兜底；若仍传入 null，则 steps 无法计算 → 原样返回
 *     gradeOrAge（保守不臆测进级，避免把老数据多升 N 级）。
 *
 * @param gradeOrAge    students.grade_or_age 录入原值
 * @param gradeBaseYear students.grade_base_year 录入时学年（可能 null，调用方建议用 createdAt 学年兜底）
 * @param now           当前时间（默认 new Date()，可注入用于测试）
 * @returns 推算后的当前年级；豁免/缺基准年时原样返回 gradeOrAge
 */
export function computeCurrentGrade(
  gradeOrAge: string | null | undefined,
  gradeBaseYear: number | null | undefined,
  now: Date = new Date(),
): string | null | undefined {
  if (gradeOrAge === null || gradeOrAge === undefined || gradeOrAge === '') return gradeOrAge;
  if (gradeBaseYear === null || gradeBaseYear === undefined || !Number.isFinite(gradeBaseYear)) {
    // 无录入学年基准：保守原样返回（不臆测进级）
    return gradeOrAge;
  }
  const steps = academicYear(now) - gradeBaseYear;
  return advance(gradeOrAge, steps);
}

/**
 * 写路径辅助：录入/编辑年级时应写入的 grade_base_year（= 当前学年）。
 * 等价于 academicYear(now)，单列出语义化别名供写路径可读引用。
 *
 * @param now 当前时间（默认 new Date()）
 * @returns 当前学年（写 students.grade_base_year）
 */
export function gradeBaseYearForWrite(now: Date = new Date()): number {
  return academicYear(now);
}

/**
 * 判断某值是否为阶梯标准值（12 级之一）。供调用方按需判断是否「会进级」。
 */
export function isLadderGrade(grade: string | null | undefined): boolean {
  if (grade === null || grade === undefined) return false;
  return GRADE_LADDER.indexOf(grade) !== -1;
}
