#!/usr/bin/env ts-node
/**
 * backfill-v41-customers-mobile.ts — A02-4 customers.primary_mobile 三列加密 backfill（单 tenant）
 *
 * 来源：用户 2026-05-10 P0 第 2 项「敏感字段加密」+ V41 migration
 *
 * 模式：单 tenant 进程 — 外层 bash 脚本（backfill-v41-customers-mobile.sh）循环 tenants
 *   - 跟 V40 (单表 N 行) 不同：customers 在 tenant schema，需要 64 tenants × N 行
 *   - 跟 V34/V35/V37/V39 (纯 SQL) 不同：HMAC + AES 需 Node 实现，PG 内做字节序可能不一致
 *
 * 单 tenant 流程：
 *   1. SET search_path TO ${TENANT_SCHEMA}, public
 *   2. SELECT 所有 primary_mobile_hash IS NULL 或 primary_mobile_encrypted IS NULL 的行
 *   3. 逐行计算 hmac(primary_mobile) + aes-gcm(primary_mobile) 后 UPDATE
 *   4. 输出 OK=N FAIL=N（供外层 bash 累计）
 *
 * 幂等：WHERE primary_mobile_hash IS NULL OR primary_mobile_encrypted IS NULL — 重跑只处理未 backfill 行
 *
 * 用法（由 backfill-v41-customers-mobile.sh 调用，不直接执行）：
 *   # dry-run（默认，仅列总行数）
 *   TENANT_SCHEMA=tenant_xxx npx ts-node scripts/backfill-v41-customers-mobile.ts
 *
 *   # 真执行
 *   TENANT_SCHEMA=tenant_xxx npx ts-node scripts/backfill-v41-customers-mobile.ts --apply
 *
 *   # 限定 batch 大小（默认 200）
 *   TENANT_SCHEMA=tenant_xxx npx ts-node scripts/backfill-v41-customers-mobile.ts --apply --batch=500
 *
 * 前置：
 *   - .env 已配 ENCRYPTION_KEY + HASH_KEY（两个 key 必须不同）
 *   - DB_HOST / DB_USER / DB_PASSWORD / DB_NAME 可用
 *   - V41 已 apply（primary_mobile_hash + primary_mobile_encrypted 列已存在）
 *   - TENANT_SCHEMA 环境变量必须有值且匹配 /^tenant_[a-z0-9_]+$/
 *
 * 输出格式（最后一行机读，外层 bash 用 grep 累计）：
 *   ===> TENANT=tenant_xxx OK=N FAIL=N TOTAL=N
 *
 * 出具：edu-server backend  2026-05-13
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { Pool } from 'pg';
import { FieldEncryptor } from '../src/common/crypto/field-encryptor';
import { HmacHasher } from '../src/common/crypto/hmac-hasher';

/**
 * 简易 .env 读取（避免引入 dotenv 依赖）— 同 V40 backfill
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
    } else if (arg === '--dry-run') {
      // 默认行为，保留显式选项以便 sh 脚本统一传参
      opts.apply = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `用法: TENANT_SCHEMA=tenant_xxx ts-node scripts/backfill-v41-customers-mobile.ts [--apply] [--batch=N]`,
      );
      process.exit(0);
    }
  }
  return opts;
}

interface CustomerRowMin {
  id: string;
  primary_mobile: string | null;
  primary_mobile_hash: Buffer | null;
  primary_mobile_encrypted: Buffer | null;
}

async function main(): Promise<void> {
  const opts = parseArgs();

  // 1. TENANT_SCHEMA env 必填 + 格式校验（防 SQL 注入）
  const tenantSchema = process.env.TENANT_SCHEMA;
  if (!tenantSchema) {
    console.error('[fatal] TENANT_SCHEMA env 未设置');
    console.error('       用法: TENANT_SCHEMA=tenant_xxx ts-node scripts/backfill-v41-customers-mobile.ts');
    process.exit(1);
  }
  if (!/^tenant_[a-z0-9_]+$/.test(tenantSchema)) {
    console.error(`[fatal] TENANT_SCHEMA 格式非法（须 tenant_<lowercase alnum/underscore>）: ${tenantSchema}`);
    process.exit(1);
  }

  // 简短头部（外层 bash 已打印过详细 banner）
  if (!opts.apply) {
    console.log(`[mode] DRY-RUN tenant=${tenantSchema}`);
  } else {
    console.log(`[mode] APPLY tenant=${tenantSchema}`);
  }

  // 2. 校验密钥（缺失会构造抛错）
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

  // 3. 连接 PG
  const pool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'eduapp',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'edu',
  });

  let totalRows = 0;
  let okRows = 0;
  let failedRows = 0;

  try {
    // 4. 切 search_path
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${tenantSchema}, public`);

      // 5. 统计待 backfill 行数
      const countRes = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM customers
         WHERE primary_mobile IS NOT NULL
           AND (primary_mobile_hash IS NULL OR primary_mobile_encrypted IS NULL)`,
      );
      totalRows = parseInt(countRes.rows[0]?.count || '0', 10);
      console.log(`[stats] tenant=${tenantSchema} 待 backfill 行数: ${totalRows}`);

      if (totalRows === 0) {
        console.log(`[ok] tenant=${tenantSchema} 无待处理行`);
        // 输出最后一行机读
        console.log(`===> TENANT=${tenantSchema} OK=0 FAIL=0 TOTAL=0`);
        return;
      }

      if (!opts.apply) {
        console.log(`[dry-run] tenant=${tenantSchema} 加 --apply 真执行`);
        console.log(`===> TENANT=${tenantSchema} OK=0 FAIL=0 TOTAL=${totalRows}`);
        return;
      }

      // 6. 分批拉取 + 单行 UPDATE
      let processed = 0;
      const failures: Array<{ id: string; err: string }> = [];

      while (processed < totalRows) {
        const batch = await client.query<CustomerRowMin>(
          `SELECT id, primary_mobile, primary_mobile_hash, primary_mobile_encrypted
           FROM customers
           WHERE primary_mobile IS NOT NULL
             AND (primary_mobile_hash IS NULL OR primary_mobile_encrypted IS NULL)
           ORDER BY id ASC
           LIMIT $1`,
          [opts.batchSize],
        );

        if (batch.rows.length === 0) break;

        for (const row of batch.rows) {
          if (!row.primary_mobile) continue; // SELECT 已过滤兜底
          try {
            const newHash = row.primary_mobile_hash || hasher.hash(row.primary_mobile);
            const newEncrypted =
              row.primary_mobile_encrypted || encryptor.encrypt(row.primary_mobile);
            await client.query(
              `UPDATE customers
               SET primary_mobile_hash = $1,
                   primary_mobile_encrypted = $2,
                   updated_at = NOW()
               WHERE id = $3`,
              [newHash, newEncrypted, row.id],
            );
            okRows++;
          } catch (err) {
            const msg = (err as Error).message;
            failures.push({ id: row.id, err: msg });
            failedRows++;
            console.error(`[fail] tenant=${tenantSchema} customer=${row.id.slice(0, 8)}...: ${msg}`);
          }
        }

        processed += batch.rows.length;
        console.log(
          `[progress] tenant=${tenantSchema} ${processed}/${totalRows} ok=${okRows} fail=${failedRows}`,
        );
      }

      // 7. 校验：抽样回读确认 hash 一致
      if (okRows > 0) {
        const sample = await client.query<CustomerRowMin>(
          `SELECT id, primary_mobile, primary_mobile_hash, primary_mobile_encrypted
           FROM customers
           WHERE primary_mobile_hash IS NOT NULL AND primary_mobile_encrypted IS NOT NULL
           ORDER BY updated_at DESC
           LIMIT 5`,
        );
        let verifyOk = 0;
        for (const row of sample.rows) {
          if (!row.primary_mobile) continue;
          const expectedHash = hasher.hash(row.primary_mobile)!;
          const expectedDecrypt = row.primary_mobile_encrypted
            ? encryptor.decrypt(row.primary_mobile_encrypted)
            : null;
          const hashOk = row.primary_mobile_hash && row.primary_mobile_hash.equals(expectedHash);
          const decryptOk = expectedDecrypt === row.primary_mobile;
          if (hashOk && decryptOk) verifyOk++;
        }
        console.log(`[verify] tenant=${tenantSchema} ${verifyOk}/${sample.rows.length} 行往返一致`);
        if (verifyOk !== sample.rows.length) {
          console.error(`[verify-fail] tenant=${tenantSchema} 部分行往返不一致`);
          // 不直接 exit；把详细信息打给 sh 累计；但标记非零退出码
          process.exitCode = 1;
        }
      }

      if (failures.length > 0) {
        console.log(`[fail-summary] tenant=${tenantSchema} 失败行 (前 10):`);
        failures.slice(0, 10).forEach((f) => {
          console.log(`    - ${f.id}: ${f.err}`);
        });
      }
    } finally {
      // 复位 search_path 防连接复用污染
      try {
        await client.query(`SET search_path TO public`);
      } catch {
        /* ignore */
      }
      client.release();
    }
  } finally {
    await pool.end();
  }

  // 最后一行机读，外层 bash grep 累计
  console.log(
    `===> TENANT=${tenantSchema} OK=${okRows} FAIL=${failedRows} TOTAL=${totalRows}`,
  );

  if (failedRows > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
