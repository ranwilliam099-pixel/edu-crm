import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { AlertService } from '../../../common/alert/alert.service';

/**
 * WxPayCertMonitorService — 商户证书过期监控（T14 容灾 §1）
 *
 * 来源：
 *   - 2026-05-16 T14 architect spec §1（修 R1 audit P0-4：商户 cert 2031 过期无告警）
 *
 * 职责：
 *   - 每周一 08:00 Asia/Shanghai 读 apiclient_cert.pem 真实 not_after
 *   - 三档阈值：≥60d silent / <60d warn / <30d high / <7d fatal
 *   - 触发钉钉/企微告警（dedupKey 防 spam，复用现有 AlertService）
 *
 * Fail-open 哲学（与 wxpay-platform-cert 一致）：
 *   - 文件不存在 / PEM 解析失败 → logger.warn 不抛错
 *   - WXPAY_MODE=mock → 跳过（dev/早期不依赖）
 *   - AlertService 未注入 → 仅 logger（不阻塞 cron 调度）
 *
 * 防 anti-pattern（HARD_RULES §4 / spec §1.6）：
 *   - 装饰器 @Cron 名字 wxpay-cert-check 唯一（grep 验证）
 *   - 启动后 NestScheduleModule 注册日志可证 wiring 生效
 *
 * §1.3 AlertService 复用决策：
 *   实施前 grep 已确认 src/common/alert/alert.service.ts 存在（AlertModule global）
 *   → @Optional() 注入，不新建 dingtalk client
 */

/** crypto.X509Certificate 读 cert 结果（spec §1.2） */
type ReadCertResult =
  | { ok: true; daysLeft: number; notAfter: Date }
  | { ok: false; error: string };

const MS_PER_DAY = 86400000;

@Injectable()
export class WxPayCertMonitorService {
  private readonly logger = new Logger(WxPayCertMonitorService.name);

  constructor(
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly alertService?: AlertService,
  ) {}

  /**
   * 每周一 08:00 Asia/Shanghai 触发（spec §1.2）
   *
   * cron name 'wxpay-cert-check' 是 Runtime Wiring 验证锚点
   */
  @Cron('0 8 * * 1', {
    timeZone: 'Asia/Shanghai',
    name: 'wxpay-cert-check',
  })
  async checkMerchantCertExpiry(): Promise<void> {
    const mode = this.config?.get<string>('WXPAY_MODE', 'mock');
    if (mode !== 'real') return;

    const certPath = this.resolveActiveCertPath();
    if (!certPath) {
      this.logger.warn(
        'wxpay cert path not configured (WXPAY_CERT_PATH / _PRIMARY / _FALLBACK 全缺)，skip cert expiry check',
      );
      return;
    }

    const result = this.readCertExpiry(certPath);
    if (!result.ok) {
      this.logger.warn(`wxpay cert expiry read failed: ${result.error}`);
      return;
    }

    await this.handleExpiry(result.daysLeft, result.notAfter, certPath);
  }

  /**
   * 暴露给单测：纯函数读 cert validTo + 计算 daysLeft
   *
   * @returns {ok:true} 含 daysLeft (Math.floor) + notAfter
   *          {ok:false} 含 error 描述（文件不存在 / PEM 损坏 / crypto 异常）
   */
  readCertExpiry(certPath: string): ReadCertResult {
    try {
      if (!fs.existsSync(certPath)) {
        return { ok: false, error: `cert file not found: ${certPath}` };
      }
      const pem = fs.readFileSync(certPath, 'utf8');
      // Node 20+ stdlib：crypto.X509Certificate 解析 X.509 PEM
      const cert = new crypto.X509Certificate(pem);
      const notAfter = new Date(cert.validTo);
      const daysLeft = Math.floor((notAfter.getTime() - Date.now()) / MS_PER_DAY);
      return { ok: true, daysLeft, notAfter };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * 三档阈值决策（spec §1.2）
   *
   *   ≥60d: silent (debug log)
   *   <60d: warn  (logger.warn + alert severity=warn)
   *   <30d: high  (logger.error + alert severity=error)
   *    <7d: fatal (logger.error + alert severity=critical)
   *
   * dedupKey 按天粒度 (cert path + ISO date)，避免重复告警 spam
   */
  async handleExpiry(daysLeft: number, notAfter: Date, certPath: string): Promise<void> {
    const isoDate = notAfter.toISOString().slice(0, 10);

    if (daysLeft >= 60) {
      this.logger.debug(`wxpay cert ok: ${daysLeft}d left (expires ${isoDate})`);
      return;
    }

    const title = `wxpay 商户证书剩 ${daysLeft} 天到期`;
    const body = `cert path: \`${certPath}\`\nexpires: \`${isoDate}\`\ndays left: \`${daysLeft}\``;
    const dedupKey = `wxpay-cert-expiry:${certPath}:${new Date().toISOString().slice(0, 10)}`;
    // T14 round 2 (2026-05-16 三审共识 finding): dedupKey 按天粒度但 AlertService 默认 dedupTtl=30s
    //   语义不一致：手动触发或时区 DST 偏移可能让同天两次告警都通过（30s 后第二次仍发）。
    //   显式设 6h TTL：cron 每周一 08:00 触发，6h 窗口完全覆盖同一天调用，与 dedupKey ISO date 设计意图对齐。
    const dedupTtl = 6 * 3600;

    if (daysLeft < 7) {
      this.logger.error(`[CERT_FATAL] ${title} (${certPath} expires ${isoDate})`);
      await this.alertService?.send('critical', title, body, { dedupKey, dedupTtl });
    } else if (daysLeft < 30) {
      this.logger.error(`[CERT_HIGH] ${title} (${certPath} expires ${isoDate})`);
      await this.alertService?.send('error', title, body, { dedupKey, dedupTtl });
    } else {
      this.logger.warn(`[CERT_WARN] ${title} (${certPath} expires ${isoDate})`);
      await this.alertService?.send('warn', title, body, { dedupKey, dedupTtl });
    }
  }

  /**
   * 取当前 active cert path（与 wxpay-real / platform-cert 派生逻辑保持一致）
   *
   * 优先 WXPAY_CERT_PATH_<ACTIVE>，缺则 fallback WXPAY_CERT_PATH（旧无后缀）
   */
  private resolveActiveCertPath(): string | undefined {
    if (!this.config) return undefined;
    const active = this.config.get<string>('WXPAY_MCHID_ACTIVE', 'primary');
    const suffix = active.toUpperCase();
    return (
      this.config.get<string>(`WXPAY_CERT_PATH_${suffix}`) ||
      this.config.get<string>('WXPAY_CERT_PATH')
    );
  }
}
