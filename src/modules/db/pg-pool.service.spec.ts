import { Test } from '@nestjs/testing';
import { PgPoolService } from './pg-pool.service';
import { ConfigService } from '@nestjs/config';

describe('PgPoolService.transaction helper', () => {
  let svc: PgPoolService;
  let mockClient: { query: jest.Mock };
  let releaseSpy: jest.Mock;

  beforeEach(async () => {
    mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    releaseSpy = jest.fn();

    const m = await Test.createTestingModule({
      providers: [
        PgPoolService,
        {
          provide: ConfigService,
          useValue: { get: (k: string, d?: string) => d || 'mock' },
        },
      ],
    }).compile();
    svc = m.get(PgPoolService);

    // 手动替换 pool.connect 为 mock
    (svc as any).pool = {
      connect: jest.fn().mockResolvedValue({
        ...mockClient,
        release: releaseSpy,
      }),
      on: jest.fn(),
      end: jest.fn(),
    };
  });

  it('issues BEGIN/COMMIT around fn and returns result', async () => {
    const r = await svc.transaction(async (client) => {
      await client.query('UPDATE foo SET x = 1');
      return { ok: true };
    });
    expect(r).toEqual({ ok: true });
    const sqls = mockClient.query.mock.calls.map((c) => c[0]);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');
    expect(releaseSpy).toHaveBeenCalled();
  });

  it('issues ROLLBACK and re-throws on fn error', async () => {
    await expect(
      svc.transaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const sqls = mockClient.query.mock.calls.map((c) => c[0]);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    expect(releaseSpy).toHaveBeenCalled();
  });

  it('SET LOCAL search_path when tenantSchema given', async () => {
    await svc.transaction(
      async (client) => {
        await client.query('SELECT 1');
      },
      { tenantSchema: 'tenant_abc123' },
    );
    const sqls = mockClient.query.mock.calls.map((c) => c[0]);
    expect(sqls.some((s: string) => /SET LOCAL search_path TO tenant_abc123/.test(s))).toBe(true);
  });

  it('rejects invalid tenantSchema with regex check', async () => {
    await expect(
      svc.transaction(
        async () => undefined,
        { tenantSchema: 'evil; DROP TABLE x' },
      ),
    ).rejects.toThrow(/Invalid tenantSchema/);
    // 仍然 ROLLBACK + release
    const sqls = mockClient.query.mock.calls.map((c) => c[0]);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('ROLLBACK');
    expect(releaseSpy).toHaveBeenCalled();
  });

  it('always releases client even when ROLLBACK itself fails', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      throw new Error('original');
    });
    await expect(
      svc.transaction(async () => undefined),
    ).rejects.toThrow();
    expect(releaseSpy).toHaveBeenCalled();
  });
});
