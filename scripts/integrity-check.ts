/**
 * ISAFlow Accounting Integrity Check
 *
 * Runs double-entry, referential, tenant-isolation and balance-cache sanity
 * checks against the live DB. Check definitions live in scripts/lib/* so this
 * file stays a thin orchestrator. Exits 1 if any hard check fails.
 *
 * Usage: bun scripts/integrity-check.ts   (reads DATABASE_URL / .env.local)
 *        bun scripts/integrity-check.ts --baseline scripts/integrity-baseline-prod.json
 *
 * --baseline <file>: JSON array of known-and-accepted failures (label +
 * required maxOffending cap + reason). Listed failures within their cap are
 * reported as [WAIVED] and do not fail the run; anything new or worse still
 * exits 1. Used by the post-deploy prod gate while HUMAN-GATED repairs wait
 * on Hein — never as a way to hide a regression.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSql } from './_pg';
import { coreChecks } from './lib/integrityChecks';
import { tenantChecks } from './lib/integrityChecksTenant';
import {
  applyBaseline,
  parseBaselineJson,
  renderResult,
  summarize,
  type BaselineEntry,
  type CheckResult,
} from './lib/integrityTypes';

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

// ── Baseline loading (--baseline <file>) ────────────────────────────────────
// Parsing/validation lives in parseBaselineJson (integrityTypes.ts) so it is
// unit-tested; this wrapper only handles argv + file IO.
function loadBaseline(): BaselineEntry[] {
  const idx = process.argv.indexOf('--baseline');
  if (idx === -1) return [];
  const file = process.argv[idx + 1];
  if (!file) {
    console.error('ERROR: --baseline requires a file path');
    process.exit(1);
  }
  const resolved = path.resolve(file);
  try {
    return parseBaselineJson(fs.readFileSync(resolved, 'utf-8'));
  } catch (err) {
    console.error(`ERROR: invalid baseline ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const baseline = loadBaseline();
const sql = createSql();

async function main(): Promise<void> {
  console.log('=== ISAFlow Accounting Integrity Check ===\n');
  if (baseline.length > 0) {
    console.log(`Baseline active: ${baseline.length} known failure(s) may be waived (never new ones)\n`);
  }

  const checks = [...coreChecks, ...tenantChecks];
  const results: CheckResult[] = [];
  for (const check of checks) {
    // Apply the baseline per result and render immediately: operators watch
    // this live during post-deploy verification — don't buffer 15+ checks.
    const [result] = applyBaseline([await check(sql)], baseline) as [CheckResult];
    results.push(result);
    renderResult(result, (s) => console.log(s));
  }

  const { passed, total, failed, waived } = summarize(results);
  console.log('');
  console.log(
    `=== SUMMARY: ${passed}/${total} checks passed${waived > 0 ? ` (${waived} WAIVED via baseline — see [WAIVED] rows)` : ''} ===`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
