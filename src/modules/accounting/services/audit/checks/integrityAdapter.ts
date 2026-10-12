/**
 * Master's fifteen integrity checks as recorded checks — run by
 * runIntegrityChecks itself (their SQL is not forked), one check at a time,
 * each in its own SAVEPOINT: a check that errors would otherwise abort the
 * snapshot's whole transaction, since the runner catches the error after
 * Postgres has already aborted.
 */
import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { INTEGRITY_CHECK_IDS, type IntegrityCheckResult } from '@/modules/accounting/services/gl/integrityChecks/types';
import { runIntegrityChecks } from '@/modules/accounting/services/gl/integrityChecks';
import { money, result, type CheckResult, type CheckWindow, type Finding } from './checkTypes';

export const INTEGRITY_CHECK_VERSION = 1;
const SAMPLE_LIMIT = 100;

class CheckDidNotRun extends Error {}

function toResult(r: IntegrityCheckResult): CheckResult {
  const findings: Finding[] = r.sample.map((s) => ({
    key: `${r.id}:${s.id}`, refs: [s.id],
    detail: { label: s.label, amount: s.amount === undefined ? null : money(s.amount), detail: s.detail ?? null },
  }));
  const out = result(`integrity.${r.id}`, INTEGRITY_CHECK_VERSION, 'integrity', null, findings);
  // The runner's count is every failing row, not the sample.
  return { ...out, findingCount: r.count, status: r.count > 0 ? 'fail' : 'pass' };
}

export async function runIntegrity(w: CheckWindow, step?: (name: string) => Promise<void>): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const id of INTEGRITY_CHECK_IDS) {
    await step?.(`the integrity check ${id}`);
    try {
      const r = await withSavepoint(`audit_integrity_${INTEGRITY_CHECK_IDS.indexOf(id)}`, async () => {
        const report = await runIntegrityChecks(w.companyId, { checks: [id], asAt: w.to, limit: SAMPLE_LIMIT });
        const check = report.checks[0]!;
        // count -1: the check threw inside the runner. Throw again so the savepoint rolls back the abort.
        if (check.count < 0) throw new CheckDidNotRun(id);
        return check;
      });
      out.push(toResult(r));
    } catch (err) {
      log.warn('audit: integrity check did not run', { check: id, error: err instanceof Error ? err.message : String(err) }, 'audit');
      out.push(result(`integrity.${id}`, INTEGRITY_CHECK_VERSION, 'integrity', null, [], 'unknown'));
    }
  }
  return out;
}
