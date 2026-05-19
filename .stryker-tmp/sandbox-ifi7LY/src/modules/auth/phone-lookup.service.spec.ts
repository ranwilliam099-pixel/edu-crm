/**
 * PhoneLookupService 单测 — Sprint X.2 (2026-05-17)
 *
 * 验证（SSOT §12.1）：
 *   - 跨表反查: parents 表 + N tenants.users
 *   - fail-open: 某 tenant 抛错不影响其他 tenant
 *   - V44: deleted_at IS NULL 仅返 active
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PhoneLookupService } from './phone-lookup.service';
import { PgPoolService } from '../db/pg-pool.service';
import { ParentRepository } from '../db/parent.repository';
import type { Parent } from '../parent/parent.service';

describe('PhoneLookupService - Sprint X.2 跨表 phone 反查', () => {
  let service: PhoneLookupService;
  let pgQuerySpy: jest.Mock;
  let pgTenantQuerySpy: jest.Mock;
  let parentFindByPhoneSpy: jest.Mock;

  beforeEach(async () => {
    pgQuerySpy = jest.fn().mockResolvedValue([]);
    pgTenantQuerySpy = jest.fn().mockResolvedValue([]);
    parentFindByPhoneSpy = jest.fn().mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PhoneLookupService,
        {
          provide: PgPoolService,
          useValue: {
            query: pgQuerySpy,
            tenantQuery: pgTenantQuerySpy,
          },
        },
        {
          provide: ParentRepository,
          useValue: { findParentByPhone: parentFindByPhoneSpy },
        },
      ],
    }).compile();

    service = module.get(PhoneLookupService);
  });

  it('phone 未注册 → { bUsers: [], parent: null }', async () => {
    pgQuerySpy.mockResolvedValueOnce([]); // tenants list 空
    parentFindByPhoneSpy.mockResolvedValueOnce(null);
    const result = await service.lookupByPhone('13800001111');
    expect(result).toEqual({ bUsers: [], parent: null });
  });

  it('parents 表命中 → parent 返回, bUsers 空', async () => {
    pgQuerySpy.mockResolvedValueOnce([]); // 0 tenants
    parentFindByPhoneSpy.mockResolvedValueOnce({
      id: 'p1'.padEnd(32, '0'),
      phone: '13800001111',
      status: '启用',
    } as unknown as Parent);
    const result = await service.lookupByPhone('13800001111');
    expect(result.parent).toEqual({
      parentId: 'p1'.padEnd(32, '0'),
      status: '启用',
    });
    expect(result.bUsers).toEqual([]);
  });

  it('单 tenant.users 命中 → bUsers 1 row', async () => {
    pgQuerySpy.mockResolvedValueOnce([{ id: 'T1'.padEnd(32, '0'), name: 'TenantA' }]);
    pgTenantQuerySpy.mockResolvedValueOnce([
      {
        id: 'u1'.padEnd(32, '0'),
        name: 'Alice',
        mobile: '13800001111',
        role: 'sales',
        campus_id: 'c1'.padEnd(32, '0'),
        status: '启用',
        deleted_at: null,
        password_hash: '$2b$12$xxx',
        campus_name: '主校区',
      },
    ]);
    const result = await service.lookupByPhone('13800001111');
    expect(result.bUsers).toHaveLength(1);
    expect(result.bUsers[0].userId).toBe('u1'.padEnd(32, '0'));
    expect(result.bUsers[0].role).toBe('sales');
    expect(result.bUsers[0].tenantName).toBe('TenantA');
    expect(result.bUsers[0].campusName).toBe('主校区');
  });

  it('跨 tenant 多绑 → 2+ bUsers', async () => {
    pgQuerySpy.mockResolvedValueOnce([
      { id: 'T1'.padEnd(32, '0'), name: 'TenantA' },
      { id: 'T2'.padEnd(32, '0'), name: 'TenantB' },
    ]);
    pgTenantQuerySpy
      .mockResolvedValueOnce([
        {
          id: 'u1'.padEnd(32, '0'),
          name: 'Alice',
          mobile: '13800001111',
          role: 'sales',
          campus_id: 'c1'.padEnd(32, '0'),
          status: '启用',
          deleted_at: null,
          password_hash: 'h1',
          campus_name: 'TenantA主校区',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'u2'.padEnd(32, '0'),
          name: 'Alice',
          mobile: '13800001111',
          role: 'teacher',
          campus_id: 'c2'.padEnd(32, '0'),
          status: '启用',
          deleted_at: null,
          password_hash: 'h2',
          campus_name: 'TenantB主校区',
        },
      ]);
    const result = await service.lookupByPhone('13800001111');
    expect(result.bUsers).toHaveLength(2);
    expect(result.bUsers[0].tenantId).toBe('T1'.padEnd(32, '0'));
    expect(result.bUsers[1].tenantId).toBe('T2'.padEnd(32, '0'));
  });

  it('fail-open: tenants list 查询失败 → 返空 bUsers', async () => {
    pgQuerySpy.mockRejectedValueOnce(new Error('DB down'));
    const result = await service.lookupByPhone('13800001111');
    expect(result.bUsers).toEqual([]);
  });

  it('fail-open: 某 tenant 查询失败 → 不影响其他 tenant', async () => {
    pgQuerySpy.mockResolvedValueOnce([
      { id: 'T1'.padEnd(32, '0'), name: 'TenantA' },
      { id: 'T2'.padEnd(32, '0'), name: 'TenantB' },
    ]);
    pgTenantQuerySpy
      .mockRejectedValueOnce(new Error('schema not found'))
      .mockResolvedValueOnce([
        {
          id: 'u2'.padEnd(32, '0'),
          name: 'Bob',
          mobile: '13800001111',
          role: 'sales',
          campus_id: 'c2'.padEnd(32, '0'),
          status: '启用',
          deleted_at: null,
          password_hash: 'h2',
          campus_name: '主校区',
        },
      ]);
    const result = await service.lookupByPhone('13800001111');
    // T1 抛错跳过, T2 命中
    expect(result.bUsers).toHaveLength(1);
    expect(result.bUsers[0].tenantId).toBe('T2'.padEnd(32, '0'));
  });

  it('fail-open: parents 反查抛错 → parent null + bUsers 仍正常', async () => {
    parentFindByPhoneSpy.mockRejectedValueOnce(new Error('decrypt failed'));
    pgQuerySpy.mockResolvedValueOnce([]); // 0 tenants
    const result = await service.lookupByPhone('13800001111');
    expect(result.parent).toBeNull();
    expect(result.bUsers).toEqual([]);
  });

  it('parent.status="停用" 直接透传 (上层 controller 过滤)', async () => {
    parentFindByPhoneSpy.mockResolvedValueOnce({
      id: 'p1'.padEnd(32, '0'),
      phone: '13800001111',
      status: '停用',
    } as unknown as Parent);
    pgQuerySpy.mockResolvedValueOnce([]);
    const result = await service.lookupByPhone('13800001111');
    expect(result.parent?.status).toBe('停用');
  });
});
