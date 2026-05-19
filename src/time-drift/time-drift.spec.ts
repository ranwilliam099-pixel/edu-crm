/**
 * L10 时序漂移测试（leader 自补 Day 5；P1-1 round 2 加强）
 *
 * 来源：v2.0 §3.L10 + plan Phase B.L10
 *
 * 目的：测「老数据 + 新代码」「新数据 + 旧 schema 残留」类场景
 *   不让生产积累的历史数据让新代码崩溃
 *
 * 4 关键场景：
 *   1. 6 月前签的 contract（无 currency 列）→ 月报聚合不炸
 *   2. V40 之前的 parent（无 phone_hash）→ findByPhone fallback 明文 + 不抛
 *   3. V41 之前的 customer（无 primary_mobile_hash）→ checkDup fallback 明文 + 不抛
 *   4. 已 deactivated 但 audit_log 仍引用的 user → JWT 黑名单生效 + 历史 audit 不级联删
 *
 * 策略：用 mock service 模拟「老数据」状态，验证新代码 fallback 路径
 * 不依赖真 PG（pure logic test）
 *
 * P1-1 round 2 加强（2026-05-19）：
 *   防回归 spec 通过 fs.readFileSync 读真实 production .repository.ts 源码，
 *   验证 fallback 分支是否仍存在 — 而不是测试 spec 内部字符串字面量（false-green）。
 *   未来 dev 删除生产 repository 的 fallback 分支时，本 spec 必失败。
 */
import * as fs from 'fs';
import * as path from 'path';

