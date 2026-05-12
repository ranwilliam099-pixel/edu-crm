#!/usr/bin/env ts-node
/**
 * backfill-v40-parents-phone.ts — A02-3 parent.phone 双列加密 backfill
 *
 * 来源：用户 2026-05-13「方案 A 双列 hash+encrypted」拍板 + V40 migration
 *
 * 与 V33/V34/V37/V39 backfill 关键差异：
 *   - public.parents 表跨租户共享（V10 拍板），不是 tenant schema 循环
 *   - 单表 N 行 backfill，N = 全平台家长总数
 *   - HMAC + AES-GCM 都需要 Node 实现（PG 内做字节序可能不一致）
 *
 * 模式：
 *   1. SELECT 所有 phone_hash IS NULL 或 phone_encrypted IS NULL 的行
 *   2. 逐行计算 hmac(phone) + aes-gcm(phone) 后 UPDATE
 *   3. 记录 OK / FAIL 计数 + per-row 错误日志
 *
 * 幂等：WHERE phone_hash IS NULL OR phone_encrypted IS NULL — 重跑只处理未 backfill 行
 *
 * 用法：
 *   # dry-run（默认，仅列总行数）
 *   npx ts-node scripts/backfill-v40-parents-phone.ts
 *
 *   # 真执行
 *   npx ts-node scripts/backfill-v40-parents-phone.ts --apply
 *
 *   # 限定 batch 大小（默认 200）
 *   npx ts-node scripts/backfill-v40-parents-phone.ts --apply --batch=500
 *
 * 前置：
 *   - .env 已配 ENCRYPTION_KEY + HASH_KEY（两个 key 必须不同）
 *   - DB_HOST / DB_USER / DB_PASSWORD / DB_NAME 可用
 *   - V40 已 apply（phone_hash + phone_encrypted 列已存在）
 *
 * 出具：edu-server backend  2026-05-13
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { Pool } from 'pg';
import { FieldEncryptor } from '../src/common/crypto/field-encryptor';
import { HmacHasher } from '../src/common/crypto/hmac-hasher';

/**
 * 简易 .env 读取（避免引入 dotenv 依赖）
 * 仅识别 KEY=VALUE 行，跳过 # 注释 + 空行；不支持 export / 多行 / 引号 escape
 * 已存在的 process.env 优先（不覆盖）
 */
function loadDotEnv(envPath: string): void {
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(resolve(__dirname, '..', '.env'));

interface CliOptions {
  apply: boolean;
  batchSize: number;
}

function parseArgs(): CliOptions {
  const opts: CliOptions = { apply: false, batchSize: 200 };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') opts.apply = true;
    else if (arg.startsWith('--batch=')) {
      const n = parseInt(arg.slice('--batch='.length), 10);
      if (!isNaN(n) && n > 0) opts.batchSize = n;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`用法: ts-node scripts/backfill-v40-parents-phone.ts [--apply] [--batch=N]`);
      process.exit(0);
    }
  }
  return opts;
}

