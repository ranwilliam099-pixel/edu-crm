/**
 * business-metrics.service.spec.ts (L7 业务监控 - 5/20 stryker 0% coverage 修补)
 *
 * 来源：5/20 stryker mutation 跑出 business-metrics 137 mutant 全 no-cov
 *   → 该 service 是 L7 5xx 错误率监控核心，5/13 commit `7013a3c` 上线但从未 spec
 *   → 同 audit_log silent fail 风险（监控代码本身没人测，坏了等于哑巴）
 *
 * 覆盖 case：
 *   1. record() ok / 4xx / 5xx counter 累加
 *   2. record() window 按 method:path key 分槽
 *   3. record() 5xx 触发 checkImmediateThreshold 异步检查
 *   4. record() 异常 fail-open（捕获 + logger.warn 不抛）
 *   5. flushSlot 写 Redis (key 格式 metrics:endpoint:M:P:1min:bucket)
 *   6. flushSlot Redis 缺 / Redis 抛 → fail-open
 *   7. checkImmediateThreshold 5xx < 10 不告警
 *   8. checkImmediateThreshold 5xx >= 10 + 未 dedup → alert.send critical
 *   9. checkImmediateThreshold dedup 命中跳过
 *   10. checkImmediateThreshold alert.send 抛 → fail-open
 *   11. checkErrorRateThresholds 5xx 率 > 1% MIN_SAMPLE+ → P1
 *   12. checkErrorRateThresholds 4xx 率 > 10% MIN_SAMPLE+ → P2 (warn)
 *   13. checkErrorRateThresholds 样本 < 10 跳过
 *   14. checkErrorRateThresholds dedup 命中跳过
 *   15. checkErrorRateThresholds 触发后 reset window
 *   16. isDeduped / markDeduped Redis 缺 → false / noop
 *   17. getWindowSnapshot 返当前 window 副本（仅 ok/fail4xx/fail5xx/total）
 *   18. resetWindow 清空
 */
import { BusinessMetricsService } from './business-metrics.service';

