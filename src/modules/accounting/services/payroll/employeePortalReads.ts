/**
 * What a signed-in employee may read in the self-service portal (wave 6 SS): their OWN final payslips and leave
 * balances, read-only. Every read takes the company and employee from the verified portal session
 * (employeePortalAuth), never from the request, and filters on both.
 *
 * A payslip is shown only when it is final (payRunFinalSql: approved or paid, with an approval time) AND prints the
 * details frozen at that approval (PS3's snapshot of the run's CURRENT approval; payslipModel `detailsAsAt`), the
 * rule PE's email follows (DETAILS_NOT_FROZEN): a run approved before PS3 went live is not shown. A reopened run is
 * not final, so its slip leaves the list and its PDF is 404 at once; after re-approval the new slip shows.
 * Regular monthly runs only, and each listed run must pass the same run-kind guard the PDF render runs
 * (assertRunKindSupported 'payslip'; review #1576 L1), so the list never shows a slip whose download would 404.
 */
import { sql } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { getPayslips, PayslipNotFound } from './payslipModel';
import { buildPayslipPdf, payslipFilename } from './payslipPdf';
import { assertRunKindSupported, isRunKindUnsupported, RunKindUnsupportedError } from './payrollRunKindGuard';
import { snapshotIsThisApproval } from './payslipSnapshot';
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
  const shown: OwnPayslip[] = [];
  for (const r of rows.filter((x) => snapshotIsThisApproval(x.snapshot_approved_at, x.approved_at_us))) {
    if (!(await renderable(companyId, r.run_id))) continue;
    shown.push({
      runId: r.run_id, periodYear: Number(r.period_year), periodMonth: Number(r.period_month),
      runDate: r.run_date == null ? null : String(r.run_date).slice(0, 10), netPay: Number(r.net_pay),
    });
  }
  return shown;
}

/** Whether the payslip render would accept this run (the guard ownPayslipPdf meets through getPayslips). */
async function renderable(companyId: string, runId: string): Promise<boolean> {
  try {
    await assertRunKindSupported(companyId, runId, 'payslip');
    return true;
  } catch (err) {
    if (isRunKindUnsupported(err)) return false;
    throw err;
  }
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

interface LeaveRow {
  company_id: string; employee_id: string; leave_type: string; balance_year: number;
  accrued: string | number; taken: string | number; pending: string | number; balance: string | number;
}

/**
 * The employee's own leave balances for the year, filtered by company AND employee in the SQL (review #1576 M2: no
 * read of the whole company's leave), and again on the rows, so a query edit cannot widen what is returned.
 * Its own statement, not payrollLeaveService.listLeaveBalances (439 lines; spec §1 rule 4: SS does not grow it).
 */
export async function ownLeaveBalances(companyId: string, employeeId: string, year = Number(todaySast().slice(0, 4))): Promise<OwnLeaveBalance[]> {
  const rows = (await sql`
    SELECT plb.company_id::text AS company_id, plb.employee_id::text AS employee_id, plt.name AS leave_type, plb.balance_year,
           plb.accrued, plb.taken, plb.pending, plb.balance
      FROM payroll_leave_balances plb
      JOIN payroll_leave_types plt ON plt.id = plb.leave_type_id
     WHERE plb.company_id = ${companyId}::uuid AND plb.employee_id = ${employeeId}::uuid AND plb.balance_year = ${year}
     ORDER BY plt.name
  `) as LeaveRow[];
  return rows.filter((r) => r.company_id === companyId && r.employee_id === employeeId).map((r) => ({
    leaveType: r.leave_type, year: Number(r.balance_year), accrued: Number(r.accrued), taken: Number(r.taken),
    pending: Number(r.pending), balance: Number(r.balance),
  }));
}
