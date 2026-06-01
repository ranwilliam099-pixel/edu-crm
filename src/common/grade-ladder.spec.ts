import {
  GRADE_LADDER,
  academicYear,
  advance,
  computeCurrentGrade,
  gradeBaseYearForWrite,
  isLadderGrade,
} from './grade-ladder';

/**
 * grade-ladder.spec.ts — SSOT §4.1.1 学员年级自动升级纯函数单测
 *
 * 覆盖：
 *   - GRADE_LADDER 阶梯完整性（11 级 + 顺序）
 *   - academicYear 8/1 学年边界（7 月 / 8 月 / 跨年）
 *   - advance 各级进级 / 封顶高三 / 非阶梯豁免 / 不退级
 *   - computeCurrentGrade computed-on-read + 缺基准年兜底
 *   - gradeBaseYearForWrite / isLadderGrade
 */

describe('GRADE_LADDER', () => {
  it('恰好 11 级，顺序小学一年级 → 高三', () => {
    expect(GRADE_LADDER).toEqual([
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
    ]);
    expect(GRADE_LADDER.length).toBe(12);
  });

  it('封顶是高三（末位）', () => {
    expect(GRADE_LADDER[GRADE_LADDER.length - 1]).toBe('高三');
  });
});

describe('academicYear（学年起点 8/1）', () => {
  it('8 月 1 日 → 当年学年', () => {
    expect(academicYear(new Date(2026, 7, 1))).toBe(2026); // month0=7 → 8月
  });

  it('8 月之后（如 12 月）→ 当年学年', () => {
    expect(academicYear(new Date(2026, 11, 31))).toBe(2026);
  });

  it('7 月 31 日（学年末尾）→ 上一年学年', () => {
    expect(academicYear(new Date(2026, 6, 31))).toBe(2025); // month0=6 → 7月
  });

  it('1 月（学年中段）→ 上一年学年', () => {
    expect(academicYear(new Date(2026, 0, 15))).toBe(2025);
  });

  it('边界：7/31 23:59 vs 8/1 00:00 跨学年', () => {
    expect(academicYear(new Date(2026, 6, 31, 23, 59, 59))).toBe(2025);
    expect(academicYear(new Date(2026, 7, 1, 0, 0, 0))).toBe(2026);
  });

  it('默认参数使用 now（不抛错，返回整数年份）', () => {
    const y = academicYear();
    expect(Number.isInteger(y)).toBe(true);
    const realNow = new Date();
    const expected = realNow.getMonth() >= 7 ? realNow.getFullYear() : realNow.getFullYear() - 1;
    expect(y).toBe(expected);
  });
});

describe('advance（沿阶梯进级 / 封顶 / 豁免）', () => {
  it('小学一年级 + 1 步 → 小学二年级', () => {
    expect(advance('小学一年级', 1)).toBe('小学二年级');
  });

  it('小学五年级 + 1 步 → 小学六年级', () => {
    expect(advance('小学五年级', 1)).toBe('小学六年级');
  });

  it('跨学段：小学六年级 + 1 步 → 初一', () => {
    expect(advance('小学六年级', 1)).toBe('初一');
  });

  it('跨学段：初三 + 1 步 → 高一', () => {
    expect(advance('初三', 1)).toBe('高一');
  });

  it('多步：小学一年级 + 6 步 → 初一', () => {
    expect(advance('小学一年级', 6)).toBe('初一');
  });

  it('封顶：高三 + 任意步 → 高三', () => {
    expect(advance('高三', 1)).toBe('高三');
    expect(advance('高三', 99)).toBe('高三');
  });

  it('封顶：高二 + 5 步（越过末位）→ 高三', () => {
    expect(advance('高二', 5)).toBe('高三');
  });

  it('封顶：小学一年级 + 100 步 → 高三', () => {
    expect(advance('小学一年级', 100)).toBe('高三');
  });

  it('0 步 → 原样', () => {
    expect(advance('初二', 0)).toBe('初二');
  });

  it('负步（时钟回拨 / 倒填学年）→ 不退级，原样', () => {
    expect(advance('初二', -3)).toBe('初二');
  });

  it('小数步向下取整：小学一年级 + 2.9 步 → 小学三年级（floor=2）', () => {
    expect(advance('小学一年级', 2.9)).toBe('小学三年级');
  });

  it('非阶梯值豁免：「5 岁」原样返回', () => {
    expect(advance('5 岁', 3)).toBe('5 岁');
  });

  it('非阶梯值豁免：「学前」原样返回', () => {
    expect(advance('学前', 5)).toBe('学前');
  });

  it('非阶梯值豁免：「未上学」原样返回', () => {
    expect(advance('未上学', 2)).toBe('未上学');
  });

  it('null / undefined / 空串原样返回', () => {
    expect(advance(null, 3)).toBeNull();
    expect(advance(undefined, 3)).toBeUndefined();
    expect(advance('', 3)).toBe('');
  });

  it('NaN / Infinity 步 → 原样（防御）', () => {
    expect(advance('初一', NaN)).toBe('初一');
    expect(advance('初一', Infinity as unknown as number)).toBe('初一');
  });

  it('从每一级 +1 都落在下一级（穷举阶梯）', () => {
    for (let i = 0; i < GRADE_LADDER.length - 1; i++) {
      expect(advance(GRADE_LADDER[i], 1)).toBe(GRADE_LADDER[i + 1]);
    }
    // 末位 +1 仍封顶
    expect(advance(GRADE_LADDER[GRADE_LADDER.length - 1], 1)).toBe('高三');
  });
});

