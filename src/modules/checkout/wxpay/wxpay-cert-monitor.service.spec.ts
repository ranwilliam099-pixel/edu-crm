import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AlertService } from '../../../common/alert/alert.service';
import { WxPayCertMonitorService } from './wxpay-cert-monitor.service';

/**
 * WxPayCertMonitorService 单元测试 — T14 §1.5 9 用例
 *
 * 覆盖：
 *   1. readCertExpiry 文件不存在
 *   2. readCertExpiry 合法 100d cert
 *   3. readCertExpiry 损坏 PEM
 *   4. handleExpiry 90d (silent)
 *   5. handleExpiry 59d (warn)
 *   6. handleExpiry 29d (error)
 *   7. handleExpiry 6d (critical)
 *   8. checkMerchantCertExpiry WXPAY_MODE=mock (skip)
 *   9. checkMerchantCertExpiry 缺 WXPAY_CERT_PATH (warn skip)
 *
 * fixture：beforeAll 用 crypto.generateKeyPairSync + X509Certificate 自签
 *   100d / 59d / 29d / 6d 临时 cert，写 os.tmpdir()，afterAll 清理
 */

const MS_PER_DAY = 86400000;

/**
 * 用 openssl 命令自签 cert（CI / 本地都装了 openssl，比手写 ASN.1 DER 简洁）
 *
 * 选 openssl 而非 selfsigned npm 包的理由：
 *   - 项目未装 selfsigned（package.json 无依赖）
 *   - crypto.X509Certificate 只读不能 .create()
 *   - 手写 ASN.1 DER 编码 > 200 LOC fixture，违反 HARD_RULES §3
 */
