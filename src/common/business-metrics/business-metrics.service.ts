import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '../../modules/redis/redis.service';
import { AlertService } from '../alert/alert.service';

/**
 * BusinessMetricsService (L7 v2.0 §3.L7) — 业务关键路径成功率聚合 + 阈值告警
 *
 * 设计：
 *   - record(method, path, status, durationMs) 内存累加 5min 窗口
 *   - cron 每 1min flush 到 Redis (key: `metrics:endpoint:{method}:{path}:5min:{ts}`)
 *   - 错误率 > 1% 持续 5min → alert.send 钉钉/企微告警
 *   - Redis fail-open（监控不阻塞业务）
 *
 * 阈值（拍板）：
 *   - 5xx 错误率 > 1% / 5min → P1 告警
 *   - 4xx 错误率 > 10% / 5min → P2 告警（业务异常多）
 *   - 单 endpoint 5xx 总数 > 10 / 1min → P1 即时告警
 *
 * 防 spam：
 *   - 同 endpoint 同级别告警 Redis dedup 5min（key: `alert:dedup:{key}`）
 *
 * 失败模式：
 *   - record() 完全捕获（fail-open）
 *   - Redis 写失败 → logger.warn 不抛
 *   - alertService.send 失败 → logger.warn 不抛
 */
@Injectable()
export class BusinessMetricsService {
  private readonly logger = new Logger(BusinessMetricsService.name);

  // 内存窗口：5min slot 按 endpoint 累加
  // 格式: { 'POST:/db/customers': { ok: 0, fail4xx: 0, fail5xx: 0, total: 0, lastFlushAt: ts } }
  private readonly window: Map<
    string,
    { ok: number; fail4xx: number; fail5xx: number; total: number; lastFlushAt: number }
  > = new Map();

  private readonly DEDUP_WINDOW_SEC = 300; // 5min
  private readonly ERR_RATE_5XX_THRESHOLD = 0.01; // 1%
  private readonly ERR_RATE_4XX_THRESHOLD = 0.1; // 10%
  private readonly ERR_COUNT_5XX_THRESHOLD_PER_MIN = 10;
  private readonly MIN_SAMPLE_FOR_RATE = 10; // 至少 10 样本才看比率（防小样本噪音）

  constructor(
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly alert?: AlertService,
  ) {}

  /**
   * 记录一次业务调用
   *
   * fail-open：所有异常吞掉 + logger.warn
   */
  record(method: string, path: string, status: number, durationMs: number): void {
    try {
      const key = `${method}:${path}`;
      const slot = this.window.get(key) ?? {
        ok: 0,
        fail4xx: 0,
        fail5xx: 0,
        total: 0,
        lastFlushAt: Date.now(),
      };
      slot.total++;
      if (status >= 500) {
        slot.fail5xx++;
        // 单条 5xx 即时检查阈值（不等 cron）
        this.checkImmediateThreshold(key, slot).catch((err) =>
          this.logger.warn(`checkImmediateThreshold failed: ${(err as Error).message}`),
        );
      } else if (status >= 400) {
        slot.fail4xx++;
      } else {
        slot.ok++;
      }
      this.window.set(key, slot);

      // 异步 flush（不 await）
      void this.flushSlot(key, slot, durationMs);
    } catch (e) {
      // 完全 fail-open
      this.logger.warn(`metrics.record failed (fail-open): ${(e as Error).message}`);
    }
  }

  /**
   * 写当前 slot 到 Redis (5min 窗口分桶)
   */
  private async flushSlot(
    key: string,
    slot: { ok: number; fail4xx: number; fail5xx: number; total: number; lastFlushAt: number },
    durationMs: number,
  ): Promise<void> {
    if (!this.redis) return; // dev / test 无 Redis fail-open
    try {
      const bucket = Math.floor(Date.now() / 60000); // 1min bucket
      const redisKey = `metrics:endpoint:${key}:1min:${bucket}`;
      // INCR + EXPIRE 6min (保留 5min + 1min buffer)
      await this.redis.set(redisKey, JSON.stringify(slot), 360);
      // 单独记录 duration（P50/P95 后续 cron 聚合）
      await this.redis.set(`metrics:duration:${key}:last`, String(durationMs), 60);
    } catch (e) {
      // fail-open
      this.logger.warn(`metrics.flushSlot failed (fail-open): ${(e as Error).message}`);
    }
  }

