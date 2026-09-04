/**
 * check-migration-rls — CI entrypoint for: every migration-created table
 * carrying company_id must end up under row-level security.
 *
 * Detection logic lives in ./migrationRlsRule.ts so it can be unit-tested;
 * this file walks scripts/migrations/sql/, reports, and applies the
 * baseline. See tests/unit/ci/migrationRlsRule.test.ts and
 * migrationRlsRule.ts's own comment for what the rule can and cannot see —
 * in particular, migrations 348 and 498 grant RLS to tables DYNAMICALLY (a
 * DO-block loop over pg_policies, no table name as literal text anywhere),
 * so a table protected ONLY by one of those two sweeps has nothing this gate
 * can match and is reported as a violation even though the live database has
 * it under RLS. scripts/ci/migration-rls.baseline lists exactly those tables
 * — verified safe against isaflow_dev, not allowlisted defects — following
 * the same report-only-against-a-baseline convention as
 * check-is-active-in-balances.sh. This fails only on a table NOT in that
 * baseline, which is how 595_gl_account_merges.sql was found: genuinely
 * unprotected, not a gate blind spot. See FINDINGS.md.
 *
 * Run: bun scripts/ci/check-migration-rls.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findViolations } from './migrationRlsRule';

const DIR = 'scripts/migrations/sql';
const BASELINE_PATH = 'scripts/ci/migration-rls.baseline';

function readBaseline(): Set<string> {
  const out = new Set<string>();
  let text: string;
  try {
    text = readFileSync(BASELINE_PATH, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    out.add(trimmed.toLowerCase());
  }
  return out;
}

const files = readdirSync(DIR)
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(f => ({ file: join(DIR, f), text: readFileSync(join(DIR, f), 'utf8') }));

const baseline = readBaseline();
const allViolations = findViolations(files);
const newViolations = allViolations.filter(v => !baseline.has(v.table));
const baselinedCount = allViolations.length - newViolations.length;

console.log('=== every migration-created company_id table must end up under RLS ===');
if (baselinedCount > 0) {
  console.log(`(${baselinedCount} table(s) not directly verifiable by this gate, matched against the baseline — see ${BASELINE_PATH})`);
}
if (newViolations.length > 0) {
  console.error(`ERROR: ${newViolations.length} table(s) with company_id and no ENABLE+FORCE+POLICY found anywhere in scripts/migrations/sql/, and not in the baseline.`);
  for (const v of newViolations) {
    console.error(`  ${v.table}  (created at ${v.file}:${v.line})`);
  }
  console.error('');
  console.error('Fix: add ENABLE/FORCE ROW LEVEL SECURITY + a CREATE POLICY for this table,');
  console.error('in the same migration or a new one. Do NOT add it to the baseline instead —');
  console.error('the baseline is for tables independently confirmed safe, not new gaps.');
  process.exit(1);
}
console.log('OK: every company_id table created by a migration is under RLS (directly or via the baseline).');
