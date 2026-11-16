/**
 * Wave 6 PS3: the details a final payslip prints, frozen at approval (migration 999k).
 *
 * `freezePayslipDetails` runs inside approvePayrollRun's transaction, after the header's approval UPDATE: it writes
 * each line's `payslip_snapshot` (the employee's name, number, tax number, payment method, occupation and terms of
 * work; the active bank account's name, last four digits and length, never the number; the employer's name and
 * address), the line's year to date as at the approval (payslipYearToDate; review B1: the slip is the document as
 * issued, so reopening an earlier month does not move it), and the header's `approved_at`, read in the same
 * statement. `clearPayslipDetails` runs in reopenPayrollRun. Neither is part of the approval plan hash.
 * approvePayrollRun freezes only a run it moves INTO approval: re-approving an already-approved run (to post its
 * journal) keeps its approval time and whatever snapshot it has (review B3).
 *
 * `detailsOf` picks what a slip prints: the snapshot when `frozen` (the run is final and the snapshot's approvedAt
 * equals the header's current approved_at, judged in SQL, grill F8), otherwise the live row. An older colour that
 * reopens and re-approves without clearing leaves a snapshot of an earlier approval: it is never used.
 * The employee has no address on file (payroll_employees has no address column), so none is frozen.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getCompanyDetailsFromCompany } from '@/modules/accounting/services/core/pdfShared';
import { payslipYearToDate, type PayslipYearToDate } from './payslipYearToDate';

/** The employee details a slip prints, as read live (payslipModel.readLines) or from the snapshot. */
export interface PayslipDetails {
  employee_number: string;
  first_name: string;
  last_name: string;
  tax_number: string | null;
  payment_method: string;
  occupation: string | null;
  pay_basis: string;
  hours_per_week: string | number | null;
  hours_per_day: string | number | null;
  hourly_rate: string | number | null;
  daily_rate: string | number | null;
  bank_last_four: string | null;
  bank_length: string | number | null;
  bank_name: string | null;
}

export interface Employer { name: string; address: string }

/** The snapshot as stored: the details, the employer, and the approval it belongs to. */
export interface PayslipSnapshot extends PayslipDetails { approvedAt: string; employer: Employer; yearToDate?: PayslipYearToDate }

/** Write the snapshot on every line of this company's approved run. Returns the number of lines frozen. */
export async function freezePayslipDetails(companyId: string, runId: string): Promise<number> {
  const lines = (await sql`
    SELECT prl.employee_id::text AS employee_id, h.period_month, h.period_year
      FROM payroll_run_lines prl JOIN payroll_run_headers h ON h.id = prl.run_id
     WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
  `) as Array<{ employee_id: string; period_month: number; period_year: number }>;
  if (lines.length === 0) return 0;
  const run = { id: runId, periodMonth: Number(lines[0]!.period_month), periodYear: Number(lines[0]!.period_year) };
  const ytd = await payslipYearToDate(companyId, run, lines.map((l) => l.employee_id));
  const yearToDate = JSON.stringify(Object.fromEntries(ytd));
  const company = await getCompanyDetailsFromCompany(companyId);
  const employer = JSON.stringify({ name: company.name, address: company.address });
  const rows = (await sql`
    UPDATE payroll_run_lines prl
       SET payslip_snapshot = jsonb_build_object(
             'approvedAt', h.approved_at,
             'employee_number', pe.employee_number, 'first_name', pe.first_name, 'last_name', pe.last_name,
             'tax_number', pe.tax_number, 'payment_method', pe.payment_method,
             'occupation', pe.occupation, 'pay_basis', pe.pay_basis, 'hours_per_week', pe.hours_per_week,
             'hours_per_day', pe.hours_per_day, 'hourly_rate', pe.hourly_rate, 'daily_rate', pe.daily_rate,
             'bank_last_four', RIGHT(btrim(bd.account_number), 4), 'bank_length', char_length(btrim(bd.account_number)),
             'bank_name', bd.bank_name,
             'employer', ${employer}::jsonb,
             'yearToDate', ${yearToDate}::jsonb -> (prl.employee_id::text))
      FROM payroll_run_headers h,
           payroll_employees pe
           LEFT JOIN payroll_bank_details bd ON bd.employee_id = pe.id AND bd.company_id = pe.company_id AND bd.is_active
     WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
       AND h.status = 'approved' AND h.approved_at IS NOT NULL
       AND prl.run_id = h.id
       AND pe.id = prl.employee_id AND pe.company_id = h.company_id
    RETURNING prl.id
  `) as Array<{ id: string }>;
  // A line whose employee is gone from this company, or a run not approved, freezes nothing: its slip reads live.
  if (rows.length < lines.length) {
    log.warn('Payslip details not frozen on every line', { companyId, runId, lines: lines.length, frozen: rows.length }, 'payslipSnapshot');
  }
  return rows.length;
}

/** Drop the snapshot from every line of this company's run (reopen). */
export async function clearPayslipDetails(companyId: string, runId: string): Promise<void> {
  await sql`
    UPDATE payroll_run_lines prl SET payslip_snapshot = NULL
      FROM payroll_run_headers h
     WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid AND prl.run_id = h.id
       AND prl.payslip_snapshot IS NOT NULL
  `;
}

/** A line as payslipModel reads it: the live details, the snapshot, and whether the snapshot is this approval's. */
export interface DetailsRow extends PayslipDetails { payslip_snapshot: unknown; details_frozen: boolean }

/** The details, employer and year to date a slip prints: the snapshot's when frozen, else live (yearToDate null). */
export function detailsOf(row: DetailsRow, liveEmployer: Employer): {
  details: PayslipDetails; employer: Employer; yearToDate: PayslipYearToDate | null;
} {
  if (row.details_frozen !== true || row.payslip_snapshot == null || typeof row.payslip_snapshot !== 'object') {
    return { details: row, employer: liveEmployer, yearToDate: null };
  }
  const snap = row.payslip_snapshot as PayslipSnapshot;
  return { details: snap, employer: snap.employer, yearToDate: snap.yearToDate ?? null };
}
