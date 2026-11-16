/**
 * Payslips from a pay run's STORED lines (wave 4 PS). `getPayslips` reads the run
 * header, its lines and breakdowns, each employee's name, number and tax number, the last four digits of the active bank account (cut in SQL, so the
 * whole number never leaves the database) and the year to date. Nothing is
 * recalculated (`payslipItems`). Final or DRAFT is `isPayRunFinal` alone: approved or paid with an
 * approval time, never the status column by itself. Never the ID number.
 *
 * Every read is scoped by company: a run of another company is `PayslipNotFound`,
 * as is a cancelled run (the history hides it too) and an employee with no line on it.
 *
 * Occupation (BCEA s33(1)(b)) and the stored terms of work (hours, rates) come from the employee's profile
 * (migration 967). The EE level or department is not an occupation: with none captured the slip prints
 * "Occupation not recorded".
 *
 * Wave 6 PS3: a final run prints the details frozen at its approval (payslipSnapshot), not the live profile, bank
 * account and company; a final run with no snapshot of its current approval reads live and says "as at download".
 */
import { sql } from '@/lib/neon';
import { getCompanyDetailsFromCompany } from '@/modules/accounting/services/core/pdfShared';
import { quantitiesFromBreakdown, type WorkedQuantity } from './payslipQuantities';
import { itemisePayslip, readBreakdown, type PayslipLines } from './payslipItems';
import { payslipYearToDate, type PayslipYearToDate } from './payslipYearToDate';
import { assertRunKindSupported } from './payrollRunKindGuard';
import { detailsOf, type DetailsRow } from './payslipSnapshot';

export class PayslipNotFound extends Error {
  constructor(what: 'run' | 'employee') {
    super(what === 'run' ? 'Pay run not found' : 'This employee has no line on this pay run');
    this.name = 'PayslipNotFound';
  }
}

export interface Payslip extends PayslipLines {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  taxNumber: string | null;
  paymentMethod: string;
  /** The active bank account's last four digits; null when none is on file. */
  bankLastFour: string | null;
  bankName: string | null;
  /** A bank account is on file but too short to mask (fewer than four characters). */
  bankIncomplete: boolean;
  /** Hours or days stamped on the line's stored breakdown for basic pay (3601) and overtime (3607); null when none. */
  workedOrdinary: WorkedQuantity | null;
  workedOvertime: WorkedQuantity | null;
  /** BCEA s33(1)(b): the employee's occupation as captured on the profile; null when none. */
  occupation: string | null;
  payBasis: string;
  /** The stored terms of work (contracted hours, rates); null when not captured. */
  hoursPerWeek: number | null;
  hoursPerDay: number | null;
  hourlyRate: number | null;
  dailyRate: number | null;
  yearToDate: PayslipYearToDate;
}

export interface PayslipRun {
  runId: string;
  periodMonth: number;
  periodYear: number;
  runDate: string | null;
  /** R-035 cleared (or grandfathered): false prints DRAFT on every page. */
  final: boolean;
  /** Wave 6 PS3: 'approval' when every slip prints the details frozen at this approval; else 'download' (live). */
  detailsAsAt: 'approval' | 'download';
  employer: { name: string; address: string };
  payslips: Payslip[];
}

interface HeaderRow { period_month: number; period_year: number; run_date: string | Date | null }

interface LineRow extends DetailsRow {
  employee_id: string;
  gross_pay: string | number;
  paye: string | number;
  uif_employee: string | number;
  uif_employer: string | number;
  sdl: string | number;
  net_pay: string | number;
  component_breakdown: unknown;
  run_final: boolean;
}

/** Hours or days stamped on the stored breakdown at calculation time (payslipQuantities). */
function workedOf(breakdown: unknown): { workedOrdinary: WorkedQuantity | null; workedOvertime: WorkedQuantity | null } {
  const q = quantitiesFromBreakdown(breakdown);
  return { workedOrdinary: q.ordinary, workedOvertime: q.overtime };
}

const numOrNull = (v: string | number | null): number | null => (v == null ? null : Number(v));