function openssl_genSelfSignedCert(days: number): {
  certPath: string;
  cleanup: () => void;
} {
  const { execSync } = require('child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxpay-cert-mon-'));
  const keyPath = path.join(tmpDir, 'k.pem');
  const certPath = path.join(tmpDir, 'c.pem');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${certPath} -days ${days} -subj /CN=test 2>/dev/null`,
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  return {
    certPath,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

describe('WxPayCertMonitorService (T14)', () => {
  let service: WxPayCertMonitorService;
  let config: { get: jest.Mock };
  let alertService: jest.Mocked<Pick<AlertService, 'send'>>;
  const fixtures: { cleanup: () => void }[] = [];

  // 4 个固定到期天数的 cert fixture（spec §1.5）
  let cert100d: { certPath: string };
  let cert59d: { certPath: string };
  let cert29d: { certPath: string };
  let cert6d: { certPath: string };

  beforeAll(() => {
    // openssl -days 是 cert 颁发到过期的天数；我们要 daysLeft = N，
    // 所以 -days = N（cert 立即颁发 + N 天后过期）
    const a = openssl_genSelfSignedCert(100);
    const b = openssl_genSelfSignedCert(59);
    const c = openssl_genSelfSignedCert(29);
    const d = openssl_genSelfSignedCert(6);
    cert100d = { certPath: a.certPath };
    cert59d = { certPath: b.certPath };
    cert29d = { certPath: c.certPath };
    cert6d = { certPath: d.certPath };
    fixtures.push(a, b, c, d);
  });

  afterAll(() => {
    for (const f of fixtures) {
      try {
        f.cleanup();
      } catch {
        /* ignore */
      }
    }
  });

  beforeEach(async () => {
    config = {
      get: jest.fn((k: string, def?: unknown) => {
        if (k === 'WXPAY_MODE') return 'real';
        if (k === 'WXPAY_MCHID_ACTIVE') return 'primary';
        if (k === 'WXPAY_CERT_PATH') return cert100d.certPath;
        return def;
      }),
    };
    alertService = {
      send: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<Pick<AlertService, 'send'>>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WxPayCertMonitorService,
        { provide: ConfigService, useValue: config },
        { provide: AlertService, useValue: alertService },
      ],
    }).compile();

    service = module.get(WxPayCertMonitorService);
  });

  describe('readCertExpiry', () => {
    it('文件不存在 → {ok:false, error:/not found/}', () => {
      const r = service.readCertExpiry('/tmp/__nonexistent_wxpay_cert__.pem');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(/not found/);
      }
    });

    it('合法 100d cert → {ok:true, daysLeft ≈ 100, notAfter Date}', () => {
      const r = service.readCertExpiry(cert100d.certPath);
      expect(r.ok).toBe(true);
      if (r.ok) {
        // openssl -days 100 + 立即颁发 → daysLeft ∈ [99, 100]（时钟漂移 + Math.floor）
        expect(r.daysLeft).toBeGreaterThanOrEqual(99);
        expect(r.daysLeft).toBeLessThanOrEqual(100);
        expect(r.notAfter).toBeInstanceOf(Date);
        expect(r.notAfter.getTime()).toBeGreaterThan(Date.now());
      }
    });

    it('损坏 PEM → {ok:false}', () => {
      const tmp = path.join(os.tmpdir(), `bad-cert-${Date.now()}.pem`);
      fs.writeFileSync(tmp, 'not a real pem');
      try {
        const r = service.readCertExpiry(tmp);
        expect(r.ok).toBe(false);
      } finally {
        fs.unlinkSync(tmp);
      }
    });
  });

  describe('handleExpiry 阈值决策', () => {
    it('90d → silent（0 alert call）', async () => {
      await service.handleExpiry(90, new Date(Date.now() + 90 * MS_PER_DAY), '/p');
      expect(alertService.send).not.toHaveBeenCalled();
    });

    it('59d → 1 alert call severity=warn', async () => {
      await service.handleExpiry(59, new Date(Date.now() + 59 * MS_PER_DAY), '/p');
      expect(alertService.send).toHaveBeenCalledTimes(1);
      expect(alertService.send).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('59'),
        expect.any(String),
        expect.objectContaining({ dedupKey: expect.stringContaining('/p') }),
      );
    });

    it('29d → 1 alert call severity=error', async () => {
      await service.handleExpiry(29, new Date(Date.now() + 29 * MS_PER_DAY), '/p');
      expect(alertService.send).toHaveBeenCalledTimes(1);
      expect(alertService.send).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('29'),
        expect.any(String),
        expect.objectContaining({ dedupKey: expect.any(String) }),
      );
    });

    it('6d → 1 alert call severity=critical', async () => {
      await service.handleExpiry(6, new Date(Date.now() + 6 * MS_PER_DAY), '/p');
      expect(alertService.send).toHaveBeenCalledTimes(1);
      expect(alertService.send).toHaveBeenCalledWith(
        'critical',
        expect.stringContaining('6'),
        expect.any(String),
        expect.objectContaining({ dedupKey: expect.any(String) }),
      );
    });
  });

  describe('checkMerchantCertExpiry 入口', () => {
    it('WXPAY_MODE=mock → 跳过（不读文件不告警）', async () => {
      config.get.mockImplementation((k: string) => {
        if (k === 'WXPAY_MODE') return 'mock';
        return undefined;
      });
      // spy readCertExpiry 不应被调
      const spy = jest.spyOn(service, 'readCertExpiry');
      await service.checkMerchantCertExpiry();
      expect(spy).not.toHaveBeenCalled();
      expect(alertService.send).not.toHaveBeenCalled();
    });

    it('WXPAY_MODE=real + 缺 CERT_PATH → warn skip', async () => {
      config.get.mockImplementation((k: string, def?: unknown) => {
        if (k === 'WXPAY_MODE') return 'real';
        if (k === 'WXPAY_MCHID_ACTIVE') return 'primary';
        // 所有 cert path 都缺
        return def;
      });
      const spy = jest.spyOn(service, 'readCertExpiry');
      await service.checkMerchantCertExpiry();
      expect(spy).not.toHaveBeenCalled();
      expect(alertService.send).not.toHaveBeenCalled();
    });
  });

  describe('整合：cert6d 文件 → 触发 critical 告警', () => {
    it('checkMerchantCertExpiry 读 6d cert → severity=critical', async () => {
      config.get.mockImplementation((k: string, def?: unknown) => {
        if (k === 'WXPAY_MODE') return 'real';
        if (k === 'WXPAY_MCHID_ACTIVE') return 'primary';
        if (k === 'WXPAY_CERT_PATH') return cert6d.certPath;
        return def;
      });
      await service.checkMerchantCertExpiry();
      expect(alertService.send).toHaveBeenCalledTimes(1);
      const [level] = alertService.send.mock.calls[0]!;
      // 6d cert，但 openssl 颁发 + 读取间可能 daysLeft=5 或 6（Math.floor）
      // 阈值 < 7 → critical
      expect(level).toBe('critical');
    });
  });

  describe('AlertService 未注入 → 仅 logger（不抛错）', () => {
    it('handleExpiry 59d 无 alertService → 不抛错', async () => {
      // 重建一个不注入 alertService 的 service
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WxPayCertMonitorService,
          { provide: ConfigService, useValue: config },
        ],
      }).compile();
      const s = module.get(WxPayCertMonitorService);
      await expect(
        s.handleExpiry(59, new Date(Date.now() + 59 * MS_PER_DAY), '/p'),
      ).resolves.not.toThrow();
    });
  });
});