interface ParentRowMin {
  id: string;
  phone: string | null;
  phone_hash: Buffer | null;
  phone_encrypted: Buffer | null;
}

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log('');
  console.log('===============================================');
  console.log('  V40 backfill parents.phone_hash + phone_encrypted');
  console.log('===============================================');
  console.log('');

  if (!opts.apply) {
    console.log('[mode] DRY-RUN (默认) — 加 --apply 真执行');
  } else {
    console.log('[mode] APPLY — 真执行 UPDATE');
  }
  console.log(`[batch] size = ${opts.batchSize}`);
  console.log('');

  // 1. 校验密钥（缺失会构造抛错）
  let encryptor: FieldEncryptor;
  let hasher: HmacHasher;
  try {
    encryptor = new FieldEncryptor();
    hasher = new HmacHasher();
  } catch (e) {
    console.error('[fatal] 密钥配置异常:', (e as Error).message);
    console.error('       请确认 .env 已配 ENCRYPTION_KEY + HASH_KEY');
    process.exit(1);
  }

  // 2. 连接 PG
  const pool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'eduapp',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'edu',
  });

  try {
    // 3. 统计待 backfill 行数
    const countRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM public.parents
       WHERE phone IS NOT NULL
         AND (phone_hash IS NULL OR phone_encrypted IS NULL)`,
    );
    const total = parseInt(countRes.rows[0]?.count || '0', 10);
    console.log(`[stats] 待 backfill 行数: ${total}`);
    console.log('');

    if (total === 0) {
      console.log('[ok] 无待处理行，退出');
      return;
    }

    if (!opts.apply) {
      console.log('[dry-run] 加 --apply 真执行');
      return;
    }

    // 4. 分批拉取 + 单行 UPDATE
    let processed = 0;
    let ok = 0;
    let failed = 0;
    const failures: Array<{ id: string; err: string }> = [];

    while (processed < total) {
      const batch = await pool.query<ParentRowMin>(
        `SELECT id, phone, phone_hash, phone_encrypted
         FROM public.parents
         WHERE phone IS NOT NULL
           AND (phone_hash IS NULL OR phone_encrypted IS NULL)
         ORDER BY id ASC
         LIMIT $1`,
        [opts.batchSize],
      );

      if (batch.rows.length === 0) break;

      for (const row of batch.rows) {
        if (!row.phone) {
          // 理论上 SELECT 已过滤，兜底
          continue;
        }
        try {
          const newHash = row.phone_hash || hasher.hash(row.phone);
          const newEncrypted = row.phone_encrypted || encryptor.encrypt(row.phone);
          await pool.query(
            `UPDATE public.parents
             SET phone_hash = $1, phone_encrypted = $2, updated_at = NOW()
             WHERE id = $3`,
            [newHash, newEncrypted, row.id],
          );
          ok++;
        } catch (err) {
          const msg = (err as Error).message;
          failures.push({ id: row.id, err: msg });
          failed++;
          console.error(`[fail] parent=${row.id.slice(0, 8)}...: ${msg}`);
        }
      }

      processed += batch.rows.length;
      console.log(`[progress] ${processed}/${total}  ok=${ok}  fail=${failed}`);
    }

    console.log('');
    console.log('===============================================');
    console.log('  Summary');
    console.log('===============================================');
    console.log(`  OK:      ${ok}`);
    console.log(`  FAILED:  ${failed}`);
    console.log('');

    if (failures.length > 0) {
      console.log('  失败行 (前 10 条):');
      failures.slice(0, 10).forEach((f) => {
        console.log(`    - ${f.id}: ${f.err}`);
      });
    }

    // 5. 校验：抽样回读确认 hash 一致
    if (ok > 0) {
      console.log('');
      console.log('[verify] 抽样回读校验（最多 5 行）...');
      const sample = await pool.query<ParentRowMin>(
        `SELECT id, phone, phone_hash, phone_encrypted
         FROM public.parents
         WHERE phone_hash IS NOT NULL AND phone_encrypted IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 5`,
      );
      let verifyOk = 0;
      for (const row of sample.rows) {
        if (!row.phone) continue;
        const expectedHash = hasher.hash(row.phone)!;
        const expectedDecrypt = row.phone_encrypted
          ? encryptor.decrypt(row.phone_encrypted)
          : null;
        const hashOk = row.phone_hash && row.phone_hash.equals(expectedHash);
        const decryptOk = expectedDecrypt === row.phone;
        if (hashOk && decryptOk) verifyOk++;
      }
      console.log(`[verify] ${verifyOk}/${sample.rows.length} 行往返一致`);
      if (verifyOk !== sample.rows.length) {
        console.error('[verify-fail] 部分行往返不一致，请人工检查');
        process.exit(1);
      }
    }

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
