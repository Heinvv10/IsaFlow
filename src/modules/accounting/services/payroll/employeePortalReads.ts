/**
 * What a signed-in employee may read in the self-service portal (wave 6 SS): their OWN final payslips and leave
 * balances, read-only. Every read takes the company and employee from the verified portal session
 * (employeePortalAuth), never from the request, and filters on both.
 *
 * A payslip is shown only when it is final (payRunFinalSql: approved or paid, with an approval time) AND prints the
 * details frozen at that approval (PS3's snapshot of the run's CURRENT approval; payslipModel `detailsAsAt`), the
 * rule PE's email follows (DETAILS_NOT_FROZEN): a run approved before PS3 went live is not shown. A reopened run is
 * not final, so its slip leaves the list and its PDF is 404 at once; after re-approval the new slip shows.
 * Regular monthly runs only: the payslip render refuses other kinds (payrollRunKindGuard), so they are not listed.
 */
import { sql } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { getPayslips, PayslipNotFound } from './payslipModel';
import { buildPayslipPdf, payslipFilename } from './payslipPdf';
import { RunKindUnsupportedError } from './payrollRunKindGuard';
import { snapshotIsThisApproval } from './payslipSnapshot';
import { listLeaveBalances } from './payrollLeaveService';
import { todaySast } from './employeePortalWindow';

export interface OwnPayslip { runId: string; periodYear: number; periodMonth: number; runDate: string | null; netPay: number }

interface ListRow {
  run_id: string; period_year: number; period_month: number; run_date: string | null; net_pay: string | number;
  snapshot_approved_at: string | null; approved_at_us: string | null;
}

export async function listOwnPayslips(companyId: string, employeeId: string): Promise<OwnPayslip[]> {
  const rows = (await sql`
    SELECT h.id::text AS run_id, h.period_year, h.period_month, h.run_date, prl.net_pay,
           prl.payslip_snapshot->>'approvedAt' AS snapshot_approved_at,
           (extract(epoch FROM h.approved_at) * 1000000)::bigint::text AS approved_at_us
      FROM payroll_run_lines prl
      JOIN payroll_run_headers h ON h.id = prl.run_id
      JOIN payroll_employees e ON e.id = prl.employee_id AND e.company_id = h.company_id
     WHERE prl.employee_id = ${employeeId}::uuid AND h.company_id = ${companyId}::uuid
       AND ${sql.unsafe(payRunFinalSql('h'))}
       AND h.run_kind = 'regular' AND h.pay_frequency = 'monthly'
     ORDER BY h.period_year DESC, h.period_month DESC
  `) as ListRow[];
  return rows.filter((r) => snapshotIsThisApproval(r.snapshot_approved_at, r.approved_at_us)).map((r) => ({
    runId: r.run_id, periodYear: Number(r.period_year), periodMonth: Number(r.period_month),
    runDate: r.run_date == null ? null : String(r.run_date).slice(0, 10), netPay: Number(r.net_pay),
  }));
}

/** The employee's own final slip on that run as a PDF, or null (not theirs, not final, not frozen: one 404). */
export async function ownPayslipPdf(companyId: string, employeeId: string, runId: string): Promise<{ filename: string; pdf: Buffer } | null> {
  try {
    const run = await getPayslips(companyId, runId, [employeeId]);
    if (!run.final || run.detailsAsAt !== 'approval') return null;
    return { filename: payslipFilename(run, run.payslips[0]?.employeeNumber), pdf: await buildPayslipPdf(run) };
  } catch (err) {
    if (err instanceof PayslipNotFound || err instanceof RunKindUnsupportedError) return null;
    throw err;
  }
}

export interface OwnLeaveBalance { leaveType: string; year: number; accrued: number; taken: number; pending: number; balance: number }

export async function ownLeaveBalances(companyId: string, employeeId: string, year = Number(todaySast().slice(0, 4))): Promise<OwnLeaveBalance[]> {
  return (await listLeaveBalances(companyId, year)).filter((b) => b.employeeId === employeeId && b.companyId === companyId)
    .map((b) => ({ leaveType: b.leaveTypeName, year: b.balanceYear, accrued: b.accrued, taken: b.taken, pending: b.pending, balance: b.balance }));
}
