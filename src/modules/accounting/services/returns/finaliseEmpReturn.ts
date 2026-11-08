/**
 * Finalise an EMP201 (wave 5 L1a). The figures are generateEMP201's; the return is refused (409)
 * unless EVERY pay run it sums, and every other live run of the period, is final under R-035
 * (isPayRunFinal), never by status string. No payroll lock (decision 7). Nothing is written
 * before the checks pass.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { isPayRunFinal } from '@/modules/accounting/services/payroll/payslipFinal';
import { insertVersion, nextVersion } from './returnVersionStore';
import { ReturnRefusal, type ReturnActor, type ReturnVersion } from './returnVersionTypes';

interface RunHeader {
  id: string;
  month: string;
  approvedPlanHash: string | null;
  approvedAt: string | null;
}

/** Every non-cancelled run of the period, share-locked so a reopen waits for this transaction. */
async function periodRuns(companyId: string, periodStart: string, periodEnd: string): Promise<RunHeader[]> {
  const rows = (await sql`
    SELECT id, period_year, period_month, approved_plan_hash, approved_at
    FROM payroll_run_headers
    WHERE company_id = ${companyId}::UUID AND status <> 'cancelled'
      AND make_date(period_year, period_month, 1) >= ${periodStart}::DATE
      AND make_date(period_year, period_month, 1) <= ${periodEnd}::DATE
    ORDER BY period_year, period_month, id
    FOR SHARE
  `) as DbRow[];
  return rows.map((r) => ({
    id: String(r.id),
    month: `${String(r.period_month).padStart(2, '0')}/${r.period_year}`,
    approvedPlanHash: r.approved_plan_hash == null ? null : String(r.approved_plan_hash),
    approvedAt: r.approved_at == null ? null : new Date(r.approved_at as string | Date).toISOString(),
  }));
}

export async function finaliseEmpReturn(
  companyId: string, periodStart: string, periodEnd: string, actor: ReturnActor, existing: ReturnVersion[],
): Promise<ReturnVersion> {
  const runs = await periodRuns(companyId, periodStart, periodEnd);
  const notFinal: string[] = [];
  for (const run of runs) {
    if (!(await isPayRunFinal(companyId, run.id))) notFinal.push(run.month);
  }
  if (notFinal.length > 0) {
    throw new ReturnRefusal(409,
      `Pay run${notFinal.length === 1 ? '' : 's'} for ${notFinal.join(', ')} ${notFinal.length === 1 ? 'is' : 'are'} `
      + 'not final under the approval rule, so the EMP201 would not match the payslips. Approve or cancel it first.');
  }

  const figures = await generateEMP201(companyId, periodStart, periodEnd);
  const summed = new Set(figures.payrollRuns.map((r) => r.id));
  const used = runs.filter((r) => summed.has(r.id));
  // A summed run absent from the share-locked list could only be a run that moved in between.
  if (used.length !== summed.size) {
    throw new ReturnRefusal(409, 'The pay runs changed while the EMP201 was being finalised. Try again.');
  }
  const approved = used.map((r) => r.approvedAt).filter((a): a is string => a !== null).sort();
  const next = nextVersion(existing);
  return insertVersion({
    companyId, form: 'EMP201', periodStart, periodEnd, ...next,
    figures: {
      ...figures,
      runs: used.map((r) => ({ id: r.id, approvedPlanHash: r.approvedPlanHash, approvedAt: r.approvedAt })),
    },
    postedThrough: approved[approved.length - 1] ?? new Date().toISOString(),
    vatPeriodLockId: null,
    finalisedBy: actor.userId,
  });
}
