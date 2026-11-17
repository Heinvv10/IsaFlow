/** EMP201 drift beyond the totals (wave 5 L1a): the run set, each run's plan hash, per-run finality and directive totals. */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { isPayRunFinal } from '@/modules/accounting/services/payroll/payslipFinal';
import { listNotFinalDeclaredRuns } from '@/modules/accounting/services/payroll/payRunNotFinal';
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
  /**
   * Runs that are not final now (reopened, say) among those summed now and those the finalised version recorded.
   * generateEMP201 sums final runs only (wave 6 EF), so a recorded run that lost finality is judged from the record,
   * and an approved/paid run of the period with no approval time (payRunNotFinal) counts too.
   */
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
  const unfinal = new Set<string>();
  for (const id of new Set([...ids, ...then.map((r) => r.id)])) if (!(await isPayRunFinal(companyId, id))) unfinal.add(id);
  const period = { start: current.periodStart.slice(0, 10), end: current.periodEnd.slice(0, 10) };
  for (const r of await listNotFinalDeclaredRuns(companyId, period.start, period.end)) unfinal.add(r.id);
  const unfinalRuns = unfinal.size;
  const t = directiveTotals(current.directivePayments);
  return { runsChanged: key(now) !== key(then), unfinalRuns,
    directive: { directiveCount: t.count, directiveGross: t.gross, directivePaye: t.paye } };
}