  /**
   * 即时阈值检查：单 endpoint 5xx 数 > 10/1min → P1 告警
   */
  private async checkImmediateThreshold(
    key: string,
    slot: { ok: number; fail4xx: number; fail5xx: number; total: number; lastFlushAt: number },
  ): Promise<void> {
    if (!this.alert) return; // dev / test 无 alert fail-open
    // 仅当 5xx 数 >= 阈值 才告警
    if (slot.fail5xx < this.ERR_COUNT_5XX_THRESHOLD_PER_MIN) return;
    // dedup 防 spam
    if (await this.isDeduped(`5xx-count:${key}`)) return;

    try {
      await this.alert.send(
        'critical',
        `5xx 错误突增: ${key}`,
        `endpoint=${key} | 5xx=${slot.fail5xx} | total=${slot.total} | window=5min`,
        { dedupKey: `5xx-count:${key}`, dedupTtl: this.DEDUP_WINDOW_SEC },
      );
      await this.markDeduped(`5xx-count:${key}`);
    } catch (e) {
      this.logger.warn(`alert.send failed (fail-open): ${(e as Error).message}`);
    }
  }

  /**
   * cron 调用：扫所有 endpoint，计算 5min 错误率，触发阈值告警
   * 应该在 cron-jobs.service 里每 5min 调一次
   */
  async checkErrorRateThresholds(): Promise<{ alerted: number; checked: number }> {
    let alerted = 0;
    let checked = 0;
    for (const [key, slot] of this.window.entries()) {
      checked++;
      if (slot.total < this.MIN_SAMPLE_FOR_RATE) continue;

      const rate5xx = slot.fail5xx / slot.total;
      const rate4xx = slot.fail4xx / slot.total;

      if (rate5xx > this.ERR_RATE_5XX_THRESHOLD) {
        if (!(await this.isDeduped(`5xx-rate:${key}`))) {
          await this.tryAlert('P1', `5xx 错误率突增: ${key}`, key, slot, rate5xx);
          await this.markDeduped(`5xx-rate:${key}`);
          alerted++;
        }
      } else if (rate4xx > this.ERR_RATE_4XX_THRESHOLD) {
        if (!(await this.isDeduped(`4xx-rate:${key}`))) {
          await this.tryAlert('P2', `4xx 错误率高: ${key}`, key, slot, rate4xx);
          await this.markDeduped(`4xx-rate:${key}`);
          alerted++;
        }
      }

      // reset window
      this.window.set(key, {
        ok: 0,
        fail4xx: 0,
        fail5xx: 0,
        total: 0,
        lastFlushAt: Date.now(),
      });
    }
    return { alerted, checked };
  }

  private async tryAlert(
    level: 'P1' | 'P2',
    title: string,
    key: string,
    slot: { ok: number; fail4xx: number; fail5xx: number; total: number; lastFlushAt: number },
    rate: number,
  ): Promise<void> {
    if (!this.alert) return;
    // P1 → critical, P2 → warn (alert.service AlertLevel: 'critical' | 'error' | 'warn')
    const alertLevel = level === 'P1' ? 'critical' : 'warn';
    try {
      await this.alert.send(
        alertLevel,
        title,
        `endpoint=${key} | rate=${(rate * 100).toFixed(2)}% | total=${slot.total} | ok=${slot.ok} | 4xx=${slot.fail4xx} | 5xx=${slot.fail5xx}`,
        { dedupKey: `${level === 'P1' ? '5xx' : '4xx'}-rate:${key}`, dedupTtl: this.DEDUP_WINDOW_SEC },
      );
    } catch (e) {
      this.logger.warn(`alert.send failed (fail-open): ${(e as Error).message}`);
    }
  }

  private async isDeduped(dedupKey: string): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const v = await this.redis.get(`alert:dedup:${dedupKey}`);
      return v !== null;
    } catch {
      return false; // fail-open
    }
  }

  private async markDeduped(dedupKey: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(`alert:dedup:${dedupKey}`, '1', this.DEDUP_WINDOW_SEC);
    } catch {
      // fail-open
    }
  }

  /**
   * 测试用：拿当前 window 快照
   */
  getWindowSnapshot(): Record<string, { ok: number; fail4xx: number; fail5xx: number; total: number }> {
    const out: Record<string, { ok: number; fail4xx: number; fail5xx: number; total: number }> = {};
    for (const [key, slot] of this.window.entries()) {
      out[key] = {
        ok: slot.ok,
        fail4xx: slot.fail4xx,
        fail5xx: slot.fail5xx,
        total: slot.total,
      };
    }
    return out;
  }

  /**
   * 测试用：清空 window
   */
  resetWindow(): void {
    this.window.clear();
  }
}