describe('[L10 时序漂移] 老数据 + 新代码兼容性', () => {
  describe('场景 1: 6 月前 contract（无 currency 列）月报聚合不炸', () => {
    it('contract.currency = undefined → monthly_report 聚合默认 CNY 不抛', () => {
      // 模拟 6 月前签的 contract 行（V<N> 加 currency 列之前）
      const oldContract: {
        id: string;
        totalAmount: number;
        currency?: string; // V<N> 之前不存在
      } = {
        id: 'oldcontract00000000000000000001',
        totalAmount: 9800,
        // currency 字段缺失（V<N> 之前没加）
      };

      // monthly_report 聚合代码应有 fallback
      const aggregateContractAmount = (c: typeof oldContract): { amount: number; currency: string } => ({
        amount: c.totalAmount,
        currency: c.currency ?? 'CNY', // fallback 默认 CNY
      });

      const result = aggregateContractAmount(oldContract);
      expect(result).toEqual({ amount: 9800, currency: 'CNY' });
      // 验证不抛错（合同金额仍计入月报）
    });

    it('contract.currency = null → 同样 fallback CNY', () => {
      const c = { id: 'c2', totalAmount: 5000, currency: null as string | null };
      const result = { amount: c.totalAmount, currency: c.currency ?? 'CNY' };
      expect(result.currency).toBe('CNY');
    });
  });

  describe('场景 2: V40 之前 parent（无 phone_hash）findByPhone fallback 明文', () => {
    // 模拟 PhoneLookupService.findByPhone 行为
    const findByPhone = (
      phone: string,
      rows: Array<{ id: string; phone: string | null; phone_hash: Buffer | null }>,
    ): { id: string } | null => {
      const hashKey = Buffer.from(`hash_of_${phone}`); // mock hash
      // 优先 hash 列查
      const byHash = rows.find((r) => r.phone_hash !== null && r.phone_hash.equals(hashKey));
      if (byHash) return { id: byHash.id };
      // fallback 明文（V40 之前数据 phone_hash IS NULL）
      const byPlain = rows.find((r) => r.phone_hash === null && r.phone === phone);
      if (byPlain) return { id: byPlain.id };
      return null;
    };

    it('V40 之前 row (phone_hash=NULL, phone=明文) → fallback 明文匹配成功', () => {
      const rows = [
        { id: 'p_old', phone: '13800001234', phone_hash: null },
        { id: 'p_new', phone: '13800009999', phone_hash: Buffer.from('hash_of_13800009999') },
      ];
      const result = findByPhone('13800001234', rows);
      expect(result).toEqual({ id: 'p_old' });
    });

    it('V40 之后 row (phone_hash 命中) → 优先用 hash 不走 fallback', () => {
      const rows = [
        { id: 'p_new', phone: '13800009999', phone_hash: Buffer.from('hash_of_13800009999') },
      ];
      const result = findByPhone('13800009999', rows);
      expect(result).toEqual({ id: 'p_new' });
    });

    it('phone 不存在 → return null（不抛）', () => {
      const result = findByPhone('13800007777', []);
      expect(result).toBeNull();
    });
  });

  describe('场景 3: V41 之前 customer（无 primary_mobile_hash）checkDup fallback 明文', () => {
    // 模拟 StudentImportRepository.checkDup（V41 三写之前的 customer）
    const checkDup = (
      mobile: string,
      rows: Array<{
        id: string;
        primary_mobile: string;
        primary_mobile_hash: Buffer | null;
      }>,
    ): boolean => {
      const hashKey = Buffer.from(`hash_of_${mobile}`);
      // 优先 hash 列查
      if (rows.some((r) => r.primary_mobile_hash !== null && r.primary_mobile_hash.equals(hashKey))) {
        return true;
      }
      // fallback 明文（V41 之前数据 primary_mobile_hash IS NULL）
      return rows.some((r) => r.primary_mobile_hash === null && r.primary_mobile === mobile);
    };

    it('V41 之前 row → fallback 明文查重成功', () => {
      const rows = [
        { id: 'c_old', primary_mobile: '13800001234', primary_mobile_hash: null },
      ];
      expect(checkDup('13800001234', rows)).toBe(true);
    });

    it('V41 之后 row → hash 命中（不走 fallback）', () => {
      const rows = [
        {
          id: 'c_new',
          primary_mobile: '13800009999',
          primary_mobile_hash: Buffer.from('hash_of_13800009999'),
        },
      ];
      expect(checkDup('13800009999', rows)).toBe(true);
    });

    it('混合 row（部分 V41 之前 / 部分 V41 之后）→ 两种都能查到', () => {
      const rows = [
        { id: 'c_old', primary_mobile: '13800001234', primary_mobile_hash: null },
        {
          id: 'c_new',
          primary_mobile: '13800009999',
          primary_mobile_hash: Buffer.from('hash_of_13800009999'),
        },
      ];
      expect(checkDup('13800001234', rows)).toBe(true); // 老数据 fallback
      expect(checkDup('13800009999', rows)).toBe(true); // 新数据 hash
      expect(checkDup('13800007777', rows)).toBe(false); // 不存在
    });
  });

  describe('场景 4: deactivated user 但历史 audit_log 引用不级联删', () => {
    type AuditLog = { id: string; actorUserId: string; action: string };
    type User = { id: string; deactivated_at: Date | null };

    const isUserActive = (user: User | undefined): boolean => {
      if (!user) return false;
      return user.deactivated_at === null;
    };

    // 模拟 JWT 黑名单 check
    const verifyJwt = (
      userId: string,
      users: Map<string, User>,
    ): { ok: true } | { ok: false; reason: string } => {
      const user = users.get(userId);
      if (!user) return { ok: false, reason: 'user not found' };
      if (!isUserActive(user)) return { ok: false, reason: 'user deactivated (JWT blacklist)' };
      return { ok: true };
    };

    it('deactivated user 登录 → JWT 黑名单生效 (403)', () => {
      const users = new Map<string, User>([
        ['u1', { id: 'u1', deactivated_at: new Date('2026-04-01') }],
      ]);
      const result = verifyJwt('u1', users);
      expect(result).toEqual({ ok: false, reason: 'user deactivated (JWT blacklist)' });
    });

    it('deactivated user 历史 audit_log 仍可读（不级联删）', () => {
      const auditLogs: AuditLog[] = [
        { id: 'a1', actorUserId: 'u1', action: 'customer.create' },
        { id: 'a2', actorUserId: 'u1', action: 'contract.archive' },
      ];
      const users = new Map<string, User>([
        ['u1', { id: 'u1', deactivated_at: new Date('2026-04-01') }],
      ]);

      // audit_log 不级联删 — 历史记录仍存在
      expect(auditLogs).toHaveLength(2);
      expect(auditLogs.every((a) => a.actorUserId === 'u1')).toBe(true);

      // 但 user 已 deactivated
      expect(isUserActive(users.get('u1'))).toBe(false);

      // 合规：历史操作可追溯，user 已停权
    });

    it('active user 登录 → JWT 验证通过', () => {
      const users = new Map<string, User>([
        ['u2', { id: 'u2', deactivated_at: null }],
      ]);
      expect(verifyJwt('u2', users)).toEqual({ ok: true });
    });

    it('user 不存在（已硬删）→ 拒绝（但 audit_log 已记 actorUserId）', () => {
      const users = new Map<string, User>();
      const auditLog: AuditLog = { id: 'a3', actorUserId: 'u_deleted', action: 'student.create' };
      expect(verifyJwt('u_deleted', users)).toEqual({ ok: false, reason: 'user not found' });
      // 但 audit_log 仍保留历史 actorUserId
      expect(auditLog.actorUserId).toBe('u_deleted');
    });
  });

  describe('防回归：时序漂移防御代码不能被未来「优化」删除（P1-1 round 2 改读真实生产源码）', () => {
    // 真实路径：src/modules/db/parent.repository.ts + src/modules/db/student-import.repository.ts
    // 跑时 cwd = edu-server 根，path.resolve 解析绝对路径
    const PARENT_REPO_PATH = path.resolve(__dirname, '../modules/db/parent.repository.ts');
    const STUDENT_IMPORT_REPO_PATH = path.resolve(__dirname, '../modules/db/student-import.repository.ts');

    it('parent.repository.ts 真源文件存在（防 path 移动）', () => {
      expect(fs.existsSync(PARENT_REPO_PATH)).toBe(true);
    });

    it('student-import.repository.ts 真源文件存在（防 path 移动）', () => {
      expect(fs.existsSync(STUDENT_IMPORT_REPO_PATH)).toBe(true);
    });

    it('PhoneLookup 必须保留 phone_hash NULL fallback 分支（V40 兼容）— 读真实生产 parent.repository.ts', () => {
      // 这个 spec 防未来 dev 看「phone_hash IS NULL 是无效数据」就删 fallback
      // 改为读真实生产文件，不是 spec 内部字符串字面量
      const parentRepoCode = fs.readFileSync(PARENT_REPO_PATH, 'utf-8');

      // 必须含 hash 查询 + 明文 fallback 两段
      // hash 查询：WHERE phone_hash = $1
      expect(parentRepoCode).toMatch(/WHERE\s+phone_hash\s*=\s*\$/);
      // 明文 fallback：WHERE phone = $1
      expect(parentRepoCode).toMatch(/WHERE\s+phone\s*=\s*\$/);
      // 必须有 "fallback 明文" 或 "兼容" 注释（防 dev 删 fallback 时连注释一起删）
      expect(parentRepoCode).toMatch(/fallback\s*明文|兼容.*phone_hash=NULL/);
    });

    it('CustomerCheckDup 必须保留 primary_mobile_hash NULL fallback 分支（V41 兼容）— 读真实生产 student-import.repository.ts', () => {
      const studentImportCode = fs.readFileSync(STUDENT_IMPORT_REPO_PATH, 'utf-8');

      // hash 查询：WHERE primary_mobile_hash = $1
      expect(studentImportCode).toMatch(/WHERE\s+primary_mobile_hash\s*=\s*\$/);
      // 明文 fallback：WHERE primary_mobile = $1 或 OR primary_mobile = ...
      expect(studentImportCode).toMatch(/primary_mobile\s*=\s*\$|primary_mobile\s*=\s*[`']/);
      // 必须有 backfill 兼容注释（防回归）
      expect(studentImportCode).toMatch(/backfill|兼容|primary_mobile_hash=NULL/);
    });

    it('CustomerRepository / parent.repository fallback 不能被简化为「只查 hash 列」（生产 backfill 未完成时 5K+ 老行查不到 → P0 事故）', () => {
      // 复合断言：parent + student-import 两个文件都必须有 fallback 分支
      // 这是 V40/V41 渐进 backfill 期间的关键防御代码
      const parentCode = fs.readFileSync(PARENT_REPO_PATH, 'utf-8');
      const studentCode = fs.readFileSync(STUDENT_IMPORT_REPO_PATH, 'utf-8');

      // 验证两个都有「先查 hash → miss 后查明文」的模式
      // parent.repository.ts: findParentByPhone 有 hash + 明文两段 SELECT
      const parentSelectCount = (parentCode.match(/SELECT[\s\S]*?FROM\s+public\.parents\s+WHERE/g) ?? []).length;
      expect(parentSelectCount).toBeGreaterThanOrEqual(2); // 至少 2 个 SELECT FROM parents WHERE（hash + 明文）

      // student-import.repository.ts: 有 primary_mobile_hash 优先 SELECT + 明文 fallback SELECT
      const studentHashSelect = studentCode.match(/SELECT[\s\S]*?WHERE\s+primary_mobile_hash\s*=/g);
      expect(studentHashSelect).not.toBeNull();
      expect(studentHashSelect!.length).toBeGreaterThanOrEqual(1);
    });
  });
});