const dateOnly = (d: string | Date | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

async function readLines(companyId: string, runId: string, employeeIds: string[] | null): Promise<LineRow[]> {
  return (await sql`
    SELECT prl.employee_id::text AS employee_id, pe.employee_number, pe.first_name, pe.last_name,
           pe.tax_number, pe.payment_method,
           pe.occupation, pe.pay_basis, pe.hours_per_week, pe.hours_per_day, pe.hourly_rate, pe.daily_rate,
           RIGHT(btrim(bd.account_number), 4) AS bank_last_four, char_length(btrim(bd.account_number)) AS bank_length, bd.bank_name,
           prl.gross_pay, prl.paye, prl.uif_employee, prl.uif_employer, prl.sdl, prl.net_pay,
           prl.component_breakdown,
           (prh.status IN ('approved', 'paid') AND COALESCE(prh.approved_at, prh.approval_grandfathered_at) IS NOT NULL) AS run_final,
           prl.payslip_snapshot,
           -- PS3 (F8): the snapshot is this approval's only while its approvedAt is the header's current approved_at.
           -- A malformed approvedAt is not frozen, never a cast error (CASE fixes the evaluation order).
           CASE WHEN prh.status IN ('approved', 'paid')
                 AND prl.payslip_snapshot->>'approvedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+([+-][0-9:]+|Z)$'
                THEN COALESCE((prl.payslip_snapshot->>'approvedAt')::timestamptz = prh.approved_at, false)
                ELSE false END AS details_frozen
      FROM payroll_run_lines prl
      JOIN payroll_run_headers prh ON prh.id = prl.run_id
      JOIN payroll_employees pe ON pe.id = prl.employee_id AND pe.company_id = prh.company_id
      LEFT JOIN payroll_bank_details bd
        ON bd.employee_id = pe.id AND bd.company_id = prh.company_id AND bd.is_active
     WHERE prl.run_id = ${runId}::uuid
       AND prh.company_id = ${companyId}::uuid
       AND (${employeeIds}::text[] IS NULL OR prl.employee_id::text = ANY(${employeeIds}::text[]))
     ORDER BY pe.employee_number
  `) as LineRow[];
}

/** The catalogue type of each component the breakdowns name, in this company only. */
async function componentTypes(companyId: string, lines: LineRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(lines.flatMap((l) => readBreakdown(l.component_breakdown)
    .map((i) => String(i.componentId ?? '')).filter(Boolean)))];
  if (ids.length === 0) return new Map();
  const rows = (await sql`
    SELECT id::text AS id, component_type FROM payroll_components
     WHERE company_id = ${companyId}::uuid AND id::text = ANY(${ids}::text[])
  `) as Array<{ id: string; component_type: string }>;
  return new Map(rows.map((r) => [r.id, r.component_type]));
}

export async function getPayslips(companyId: string, runId: string, employeeIds?: string[]): Promise<PayslipRun> {
  const headers = (await sql`
    SELECT period_month, period_year, run_date FROM payroll_run_headers
     WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid AND status <> 'cancelled'
  `) as HeaderRow[];
  const header = headers[0];
  if (!header) throw new PayslipNotFound('run');
  await assertRunKindSupported(companyId, runId, 'payslip'); // wave 6 FQa: a run this release cannot print

  const lines = await readLines(companyId, runId, employeeIds ?? null);
  if (lines.length === 0 || (employeeIds && lines.length !== new Set(employeeIds).size)) throw new PayslipNotFound('employee');

  const run = { id: runId, periodMonth: Number(header.period_month), periodYear: Number(header.period_year) };
  // One after another: they share the request's transaction connection.
  const final = lines[0]!.run_final === true; // read in the lines' own statement: the figures and their final state cannot tear
  const types = await componentTypes(companyId, lines);
  const ytd = await payslipYearToDate(companyId, run, lines.map((l) => l.employee_id));
  const company = await getCompanyDetailsFromCompany(companyId);
  // PS3: all of the run's slips print one approval's details, or all print live ones.
  const frozen = final && lines.every((l) => l.details_frozen === true);
  const live = { name: company.name, address: company.address };
  const shown = lines.map((l) => ({ l, ...detailsOf({ ...l, details_frozen: frozen }, live) }));

  return {
    runId, periodMonth: run.periodMonth, periodYear: run.periodYear, runDate: dateOnly(header.run_date), final,
    detailsAsAt: frozen ? 'approval' : 'download',
    employer: shown[0]!.employer,
    payslips: shown.map(({ l, details: d, yearToDate: frozenYtd }): Payslip => ({
      ...itemisePayslip({
        grossPay: Number(l.gross_pay), paye: Number(l.paye), uifEmployee: Number(l.uif_employee),
        uifEmployer: Number(l.uif_employer), sdl: Number(l.sdl), netPay: Number(l.net_pay), breakdown: l.component_breakdown,
      }, types),
      employeeId: l.employee_id,
      employeeNumber: String(d.employee_number),
      employeeName: `${d.first_name} ${d.last_name}`.trim(),
      taxNumber: d.tax_number,
      paymentMethod: String(d.payment_method),
      // A masked form needs four real characters: a shorter (or blank) number is incomplete, never printed as is.
      bankLastFour: Number(d.bank_length ?? 0) >= 4 ? d.bank_last_four : null,
      bankIncomplete: d.bank_length != null && Number(d.bank_length) < 4,
      bankName: d.bank_name,
      ...workedOf(l.component_breakdown),
      occupation: d.occupation,
      payBasis: String(d.pay_basis),
      hoursPerWeek: numOrNull(d.hours_per_week),
      hoursPerDay: numOrNull(d.hours_per_day),
      hourlyRate: numOrNull(d.hourly_rate),
      dailyRate: numOrNull(d.daily_rate),
      yearToDate: frozenYtd ?? ytd.get(l.employee_id)!, // PS3 (B1): the year to date as issued at approval
    })),
  };
}
