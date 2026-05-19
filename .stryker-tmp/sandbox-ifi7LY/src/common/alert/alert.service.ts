import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../modules/redis/redis.service';

/**
 * AlertService — 钉钉/企微告警（生产架构 P0 第 8 项）
 *
 * 来源：用户 2026-05-10 「可上架生产架构」P0 第 8 项
 *
 * 用途：
 *   - 5xx 错误（GlobalExceptionFilter 调）
 *   - 慢查询 / DB 连接池满
 *   - 健康检查失败（外部 cron 调 /health/ready）
 *   - 业务异常（注册失败率 > 5% / 支付失败 > 1% / cron 失败）
 *
 * 关键设计：
 *   - 同一 alert 30s 内只发 1 次（防 spam，Redis setNX 实现）
 *   - 不阻塞主业务（fail-open，curl 失败不抛错）
 *   - 无 webhook URL 配置时静默跳过（dev/早期不依赖）
 *   - 5 个严重级别（DEBUG/INFO/WARN/ERROR/CRITICAL）
 *   - markdown 格式（钉钉 + 企微均支持）
 *
 * 配置 ENV：
 *   DINGTALK_WEBHOOK = https://oapi.dingtalk.com/robot/send?access_token=xxx
 *   WEWORK_WEBHOOK   = https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
 *
 * 至少配一个 webhook 才会真发；两个都不配 → 仅 logger 记录
 */

export type AlertLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface AlertOptions {
  /** 同一 dedupKey 在 dedupTtl 秒内只发 1 次（防 spam）*/
  dedupKey?: string;
  /** dedup 时间窗口，秒 */
  dedupTtl?: number;
  /** 附加 context（key-value 显示）*/
  context?: Record<string, unknown>;
  /** 主机名（默认 os.hostname）*/
  hostname?: string;
}

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  debug: '🔍',
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
  critical: '🚨',
};

@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);
  private readonly hostname: string;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    // 不强依赖 os 模块，简单从 env 取
    this.hostname = process.env.HOSTNAME ?? 'unknown';
  }

  /**
   * 发告警（同步等待，但内部失败不抛错）
   *
   * @returns true=已发出（或被 dedup 跳过）/ false=配置缺失或网络失败
   */
  async send(
    level: AlertLevel,
    title: string,
    body: string,
    options: AlertOptions = {},
  ): Promise<boolean> {
    // 1. dedup 检查（防 spam）
    if (options.dedupKey) {
      const ttl = options.dedupTtl ?? 30;
      const dedupRedisKey = `alert:dedup:${options.dedupKey}`;
      try {
        const ok = await this.redis.setNX(dedupRedisKey, '1', ttl);
        if (!ok) {
          this.logger.debug(`alert dedup skip: ${options.dedupKey}`);
          return true; // 视为成功（已在窗口内发过）
        }
      } catch (err) {
        // Redis 故障不阻断告警发送
        this.logger.warn(`alert dedup check failed (continue): ${(err as Error).message}`);
      }
    }

    // 2. 拼 markdown
    const md = this.buildMarkdown(level, title, body, options);

    // 3. 多渠道并发发送（任一成功即视为成功）
    const dingUrl = this.config.get<string>('DINGTALK_WEBHOOK', '');
    const weworkUrl = this.config.get<string>('WEWORK_WEBHOOK', '');

    const tasks: Promise<boolean>[] = [];
    if (dingUrl) tasks.push(this.sendDingtalk(dingUrl, title, md));
    if (weworkUrl) tasks.push(this.sendWework(weworkUrl, md));

    if (tasks.length === 0) {
      // 无 webhook 配置 → 仅日志
      this.logger.warn(`[ALERT-${level.toUpperCase()}] ${title}: ${body}`);
      return false;
    }

    const results = await Promise.allSettled(tasks);
    const anyOk = results.some((r) => r.status === 'fulfilled' && r.value);
    if (!anyOk) {
      this.logger.error(`[ALERT-FAIL] all webhooks failed for: ${title}`);
    }
    return anyOk;
  }

  // ============================================================
  // 便捷方法
  // ============================================================

  warn(title: string, body: string, options?: AlertOptions): Promise<boolean> {
    return this.send('warn', title, body, options);
  }

  error(title: string, body: string, options?: AlertOptions): Promise<boolean> {
    return this.send('error', title, body, options);
  }

  critical(title: string, body: string, options?: AlertOptions): Promise<boolean> {
    return this.send('critical', title, body, options);
  }

  // ============================================================
  // 内部：渠道实现
  // ============================================================

  private async sendDingtalk(url: string, title: string, markdown: string): Promise<boolean> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { title, text: markdown },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        this.logger.warn(`dingtalk webhook ${res.status}: ${await res.text()}`);
        return false;
      }
      const json = (await res.json()) as { errcode?: number; errmsg?: string };
      if (json.errcode !== 0) {
        this.logger.warn(`dingtalk errcode=${json.errcode} msg=${json.errmsg}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`dingtalk send failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async sendWework(url: string, markdown: string): Promise<boolean> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { content: markdown },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { errcode?: number };
      return json.errcode === 0;
    } catch (err) {
      this.logger.warn(`wework send failed: ${(err as Error).message}`);
      return false;
    }
  }

  private buildMarkdown(
    level: AlertLevel,
    title: string,
    body: string,
    options: AlertOptions,
  ): string {
    const emoji = LEVEL_EMOJI[level];
    const host = options.hostname ?? this.hostname;
    const env = process.env.NODE_ENV ?? 'development';
    const ts = new Date().toISOString().replace('T', ' ').replace(/\..+$/, ' UTC');

    let md = `## ${emoji} ${title}\n\n`;
    md += `**level**: ${level.toUpperCase()}\n\n`;
    md += `**env**: ${env}\n\n`;
    md += `**host**: ${host}\n\n`;
    md += `**time**: ${ts}\n\n`;
    md += `**详情**:\n\n${body}\n`;

    if (options.context && Object.keys(options.context).length > 0) {
      md += '\n**context**:\n\n';
      for (const [k, v] of Object.entries(options.context)) {
        md += `- ${k}: \`${this.safeStringify(v)}\`\n`;
      }
    }
    return md;
  }

  private safeStringify(v: unknown): string {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'string') return v.slice(0, 200);
    try {
      return JSON.stringify(v).slice(0, 200);
    } catch {
      return String(v);
    }
  }
}