describe('BusinessMetricsService', () => {
  let service: BusinessMetricsService;
  let mockRedis: { get: jest.Mock; set: jest.Mock };
  let mockAlert: { send: jest.Mock };

  beforeEach(() => {
    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    mockAlert = { send: jest.fn().mockResolvedValue(undefined) };
    service = new BusinessMetricsService(mockRedis as any, mockAlert as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
    service.resetWindow();
  });

  // ----------------------------------------------------------------
  // Case 1-3: record() counter + window key + 5xx immediate
  // ----------------------------------------------------------------
  it('record() — 2xx 累加 ok，4xx 累加 fail4xx，5xx 累加 fail5xx', () => {
    service.record('POST', '/db/customers', 201, 50);
    service.record('POST', '/db/customers', 400, 30);
    service.record('POST', '/db/customers', 500, 100);

    const snap = service.getWindowSnapshot();
    expect(snap['POST:/db/customers']).toEqual({
      ok: 1,
      fail4xx: 1,
      fail5xx: 1,
      total: 3,
    });
  });

  it('record() — 不同 method/path 分独立 slot', () => {
    service.record('POST', '/db/customers', 200, 10);
    service.record('GET', '/db/customers', 200, 10);
    service.record('POST', '/db/students', 200, 10);

    const snap = service.getWindowSnapshot();
    expect(Object.keys(snap)).toHaveLength(3);
    expect(snap['POST:/db/customers'].ok).toBe(1);
    expect(snap['GET:/db/customers'].ok).toBe(1);
    expect(snap['POST:/db/students'].ok).toBe(1);
  });

  it('record() 5xx 触发 checkImmediateThreshold（间接：累 10 个 5xx → alert.send 调用）', async () => {
    for (let i = 0; i < 10; i++) {
      service.record('POST', '/db/customers', 500, 10);
    }
    // checkImmediateThreshold 是 async 但 record 不 await → 用 setImmediate 等微任务清空
    await new Promise((r) => setImmediate(r));
    expect(mockAlert.send).toHaveBeenCalledWith(
      'critical',
      expect.stringContaining('5xx 错误突增'),
      expect.stringContaining('5xx=10'),
      expect.objectContaining({ dedupKey: '5xx-count:POST:/db/customers' }),
    );
  });

  // ----------------------------------------------------------------
  // Case 4: record() fail-open
  // ----------------------------------------------------------------
  it('record() 异常 fail-open — 不抛错', () => {
    // 故意造成 window.set 失败：mock 内部 map throw
    const brokenMap = new Map();
    brokenMap.set = jest.fn(() => {
      throw new Error('boom');
    });
    (service as any).window = brokenMap;

    expect(() => service.record('POST', '/x', 200, 0)).not.toThrow();
  });

  // ----------------------------------------------------------------
  // Case 5-6: flushSlot Redis key + fail-open
  // ----------------------------------------------------------------
  it('flushSlot — 调 Redis.set 用 metrics:endpoint:M:P:1min:bucket key 格式 + 360s TTL', async () => {
    service.record('POST', '/db/customers', 200, 50);
    // record 内 flushSlot 是 fire-and-forget，等微任务
    await new Promise((r) => setImmediate(r));
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^metrics:endpoint:POST:\/db\/customers:1min:\d+$/),
      expect.stringContaining('"total":1'),
      360,
    );
    // duration 单独记
    expect(mockRedis.set).toHaveBeenCalledWith(
      'metrics:duration:POST:/db/customers:last',
      '50',
      60,
    );
  });

  it('flushSlot 无 Redis 注入 → fail-open 静默', async () => {
    const noRedisService = new BusinessMetricsService(undefined, mockAlert as any);
    expect(() => noRedisService.record('POST', '/x', 200, 0)).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(mockRedis.set).not.toHaveBeenCalled(); // 没注入根本不调
  });

  it('flushSlot Redis.set 抛 → fail-open 不污染主路径', async () => {
    mockRedis.set.mockRejectedValueOnce(new Error('redis down'));
    service.record('POST', '/x', 200, 0);
    await new Promise((r) => setImmediate(r));
    // record 返 void，没抛
    expect(mockAlert.send).not.toHaveBeenCalled(); // 5xx 阈值未到
  });

  // ----------------------------------------------------------------
  // Case 7-10: checkImmediateThreshold
  // ----------------------------------------------------------------
  it('checkImmediateThreshold — fail5xx < 10 不告警', async () => {
    for (let i = 0; i < 9; i++) service.record('POST', '/x', 500, 0);
    await new Promise((r) => setImmediate(r));
    expect(mockAlert.send).not.toHaveBeenCalled();
  });

  it('checkImmediateThreshold — dedup 命中跳过 alert', async () => {
    mockRedis.get.mockResolvedValue('1'); // dedup hit
    for (let i = 0; i < 10; i++) service.record('POST', '/x', 500, 0);
    await new Promise((r) => setImmediate(r));
    expect(mockAlert.send).not.toHaveBeenCalled();
  });

  it('checkImmediateThreshold — 无 alert 注入 → 跳过', async () => {
    const noAlertService = new BusinessMetricsService(mockRedis as any, undefined);
    for (let i = 0; i < 10; i++) noAlertService.record('POST', '/x', 500, 0);
    await new Promise((r) => setImmediate(r));
    expect(mockAlert.send).not.toHaveBeenCalled();
  });

  it('checkImmediateThreshold — alert.send 抛 fail-open', async () => {
    mockAlert.send.mockRejectedValueOnce(new Error('webhook down'));
    expect(() => {
      for (let i = 0; i < 10; i++) service.record('POST', '/x', 500, 0);
    }).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(mockAlert.send).toHaveBeenCalled(); // 调了，但抛被吞
  });

  it('checkImmediateThreshold — 触发后调 markDeduped', async () => {
    for (let i = 0; i < 10; i++) service.record('POST', '/x', 500, 0);
    await new Promise((r) => setImmediate(r));
    expect(mockRedis.set).toHaveBeenCalledWith(
      'alert:dedup:5xx-count:POST:/x',
      '1',
      300,
    );
  });

  // ----------------------------------------------------------------
  // Case 11-15: checkErrorRateThresholds
  // ----------------------------------------------------------------
  it('checkErrorRateThresholds — 5xx 率 > 1% + 样本 >= 10 → P1 critical', async () => {
    // 100 调用，2 个 5xx，rate = 2%（> 1% threshold）
    for (let i = 0; i < 98; i++) service.record('POST', '/x', 200, 0);
    for (let i = 0; i < 2; i++) service.record('POST', '/x', 500, 0);
    // 等 record 内部异步任务结算，再清 mock 校验 cron 行为
    await new Promise((r) => setImmediate(r));
    mockAlert.send.mockClear();
    mockRedis.set.mockClear();
    mockRedis.get.mockResolvedValue(null);

    const result = await service.checkErrorRateThresholds();
    expect(result.checked).toBe(1);
    expect(result.alerted).toBe(1);
    expect(mockAlert.send).toHaveBeenCalledWith(
      'critical',
      expect.stringContaining('5xx 错误率突增'),
      expect.stringContaining('rate='),
      expect.objectContaining({ dedupKey: '5xx-rate:POST:/x' }),
    );
  });

  it('checkErrorRateThresholds — 4xx 率 > 10% + 5xx 不超 → P2 warn', async () => {
    for (let i = 0; i < 85; i++) service.record('POST', '/x', 200, 0);
    for (let i = 0; i < 15; i++) service.record('POST', '/x', 400, 0); // 15% 4xx
    await new Promise((r) => setImmediate(r));
    mockAlert.send.mockClear();
    mockRedis.set.mockClear();
    mockRedis.get.mockResolvedValue(null);

    const result = await service.checkErrorRateThresholds();
    expect(result.alerted).toBe(1);
    expect(mockAlert.send).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('4xx 错误率高'),
      expect.stringContaining('rate='),
      expect.objectContaining({ dedupKey: '4xx-rate:POST:/x' }),
    );
  });

  it('checkErrorRateThresholds — 样本 < MIN_SAMPLE_FOR_RATE (10) 跳过', async () => {
    for (let i = 0; i < 5; i++) service.record('POST', '/x', 500, 0); // 100% 5xx 但样本太少
    await new Promise((r) => setImmediate(r));
    mockAlert.send.mockClear();

    const result = await service.checkErrorRateThresholds();
    expect(result.checked).toBe(1);
    expect(result.alerted).toBe(0);
    expect(mockAlert.send).not.toHaveBeenCalled();
  });

  it('checkErrorRateThresholds — dedup 命中跳过', async () => {
    for (let i = 0; i < 100; i++) service.record('POST', '/x', i < 5 ? 500 : 200, 0);
    await new Promise((r) => setImmediate(r));
    mockAlert.send.mockClear();
    mockRedis.get.mockResolvedValue('1'); // dedup hit

    const result = await service.checkErrorRateThresholds();
    expect(result.alerted).toBe(0);
    expect(mockAlert.send).not.toHaveBeenCalled();
  });

  it('checkErrorRateThresholds — 触发后 reset window', async () => {
    for (let i = 0; i < 100; i++) service.record('POST', '/x', i < 5 ? 500 : 200, 0);
    await new Promise((r) => setImmediate(r));
    mockRedis.get.mockResolvedValue(null);

    await service.checkErrorRateThresholds();
    const snap = service.getWindowSnapshot();
    expect(snap['POST:/x']).toEqual({ ok: 0, fail4xx: 0, fail5xx: 0, total: 0 });
  });

  it('checkErrorRateThresholds — 5xx 优先于 4xx（同 window 5xx 触发不再判 4xx）', async () => {
    // 95 ok / 2 5xx / 3 4xx 都超阈值
    for (let i = 0; i < 95; i++) service.record('POST', '/x', 200, 0);
    for (let i = 0; i < 2; i++) service.record('POST', '/x', 500, 0);
    for (let i = 0; i < 13; i++) service.record('POST', '/x', 400, 0); // 13% 4xx
    await new Promise((r) => setImmediate(r));
    mockAlert.send.mockClear();
    mockRedis.get.mockResolvedValue(null);

    const result = await service.checkErrorRateThresholds();
    // 只触发一次 critical (5xx)，不再发 warn (4xx)
    expect(result.alerted).toBe(1);
    expect(mockAlert.send).toHaveBeenCalledTimes(1);
    expect(mockAlert.send).toHaveBeenCalledWith(
      'critical',
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });

  // ----------------------------------------------------------------
  // Case 16: isDeduped / markDeduped fail-open
  // ----------------------------------------------------------------
  it('isDeduped Redis.get 抛 → false (fail-open，不阻 alert)', async () => {
    mockRedis.get.mockRejectedValue(new Error('redis down'));
    for (let i = 0; i < 10; i++) service.record('POST', '/x', 500, 0);
    await new Promise((r) => setImmediate(r));
    // Redis 抛 → isDeduped 返 false → alert 仍发
    expect(mockAlert.send).toHaveBeenCalled();
  });

  it('markDeduped Redis.set 抛 → 不抛 fail-open', async () => {
    mockRedis.set.mockRejectedValue(new Error('redis down'));
    expect(() => {
      for (let i = 0; i < 10; i++) service.record('POST', '/x', 500, 0);
    }).not.toThrow();
  });

  // ----------------------------------------------------------------
  // Case 17-18: getWindowSnapshot / resetWindow
  // ----------------------------------------------------------------
  it('getWindowSnapshot — 仅返 ok/fail4xx/fail5xx/total（不含 lastFlushAt）', () => {
    service.record('POST', '/x', 200, 0);
    const snap = service.getWindowSnapshot();
    expect(Object.keys(snap['POST:/x'])).toEqual(['ok', 'fail4xx', 'fail5xx', 'total']);
    expect(snap['POST:/x']).not.toHaveProperty('lastFlushAt');
  });

  it('resetWindow — 清空所有 slot', () => {
    service.record('POST', '/x', 200, 0);
    service.record('GET', '/y', 200, 0);
    expect(Object.keys(service.getWindowSnapshot())).toHaveLength(2);
    service.resetWindow();
    expect(Object.keys(service.getWindowSnapshot())).toHaveLength(0);
  });
});