describe('computeCurrentGrade（computed-on-read）', () => {
  it('录入小学一年级 @2024 学年，now=2026 学年（跨 2 学年）→ 小学三年级', () => {
    // baseYear=2024, now=2026/9 → academicYear=2026 → steps=2
    const now = new Date(2026, 8, 1); // 2026-09
    expect(computeCurrentGrade('小学一年级', 2024, now)).toBe('小学三年级');
  });

  it('录入初三 @2023 学年，now=2026 学年（3 步，越过 → 封顶高三）', () => {
    const now = new Date(2026, 9, 10); // 2026-10 → 学年 2026
    // 初三(idx8)+3=11 → 高三（封顶）
    expect(computeCurrentGrade('初三', 2023, now)).toBe('高三');
  });

  it('同学年录入（steps=0）→ 原样小学一年级', () => {
    const now = new Date(2026, 8, 1); // 学年 2026
    expect(computeCurrentGrade('小学一年级', 2026, now)).toBe('小学一年级');
  });

  it('录入后未到 8/1（同学年内）→ 不进级', () => {
    // baseYear=2025（2025-09 录入），now=2026-07（仍 2025 学年）→ steps=0
    const now = new Date(2026, 6, 31); // 2026-07-31 → 学年 2025
    expect(computeCurrentGrade('小学一年级', 2025, now)).toBe('小学一年级');
  });

  it('跨过 8/1 → 进 1 级', () => {
    // baseYear=2025，now=2026-08-01（学年 2026）→ steps=1
    const now = new Date(2026, 7, 1);
    expect(computeCurrentGrade('小学一年级', 2025, now)).toBe('小学二年级');
  });

  it('非阶梯值「5 岁」→ 原样（豁免，不受 steps 影响）', () => {
    const now = new Date(2030, 8, 1);
    expect(computeCurrentGrade('5 岁', 2024, now)).toBe('5 岁');
  });

  it('gradeBaseYear=null 兜底：保守原样返回（不臆测进级）', () => {
    const now = new Date(2030, 8, 1);
    expect(computeCurrentGrade('小学一年级', null, now)).toBe('小学一年级');
  });

  it('gradeBaseYear=undefined 兜底：保守原样返回', () => {
    const now = new Date(2030, 8, 1);
    expect(computeCurrentGrade('小学一年级', undefined, now)).toBe('小学一年级');
  });

  it('gradeOrAge=null → null', () => {
    expect(computeCurrentGrade(null, 2024, new Date(2026, 8, 1))).toBeNull();
  });

  it('高三录入后多年 → 仍高三（封顶稳定）', () => {
    const now = new Date(2035, 8, 1);
    expect(computeCurrentGrade('高三', 2024, now)).toBe('高三');
  });

  it('默认 now 参数不抛错', () => {
    expect(() => computeCurrentGrade('初一', 2024)).not.toThrow();
  });
});

describe('gradeBaseYearForWrite', () => {
  it('= academicYear(now)', () => {
    const now = new Date(2026, 8, 1); // 学年 2026
    expect(gradeBaseYearForWrite(now)).toBe(2026);
    expect(gradeBaseYearForWrite(now)).toBe(academicYear(now));
  });

  it('7 月录入 → 上一学年', () => {
    const now = new Date(2026, 6, 1); // 学年 2025
    expect(gradeBaseYearForWrite(now)).toBe(2025);
  });
});

describe('isLadderGrade', () => {
  it('阶梯值 true', () => {
    expect(isLadderGrade('小学一年级')).toBe(true);
    expect(isLadderGrade('高三')).toBe(true);
  });

  it('非阶梯值 false', () => {
    expect(isLadderGrade('5 岁')).toBe(false);
    expect(isLadderGrade('学前')).toBe(false);
    expect(isLadderGrade(null)).toBe(false);
    expect(isLadderGrade(undefined)).toBe(false);
    expect(isLadderGrade('')).toBe(false);
  });
});
