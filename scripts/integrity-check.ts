/**
 * ISAFlow Accounting Integrity Check
 *
 * Runs double-entry, referential, tenant-isolation and balance-cache sanity
 * checks against the live DB. Check definitions live in scripts/lib/* so this
 * file stays a thin orchestrator. Exits 1 if any hard check fails.
 *
 * Usage: bun scripts/integrity-check.ts   (reads DATABASE_URL / .env.local)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSql } from './_pg';
import { coreChecks } from './lib/integrityChecks';
import { tenantChecks } from './lib/integrityChecksTenant';
import { renderResult, summarize, type CheckResult } from './lib/integrityTypes';

// ── Env loading ─────────────────────────────────────────────────────────────
const envPath = path.resolve(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    if (!process.env[k!]) process.env[k!] = rawV!.replace(/^["']|["']$/g, '');
  }
}

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not found in environment or .env.local');
  process.exit(1);
}

const sql = createSql();

async function main(): Promise<void> {
  console.log('=== ISAFlow Accounting Integrity Check ===\n');

  const checks = [...coreChecks, ...tenantChecks];
  const results: CheckResult[] = [];
  for (const check of checks) {
    const result = await check(sql);
    results.push(result);
    renderResult(result, (s) => console.log(s));
  }

  const { passed, total, failed } = summarize(results);
  console.log('');
  console.log(`=== SUMMARY: ${passed}/${total} checks passed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
