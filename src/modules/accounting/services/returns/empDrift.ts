/** EMP201 drift beyond the totals (wave 5 L1a): the run set, each run's plan hash, per-run finality and directive totals. */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { isPayRunFinal } from '@/modules/accounting/services/payroll/payslipFinal';
import type { EMP201Data } from '@/modules/accounting/services/reports/emp201Service';

export function directiveTotals(payments: { gross: number; paye: number }[]): { count: number; gross: number; paye: number } {
  const cents = (n: number): number => Math.round(n * 100) / 100;
  return {
    count: payments.length,
    gross: cents(payments.reduce((t, p) => t + p.gross, 0)),
    paye: cents(payments.reduce((t, p) => t + p.paye, 0)),
  };
}

export interface EmpRunDrift {
  /** The set of summed run ids, or any run's approved_plan_hash, differs from the finalised one. */
  runsChanged: boolean;
  /** Summed runs that are no longer final under R-035 (reopened, say). */
  unfinalRuns: number;
  /** Directive totals as numeric fields, for the same comparison as the rest. */
  directive: Record<string, number>;
}

const key = (runs: { id: string; approvedPlanHash: string | null }[]): string =>
  runs.map((r) => `${r.id}:${r.approvedPlanHash ?? ''}`).sort().join('|');

export async function empRunDrift(
  companyId: string, recorded: Record<string, unknown>, current: EMP201Data,
): Promise<EmpRunDrift> {
  const ids = current.payrollRuns.map((r) => r.id);
  const hashes = ids.length === 0 ? [] : (await sql`
    SELECT id, approved_plan_hash FROM payroll_run_headers
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
  `) as DbRow[];
  const now = hashes.map((r) => ({ id: String(r.id), approvedPlanHash: r.approved_plan_hash == null ? null : String(r.approved_plan_hash) }));
  const then = Array.isArray(recorded.runs) ? recorded.runs as { id: string; approvedPlanHash: string | null }[] : [];
  let unfinalRuns = 0;
  for (const id of ids) if (!(await isPayRunFinal(companyId, id))) unfinalRuns += 1;
  const t = directiveTotals(current.directivePayments);
  return { runsChanged: key(now) !== key(then), unfinalRuns,
    directive: { directiveCount: t.count, directiveGross: t.gross, directivePaye: t.paye } };
}
